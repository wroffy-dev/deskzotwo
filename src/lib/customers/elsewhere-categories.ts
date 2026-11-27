import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { ELSEWHERE_CATEGORIES, type ElsewhereCategoryOption } from "@/lib/customers/elsewhere-rules";

/**
 * Installed elsewhere's categories, the workspace's own list (owner, 2 Nov 2026: "this category list should be editable
 * so more can be added or deleted" — Settings › Lists; src/actions/elsewhere-category.ts). An entry holds a category's
 * key. A workspace not migrated yet reads the nine Deskzo came with, under the keys the table seeds them with.
 */
export async function elsewhereCategoryOptions(): Promise<ElsewhereCategoryOption[]> {
  try {
    return await db.elsewhereCategoryOption.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true } });
  } catch (err) {
    if (notMigratedYet(err)) return ELSEWHERE_CATEGORIES.map((c) => ({ key: c.key, name: c.label.split(" — ")[0]! }));
    throw err;
  }
}

/** Whether a key is one of the list's — what a saved entry may hold. */
export async function isElsewhereCategory(key: string): Promise<boolean> {
  return (await elsewhereCategoryOptions()).some((c) => c.key === key);
}
