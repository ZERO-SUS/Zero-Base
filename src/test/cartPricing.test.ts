import { describe, expect, it } from 'vitest';
import {
  computeCartTotals,
  getGroupSubtotal,
  getItemLineTotal,
  groupsFromExisting,
  newCartItem,
  resolveServiceCategories,
  toCartPayloadGroups,
  type DraftCartGroup,
} from '../lib/cartPricing';
import type { BusinessSettings, ServiceCategoryGroup } from '../types/domain';

describe('Itemized Service Cart & Checkout Pricing Helpers', () => {
  it('resolves dynamic active and inactive categories from settings with kinds', () => {
    const settings: BusinessSettings = {
      app_name: 'ZERO BASE',
      timezone: 'Asia/Kolkata',
      currency_code: 'INR',
      currency_symbol: '₹',
      service_types: ['Overhead Tank Cleaning'],
      service_categories: [
        { name: 'Overhead Tank Cleaning', active: true, kind: 'tank' },
        { name: 'Solar Panel Cleaning', active: true, kind: 'solar' },
        { name: 'Old Discontinued Service', active: false, kind: 'other' },
      ],
      default_reminder_months: 6,
    };

    const resolved = resolveServiceCategories(settings);
    expect(resolved).toHaveLength(3);
    expect(resolved.filter((c) => c.active).map((c) => c.name)).toEqual([
      'Overhead Tank Cleaning',
      'Solar Panel Cleaning',
    ]);
    expect(resolved[1].kind).toBe('solar');
  });

  it('calculates single tank, multiple tanks, grouped quantities, solar, and plumbing itemized totals accurately', () => {
    const groups: DraftCartGroup[] = [
      {
        category_name: 'Overhead Tank Cleaning',
        kind: 'tank',
        pricing_mode: 'itemized',
        category_subtotal: '',
        items: [
          {
            uid: 't1',
            item_name: 'Terrace Tanks',
            capacity_litres: '1000',
            quantity: 3,
            unit_price: '600',
            description: '3 identical 1000L tanks',
          },
          {
            uid: 't2',
            item_name: 'Main Reservoir',
            capacity_litres: '5000',
            quantity: 1,
            unit_price: '1500',
            description: '',
          },
        ],
      },
      {
        category_name: 'Solar Panel Cleaning',
        kind: 'solar',
        pricing_mode: 'itemized',
        category_subtotal: '',
        items: [
          {
            uid: 'sol1',
            item_name: 'Mono PERC Panels',
            capacity_litres: '',
            quantity: 20,
            unit_price: '50',
            description: '20 panels',
          },
        ],
      },
      {
        category_name: 'Plumbing Services',
        kind: 'plumbing',
        pricing_mode: 'itemized',
        category_subtotal: '',
        items: [
          {
            uid: 'p1',
            item_name: 'Float Valve Replacement',
            capacity_litres: '',
            quantity: 2,
            unit_price: '250',
            description: '',
          },
        ],
      },
    ];

    expect(getItemLineTotal(groups[0].items[0], 'itemized')).toBe(1800);
    expect(getGroupSubtotal(groups[0])).toBe(3300);

    const fixedCalc = computeCartTotals(groups, 'fixed', '300');
    expect(fixedCalc.error).toBeNull();
    expect(fixedCalc.subtotal).toBe(4800);
    expect(fixedCalc.discountAmount).toBe(300);
    expect(fixedCalc.grandTotal).toBe(4500);

    const pctCalc = computeCartTotals(groups, 'percentage', '15');
    expect(pctCalc.error).toBeNull();
    expect(pctCalc.discountAmount).toBe(720);
    expect(pctCalc.grandTotal).toBe(4080);
  });

  it('prevents double counting when category pricing mode is category_total (combined price)', () => {
    const groups: DraftCartGroup[] = [
      {
        category_name: 'Underground Sump Cleaning',
        kind: 'sump',
        pricing_mode: 'category_total',
        category_subtotal: '2200',
        items: [
          {
            uid: 's1',
            item_name: 'Sump 1',
            capacity_litres: '10000',
            quantity: 1,
            unit_price: '1500', // must be ignored in combined mode
            description: '',
          },
          {
            uid: 's2',
            item_name: 'Sump 2',
            capacity_litres: '5000',
            quantity: 1,
            unit_price: '1000', // must be ignored in combined mode
            description: '',
          },
        ],
      },
    ];

    expect(getItemLineTotal(groups[0].items[0], 'category_total')).toBe(0);
    expect(getGroupSubtotal(groups[0])).toBe(2200);

    const payload = toCartPayloadGroups(groups);
    expect(payload[0].category_subtotal).toBe(2200);
    expect(payload[0].items[0].unit_price).toBe(0);
  });

  it('validates fixed discounts exceeding subtotal and percentage discounts exceeding 100%', () => {
    const groups: DraftCartGroup[] = [
      {
        category_name: 'Overhead Tank Cleaning',
        kind: 'tank',
        pricing_mode: 'itemized',
        category_subtotal: '',
        items: [{ ...newCartItem('tank', 0), unit_price: '1000', quantity: 1 }],
      },
    ];

    const badFixed = computeCartTotals(groups, 'fixed', '1200');
    expect(badFixed.error).toBe('Fixed discount cannot exceed cart subtotal.');

    const badPct = computeCartTotals(groups, 'percentage', '110');
    expect(badPct.error).toBe('Percentage discount cannot exceed 100%.');
  });

  it('hydrates existing service category groups accurately for edit mode', () => {
    const existing: ServiceCategoryGroup[] = [
      {
        id: 'g1',
        service_id: 'srv1',
        category_name: 'Overhead Tank Cleaning',
        pricing_mode: 'itemized',
        category_subtotal: 1200,
        display_order: 0,
        items: [
          {
            id: 'i1',
            service_id: 'srv1',
            category_group_id: 'g1',
            category_name: 'Overhead Tank Cleaning',
            item_name: 'Terrace Tank',
            capacity_litres: 2000,
            quantity: 1,
            unit_price: 1200,
            line_total: 1200,
            description: 'Standard wash',
            display_order: 0,
          },
        ],
      },
    ];

    const hydrated = groupsFromExisting(existing, [
      { name: 'Overhead Tank Cleaning', active: true, kind: 'tank' },
    ]);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].kind).toBe('tank');
    expect(hydrated[0].items[0].capacity_litres).toBe('2000');
    expect(hydrated[0].items[0].unit_price).toBe('1200');
  });
});
