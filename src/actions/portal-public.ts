"use server";

import { writeOffsFor } from "@/lib/receivables/write-off";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { openAssetTicket, portalAssetOf, portalAssetsOf, type PortalAsset } from "@/lib/portal/assets";
import { ticketPath } from "@/lib/record-links";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { getOrganisation } from "@/lib/organisation";
import { notifyUser } from "@/lib/notify";
import { settleInvoice } from "@/lib/receivables";
import { checkCode, deviceTrusted, maskEmail, portalRequiresCode, sendCode } from "@/lib/portal/device";
import { tokenHash, withTokenColumns } from "@/lib/portal/link-token";
import { definitionsFor, portalKeys, valuesOf } from "@/lib/custom-fields/server";
import { fileRef, formatValue, maskedSecret, secretTail, type CustomFieldValues } from "@/lib/custom-fields/rules";
import { revealFieldSecret } from "@/lib/custom-fields/secure";
import { activeGateways, GATEWAY_HOME_CURRENCY, internationalGatewayIds } from "@/lib/collect/gateways";
import {
  REFUSAL_MESSAGE,
  allowedActions,
  companyMayUsePortal,
  linkState,
  visibleSections,
  type Action,
  type Section,
} from "@/lib/portal/access";
import type { ActionResult } from "@/actions/company";
import { completeCustomerTask, portalProjectDocumentAllowed, portalProjectsFor, reviewStage, type PortalProject } from "@/lib/projects/portal";
import { docTypeIn, RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";

/**
 * The customer's own view of their account, served to somebody with no login here.
 *
 * The third module in the app that answers to a stranger holding a token — after the new-joiner
 * intake and the feedback form — and by far the one that returns the most, so the rules those two
 * established are worth restating in the place they matter most:
 *
 *   · **The token is the authentication.** 192 bits of randomness, revocable, and expiring if the
 *     settings say so. There is no password, because there is no account.
 *   · **Every query is scoped by the company the token resolves to**, and that company id comes
 *     from the token alone. Nothing the browser sends is ever allowed to name a company, an order
 *     or an invoice — see `subscriptionOf` below, which is the one place a client-supplied id is
 *     accepted and therefore the one place it is re-checked against the token's company.
 *   · **A bad token is indistinguishable from a revoked, expired, or switched-off one.** Four
 *     different refusals, one sentence, because the customer's next step is the same for all four
 *     and the differences would tell somebody which tokens are real.
 *   · **Nothing here writes to anything the customer does not own.** The only writes are their own
 *     visit counter and a request addressed to us.
 *
 * What it deliberately does *not* return: cost prices, margins, internal notes, who owns the
 * account, or anything about any other company. The selects below are explicit for that reason —
 * a `select` that grows by accident is the way this module would leak.
 */

export type PortalView = {
  companyName: string;
  personName: string;
  /** Null when the organisation has no name recorded — the page then omits the line entirely. */
  ourName: string | null;
  welcome: string | null;
  sections: Section[];
  actions: Action[];
  /** The workspace asks for a code and this browser hasn't given one: the page shows only that (src/lib/portal/device.ts). */
  needsCode: boolean;
  /** Where the code goes, masked — null when the link has no address. */
  codeTo: string | null;
};

type Resolved = {
  loginId: string;
  /** The contact the link was made for, if any — a ticket from the portal names them. */
  contactId: string | null;
  companyId: string;
  companyName: string;
  personName: string;
  personEmail: string | null;
  sections: Set<Section>;
  actions: Set<Action>;
  settings: { welcomeMessage: string | null };
  /** No code asked for, or this browser gave one. */
  verified: boolean;
};

/**
 * Turns a token into a company, or into nothing.
 *
 * Every exported function starts here and none of them take a company id, which is the property
 * that makes the rest of the file safe to read: there is no path to another customer's data
 * because there is no argument that could describe one.
 */
/** The module each section shows — a section whose module is gone is not shown, whatever the settings say. */
const SECTION_MODULES: Record<Section, string | null> = {
  subscriptions: "orders",
  invoices: "sales_documents",
  payments: "payments",
  tickets: "helpdesk",
  assets: "it_assets",
  contacts: null,
  projects: "projects",
};

async function withinPlan(sections: Set<Section>): Promise<Set<Section>> {
  const kept = new Set<Section>();
  for (const section of sections) {
    const key = SECTION_MODULES[section];
    if (!key || (await moduleAvailableForTenant(key))) kept.add(section);
  }
  return kept;
}

/**
 * A link that works, for this browser: confirmed with a code where the workspace asks for one (owner, 29 Oct 2026).
 * Every section and request goes through here, so an action called by hand from a browser that hasn't given the code
 * gets what a bad link gets — only `openPortal` and the code's own two actions look past it (`resolveLink`).
 */
async function resolve(token: string): Promise<Resolved | null> {
  const resolved = await resolveLink(token);
  return resolved?.verified ? resolved : null;
}

/** The link alone: whether it works at all, and whether this browser is confirmed for it. */
async function resolveLink(token: string): Promise<Resolved | null> {
  if (!token || token.length < 20) return null;
  if (!(await moduleAvailableForTenant("customer_portal"))) return null;

  const select = {
    id: true,
    expiresAt: true,
    revokedAt: true,
    personName: true,
    personEmail: true,
    contactId: true,
    company: {
      select: {
        id: true,
        name: true,
        portalEnabled: true,
        relationshipType: true,
        managedByResellerId: true,
      },
    },
  } as const;
  // Security audit round two, 13 Nov 2026 (O6): found by the token's hash. The plain token is asked only where the
  // hash finds nothing — a link written in clear by a release older than its workspace's migration — or where this
  // workspace has no hash column yet (src/lib/portal/link-token.ts).
  const byToken = () => db.portalLogin.findUnique({ where: { token }, select });
  const login = await withTokenColumns(async () => (await db.portalLogin.findUnique({ where: { tokenHash: tokenHash(token) }, select })) ?? (await byToken()), byToken);

  const state = linkState(login, new Date());
  if (!state.ok || !login) return null;

  const settings = await db.portalSettings.findUnique({ where: { id: "global" } });
  if (!settings) return null;

  const allowed = companyMayUsePortal(settings, login.company);
  if (!allowed.ok) return null;

  const sections = await withinPlan(visibleSections(settings));
  // Projects: no setting of their own — a project is on the portal when the team put it there (src/lib/projects/portal.ts).
  if (await moduleAvailableForTenant("projects")) sections.add("projects");
  const actions = allowedActions(settings);
  // Renewals and seats are asked for against a subscription; no subscriptions shown, nothing to ask.
  if (!sections.has("subscriptions")) {
    actions.delete("renewal");
    actions.delete("seats");
  }

  return {
    loginId: login.id,
    contactId: login.contactId ?? null,
    companyId: login.company.id,
    companyName: login.company.name,
    personName: login.personName,
    personEmail: login.personEmail,
    sections,
    actions,
    settings: { welcomeMessage: settings.welcomeMessage },
    verified: !(await portalRequiresCode()) || (await deviceTrusted(login.id)),
  };
}

/** What the page needs to draw its frame. Null means the one refusal sentence. */
export async function openPortal(token: string): Promise<PortalView | null> {
  const resolved = await resolveLink(token);
  if (!resolved) return null;

  const org = await getOrganisation();
  // Not confirmed yet: the frame and where the code goes, nothing of the account.
  if (!resolved.verified) {
    return {
      companyName: resolved.companyName,
      personName: resolved.personName.trim().split(/\s+/)[0] ?? resolved.personName,
      ourName: org.tradeName || org.legalName || null,
      welcome: null,
      sections: [],
      actions: [],
      needsCode: true,
      codeTo: resolved.personEmail ? maskEmail(resolved.personEmail) : null,
    };
  }

  // Recorded here rather than on every fetch, so the count is visits rather than page components.
  // Failure is swallowed: a customer should never be shown an error because our counter broke.
  await db.portalLogin
    .update({ where: { id: resolved.loginId }, data: { lastSeenAt: new Date(), visits: { increment: 1 } } })
    .catch(() => {});

  return {
    companyName: resolved.companyName,
    // The first name only, as the feedback form does. The rest of what we hold about them is not
    // this page's business.
    personName: resolved.personName.trim().split(/\s+/)[0] ?? resolved.personName,
    ourName: org.tradeName || org.legalName || null,
    welcome: resolved.settings.welcomeMessage,
    sections: [...resolved.sections],
    actions: [...resolved.actions],
    needsCode: false,
    codeTo: null,
  };
}

/** A code to the link's person, for this browser (src/lib/portal/device.ts). */
export async function sendPortalCode(token: string): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const resolved = await resolveLink(token);
  if (!resolved) return { ok: false, error: REFUSAL_MESSAGE };
  if (resolved.verified) return { ok: true, to: resolved.personEmail ? maskEmail(resolved.personEmail) : "" };
  const org = await getOrganisation();
  return sendCode({ id: resolved.loginId, personName: resolved.personName, personEmail: resolved.personEmail }, org.tradeName || org.legalName || "us");
}

