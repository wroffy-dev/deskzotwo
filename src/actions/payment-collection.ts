"use server";

import { revalidatePath } from "next/cache";
import { plainError } from "@/lib/plain-error";
import { tooLong } from "@/lib/validation/text";
import { z } from "zod";
import { Prisma, type MsmeCategory, type PaymentGatewayMode, type PaymentGatewayProvider } from "@prisma/client";
import { db } from "@/lib/db";
import { moduleAvailableForTenant, requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { documentAccess, mayAccess } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { mergeTemplate, MERGE_FIELDS } from "@/lib/documents/email-template";
import { GatewayError } from "@/lib/billing/gateway";
import { GATEWAY_NAMES, gatewayApi } from "@/lib/collect/gateway-api";
import { heldLinkFor, openLinkFor, payLinkFor, retireLink, type PayLink } from "@/lib/collect/links";
import { gatewayFor, internationalGatewayIds } from "@/lib/collect/gateways";
import { notMigratedYet } from "@/lib/not-migrated";
import { invoiceBalance } from "@/lib/collect/balance";
import { mayLogFollowUps } from "@/lib/collections/load";
import { fillReminderFields, WHATSAPP_VALUES } from "@/lib/collect/reminders";
import { collectionInsights, type CollectionInsights } from "@/lib/collect/insights";
import { chargeInterestDraft } from "@/lib/collect/charge";
import { documentWriteKey } from "@/lib/documents/write-permission";
import { workspaceClock } from "@/lib/time/workspace";
import {
  collectionConfig,
  DEFAULT_STEPS,
  HOLD_DAYS_RANGE,
  MAX_STEPS,
  REMINDER_FIELDS,
  STEP_DAYS_RANGE,
  type CollectionConfig,
  type ReminderStep,
} from "@/lib/collect/settings";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Payment collection (owner, 23 Oct 2026 — src/lib/collect): the business's Razorpay or Cashfree
 * account, the payment reminder schedule, credit hold and the MSME details — `settings.manage`, as the
 * catalogue gates the page. Plus the two everyday actions: a pay-now link from an invoice (whoever may send
 * documents and opens it), and pausing a customer's reminders (whoever may follow up its payments).
 */

const SETTINGS_DENIED = "Only somebody who manages settings can change how payments are collected.";

async function settingsUser() {
  const user = await requireModuleUser("receivables");
  if (!(await can(user.id, "settings.manage"))) return { user, error: SETTINGS_DENIED };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { user, error: viewingAs };
  return { user, error: null };
}

export type GatewayView = {
  provider: PaymentGatewayProvider;
  name: string;
  mode: PaymentGatewayMode;
  /** The key id's last characters — enough to tell keys apart. */
  keyHint: string;
  bankAccountId: string | null;
  isDefault: boolean;
  active: boolean;
  /** International payments switched on at the gateway — links for invoices in other currencies (owner, 30 Oct 2026). */
  internationalOn: boolean;
  hasWebhookSecret: boolean;
  connectedAt: Date;
  checkedAt: Date | null;
  lastError: string | null;
};

export type ReminderLogRow = { at: Date; customer: string; invoice: string | null; step: string; status: string; error: string | null; sentTo: string | null };

export type PaymentCollectionView = {
  config: Omit<CollectionConfig, "remindersFrom"> & { remindersFrom: string | null };
  gateways: GatewayView[];
  bankAccounts: { id: string; name: string }[];
  people: { id: string; name: string }[];
  /** Whether the person reminders go as can open every invoice — else some won't go. */
  senderSeesAll: boolean | null;
  notices: { razorpay: string; cashfree: string };
  fields: { key: string; label: string; example: string }[];
  defaultSteps: ReminderStep[];
  whatsappValues: readonly string[];
  recent: ReminderLogRow[];
};

async function seesEveryInvoice(userId: string): Promise<boolean> {
  return Object.keys(await documentAccess(userId, "view")).length === 0;
}

export async function paymentCollectionView(): Promise<ActionResult<PaymentCollectionView>> {
  const user = await requireModuleUser("receivables");
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: SETTINGS_DENIED };
  const config = await collectionConfig();
  const origin = await tenantOrigin().catch(() => "");
  const [gateways, bankAccounts, people, recent] = await Promise.all([
    config.migrated ? db.paymentGateway.findMany({ orderBy: { connectedAt: "asc" } }) : Promise.resolve([]),
    db.bankAccount.findMany({ where: { active: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, name: true } }),
    db.user.findMany({ where: { active: true, kind: "MEMBER" }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    config.migrated
      ? db.paymentReminder.findMany({ orderBy: { createdAt: "desc" }, take: 25, select: { createdAt: true, sentAt: true, companyId: true, documentId: true, step: true, status: true, error: true, sentTo: true } })
      : Promise.resolve([]),
  ]);
  const [companies, documents] = await Promise.all([
    db.company.findMany({ where: { id: { in: [...new Set(recent.map((r) => r.companyId))] } }, select: { id: true, name: true } }),
    db.tradeDocument.findMany({ where: { id: { in: recent.flatMap((r) => (r.documentId ? [r.documentId] : [])) } }, select: { id: true, docNumber: true } }),
  ]);
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const docNumber = new Map(documents.map((d) => [d.id, d.docNumber]));
  const international = await internationalGatewayIds();
  const { remindersFrom, ...rest } = config;
  return {
    ok: true,
    data: {
      config: { ...rest, remindersFrom: remindersFrom?.toISOString() ?? null },
      gateways: gateways.map((g) => ({
        provider: g.provider,
        name: GATEWAY_NAMES[g.provider],
        mode: g.mode,
        keyHint: g.keyId.length > 6 ? `…${g.keyId.slice(-6)}` : g.keyId,
        bankAccountId: g.bankAccountId,
        isDefault: g.isDefault,
        active: g.active,
        internationalOn: international.has(g.id),
        hasWebhookSecret: !!g.webhookSecretEnc,
        connectedAt: g.connectedAt,
        checkedAt: g.checkedAt,
        lastError: g.lastError,
      })),
      bankAccounts,
      people,
      senderSeesAll: config.senderUserId ? await seesEveryInvoice(config.senderUserId) : null,
      notices: { razorpay: `${origin}/api/collect/razorpay`, cashfree: `${origin}/api/collect/cashfree` },
      fields: [...MERGE_FIELDS.map((f) => ({ key: f.key, label: f.label, example: f.example })), ...REMINDER_FIELDS.map((f) => ({ key: f.key, label: f.label, example: f.example }))],
      defaultSteps: DEFAULT_STEPS,
      whatsappValues: WHATSAPP_VALUES,
      recent: recent.map((r) => ({
        at: r.sentAt ?? r.createdAt,
        customer: companyName.get(r.companyId) ?? "A customer since removed",
        invoice: r.documentId ? (docNumber.get(r.documentId) ?? "—") : null,
        step: r.step,
        status: r.status,
        error: r.error,
        sentTo: r.sentTo,
      })),
    },
  };
}

// ─── Gateways ───────────────────────────────────────────────────────────────────────────────────

const gatewaySchema = z.object({
  provider: z.enum(["RAZORPAY", "CASHFREE"]),
  mode: z.enum(["TEST", "LIVE"]),
  /** Blank keeps the key id already saved. */
  keyId: z.string().trim().max(200).optional().or(z.literal("")),
  /** Blank keeps the secret already saved. */
  secret: z.string().trim().max(500).optional().or(z.literal("")),
  webhookSecret: z.string().trim().max(500).optional().or(z.literal("")),
  bankAccountId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  isDefault: z.boolean().default(false),
  /** Absent keeps what's saved. */
  internationalOn: z.boolean().optional(),
});

/**
 * Connects a gateway, or changes one: the keys are tried against the gateway before they're kept, so a
 * typo is caught here rather than when a customer clicks Pay.
 */
export async function connectGateway(input: unknown): Promise<ActionResult<null>> {
  const { user, error } = await settingsUser();
  if (error) return { ok: false, error };
  const parsed = gatewaySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the details." };
  const d = parsed.data;
  const existing = await db.paymentGateway.findUnique({ where: { provider: d.provider } });
  const keyId = d.keyId || (existing?.active ? existing.keyId : "");
  if (keyId.length < 4) return { ok: false, error: "Enter the key id (Razorpay) or client id (Cashfree)." };
  const secret = d.secret || null;
  if (!secret && !existing?.secretEnc) return { ok: false, error: `Enter the ${d.provider === "RAZORPAY" ? "key secret" : "client secret"}.` };
  if (d.bankAccountId && !(await db.bankAccount.findFirst({ where: { id: d.bankAccountId, active: true }, select: { id: true } }))) {
    return { ok: false, error: "That bank account isn't there any more — pick another." };
  }
  const keyChanged = !existing || existing.keyId !== keyId || existing.mode !== d.mode || !!secret;
  if (keyChanged) {
    const trySecret = secret ?? (existing?.secretEnc ? await decryptSecret(existing.secretEnc) : "");
    try {
      await gatewayApi(d.provider).check({ provider: d.provider, mode: d.mode, keyId, secret: trySecret });
    } catch (err) {
      return {
        ok: false,
        error: `${GATEWAY_NAMES[d.provider]} didn't accept those keys${err instanceof GatewayError && err.status === 401 ? "" : ` (${plainError(err, "no reason given")})`}. Check you copied the ${d.mode === "TEST" ? "test" : "live"} keys, whole.`,
      };
    }
  }
  const others = await db.paymentGateway.count({ where: { active: true, provider: { not: d.provider } } });
  const isDefault = d.isDefault || others === 0;
  const data = {
    mode: d.mode,
    keyId,
    ...(secret ? { secretEnc: await encryptSecret(secret) } : {}),
    ...(d.webhookSecret ? { webhookSecretEnc: await encryptSecret(d.webhookSecret) } : {}),
    bankAccountId: d.bankAccountId || null,
    isDefault,
    active: true,
    checkedAt: keyChanged ? new Date() : existing?.checkedAt ?? null,
    lastError: keyChanged ? null : existing?.lastError ?? null,
  };
  await db.$transaction(async (tx) => {
    if (isDefault) await tx.paymentGateway.updateMany({ where: { provider: { not: d.provider } }, data: { isDefault: false } });
    if (existing) await tx.paymentGateway.update({ where: { provider: d.provider }, data });
    else await tx.paymentGateway.create({ data: { provider: d.provider, secretEnc: await encryptSecret(secret!), connectedByUserId: user.id, ...data } });
  });
  // Written on its own (owner, 30 Oct 2026): a workspace not migrated to 20261201140000_foreign_pay_links still
  // connects its gateway, and is told the international switch must wait.
  let internationalNote = "";
  let internationalWaits = false;
  if (d.internationalOn !== undefined) {
    try {
      await db.paymentGateway.update({ where: { provider: d.provider }, data: { internationalOn: d.internationalOn } });
      internationalNote = d.internationalOn ? ", international payments on" : "";
    } catch (err) {
      if (!notMigratedYet(err)) throw err;
      internationalWaits = d.internationalOn;
    }
  }
  await recordAudit({
    userId: user.id,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "PaymentGateway",
    entityId: d.provider,
    entityLabel: `${GATEWAY_NAMES[d.provider]} ${existing ? "updated" : "connected"} for pay-now links (${d.mode === "TEST" ? "test" : "live"} keys${isDefault ? ", the one new links use" : ""}${internationalNote})`,
  });
  revalidatePath("/settings/payment-collection");
  if (internationalWaits) return { ok: false, error: "Saved — but international payments can't be switched on until this workspace finishes updating. Try again in a few minutes." };
  return { ok: true, data: null };
}

/** Disconnects a gateway: its open links are closed at the gateway first, then its keys are wiped. */
export async function disconnectGateway(provider: string): Promise<ActionResult<{ closed: number; notClosed: number }>> {
  const { user, error } = await settingsUser();
  if (error) return { ok: false, error };
  if (provider !== "RAZORPAY" && provider !== "CASHFREE") return { ok: false, error: "No such gateway." };
  const gateway = await db.paymentGateway.findUnique({ where: { provider } });
  if (!gateway?.active) return { ok: false, error: "It isn't connected." };
  const open = await db.paymentLink.findMany({ where: { gatewayId: gateway.id, status: "ACTIVE" }, select: { id: true } });
  let closed = 0;
  let notClosed = 0;
  for (const link of open) {
    const outcome = await retireLink(link.id);
    if (outcome === "error") notClosed += 1;
    else closed += 1;
  }
  await db.paymentGateway.update({ where: { id: gateway.id }, data: { active: false, isDefault: false, secretEnc: "", webhookSecretEnc: null } });
  // The other one, if connected, makes the links from now on.
  await db.paymentGateway.updateMany({ where: { active: true }, data: { isDefault: true } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "PaymentGateway",
    entityId: provider,
    entityLabel: `${GATEWAY_NAMES[provider]} disconnected — ${closed} open link${closed === 1 ? "" : "s"} closed${notClosed ? `, ${notClosed} couldn't be reached` : ""}`,
  });
  revalidatePath("/settings/payment-collection");
  return { ok: true, data: { closed, notClosed } };
}

// ─── Reminders, credit hold, MSME ──────────────────────────────────────────────────────────────

const stepSchema = z.object({
  key: z.string().trim().min(1).max(40).regex(/^[a-z0-9-]+$/, "A step's key is letters, digits and dashes."),
  days: z.number().int().min(STEP_DAYS_RANGE.min).max(STEP_DAYS_RANGE.max),
  tone: z.enum(["friendly", "firm", "final"]),
  on: z.boolean(),
  subject: z.string().trim().min(1, "Give each step a subject.").max(200),
  body: z.string().trim().min(1, "Write each step's message.").max(10_000),
  /** Review first: waits in Receivables › Reminders to send (owner, 3 Nov 2026). */
  review: z.boolean().optional(),
});

const remindersSchema = z.object({
  on: z.boolean(),
  senderUserId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  /** Null goes back to the standard schedule. */
  steps: z.array(stepSchema).max(MAX_STEPS).nullable(),
  statementOn: z.boolean(),
  whatsappTemplate: z.string().trim().max(200).optional().or(z.literal("")),
  /** Each reminder in the invoice's own email thread, rather than a new email (owner, 3 Nov 2026). Absent keeps it. */
  reminderThread: z.boolean().optional(),
  /** Who they come from (src/lib/collect/sender.ts). Absent keeps it. */
  senderMode: z.enum(["PERSON", "ACCOUNT_MANAGER", "COLLECTIONS"]).optional(),
  collectionsFromName: z.string().trim().max(120).optional().or(z.literal("")),
  collectionsEmail: z.string().trim().max(200).email("The shared address has to be an email address.").optional().or(z.literal("")),
});

const SAMPLE = {
  "invoice.balance": "₹1,000.00",
  "invoice.daysOverdue": "7",
  "payment.link": "https://example.com/pay",
  "payment.line": "You can pay it online here: https://example.com/pay",
  "interest.line": "Interest so far: ₹10.00",
} as const;

/** A step's words, merged on sample values: a field typed wrong is caught on saving, not on sending. */
function wordsProblem(step: { subject: string; body: string }): string | null {
  const sample = Object.fromEntries(MERGE_FIELDS.map((f) => [f.key, f.example]));
  for (const text of [step.subject, step.body]) {
    const merged = mergeTemplate(fillReminderFields(text, SAMPLE), sample);
    if (!merged.ok) return merged.error;
  }
  return null;
}

export async function saveReminderSettings(input: unknown): Promise<ActionResult<null>> {
  const { user, error } = await settingsUser();
  if (error) return { ok: false, error };
  const parsed = remindersSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the schedule." };
  const d = parsed.data;
  const steps = d.steps;
  if (steps) {
    if (new Set(steps.map((s) => s.key)).size !== steps.length) return { ok: false, error: "Two steps have the same key." };
    if (new Set(steps.map((s) => s.days)).size !== steps.length) return { ok: false, error: "Two steps fall on the same day. Give each its own." };
    for (const step of steps) {
      const problem = wordsProblem(step);
      if (problem) return { ok: false, error: `${step.days < 0 ? `${-step.days} days before due` : step.days === 0 ? "On the due day" : `${step.days} days overdue`}: ${problem}` };
    }
  }
  const sender = d.senderUserId || (d.on ? user.id : null);
  if (sender && !(await db.user.findFirst({ where: { id: sender, active: true }, select: { id: true } }))) return { ok: false, error: "That person isn't active any more — pick someone else to send them." };

  const before = await collectionConfig();
  if (!before.migrated) return { ok: false, error: "This workspace is still being updated. Try again in a few minutes." };
  const turningOn = d.on && !before.remindersOn;
  const write = {
    remindersOn: d.on,
    ...(turningOn ? { remindersFrom: new Date() } : {}),
    senderUserId: sender,
    // No steps is the standard schedule, kept as the database's null so later wording changes reach it.
    steps: steps ? (steps as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    statementOn: d.statementOn,
    whatsappTemplate: d.whatsappTemplate || null,
    updatedByUserId: user.id,
  };
  await db.collectionSettings.upsert({ where: { id: "default" }, create: { id: "default", ...write }, update: write });
  // Who they come from, on its own too (owner, 3 Nov 2026). The shared address needs one to send from.
  if (d.senderMode !== undefined) {
    if (d.senderMode === "COLLECTIONS" && !d.collectionsEmail) return { ok: false, error: "Give the shared address reminders come from — accounts@… — or send them as a person." };
    await db.collectionSettings
      .update({ where: { id: "default" }, data: { senderMode: d.senderMode, collectionsFromName: d.collectionsFromName || null, collectionsEmail: d.collectionsEmail?.toLowerCase() || null }, select: { id: true } })
      .catch((err) => {
        if (!notMigratedYet(err)) throw err;
      });
  }
  // Written on its own: a workspace whose table hasn't the column yet keeps everything else.
  if (d.reminderThread !== undefined && d.reminderThread !== before.reminderThread) {
    await db.collectionSettings.update({ where: { id: "default" }, data: { reminderThread: d.reminderThread }, select: { id: true } }).catch((err) => {
      if (!notMigratedYet(err)) throw err;
    });
  }
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "CollectionSettings",
    entityId: "default",
    entityLabel: `Payment reminders ${d.on ? (turningOn ? "switched on" : "changed") : before.remindersOn ? "switched off" : "changed (off)"}${steps ? `, ${steps.filter((s) => s.on).length} steps` : ", the standard schedule"}${d.statementOn ? ", monthly statements on" : ""}${d.reminderThread ? ", in the invoice's thread" : ""}${d.senderMode ? `, from ${d.senderMode === "COLLECTIONS" ? d.collectionsEmail : d.senderMode === "ACCOUNT_MANAGER" ? "each account manager" : "one person"}` : ""}${steps?.some((s) => s.review) ? `, ${steps.filter((s) => s.review).length} reviewed first` : ""}`,
  });
  revalidatePath("/settings/payment-collection");
  return { ok: true, data: null };
}

const holdSchema = z.object({ on: z.boolean(), days: z.number().int().min(HOLD_DAYS_RANGE.min).max(HOLD_DAYS_RANGE.max) });

export async function saveCreditHold(input: unknown): Promise<ActionResult<null>> {
  const { user, error } = await settingsUser();
  if (error) return { ok: false, error };
  const parsed = holdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `Give the days as a whole number from ${HOLD_DAYS_RANGE.min} to ${HOLD_DAYS_RANGE.max}.` };
  const write = { creditHoldOn: parsed.data.on, creditHoldDays: parsed.data.days, updatedByUserId: user.id };
  await db.collectionSettings.upsert({ where: { id: "default" }, create: { id: "default", ...write }, update: write });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "CollectionSettings",
    entityId: "default",
    entityLabel: parsed.data.on ? `Credit hold: new orders for a customer ${parsed.data.days}+ days overdue need a credit override` : "Credit hold switched off",
  });
  revalidatePath("/settings/payment-collection");
  return { ok: true, data: null };
}

