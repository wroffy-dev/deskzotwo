import { WORLD_COUNTRIES } from "@/lib/geo/world-countries";

/**
 * A workspace's country pack (owner, 30 Oct 2026): the money, tax and people rules that differ by
 * country, picked by `Tenant.country`, which is set once at sign-up. Everything else in Deskzo is the
 * same everywhere.
 *
 * India's pack is what Deskzo always did: rupees, GST with CGST/SGST/IGST by place of supply, TDS,
 * PAN/Aadhaar/UAN/ESIC and Indian states. Every other country gets its own currency and one tax per
 * line with no state split, no GST registration and no withholding — the UAE's labelled VAT at 5%.
 * The UAE's TRN, tax invoice and VAT 201 return are its own pack's next step (plan doc
 * https://claude.ai/artifact/6VwBxfZ6SEHjJURvZvhutR, Phase 1).
 *
 * Whole India-only modules (accounting, payroll, revenue & close) and features (e-invoice, e-way
 * bill, HSN checks) are switched off by `countries` and `COUNTRY_FEATURES` in src/lib/modules.ts.
 */
export type CountryPack = {
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** As addresses store it: "India", "United Arab Emirates". */
  countryName: string;
  /** India's rules: GST registration and split, TDS, Indian ID numbers and states. */
  india: boolean;
  /** What the books are kept and amounts are shown in. One of `CURRENCIES` (src/lib/currency.ts). */
  currency: string;
  tax: {
    /** On a document line and its totals: "GST 18%", "VAT 5%". */
    name: string;
    /** The rates a line can pick, the default first after none. */
    rates: readonly number[];
    /** What a new item or line starts with. */
    defaultRate: number;
  };
  /**
   * The month the books' financial year starts, 0–11 (owner, 14 Nov 2026): April in India; January in the UAE
   * ("January 1 to December 31 is the financial year of uae") and wherever no other is set.
   */
  fyStartMonth: number;
};