/** The code typed: right, and this browser opens the link for thirty days. */
export async function verifyPortalCode(token: string, code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolved = await resolveLink(token);
  if (!resolved) return { ok: false, error: REFUSAL_MESSAGE };
  if (resolved.verified) return { ok: true };
  return checkCode(resolved.loginId, code);
}

export type PortalSubscription = {
  id: string;
  name: string;
  quantity: number;
  startDate: Date | null;
  endDate: Date | null;
  /** Null when the term has no end, negative once it has passed. */
  daysLeft: number | null;
  status: string;
  /** The fields the workspace shows the customer on it (owner, 29 Oct 2026): text, a masked secret, a file. */
  fields: PortalField[];
};

export type PortalField =
  | { key: string; label: string; kind: "text"; text: string }
  | { key: string; label: string; kind: "secret"; masked: string; canReveal: boolean }
  | { key: string; label: string; kind: "file"; fileId: string; name: string };

/** The orders' statuses the portal shows — what they bought, not what is still being thought about. */
const SHOWN_ORDERS = ["APPROVED", "PROCESSING", "FULFILLED"] as const;
/** The most requests one portal link raises in 24 hours (security audit round two, low). */
const PORTAL_REQUESTS_A_DAY = 20;

/**
 * Each subscription's fields as the customer sees them: only those marked for the portal, never a restricted one. A
 * secret is masked; it can be revealed only where the portal asks for the emailed code, so a forwarded link never
 * shows a key.
 */
