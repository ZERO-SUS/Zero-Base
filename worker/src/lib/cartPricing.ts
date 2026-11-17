import { z } from 'zod';

export type CategoryKind = 'tank' | 'sump' | 'solar' | 'plumbing' | 'other';
export type PricingMode = 'itemized' | 'category_total';
export type DiscountType = 'fixed' | 'percentage';

export const cartItemInputSchema = z.object({
  item_name: z.string().trim().max(150).optional().nullable(),
  capacity_litres: z
    .number()
    .int('Capacity must be a whole number of litres')
    .nonnegative('Capacity cannot be negative')
    .max(10_000_000)
    .optional()
    .nullable(),
  quantity: z.number().int().min(1, 'Quantity must be at least 1').max(10_000),
  unit_price: z.number().nonnegative('Unit price cannot be negative').max(10_000_000).default(0),
  description: z.string().trim().max(500).optional().nullable(),
});

export const cartCategoryGroupInputSchema = z.object({
  category_name: z.string().trim().min(1, 'Category name is required').max(120),
  pricing_mode: z.enum(['itemized', 'category_total']).default('itemized'),
  category_subtotal: z.number().nonnegative('Category subtotal cannot be negative').max(100_000_000).default(0),
  items: z.array(cartItemInputSchema).min(1, 'Each category must have at least one item'),
});

export type CartItemInput = z.infer<typeof cartItemInputSchema>;
export type CartCategoryGroupInput = z.infer<typeof cartCategoryGroupInputSchema>;

export interface ComputedCartGroup {
  category_name: string;
  pricing_mode: PricingMode;
  category_subtotal: number;
  items: Array<{
    item_name: string | null;
    capacity_litres: number | null;
    quantity: number;
    unit_price: number;
    line_total: number;
    description: string | null;
  }>;
}

export interface ComputedCartTotals {
  groups: ComputedCartGroup[];
  subtotal: number;
  discount_type: DiscountType;
  discount_value: number;
  discount_amount: number;
  grand_total: number;
  category_names: string[];
  primary_service_type: string;
  tank_summary: string;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function inferCategoryKind(name: string): CategoryKind {
  const lower = name.toLowerCase();
  if (lower.includes('sump') && !lower.includes('overhead')) return 'sump';
  if (lower.includes('tank') || lower.includes('sump')) return 'tank';
  if (lower.includes('solar')) return 'solar';
  if (lower.includes('plumb') || lower.includes('pipe')) return 'plumbing';
  return 'other';
}

export function computeAndValidateCart(params: {
  groups: CartCategoryGroupInput[];
  discount_type: DiscountType;
  discount_value: number;
}): { ok: true; data: ComputedCartTotals } | { ok: false; error: string } {
  if (!params.groups || params.groups.length === 0) {
    return { ok: false, error: 'Cart must contain at least one service category and item.' };
  }

  // Ensure each category appears at most once in the final bill
  const seenCategories = new Set<string>();
  const computedGroups: ComputedCartGroup[] = [];
  let subtotal = 0;

  for (const grp of params.groups) {
    const cleanName = grp.category_name.trim();
    const key = cleanName.toLowerCase();
    if (seenCategories.has(key)) {
      return {
        ok: false,
        error: `Duplicate category "${cleanName}". Combine items inside the same category section.`,
      };
    }
    seenCategories.add(key);

    let itemsSum = 0;
    const computedItems = grp.items.map((item) => {
      const qty = item.quantity;
      const unitPrice = grp.pricing_mode === 'itemized' ? round2(item.unit_price) : 0;
      const lineTotal = grp.pricing_mode === 'itemized' ? round2(qty * unitPrice) : 0;
      itemsSum = round2(itemsSum + lineTotal);

      return {
        item_name: item.item_name?.trim() || null,
        capacity_litres: item.capacity_litres ?? null,
        quantity: qty,
        unit_price: unitPrice,
        line_total: lineTotal,
        description: item.description?.trim() || null,
      };
    });

    const catSubtotal =
      grp.pricing_mode === 'category_total' ? round2(grp.category_subtotal) : itemsSum;

    if (catSubtotal < 0) {
      return { ok: false, error: `Subtotal for "${cleanName}" cannot be negative.` };
    }

    subtotal = round2(subtotal + catSubtotal);
    computedGroups.push({
      category_name: cleanName,
      pricing_mode: grp.pricing_mode,
      category_subtotal: catSubtotal,
      items: computedItems,
    });
  }

  let discountAmount = 0;
  const discountVal = round2(params.discount_value);
  if (discountVal < 0) {
    return { ok: false, error: 'Discount cannot be negative.' };
  }

  if (params.discount_type === 'percentage') {
    if (discountVal > 100) {
      return { ok: false, error: 'Percentage discount cannot exceed 100%.' };
    }
    discountAmount = round2(subtotal * (discountVal / 100));
  } else {
    if (discountVal > subtotal) {
      return { ok: false, error: 'Discount cannot exceed the cart subtotal.' };
    }
    discountAmount = discountVal;
  }

  const grandTotal = round2(Math.max(0, subtotal - discountAmount));
  const categoryNames = computedGroups.map((g) => g.category_name);
  const primaryServiceType =
    categoryNames.length === 1
      ? categoryNames[0]
      : `${categoryNames[0]} (+${categoryNames.length - 1} more)`;

  const summaryParts: string[] = [];
  for (const g of computedGroups) {
    for (const i of g.items) {
      const label = i.item_name || g.category_name;
      const cap = i.capacity_litres ? ` ${i.capacity_litres}L` : '';
      summaryParts.push(`${label}${cap} ×${i.quantity}`);
    }
  }

  return {
    ok: true,
    data: {
      groups: computedGroups,
      subtotal,
      discount_type: params.discount_type,
      discount_value: discountVal,
      discount_amount: discountAmount,
      grand_total: grandTotal,
      category_names: categoryNames,
      primary_service_type: primaryServiceType,
      tank_summary: summaryParts.join(', ').slice(0, 150),
    },
  };
}