/** UDYAM-XX-00-0000000: the state, the district, and seven digits. */
const UDYAM = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;

const msmeSchema = z.object({
  udyamNumber: z.string().trim().max(100, tooLong(100)).toUpperCase().optional().or(z.literal("")),
  category: z.enum(["MICRO", "SMALL", "MEDIUM"]).nullable(),
  bankRate: z.number().min(0.01).max(25).nullable(),
});

export async function saveMsmeDetails(input: unknown): Promise<ActionResult<null>> {
  const { user, error } = await settingsUser();
  if (error) return { ok: false, error };
  const parsed = msmeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the bank rate as a percentage, like 5.50." };
  const d = parsed.data;
  if (d.udyamNumber && !UDYAM.test(d.udyamNumber)) return { ok: false, error: "A Udyam number looks like UDYAM-MH-26-0123456." };
  const write = { udyamNumber: d.udyamNumber || null, msmeCategory: (d.category ?? null) as MsmeCategory | null, bankRate: d.bankRate, updatedByUserId: user.id };
  await db.collectionSettings.upsert({ where: { id: "default" }, create: { id: "default", ...write }, update: write });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "CollectionSettings",
    entityId: "default",
    entityLabel: `MSME details: ${d.udyamNumber || "no Udyam number"}${d.category ? `, ${d.category.toLowerCase()}` : ""}${d.bankRate ? `, bank rate ${d.bankRate}%` : ""}`,
  });
  revalidatePath("/settings/payment-collection");
  return { ok: true, data: null };
}