async function portalFieldsOf(ids: string[]): Promise<Map<string, PortalField[]>> {
  const out = new Map<string, PortalField[]>();
  const keys = await portalKeys("ORDER");
  if (keys.size === 0 || ids.length === 0) return out;
  const [defs, values, coded] = await Promise.all([definitionsFor("ORDER"), valuesOf("ORDER", ids), portalRequiresCode()]);
  const shown = defs.filter((d) => keys.has(d.key) && !d.archived && !d.restricted && d.type !== "USER");
  for (const id of ids) {
    const v: CustomFieldValues = values.get(id) ?? {};
    const fields: PortalField[] = [];
    for (const d of shown) {
      if (d.type === "SECRET") {
        if (secretTail(v[d.key]) !== null) fields.push({ key: d.key, label: d.label, kind: "secret", masked: maskedSecret(v[d.key]), canReveal: coded });
      } else if (d.type === "FILE") {
        const f = fileRef(v[d.key]);
        if (f) fields.push({ key: d.key, label: d.label, kind: "file", fileId: f.id, name: f.name });
      } else {
        const text = formatValue(d, v[d.key]);
        if (text) fields.push({ key: d.key, label: d.label, kind: "text", text });
      }
    }
    if (fields.length) out.set(id, fields);
  }
  return out;
}

