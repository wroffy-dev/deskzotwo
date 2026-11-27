import type { Prisma } from "@prisma/client";

/**
 * The products a record is about, for a workflow's rules (owner, 1 Nov 2026: "product category and brand
 * and family also selection for rules"). By name, as the item master shows them — an item's category is
 * stored by name already — so a rule reads "Brand is Microsoft" and a message can say it too.
 *
 * A single order carries its one product's (`itemCategory`, `brand`, `family`); a document or a lead,
 * every one across its lines or requirements (`categories`, `brands`, `families`), for "contains".
 */

export const PRODUCT_SELECT = {
  sku: true,
  category: true,
  brand: { select: { name: true } },
  productFamily: { select: { name: true } },
} as const satisfies Prisma.ItemSelect;

export type ProductRow = { sku: string; category: string | null; brand: { name: string } | null; productFamily: { name: string } | null };

/** One product's — for an order. */
export function productOf(item: ProductRow) {
  return { itemSku: item.sku, itemCategory: item.category, brand: item.brand?.name ?? null, family: item.productFamily?.name ?? null };
}

const distinct = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => !!v && !!v.trim()))].sort((a, b) => a.localeCompare(b));

/** Every product's, without repeats — for a document's lines or a lead's requirements. */
export function productsOf(items: (ProductRow | null)[]) {
  const present = items.filter((i): i is ProductRow => !!i);
  return {
    categories: distinct(present.map((i) => i.category)),
    brands: distinct(present.map((i) => i.brand?.name)),
    families: distinct(present.map((i) => i.productFamily?.name)),
  };
}

/** Which data fields pick from which list in the rule editor (src/components/automate/builder/fields.tsx). */
export type ProductChoiceKind = "category" | "brand" | "family";

export function productChoiceKind(ref: string): ProductChoiceKind | null {
  if (/\.(itemCategory|categories)$/.test(ref)) return "category";
  if (/\.(brand|brands)$/.test(ref)) return "brand";
  if (/\.(family|families)$/.test(ref)) return "family";
  return null;
}

/** Whether the field holds a list — so a rule on it starts as "contains". */
export const isProductList = (ref: string) => /\.(categories|brands|families)$/.test(ref);