/** Base currencies a document can be written in — kept in step with `CURRENCIES` (src/lib/currency.ts). */
const KNOWN_CURRENCIES = new Set(["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "JPY", "CHF", "SAR", "MYR", "LKR", "BDT"]);

const TAX_BY_COUNTRY: Record<string, CountryPack["tax"]> = {
  // GST's slabs (src/lib/side-rail.ts GST_RATES): 0, 5, 18 and 40 since 22 Sep 2025, 12 and 28 kept.
  IN: { name: "GST", rates: [0, 5, 12, 18, 28, 40], defaultRate: 18 },
  // Standard 5%; zero-rated and exempt both show as 0 until the UAE pack tells them apart.
  AE: { name: "VAT", rates: [0, 5], defaultRate: 5 },
  SA: { name: "VAT", rates: [0, 15], defaultRate: 15 },
};

/**
 * The rates an item may carry (owner, 23 Nov 2026: "it should be a list of gst … the default rate should show here along
 * with option to … select other, just like zoho has"): the country's own, and in India also GST's special rates — 0.1%
 * merchant exports, 0.25% rough diamonds, 1% and 1.5% and 3% gold and stones, 6% and 7.5% notified services
 * (src/lib/gst-engine.ts GST_SLAB_RATES, the one list the law has). Empty where the country has no list: any rate.
 */
export function itemTaxRates(pack: CountryPack): { main: number[]; special: number[] } {
  if (pack.india) return { main: [...pack.tax.rates], special: [0.1, 0.25, 1, 1.5, 3, 6, 7.5] };
  return { main: pack.tax.rates.length > 1 ? [...pack.tax.rates] : [], special: [] };
}

/** Whether an item may carry this rate in this country: always, where the country has no list. */
export function isItemTaxRate(pack: CountryPack, rate: number): boolean {
  const { main, special } = itemTaxRates(pack);
  if (!main.length) return true;
  return [...main, ...special].some((r) => Math.abs(r - rate) < 0.0001);
}

/** Where the financial year doesn't start in January. */
const FY_START_BY_COUNTRY: Record<string, number> = { IN: 3 };

const packs = new Map<string, CountryPack>();

export function countryPack(country: string | null | undefined): CountryPack {
  const code = (country ?? "").trim().toUpperCase() || "IN";
  const cached = packs.get(code);
  if (cached) return cached;
  const entry = WORLD_COUNTRIES.find((c) => c.code === code);
  const pack: CountryPack = {
    country: code,
    countryName: entry?.name ?? code,
    india: code === "IN",
    currency: entry?.currency && KNOWN_CURRENCIES.has(entry.currency) ? entry.currency : "USD",
    tax: TAX_BY_COUNTRY[code] ?? { name: "Tax", rates: [0], defaultRate: 0 },
    fyStartMonth: FY_START_BY_COUNTRY[code] ?? 0,
  };
  packs.set(code, pack);
  return pack;
}

/*
 * Which workspace's pack, without an await — `formatCurrency` and the forms are synchronous.
 *
 * On the server a resolver registered by src/lib/tenancy/workspace-country.ts answers from the
 * request (or `runAsTenant`); in the browser `<WorkspaceCountry>` (src/components/layout) sets the
 * signed-in workspace's before anything renders. Both live on globalThis: the server's app bundle and
 * its client-component bundle are separate copies of this module.
 */
type Holder = { resolve?: () => string | null; browser?: string; resolveRate?: () => number | null; browserRate?: number | null };
const HOLDER = Symbol.for("deskzo.workspace-country");

function holder(): Holder {
  const g = globalThis as { [key: symbol]: Holder | undefined };
  return (g[HOLDER] ??= {});
}

export function setWorkspaceCountryResolver(resolve: () => string | null): void {
  holder().resolve = resolve;
}

/** The server's answer to which default tax rate the workspace chose (src/lib/tenancy/workspace-country.ts). */
export function setWorkspaceTaxRateResolver(resolve: () => number | null): void {
  holder().resolveRate = resolve;
}

/** The browser's workspace. Never on the server, where one process serves every workspace. */
export function setBrowserWorkspaceCountry(country: string, defaultTaxRate: number | null = null): void {
  if (typeof window === "undefined") return;
  holder().browser = country;
  holder().browserRate = defaultTaxRate;
}

/** The default tax rate this workspace chose (Settings › Taxes, or setup), or null for its country's. */
function workspaceTaxRate(): number | null {
  const h = holder();
  if (typeof window !== "undefined") return h.browserRate ?? null;
  return h.resolveRate?.() ?? null;
}

/** This workspace's country; India where there is none to tell (the public site, a script). */
export function workspaceCountry(): string {
  const h = holder();
  if (typeof window !== "undefined") return h.browser ?? "IN";
  return h.resolve?.() ?? "IN";
}

/**
 * The workspace's pack — with the default tax rate it chose (owner, 23 Nov 2026: "do both... see how zoho books has" —
 * Zoho's Default Tax Preference), when that is one of its country's rates, in place of the country's own.
 */
export function workspacePack(): CountryPack {
  const pack = countryPack(workspaceCountry());
  const chosen = workspaceTaxRate();
  if (chosen == null || chosen === pack.tax.defaultRate || !pack.tax.rates.includes(chosen)) return pack;
  return { ...pack, tax: { ...pack.tax, defaultRate: chosen } };
}

/**
 * What the paper goods travel on is called (owner, 16 Nov 2026: "eway bills in uae?" … "rename for UAE"): a
 * delivery challan is India's word, from GST's Rule 55; everywhere else, the UAE included, it is a delivery note.
 * Read when it's shown, so it's the workspace's — on the server and in the browser alike (`workspaceCountry`).
 * The document type stays DELIVERY_CHALLAN underneath, and its address /sales/challans.
 */
export function challanWords(country: string = workspaceCountry()): { one: string; many: string; One: string; Many: string } {
  const india = countryPack(country).india;
  return india
    ? { one: "delivery challan", many: "delivery challans", One: "Delivery challan", Many: "Delivery challans" }
    : { one: "delivery note", many: "delivery notes", One: "Delivery note", Many: "Delivery notes" };
}

/**
 * Whether an address is in the workspace's own country — a sale there is domestic, anywhere else an
 * export. Blank counts as home, as `isIndia` (src/lib/geo/countries.ts) does for India's.
 */
export function isDomesticAddress(country: string | null | undefined): boolean {
  const name = (country ?? "").trim().toLowerCase();
  return !name || name === workspacePack().countryName.toLowerCase();
}