export async function portalSubscriptions(token: string): Promise<PortalSubscription[]> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("subscriptions")) return [];

  const orders = await db.companyProduct.findMany({
    where: {
      companyId: resolved.companyId,
      // What they bought, not what somebody is still thinking about. An order sitting in approval
      // is an internal state, and showing it invites "why does my portal say pending".
      orderStatus: { in: [...SHOWN_ORDERS] },
    },
    select: {
      id: true,
      quantity: true,
      startDate: true,
      endDate: true,
      orderStatus: true,
      item: { select: { name: true } },
    },
    orderBy: [{ endDate: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  const today = new Date();
  const fields = await portalFieldsOf(orders.map((o) => o.id));
  return orders.map((o) => ({
    id: o.id,
    name: o.item.name,
    quantity: o.quantity,
    startDate: o.startDate,
    endDate: o.endDate,
    daysLeft: o.endDate ? Math.ceil((o.endDate.getTime() - today.getTime()) / 86400000) : null,
    status: o.orderStatus,
    fields: fields.get(o.id) ?? [],
  }));
}

/** One of their subscriptions shown in the portal, by id — the one place an id from the browser is taken, so re-checked. */
async function theirSubscription(resolved: Resolved, id: string) {
  if (!resolved.sections.has("subscriptions") || typeof id !== "string" || !id) return null;
  return db.companyProduct.findFirst({ where: { id, companyId: resolved.companyId, orderStatus: { in: [...SHOWN_ORDERS] } }, select: { id: true } });
}

/**
 * A licence key on one of their subscriptions, in the clear (owner, 29 Oct 2026): only where the portal asks for the
 * emailed code — so this browser has given it — only a field marked for the portal, and each reveal recorded.
 */
export async function portalRevealSecret(token: string, subscriptionId: string, key: string): Promise<{ ok: true; data: { secret: string } } | { ok: false; error: string }> {
  const resolved = await resolve(token);
  if (!resolved) return { ok: false, error: REFUSAL_MESSAGE };
  if (!(await portalRequiresCode())) return { ok: false, error: "Ask us for it — we'll send it to you." };
  const sub = await theirSubscription(resolved, subscriptionId);
  if (!sub || typeof key !== "string" || !(await portalKeys("ORDER")).has(key)) return { ok: false, error: "That isn't on your account." };
  const secret = await revealFieldSecret({ entity: "ORDER", recordId: sub.id, fieldKey: key, by: { portalLoginId: resolved.loginId } });
  return secret === null ? { ok: false, error: "That isn't on your account." } : { ok: true, data: { secret } };
}

/** Whether a file is one of theirs to download — a portal field's, on a subscription shown to them. For the download route. */
export async function portalFileAllowed(token: string, fileId: string): Promise<boolean> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("subscriptions") || typeof fileId !== "string" || !fileId) return false;
  const subs = await db.companyProduct.findMany({ where: { companyId: resolved.companyId, orderStatus: { in: [...SHOWN_ORDERS] } }, select: { id: true }, take: 500 });
  const fields = await portalFieldsOf(subs.map((s) => s.id));
  return [...fields.values()].some((list) => list.some((f) => f.kind === "file" && f.fileId === fileId));
}

/** Whether an invoice is one of theirs the portal lists — for its PDF download. */
export async function portalInvoiceAllowed(token: string, invoiceId: string): Promise<boolean> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("invoices") || typeof invoiceId !== "string" || !invoiceId) return false;
  const found = await db.tradeDocument.findFirst({
    where: { id: invoiceId, companyId: resolved.companyId, direction: "SALES", docType: docTypeIn(["INVOICE", "DEBIT_NOTE", "PROFORMA", "CREDIT_NOTE"]), status: { not: "DRAFT" } },
    select: { id: true },
  });
  return !!found;
}

export type PortalInvoice = {
  id: string;
  number: string;
  date: Date;
  dueDate: Date | null;
  total: number;
  status: string;
  /** What's still to pay on a tax invoice; null on anything else. */
  balance: number | null;
  /**
   * Whether it can be paid online from here: a balance and a gateway connected (src/lib/collect) — for an invoice in
   * another currency, one that takes international payments (owner, 30 Oct 2026).
   */
  payable: boolean;
  /** The currency it's written in, which its amounts and Pay button are in. */
  currency: string;
  /** Where a gateway is connected but can't take this invoice's currency: why there's no Pay button. */
  payNote: string | null;
};

