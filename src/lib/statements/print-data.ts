import { db } from "@/lib/db";
import { getBranding } from "@/actions/branding";
import { can } from "@/lib/authz/resolve";
import { moduleAccessFor } from "@/lib/modules-access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { mayAccess } from "@/lib/authz/access";
import { getOrganisation } from "@/lib/organisation";
import { partyStatement } from "@/lib/receivables/statement";
import type { StatementSide } from "./paths";

/**
 * A statement of account as the customer (or vendor) gets it (owner, 31 Oct 2026 — "customers ask for this"): our
 * letterhead and theirs, the period, an account summary — what was brought forward, invoiced (billed), received
 * (paid) and what is due at the end — and every line with its running balance; or only what is still open.
 * Worked out by `partyStatement` (src/lib/receivables/statement.ts), so it agrees with the Statement tab and the
 * balance summaries. Who may see it is checked here, by name, as the print page may be opened by the server's own
 * browser on somebody's behalf (src/lib/statements/render.ts).
 */

export type StatementShow = "all" | "outstanding";

export type StatementPrint = {
  side: StatementSide;
  companyId: string;
  party: { name: string; lines: string[]; gstin: string | null };
  ours: { name: string; lines: string[]; gstin: string | null; cin: string | null; phone: string | null; email: string | null; logo: string | null };
  /** YYYY-MM-DD, or null for "from the beginning". */
  from: string | null;
  to: string | null;
  show: StatementShow;
  /** In rupees, the party's way round: positive is what they owe us (AR) or we owe them (AP). */
  summary: { opening: number; raised: number; settled: number; closing: number };
  lines: { date: string; kind: string; reference: string; description: string; raised: number; settled: number; balance: number }[];
  open: { docNumber: string; issueDate: string | null; dueDate: string | null; daysOverdue: number; balance: number }[];
  /** Today, whatever the period: paid or credited on account and not yet set against an invoice (bill), and opening balances and journals — what takes the open invoices to the balance due. */
  onAccount: number;
  journals: number;
  balanceToday: number;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Whether this person may see this party's statement from this side — asked of them by name, with no session needed. */
export async function maySeeStatement(viewerId: string, side: StatementSide, companyId: string): Promise<boolean> {
  if ((await moduleAccessFor(viewerId, side === "AR" ? "receivables" : "payables")) !== "available") return false;
  if (!(await can(viewerId, "payments.view"))) return false;
  // Its own right since 2 Nov 2026 (owner), on top of seeing the money.
  if (!(await can(viewerId, "statements.view"))) return false;
  if (side === "AP") return mayAccess(viewerId, "vendors", "view", companyId);
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  return company !== null && (await canSeeCompany(viewerId, company));
}

export async function statementForPrint(
  viewerId: string,
  side: StatementSide,
  companyId: string,
  opts: { from?: string | null; to?: string | null; show?: string | null } = {},
): Promise<StatementPrint | null> {
  if (!(await maySeeStatement(viewerId, side, companyId))) return null;
  const from = opts.from && DAY.test(opts.from) ? opts.from : null;
  const to = opts.to && DAY.test(opts.to) ? opts.to : null;
  const show: StatementShow = opts.show === "outstanding" ? "outstanding" : "all";

  const [company, org, branding, statement] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: { name: true, locations: { orderBy: [{ isBilling: "desc" }, { isPrimary: "desc" }], take: 1, select: { address: true, city: true, state: true, pincode: true, country: true, gstNumber: true } } },
    }),
    getOrganisation(),
    getBranding(),
    partyStatement(side, companyId, { from: from ?? undefined, to: to ?? undefined }),
  ]);
  if (!company) return null;
  const place = company.locations[0];

  // The party's way round: a customer's account is debited by what they owe; a vendor's, as their books keep it, credited.
  const owed = (l: { debit: number; credit: number }) => (side === "AR" ? { raised: l.debit, settled: l.credit } : { raised: l.credit, settled: l.debit });
  const opening = statement.lines.filter((l) => l.kind === "OPENING").reduce((t, l) => t + owed(l).raised - owed(l).settled, 0);
  const moved = statement.lines.filter((l) => l.kind !== "OPENING");
  const raised = moved.reduce((t, l) => t + owed(l).raised, 0);
  const settled = moved.reduce((t, l) => t + owed(l).settled, 0);
  const sign = side === "AR" ? 1 : -1;

  return {
    side,
    companyId,
    party: {
      name: company.name,
      lines: [place?.address, [place?.city, place?.pincode].filter(Boolean).join(" "), place?.state, place?.country].filter((l): l is string => Boolean(l && l.trim())),
      gstin: place?.gstNumber ?? null,
    },
    ours: {
      name: org.legalName || branding.appName,
      lines: [org.addressLine1, org.addressLine2, [org.city, org.state, org.pincode].filter(Boolean).join(" "), org.country].filter((l): l is string => Boolean(l && l.trim())),
      gstin: org.gstin,
      cin: org.cin,
      phone: org.phone,
      email: org.email,
      logo: branding.logoDataUrl ?? null,
    },
    from,
    to,
    show,
    summary: { opening: round2(opening), raised: round2(raised), settled: round2(settled), closing: round2(opening + raised - settled) },
    lines: statement.lines.map((l) => ({ date: day(l.date)!, kind: l.kind, reference: l.reference, description: l.description, ...owed(l), balance: round2(sign * l.balance) })),
    onAccount: round2(statement.unappliedPayments + statement.unappliedCredits),
    journals: round2(statement.journals),
    balanceToday: round2(statement.balance),
    open: statement.openDocuments.map((d) => ({ docNumber: d.docNumber, issueDate: day(d.issueDate), dueDate: day(d.dueDate), daysOverdue: d.daysOverdue, balance: d.rupees })),
  };
}
