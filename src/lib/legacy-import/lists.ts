/**
 * The master lists' names and row shape (src/lib/legacy-import/master.ts), apart from the code that builds them so the
 * review screen can read them without reaching the database.
 */

export type MatchStatus = "MATCHED" | "SUGGESTED" | "CONFIRMED" | "REJECTED" | "ZOHO_ONLY" | "OLD_ONLY";
export type ListKey = "customers" | "vendors" | "products" | "contacts";
export const LISTS: { key: ListKey; label: string; zoho: string; old: string }[] = [
  { key: "customers", label: "Customers", zoho: "Zoho customers", old: "WroffyCRM customers" },
  { key: "vendors", label: "Vendors", zoho: "Zoho vendors", old: "WroffyCRM vendors" },
  { key: "products", label: "Products", zoho: "Zoho items", old: "WroffyCRM products" },
  { key: "contacts", label: "Contacts", zoho: "Zoho contact persons", old: "WroffyCRM contacts" },
];

export type MatchRow = { id: string; list: string; zohoId: string | null; oldId: string | null; zohoLabel: string | null; oldLabel: string | null; status: string; reason: string; flagged: boolean; company: string | null };