export async function portalInvoices(token: string): Promise<PortalInvoice[]> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("invoices")) return [];

  const documents = await db.tradeDocument.findMany({
    where: {
      companyId: resolved.companyId,
      direction: "SALES",
      docType: docTypeIn(["INVOICE", "DEBIT_NOTE", "PROFORMA", "CREDIT_NOTE"]),
      // A draft is our workings. Issuing one is the act that makes it theirs to see.
      status: { not: "DRAFT" },
    },
    select: {
      id: true,
      docNumber: true,
      docType: true,
      issueDate: true,
      dueDate: true,
      total: true,
      status: true,
      currency: true,
      paidBefore: true,
      payments: { select: { amount: true } },
      creditsReceived: { select: { amount: true } },
    },
    orderBy: { issueDate: "desc" },
    take: 100,
  });
  // Paying online (owner, 23 Oct 2026): where the business has connected its gateway.
  const online = (await activeGateways()).length > 0;
  const international = online && (await internationalGatewayIds()).size > 0;
  const sum = (rows: { amount: unknown }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
  // Written off (src/lib/receivables/write-off.ts): nothing left to pay here, as the business's own books say.
  const writtenOff = await writeOffsFor(documents.map((d) => d.id));

  return documents.map((d) => {
    const balance =
      (d.docType === "INVOICE" || d.docType === "DEBIT_NOTE") && d.status !== "CANCELLED" ? settleInvoice(Number(d.total), sum(d.payments), sum(d.creditsReceived) + (writtenOff.get(d.id) ?? 0), Number(d.paidBefore)).balance : null;
    return {
      id: d.id,
      number: d.docNumber,
      date: d.issueDate,
      dueDate: d.dueDate,
      total: Number(d.total),
      status: d.docType === "CREDIT_NOTE" ? "CREDIT_NOTE" : d.status,
      balance,
      payable: online && balance !== null && balance >= 1 && (d.currency === GATEWAY_HOME_CURRENCY || international),
      currency: d.currency,
      payNote:
        online && balance !== null && balance >= 1 && d.currency !== GATEWAY_HOME_CURRENCY && !international
          ? `Paying online in ${d.currency} isn't available. Please pay by bank transfer, or ask us.`
          : null,
    };
  });
}

/**
 * The pay-now link for one of their invoices (owner, 23 Oct 2026 — src/lib/collect/links.ts): the open one for
 * its balance, or a new one. Only their own company's issued invoices, and only where the invoices section is
 * theirs to see.
 */
export async function portalPayLink(token: string, invoiceId: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("invoices")) return { ok: false, error: "This link has stopped working. Ask us for a new one." };
  const invoice = await db.tradeDocument.findFirst({
    where: { id: String(invoiceId ?? ""), companyId: resolved.companyId, direction: "SALES", docType: RECEIVABLE_DOC_TYPE, status: { notIn: ["DRAFT", "CANCELLED"] } },
    select: { id: true },
  });
  if (!invoice) return { ok: false, error: "We couldn't find that invoice." };
  // Loaded only when somebody presses Pay: the public page doesn't carry the ledger and gateways with it.
  const { payLinkFor } = await import("@/lib/collect/links");
  const link = await payLinkFor(invoice.id, null);
  return link.ok ? { ok: true, url: link.link.url } : { ok: false, error: "Paying online isn't available for this invoice just now. Please pay by bank transfer, or ask us." };
}

export type PortalTicket = {
  id: string;
  reference: string;
  title: string;
  status: string;
  priority: string;
  createdAt: Date;
};

export async function portalTickets(token: string): Promise<PortalTicket[]> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("tickets")) return [];

  const tickets = await db.ticket.findMany({
    where: { companyId: resolved.companyId },
    // Deliberately no internal notes, no assignee and no SLA state: a customer reading "breached"
    // about their own ticket is a conversation nobody planned to have.
    select: { id: true, ticketSeq: true, title: true, status: true, priority: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return tickets.map((t) => ({
    id: t.id,
    reference: `#${t.ticketSeq}`,
    title: t.title,
    status: t.status,
    priority: t.priority,
    createdAt: t.createdAt,
  }));
}

export type { PortalAsset, PortalProject };

/** The projects the team put on this customer's portal, each as the team chose to show it. */
export async function portalProjects(token: string): Promise<PortalProject[]> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("projects")) return [];
  return portalProjectsFor(resolved.companyId);
}

/** Approve a stage the team asked about, or ask for changes (owner, 16 Nov 2026). */
export async function portalReviewStage(token: string, milestoneId: string, decision: string, comment: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("projects")) return { ok: false, error: REFUSAL_MESSAGE };
  return reviewStage({ companyId: resolved.companyId, milestoneId, decision, comment, byName: resolved.personName, portalLoginId: resolved.loginId });
}

/** A stage that is theirs to do, marked done, with a note if they leave one (owner, 16 Nov 2026 — phase 3). */
export async function portalCompleteTask(token: string, milestoneId: string, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("projects")) return { ok: false, error: REFUSAL_MESSAGE };
  return completeCustomerTask({ companyId: resolved.companyId, milestoneId, note, byName: resolved.personName, portalLoginId: resolved.loginId });
}

/** Whether a project document is one shared with this customer — for /portal/<token>/project-file/<id>. */
export async function portalProjectFileAllowed(token: string, documentId: string): Promise<boolean> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("projects")) return false;
  return portalProjectDocumentAllowed(resolved.companyId, documentId);
}

