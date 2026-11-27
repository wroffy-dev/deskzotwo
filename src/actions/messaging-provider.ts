"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type MessageClass, type ProviderKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { getOrganisation } from "@/lib/organisation";
import { lookupDns } from "@/lib/domain-intel/lookup";
import { DNS_TIMEOUT_MS, resolver, withTimeout } from "@/lib/dns";
import { checkDomain, warmUp, type RecordCheck } from "@/lib/marketing/sender-domain";
import { PROVIDERS, providerByKey, routeFor, sharesDomainWithTransactional } from "@/lib/marketing/providers";
import type { ActionResult } from "@/actions/company";
import { clip, withinSize, TEXT_MAX } from "@/lib/text/bounded";

/**
 * Configuring who actually puts mail on the wire.
 *
 * Secrets are encrypted at rest with the same helper the e-invoice credentials use, and never
 * travel back to a client — the settings screen gets a `hasSecret` boolean and nothing more, the
 * same way `Organisation.hasPassword` works.
 */

async function requireAdmin() {
  const user = await requireModuleUser("marketing");
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { user: null, error: "You can't configure mail providers." };
  }
  return { user, error: null };
}

/**
 * `requireAdmin` for the actions only Marketing Automation's own pages use: Marketing Automation open to the person as well. The actions other
 * screens use keep `requireAdmin` alone (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-6).
 */
async function requireAdminIfOpen(...args: Parameters<typeof requireAdmin>) {
  await requireModuleAccess("marketing");
  return requireAdmin(...args);
}

export async function listProviders() {
  const { user } = await requireAdmin();
  if (!user) return { rows: [], catalogue: [], warning: null };

  const rows = await db.messagingProvider.findMany({ orderBy: [{ kind: "asc" }, { priority: "asc" }] });
  const routable = rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    kind: r.kind,
    enabled: r.enabled,
    priority: r.priority,
    classes: r.classes,
    fromEmail: r.fromEmail,
  }));

  return toPlain({
    rows: rows.map((r) => ({
      id: r.id,
      key: r.key,
      kind: r.kind,
      label: r.label,
      enabled: r.enabled,
      priority: r.priority,
      classes: r.classes,
      fromName: r.fromName,
      fromEmail: r.fromEmail,
      replyTo: r.replyTo,
      config: (r.config as Record<string, unknown>) ?? {},
      dailyCap: r.dailyCap,
      lastVerifiedAt: r.lastVerifiedAt,
      verifyOk: r.verifyOk,
      verifyDetail: r.verifyDetail,
      /** Whether a secret is stored, never the secret itself. */
      hasSecret: !!r.secretCipher,
    })),
    catalogue: PROVIDERS.map((p) => ({ key: p.key, label: p.label, kind: p.kind, needs: p.needs, setup: p.setup ?? null })),
    // The warning worth putting in front of somebody before they send anything.
    warning: sharesDomainWithTransactional(routable)
      ? "Marketing and transactional mail are going out from the same domain. A campaign that annoys people will take your invoices and quotes down with it — send bulk from a subdomain instead."
      : null,
  });
}

export async function saveProvider(input: {
  key: string;
  label?: string;
  enabled?: boolean;
  priority?: number;
  classes?: MessageClass[];
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  config?: Record<string, unknown>;
  /** Only sent when it is being changed. Blank leaves the stored one alone. */
  secret?: string;
  dailyCap?: number | null;
}): Promise<ActionResult<{ id: string }>> {
  const { user, error } = await requireAdmin();
  if (!user) return { ok: false, error: error! };

  const definition = providerByKey[input.key];
  if (!definition) return { ok: false, error: "No such provider." };
  // Typed text capped, and the config refused past 64 KB, before they are stored (owner, 15 Nov 2026 — input bounds).
  input = {
    ...input,
    label: clip(input.label, TEXT_MAX.name) || undefined,
    fromName: clip(input.fromName, TEXT_MAX.name) || undefined,
    fromEmail: clip(input.fromEmail, TEXT_MAX.email) || undefined,
    replyTo: clip(input.replyTo, TEXT_MAX.email) || undefined,
    secret: clip(input.secret, TEXT_MAX.paragraph) || undefined,
  };
  if (!withinSize(input.config)) return { ok: false, error: "That's too much to save at once." };

  if (input.enabled && definition.kind === "EMAIL" && !input.fromEmail?.trim() && input.key !== "mock") {
    return { ok: false, error: "A from-address is needed before this can be switched on." };
  }

  const fields = {
    kind: definition.kind as ProviderKind,
    label: input.label?.trim() || definition.label,
    enabled: input.enabled ?? false,
    priority: input.priority ?? 100,
    classes: input.classes ?? [],
    fromName: input.fromName?.trim() || null,
    fromEmail: input.fromEmail?.trim().toLowerCase() || null,
    replyTo: input.replyTo?.trim().toLowerCase() || null,
    config: (input.config ?? {}) as Prisma.InputJsonValue,
    dailyCap: input.dailyCap ?? null,
    // A blank secret means "leave what is stored"; it never means "clear it". Clearing happens by
    // switching the provider off, which is the deliberate act.
    ...(input.secret?.trim() ? { secretCipher: await encryptSecret(input.secret.trim()) } : {}),
  };

  const saved = await db.messagingProvider.upsert({
    where: { key: input.key },
    create: { key: input.key, ...fields },
    update: fields,
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "MessagingProvider",
    entityId: saved.id,
    entityLabel: `${fields.label} — ${fields.enabled ? "on" : "off"}${fields.classes.length ? `, carrying ${fields.classes.join(" and ").toLowerCase()}` : ""}`,
  });
  revalidatePath("/settings/organisation");
  return { ok: true, data: saved };
}

