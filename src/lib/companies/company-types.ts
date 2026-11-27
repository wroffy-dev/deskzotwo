import { db } from "@/lib/db";

/**
 * The workspace's company types (owner, 27 Oct 2026 — Settings › Lists; src/actions/company-type.ts). A company holds
 * a type's key (Company.companyType): the eight Deskzo came with keep the keys they always had (PRIVATE_LIMITED…),
 * so the public API and saved filters read the same; one the workspace adds gets a key made from its name.
 */

export type CompanyTypeOption = { key: string; name: string };

/** Every type, in the workspace's order. */
export async function companyTypeOptions(): Promise<CompanyTypeOption[]> {
  return db.companyTypeOption.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true } });
}

/** What a key reads as: the type's name, or — a key whose type was since deleted — the key made readable. */
export function companyTypeName(key: string | null | undefined, options: CompanyTypeOption[]): string | null {
  if (!key) return null;
  return options.find((o) => o.key === key)?.name ?? key.replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/** A new type's key: its name in capitals, words joined by underscores — "Trust" → TRUST, "Pvt. Ltd." → PVT_LTD. */
export function keyForName(name: string): string {
  return name
    .normalize("NFKD")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** Letters and digits only, lower case: how two spellings of one type are compared. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * What people type for the eight built-in types — the old CRM's slugs (private-limited, sole-proprietorship) and the
 * free text its lead form let through ("Pvt Ltd", "PRIVATE LIMITED.", "Privet Limited"), squashed.
 */
const ALIASES: Record<string, string> = {
  privatelimited: "PRIVATE_LIMITED",
  privetlimited: "PRIVATE_LIMITED",
  pvtltd: "PRIVATE_LIMITED",
  pvtlimited: "PRIVATE_LIMITED",
  privateltd: "PRIVATE_LIMITED",
  limited: "PUBLIC_LIMITED",
  ltd: "PUBLIC_LIMITED",
  publiclimited: "PUBLIC_LIMITED",
  publicltd: "PUBLIC_LIMITED",
  proprietorship: "PROPRIETORSHIP",
  soleproprietorship: "PROPRIETORSHIP",
  proprietor: "PROPRIETORSHIP",
  partnership: "PARTNERSHIP",
  llp: "LLP",
  ngo: "NGO",
  trust: "NGO",
  government: "GOVERNMENT",
  govt: "GOVERNMENT",
  other: "OTHER",
};

/**
 * The type a piece of imported text names, or null: a type's own name or key, then the spellings above. Text that
 * names no type (an industry typed into the type box — "Construction", "Law firm") stays out rather than become one.
 */
export function companyTypeFromText(text: string | null | undefined, options: CompanyTypeOption[]): string | null {
  const seen = squash(text ?? "");
  if (!seen) return null;
  const own = options.find((o) => squash(o.name) === seen || squash(o.key) === seen);
  if (own) return own.key;
  const alias = ALIASES[seen];
  return alias && options.some((o) => o.key === alias) ? alias : null;
}