/** Whether this workspace has the asset request kinds and column yet (20261215400000_portal_asset_requests). */
async function assetRequestsReady(): Promise<boolean> {
  const [row] = await db.$queryRaw<{ has: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'portal_requests' AND column_name = 'assetId') AS "has"`;
  return !!row?.has;
}

const OVER_THE_DAY = "That's as many requests as one link can send in a day — we'll be in touch about the ones you've sent.";

/**
 * A request row, counted against the link's day and written in one step (security review, 15 Nov 2026 — ADV-03): the
 * count and the insert ran apart, so requests fired at once all saw room and all went in — tickets and notices with
 * them. Now the link's rows are counted and the new one written under a lock on the link, so the day's allowance holds
 * however many arrive together. Null when the day is full.
 */
async function reserveRequest(loginId: string, data: Prisma.PortalRequestUncheckedCreateInput): Promise<{ id: string } | null> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`portal-requests:${loginId}`}))`;
    const today = await tx.portalRequest.count({ where: { loginId, createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
    if (today >= PORTAL_REQUESTS_A_DAY) return null;
    return tx.portalRequest.create({ data, select: { id: true } });
  });
}

/** Their machines, where the portal shows hardware and warranties (src/lib/portal/assets.ts). */
export async function portalAssets(token: string): Promise<PortalAsset[]> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("assets")) return [];
  return portalAssetsOf(resolved.companyId);
}

/**
 * Something about one of their machines (owner, 15 Nov 2026): a problem — a ticket on it, where Tickets is in the plan,
 * else a request — a change to tell us of, or more warranty or AMC cover. The asset id is the only thing taken from the
 * browser, and it is read again scoped to the link's own company before anything is written.
 */
export async function raisePortalAssetRequest(
  token: string,
  input: { assetId: string; kind: "problem" | "change" | "cover"; message?: string | null },
): Promise<ActionResult<{ ticket: string | null }>> {
  const resolved = await resolve(token);
  if (!resolved || !resolved.sections.has("assets")) return { ok: false, error: REFUSAL_MESSAGE };
  if (!["problem", "change", "cover"].includes(input?.kind)) return { ok: false, error: "That isn't something you can ask for here." };
  const asset = await portalAssetOf(resolved.companyId, input.assetId);
  if (!asset) return { ok: false, error: REFUSAL_MESSAGE };
  const message = String(input.message ?? "").trim().slice(0, 2000);
  if (input.kind !== "cover" && !message) return { ok: false, error: input.kind === "problem" ? "What's wrong with it?" : "What has changed?" };
  const company = await db.company.findUnique({ where: { id: resolved.companyId }, select: { name: true, ownerUserId: true, assignedToUserId: true } });
  const tellUserId = company?.ownerUserId ?? company?.assignedToUserId ?? null;
  const who = { companyId: resolved.companyId, loginId: resolved.loginId, personName: resolved.personName, personEmail: resolved.personEmail };
  const kind = input.kind === "problem" ? "ASSET_PROBLEM" : input.kind === "change" ? "ASSET_CHANGE" : "ASSET_COVER";
  // The request row first, counted against the link's day under a lock (ADV-03) — a workspace not migrated yet takes it
  // as a question naming the machine. Nothing else happens unless it was written.
  const ready = await assetRequestsReady();
  const reserved = await reserveRequest(
    resolved.loginId,
    ready
      ? { ...who, kind, assetId: asset.id, message: message || null, ...(input.kind === "problem" ? { status: "IN_PROGRESS" as const } : {}) }
      : { ...who, kind: "QUESTION", message: `${asset.name} (${asset.tag}): ${message || "more warranty or AMC cover, please"}`.slice(0, 2000) },
  );
  if (!reserved) return { ok: false, error: OVER_THE_DAY };

  // A problem is a support ticket on the machine, where the workspace has Tickets; the request row says which.
  if (input.kind === "problem" && (await moduleAvailableForTenant("helpdesk"))) {
    const ticket = await openAssetTicket({ companyId: resolved.companyId, contactId: resolved.contactId, asset, personName: resolved.personName, message });
    await db.portalRequest
      .update({
        where: { id: reserved.id },
        data: { message: `Ticket #${ticket.ticketSeq}: ${message}`.slice(0, 2000), status: "DONE", handledAt: new Date(), response: `Opened as ticket #${ticket.ticketSeq}.` },
      })
      .catch(() => {});
    if (tellUserId) {
      await notifyUser({ userId: tellUserId, type: "PORTAL_REQUEST", title: `${company!.name} reported a problem with ${asset.name}`, message, link: ticketPath(ticket.ticketSeq) });
    }
    return { ok: true, data: { ticket: `#${ticket.ticketSeq}` } };
  }
  if (input.kind === "problem") await db.portalRequest.update({ where: { id: reserved.id }, data: { status: "NEW" } }).catch(() => {});

  if (tellUserId) {
    const what = input.kind === "problem" ? "reported a problem with" : input.kind === "change" ? "told us of a change to" : "asked for more cover on";
    await notifyUser({ userId: tellUserId, type: "PORTAL_REQUEST", title: `${company!.name} ${what} ${asset.name}`, message: message || undefined, link: "/customer-requests" });
  }
  return { ok: true, data: { ticket: null } };
}

