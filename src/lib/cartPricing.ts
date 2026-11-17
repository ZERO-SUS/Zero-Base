import type {
  BusinessSettings,
  CategoryKind,
  DiscountType,
  PricingMode,
  ServiceCategoryConfig,
  ServiceCategoryGroup,
} from '../types/domain';

export interface DraftCartItem {
  uid: string;
  item_name: string;
  capacity_litres: string; // string for crisp controlled input
  quantity: number;
  unit_price: string; // string for crisp controlled input
  description: string;
}

export interface DraftCartGroup {
  category_name: string;
  kind: CategoryKind;
  pricing_mode: PricingMode;
  category_subtotal: string; // used when pricing_mode === 'category_total'
  items: DraftCartItem[];
}

export interface CartComputation {
  groupTotals: Record<string, number>;
  subtotal: number;
  discountAmount: number;
  grandTotal: number;
  error: string | null;
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

export function resolveServiceCategories(settings: BusinessSettings): ServiceCategoryConfig[] {
  if (settings.service_categories && settings.service_categories.length > 0) {
    return settings.service_categories.map((cat) => ({
      name: cat.name,
      active: cat.active !== false,
      kind: cat.kind || inferCategoryKind(cat.name),
    }));
  }
  return (settings.service_types || []).map((name) => ({
    name,
    active: true,
    kind: inferCategoryKind(name),
  }));
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function defaultItemLabel(kind: CategoryKind, index: number): string {
  switch (kind) {
    case 'tank':
      return `Tank ${index + 1}`;
    case 'sump':
      return `Sump ${index + 1}`;
    case 'solar':
      return index === 0 ? 'Solar Panels' : `Solar Array ${index + 1}`;
    case 'plumbing':
      return index === 0 ? 'Plumbing Work' : `Plumbing Task ${index + 1}`;
    default:
      return `Item ${index + 1}`;
  }
}

export function newCartItem(kind: CategoryKind, existingCount: number): DraftCartItem {
  return {
    uid: uid(),
    item_name: defaultItemLabel(kind, existingCount),
    capacity_litres: kind === 'tank' || kind === 'sump' ? '1000' : '',
    quantity: 1,
    unit_price: '',
    description: '',
  };
}

export function parsePositiveOrZero(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return round2(n);
}

export function getItemLineTotal(item: DraftCartItem, pricingMode: PricingMode): number {
  if (pricingMode === 'category_total') return 0;
  return round2(Math.max(1, item.quantity) * parsePositiveOrZero(item.unit_price));
}

export function getGroupSubtotal(group: DraftCartGroup): number {
  if (group.pricing_mode === 'category_total') {
    return parsePositiveOrZero(group.category_subtotal);
  }
  return round2(
    group.items.reduce((acc, item) => acc + getItemLineTotal(item, 'itemized'), 0),
  );
}

export function computeCartTotals(
  groups: DraftCartGroup[],
  discountType: DiscountType,
  discountRaw: string,
): CartComputation {
  const groupTotals: Record<string, number> = {};
  let subtotal = 0;

  for (const g of groups) {
    const gt = getGroupSubtotal(g);
    groupTotals[g.category_name] = gt;
    subtotal = round2(subtotal + gt);
  }

  const parsedDiscount = Number(discountRaw || 0);
  if (!Number.isFinite(parsedDiscount) || parsedDiscount < 0) {
    return {
      groupTotals,
      subtotal,
      discountAmount: 0,
      grandTotal: subtotal,
      error: 'Discount cannot be negative.',
    };
  }

  let discountAmount = 0;
  if (discountType === 'percentage') {
    if (parsedDiscount > 100) {
      return {
        groupTotals,
        subtotal,
        discountAmount: 0,
        grandTotal: subtotal,
        error: 'Percentage discount cannot exceed 100%.',
      };
    }
    discountAmount = round2(subtotal * (parsedDiscount / 100));
  } else {
    if (parsedDiscount > subtotal) {
      return {
        groupTotals,
        subtotal,
        discountAmount: subtotal,
        grandTotal: 0,
        error: 'Fixed discount cannot exceed cart subtotal.',
      };
    }
    discountAmount = round2(parsedDiscount);
  }

  const grandTotal = round2(Math.max(0, subtotal - discountAmount));
  return {
    groupTotals,
    subtotal,
    discountAmount,
    grandTotal,
    error: null,
  };
}

export function toCartPayloadGroups(groups: DraftCartGroup[]) {
  return groups.map((g) => ({
    category_name: g.category_name,
    pricing_mode: g.pricing_mode,
    category_subtotal: getGroupSubtotal(g),
    items: g.items.map((item) => {
      const cap = item.capacity_litres.trim();
      return {
        item_name: item.item_name.trim() || null,
        capacity_litres: cap ? Math.max(0, Math.round(Number(cap))) : null,
        quantity: Math.max(1, Math.round(item.quantity)),
        unit_price: g.pricing_mode === 'itemized' ? parsePositiveOrZero(item.unit_price) : 0,
        description: item.description.trim() || null,
      };
    }),
  }));
}

export function groupsFromExisting(
  existingGroups: ServiceCategoryGroup[],
  categoriesConfig: ServiceCategoryConfig[],
): DraftCartGroup[] {
  const kindLookup = new Map<string, CategoryKind>();
  for (const cat of categoriesConfig) {
    kindLookup.set(cat.name.toLowerCase(), cat.kind || inferCategoryKind(cat.name));
  }

  return existingGroups.map((g) => {
    const kind = kindLookup.get(g.category_name.toLowerCase()) || inferCategoryKind(g.category_name);
    return {
      category_name: g.category_name,
      kind,
      pricing_mode: g.pricing_mode,
      category_subtotal: String(g.category_subtotal ?? 0),
      items: (g.items || []).map((item) => ({
        uid: item.id || uid(),
        item_name: item.item_name || '',
        capacity_litres: item.capacity_litres != null ? String(item.capacity_litres) : '',
        quantity: Math.max(1, item.quantity || 1),
        unit_price: item.unit_price ? String(item.unit_price) : '',
        description: item.description || '',
      })),
    };
  });
}