// ─── Everyday: a pay-now link, a customer's reminders paused ────────────────────────────────────

/** The pay-now link for an invoice — the open one, or a new one — for whoever may send it documents. */
export async function invoicePayLink(invoiceId: string, make = true): Promise<ActionResult<PayLink | null>> {
  const user = await requireModuleUser("receivables");
  const id = String(invoiceId ?? "");
  if (!id || !(await mayAccess(user.id, "documents", "view", id))) return { ok: false, error: "That invoice no longer exists." };
  if (!make) return { ok: true, data: await openLinkFor(id) };
  if (!(await can(user.id, "documents.send"))) return { ok: false, error: "You can't send documents to customers, so can't make a pay-now link." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const result = await payLinkFor(id, user.id);
  return result.ok ? { ok: true, data: result.link } : { ok: false, error: result.error };
}

/**
 * Where an invoice stands for paying online: its balance, and whether a link can be made for it. For an invoice in
 * another currency (owner, 30 Oct 2026), the gateway that takes international payments — or, where a gateway is
 * connected but none does, why not (`unavailable`), shown where the button would be. `held` is a payment the gateway
 * took that wasn't recorded by itself.
 */
export async function invoicePayLinkState(
  invoiceId: string,
): Promise<ActionResult<{ balance: number; currency: string; link: PayLink | null; gateway: string | null; unavailable: string | null; held: string | null; mayMake: boolean }>> {
  const user = await requireModuleUser("receivables");
  const id = String(invoiceId ?? "");
  if (!id || !(await mayAccess(user.id, "documents", "view", id))) return { ok: false, error: "That invoice no longer exists." };
  const due = await invoiceBalance(id);
  if (!due) return { ok: false, error: "Not an issued invoice." };
  const [link, choice, held, mayMake] = await Promise.all([openLinkFor(id), gatewayFor(due.currency), heldLinkFor(id), can(user.id, "documents.send")]);
  return {
    ok: true,
    data: {
      balance: due.balance,
      currency: due.currency,
      link,
      gateway: choice.ok ? GATEWAY_NAMES[choice.gateway.provider] : null,
      unavailable: !choice.ok && choice.reason === "international" ? choice.error : null,
      held: held?.reason ?? null,
      mayMake,
    },
  };
}

export async function setRemindersPaused(companyId: string, paused: boolean, reason?: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("receivables");
  const id = String(companyId ?? "");
  if (!id || !(await mayAccess(user.id, "companies", "view", id))) return { ok: false, error: "Company not found." };
  if (!(await mayLogFollowUps(user.id))) return { ok: false, error: "You don't follow up payments, so can't pause a customer's reminders." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const why = reason?.trim().slice(0, 300) || null;
  if (paused) {
    await db.paymentReminderPause.upsert({ where: { companyId: id }, create: { companyId: id, pausedByUserId: user.id, reason: why }, update: { pausedByUserId: user.id, reason: why } });
  } else {
    await db.paymentReminderPause.deleteMany({ where: { companyId: id } });
  }
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: id,
    entityLabel: paused ? `Payment reminders paused${why ? ` — ${why}` : ""}` : "Payment reminders resumed",
  });
  revalidatePath(`/companies/${id}`);
  return { ok: true, data: null };
}