/**
 * Raises a request.
 *
 * `companyProductId` is the only client-supplied id this file accepts, so it is re-read scoped to
 * the token's own company before anything is written. Taking it on trust would let somebody paste
 * another customer's order id into a form and have us record — and then act on — a request against
 * a subscription that is not theirs.
 */
export async function raisePortalRequest(
  token: string,
  input: { kind: Action; companyProductId?: string | null; quantity?: number | null; message?: string | null },
): Promise<ActionResult<{ id: string }>> {
  const resolved = await resolve(token);
  if (!resolved) return { ok: false, error: REFUSAL_MESSAGE };
  if (!resolved.actions.has(input.kind)) return { ok: false, error: "That isn't something you can ask for here." };
  // Security audit round two, 13 Nov 2026 (low): each request notifies the account manager, so a link takes a day's
  // worth and no more.
  let companyProductId: string | null = null;
  if (input.kind === "renewal" || input.kind === "seats") {
    if (!input.companyProductId) return { ok: false, error: "Choose which subscription this is about." };
    // Security audit round two, 13 Nov 2026 (low): only a subscription the portal shows them — not one still in approval.
    const owned = await db.companyProduct.findFirst({
      where: { id: input.companyProductId, companyId: resolved.companyId, orderStatus: { in: [...SHOWN_ORDERS] } },
      select: { id: true },
    });
    if (!owned) return { ok: false, error: REFUSAL_MESSAGE };
    companyProductId = owned.id;
  }

  if (input.kind === "seats") {
    const quantity = Number(input.quantity);
    if (!Number.isInteger(quantity) || quantity === 0 || Math.abs(quantity) > 10000) {
      return { ok: false, error: "How many seats? Give a whole number." };
    }
  }

  const message = (input.message ?? "").trim().slice(0, 2000);
  if (input.kind === "question" && !message) return { ok: false, error: "What would you like to ask?" };

  // Counted against the link's day and written in one step, under a lock on the link (ADV-03).
  const created = await reserveRequest(resolved.loginId, {
    companyId: resolved.companyId,
    loginId: resolved.loginId,
    personName: resolved.personName,
    personEmail: resolved.personEmail,
    kind: input.kind === "renewal" ? "RENEWAL" : input.kind === "seats" ? "ADD_SEATS" : "QUESTION",
    companyProductId,
    quantity: input.kind === "seats" ? Number(input.quantity) : null,
    message: message || null,
  });
  if (!created) return { ok: false, error: OVER_THE_DAY };

  /**
   * Told to whoever owns the account, falling back to nobody rather than to everybody.
   *
   * A request nobody is told about is the failure mode that makes a portal worse than a phone call
   * — but notifying the whole company because an account has no owner would train people to ignore
   * the notification, which comes to the same thing by a longer road.
   */
  const owner = await db.company.findUnique({
    where: { id: resolved.companyId },
    select: { assignedToUserId: true, name: true },
  });
  if (owner?.assignedToUserId) {
    const what =
      input.kind === "renewal"
        ? "wants to renew a subscription"
        : input.kind === "seats"
          ? `wants ${input.quantity} more seat(s)`
          : "asked a question";
    await notifyUser({
      userId: owner.assignedToUserId,
      type: "PORTAL_REQUEST",
      title: `${owner.name} ${what}`,
      message: message || undefined,
      link: "/customer-requests",
    });
  }

  return { ok: true, data: { id: created.id } };
}
