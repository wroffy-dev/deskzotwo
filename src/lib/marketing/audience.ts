import type { Prisma, MarketingTopic, MessageChannel } from "@prisma/client";
import { buildWhere, withoutResellerFlag, type WorkbookFilters } from "@/lib/workspace/filters";
import type { Clock } from "@/lib/time/zone";

/**
 * Who a campaign goes to.
 *
 * Two halves, because a marketing audience asks two different questions. *Which companies* is the
 * same question the calling workspace asks, so the company half is a `WorkbookFilters` and runs
 * through the very same `buildWhere` — one DSL, one place it can be wrong, and the reseller
 * exclusion it now applies is inherited for free.
 *
 * *Which people at those companies* is new. A renewal notice goes to whoever signs off the spend,
 * not to all eleven contacts on the account — and mailing all eleven is how a company becomes the
 * one everybody filters.
 */

export type ContactFilters = {
  /** ContactDesignation values. Empty means everybody. */
  designation?: string[];
  /** Only the contact marked primary — the default for anything commercial. */
  primaryOnly?: boolean;
  /**
   * Only addresses with a current verdict of VALID. Protects the sending domain, at the cost of
   * missing people nobody has got round to checking.
   */
  verifiedOnly?: boolean;
  /** Cap on how many contacts at one company may receive the same campaign. */
  maxPerCompany?: number;
  /**
   * By what they've done with our email (owner, 1 Nov 2026): "active" — opened or clicked in the last 90 days;
   * "inactive" — sent three or more in the last 180 days and opened none of them. Absent: everybody.
   */
  engagement?: "active" | "inactive" | null;
};

/** The windows the engagement filter reads. */
export const ENGAGEMENT = { activeDays: 90, inactiveDays: 180, inactiveSends: 3 } as const;

export const DEFAULT_CONTACT_FILTERS: ContactFilters = {
  designation: [],
  primaryOnly: false,
  verifiedOnly: true,
  maxPerCompany: 2,
};

/**
 * The company half.
 *
 * Nothing added on top of `buildWhere` — the reseller exclusion lives in there now, so an audience
 * and a calling list cannot disagree about who may be reached.
 */
export function audienceCompanyWhere(filters: WorkbookFilters, clock: Clock): Prisma.CompanyWhereInput {
  // Never a report's `countingReport`: an audience is mailed, so a reseller's end customers stay out whatever the
  // stored filters say (security audit round three, 14 Nov 2026 — R3-20).
  return buildWhere(withoutResellerFlag(filters), clock);
}

/**
 * The people half.
 *
 * `emailCheckedValue: { equals: db.contact.fields.email }` is the Prisma field-reference trick from
 * src/actions/email-verification.ts:203 — it compares two columns in SQL, so "the verdict belongs to
 * the address it is currently on" is decided in the query rather than by loading every contact.
 */
export function contactWhere(
  filters: ContactFilters,
  channel: MessageChannel,
  emailField: unknown,
): Prisma.ContactWhereInput {
  const and: Prisma.ContactWhereInput[] = [];

  if (channel === "EMAIL") and.push({ email: { not: null } });
  if (channel === "WHATSAPP") and.push({ phone: { not: null } });

  if (filters.designation && filters.designation.length > 0) {
    and.push({ designation: { in: filters.designation as never } });
  }
  if (filters.primaryOnly) and.push({ isPrimary: true });

  if (filters.verifiedOnly && channel === "EMAIL") {
    and.push({
      // Checked and working — a shared inbox or a free mailbox included (owner, 1 Nov 2026: those may be marketed to).
      emailStatus: { in: ["VALID", "RISKY"] },
      emailCheckedValue: { equals: emailField as never },
    });
  }

  // Engagement: opened or clicked lately, or sent several and opened none — a click counts as an open.
  if (filters.engagement && channel === "EMAIL") {
    const now = Date.now();
    const engaged = (days: number) => ({ events: { some: { type: { in: ["OPEN", "CLICK"] as ("OPEN" | "CLICK")[] }, occurredAt: { gte: new Date(now - days * 86_400_000) } } } });
    if (filters.engagement === "active") and.push({ marketingMessages: { some: { messageClass: "MARKETING", ...engaged(ENGAGEMENT.activeDays) } } });
    else {
      const since = new Date(now - ENGAGEMENT.inactiveDays * 86_400_000);
      and.push({ marketingMessages: { some: { messageClass: "MARKETING", sentAt: { gte: since } } } });
      and.push({ marketingMessages: { none: { messageClass: "MARKETING", ...engaged(ENGAGEMENT.inactiveDays) } } });
    }
  }

  return and.length > 0 ? { AND: and } : {};
}

/**
 * Trims each company down to the cap, keeping the primary contact first.
 *
 * Applied after the rows are loaded rather than in SQL, for the same reason `billedMin` is
 * (`isPostFilter`, src/lib/workspace/filters.ts:263): "the first two per company" is not a `where`.
 */
export function capPerCompany<T extends { companyId: string; isPrimary: boolean }>(
  contacts: T[],
  maxPerCompany: number | undefined,
): T[] {
  const cap = maxPerCompany ?? DEFAULT_CONTACT_FILTERS.maxPerCompany ?? 0;
  if (cap <= 0) return contacts;

  const taken = new Map<string, number>();
  // Primary first, so a cap of one always keeps the person who signs things.
  const ordered = [...contacts].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const kept: T[] = [];
  for (const contact of ordered) {
    const soFar = taken.get(contact.companyId) ?? 0;
    if (soFar >= cap) continue;
    taken.set(contact.companyId, soFar + 1);
    kept.push(contact);
  }
  return kept;
}

/** Reads whatever is in the `contactFilters` JSON column, falling back rather than throwing. */
export function parseContactFilters(value: unknown): ContactFilters {
  if (!value || typeof value !== "object") return { ...DEFAULT_CONTACT_FILTERS };
  const raw = value as Record<string, unknown>;
  return {
    designation: Array.isArray(raw.designation) ? (raw.designation as string[]) : [],
    primaryOnly: raw.primaryOnly === true,
    verifiedOnly: raw.verifiedOnly !== false,
    maxPerCompany: typeof raw.maxPerCompany === "number" ? raw.maxPerCompany : DEFAULT_CONTACT_FILTERS.maxPerCompany,
    engagement: raw.engagement === "active" || raw.engagement === "inactive" ? raw.engagement : null,
  };
}

/** Same tolerance for the company half — an old saved filter degrades to a broader list. */
export function parseCompanyFilters(value: unknown): WorkbookFilters {
  // Without `includeResellerManaged` (security audit round three, 14 Nov 2026 — R3-20): it came from the browser and
  // was saved as sent; read or saved through here, an audience never carries it.
  return value && typeof value === "object" && !Array.isArray(value) ? withoutResellerFlag(value as WorkbookFilters) : {};
}

/** The summary line on an audience card, so it reads without opening it. */
export function describeContactFilters(filters: ContactFilters, topic?: MarketingTopic): string {
  const bits: string[] = [];
  if (filters.primaryOnly) bits.push("primary contact only");
  else if (filters.designation && filters.designation.length > 0) {
    bits.push(filters.designation.map((d) => d.toLowerCase().replaceAll("_", " ")).join(", "));
  } else bits.push("any contact");
  if (filters.verifiedOnly) bits.push("verified addresses");
  if (filters.maxPerCompany && filters.maxPerCompany > 0) {
    bits.push(`max ${filters.maxPerCompany} per company`);
  }
  if (topic) bits.push(`opted in to ${topic.toLowerCase().replaceAll("_", " ")}`);
  return bits.join(" · ");
}