export async function remindersPausedFor(companyId: string): Promise<{ paused: boolean; reason: string | null; on: boolean; mayChange: boolean }> {
  const user = await requireModuleUser("receivables");
  const id = String(companyId ?? "");
  const config = await collectionConfig();
  // Only for an account the person may see, as setting it asks (owner, 3 Nov 2026 — Phase 2 permission fixes,
  // check:record-scope): it told anybody whether any company's reminders were paused, and why.
  if (!id || !(await mayAccess(user.id, "companies", "view", id))) return { paused: false, reason: null, on: config.remindersOn, mayChange: false };
  const [pause, mayChange] = await Promise.all([
    db.paymentReminderPause.findUnique({ where: { companyId: id }, select: { reason: true } }).catch(() => null),
    mayLogFollowUps(user.id),
  ]);
  return { paused: !!pause, reason: pause?.reason ?? null, on: config.remindersOn, mayChange };
}

/** DSO by month and the next eight weeks' collections (src/lib/collect/insights.ts), over the invoices this person reaches. */
export async function receivablesInsights(): Promise<CollectionInsights> {
  const user = await requireModuleAccess("receivables");
  const [scope, clock] = await Promise.all([documentAccess(user.id, "view"), workspaceClock()]);
  return collectionInsights(scope, clock.calendarDate(new Date()));
}

/**
 * "Charge interest" on a late invoice (src/lib/collect/charge.ts): a draft debit note for the MSMED Act interest
 * so far, for whoever may raise sales documents and opens the invoice. Opened for them to check and issue.
 */
export async function chargeMsmeInterest(invoiceId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("receivables");
  const id = String(invoiceId ?? "");
  if (!id || !(await mayAccess(user.id, "documents", "view", id))) return { ok: false, error: "That invoice no longer exists." };
  if (!(await moduleAvailableForTenant("sales_documents"))) return { ok: false, error: "Debit notes are part of Sales Documents, which isn't in this workspace's plan." };
  if (!(await can(user.id, documentWriteKey("DEBIT_NOTE", "create")))) return { ok: false, error: "You can't raise debit notes, so can't charge interest." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  return chargeInterestDraft(id, user.id);
}