/** Asks the provider whether the credentials work, and records the answer. */
export async function verifyProvider(key: string): Promise<ActionResult<{ detail: string }>> {
  const { user, error } = await requireAdmin();
  if (!user) return { ok: false, error: error! };

  const row = await db.messagingProvider.findUnique({ where: { key } });
  if (!row) return { ok: false, error: "That provider isn't configured yet." };
  const definition = providerByKey[key];
  if (!definition) return { ok: false, error: "No such provider." };

  const result = await definition.verify({
    key: row.key,
    label: row.label,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    replyTo: row.replyTo,
    config: (row.config as Record<string, unknown>) ?? {},
    secret: row.secretCipher ? await decryptSecret(row.secretCipher) : null,
  });

  await db.messagingProvider.update({
    where: { key },
    data: { lastVerifiedAt: new Date(), verifyOk: result.ok, verifyDetail: result.detail },
  });
  revalidatePath("/settings/organisation");
  return result.ok ? { ok: true, data: { detail: result.detail } } : { ok: false, error: result.detail };
}

/**
 * Whether the sending domain is set up to be believed.
 *
 * Reuses the DNS lookup the domain-intel module already does for prospects — the same four records
 * decide whether a stranger's mail reaches an inbox and whether ours does. Missing SPF or DKIM, or
 * a DMARC policy of `p=none`, is the most common reason marketing mail lands in spam, and it is
 * invisible from inside the app until somebody looks.
 */
export async function checkSenderDomain(): Promise<
  ActionResult<{
    domain: string;
    spf: boolean;
    dkim: boolean;
    dmarc: boolean;
    dmarcPolicy: string | null;
    mx: number;
    problems: string[];
    /** Each record's state with the record to paste (owner, 1 Nov 2026 — src/lib/marketing/sender-domain.ts). */
    checks: RecordCheck[];
    /** How much to send a day while the domain builds its name. */
    warmUp: { largestDay: number; limit: number; advice: string };
  }>
> {
  const { user, error } = await requireAdmin();
  if (!user) return { ok: false, error: error! };

  const org = await getOrganisation();
  const providers = await db.messagingProvider.findMany({
    where: { enabled: true, classes: { has: "MARKETING" } },
    select: { fromEmail: true, key: true, config: true },
  });

  const domain =
    org.marketingFromDomain?.trim().toLowerCase() ||
    providers.find((p) => p.fromEmail)?.fromEmail?.split("@")[1]?.trim().toLowerCase() ||
    null;
  if (!domain) {
    return { ok: false, error: "No sending domain yet. Set one in the marketing settings or on a provider." };
  }

  const [dns, txt] = await Promise.all([lookupDns(domain), withTimeout(resolver.resolveTxt(domain), DNS_TIMEOUT_MS)]);
  const spfRecords = (txt ?? []).map((parts) => parts.join("")).filter((r) => r.toLowerCase().startsWith("v=spf1"));
  const checks = checkDomain({
    domain,
    spfRecords,
    dmarcRecord: dns.dmarcRecord,
    dkimFound: dns.dkimFound,
    mxCount: dns.mxHosts.length,
    providers: providers.filter((p) => p.key !== "mock").map((p) => ({ key: p.key, host: typeof (p.config as Record<string, unknown> | null)?.host === "string" ? ((p.config as Record<string, unknown>).host as string) : null })),
  });
  // The busiest day of marketing mail in the last 30, for the warm-up advice.
  const since = new Date(Date.now() - 30 * 86_400_000);
  const days = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM marketing_messages
     WHERE "messageClass" = 'MARKETING' AND "sentAt" >= ${since}
     GROUP BY date_trunc('day', "sentAt") ORDER BY n DESC LIMIT 1`;
  const largestDay = Number(days[0]?.n ?? 0);
  const plan = warmUp(largestDay);
  const problems: string[] = [];
  if (!dns.spfRecord) problems.push("No SPF record. Receivers have no way to tell your mail from a forgery.");
  if (!dns.dkimFound) {
    problems.push("No DKIM signature found on the usual selectors. Your provider will tell you which record to add.");
  }
  if (!dns.dmarcRecord) problems.push("No DMARC record. With SPF and DKIM in place, this is the one that earns trust.");
  else if (/p=none/i.test(dns.dmarcRecord)) {
    problems.push("DMARC is set to p=none, which monitors and enforces nothing. Move to quarantine once you're confident.");
  }
  if (dns.mxHosts.length === 0) problems.push("No MX records, so nothing can reply to this domain.");

  return {
    ok: true,
    data: {
      domain,
      spf: !!dns.spfRecord,
      dkim: dns.dkimFound,
      dmarc: !!dns.dmarcRecord,
      dmarcPolicy: dns.dmarcRecord?.match(/p=(\w+)/i)?.[1] ?? null,
      mx: dns.mxHosts.length,
      problems,
      checks,
      warmUp: { largestDay, limit: plan.limit, advice: plan.advice },
    },
  };
}

/** Which provider a message of each class would actually go through — the routing, made visible. */
export async function routingSummary() {
  const { user } = await requireAdminIfOpen();
  if (!user) return null;
  const rows = await db.messagingProvider.findMany({
    select: { id: true, key: true, label: true, kind: true, enabled: true, priority: true, classes: true, fromEmail: true },
  });
  return toPlain({
    marketing: routeFor(rows, { kind: "EMAIL", messageClass: "MARKETING" }),
    transactional: routeFor(rows, { kind: "EMAIL", messageClass: "TRANSACTIONAL" }),
    whatsapp: routeFor(rows, { kind: "WHATSAPP", messageClass: "MARKETING" }),
  });
}
