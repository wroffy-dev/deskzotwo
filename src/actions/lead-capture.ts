"use server";

import { revalidatePath } from "next/cache";
import { tooLong } from "@/lib/validation/text";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { digestSecret } from "@/lib/crypto";
import { newCredentials } from "@/lib/lead-capture/credentials";
import { elementorPath } from "@/lib/lead-capture/elementor";
import { OWN_FIELD_GROUPS, ownFieldDoc, type OwnFieldGroup } from "@/lib/lead-capture/spec";
import { fillableFields } from "@/lib/custom-fields/outside-server";
import type { ActionResult } from "@/actions/company";
import { CREDIT_MODES, DEFAULT_CREDIT_LABEL, keyCredit } from "@/lib/lead-capture/credit";
import { isAutomationKind } from "@/lib/people";

/**
 * API keys for the lead capture endpoint — one per website or form.
 *
 * The secret exists in exactly one place after `createCaptureKey` returns: the screen of the person
 * who made it. Only its digest is stored, so there is no "show secret" — a lost secret means
 * revoking the key and making another, which is also the right thing to do with a leaked one.
 */

async function requireAdmin() {
  // Part of the leads module (owner, 14 Oct 2026) — only where the plan has leads.
  const user = await requireModuleUser("leads");
  return (await hasEffectivePermission(user.id, "settings.manage")) ? user : null;
}

export async function listCaptureKeys() {
  if (!(await requireAdmin())) return [];
  const keys = await db.leadCaptureKey.findMany({
    orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      keyId: true,
      sourceLabel: true,
      active: true,
      lastUsedAt: true,
      useCount: true,
      createdAt: true,
      revokedAt: true,
      createdById: true,
      secretDigest: true,
      _count: { select: { leads: true } },
    },
  });
  const creators = await db.user.findMany({
    where: { id: { in: keys.map((k) => k.createdById).filter((v): v is string => !!v) } },
    select: { id: true, name: true },
  });
  // Each live key's Elementor address (src/lib/lead-capture/elementor.ts); the digest it is made from stays here.
  return Promise.all(
    keys.map(async ({ secretDigest, ...k }) => ({
      ...k,
      leads: k._count.leads,
      createdBy: creators.find((c) => c.id === k.createdById)?.name ?? null,
      elementorPath: k.revokedAt || !k.active ? null : await elementorPath({ keyId: k.keyId, secretDigest }),
      // Who its leads are raised by (src/lib/lead-capture/credit.ts).
      credit: await keyCredit(k.id),
    })),
  );
}

/**
 * The workspace's own fields a website can fill, for the documentation: each one's key, type and
 * options, so a developer can map their form to them. Restricted, retired and person fields are not
 * listed — a website can't fill them, and a restricted field's name is not for every developer.
 */
export async function captureFieldGuide(): Promise<OwnFieldGroup[]> {
  if (!(await requireAdmin())) return [];
  const fields = await fillableFields();
  return OWN_FIELD_GROUPS.map((g) => ({ name: g.name, record: g.record, fields: fields[g.entity].map(ownFieldDoc) }));
}

const createSchema = z.object({
  name: z.string().trim().min(2, "Name the website or form this key is for").max(80),
  sourceLabel: z.string().trim().max(120).optional().or(z.literal("")),
});

export async function createCaptureKey(input: unknown): Promise<ActionResult<{ keyId: string; secret: string }>> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage API keys." };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const { keyId, secret } = newCredentials();
  const key = await db.leadCaptureKey.create({
    data: {
      name: parsed.data.name,
      sourceLabel: parsed.data.sourceLabel || null,
      keyId,
      secretDigest: await digestSecret(secret),
      createdById: user.id,
    },
    select: { id: true },
  });
  // The key's name, never its secret.
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "LeadCaptureKey", entityId: key.id, entityLabel: `API key “${parsed.data.name}”` });
  revalidatePath("/settings/lead-capture");
  return { ok: true, data: { keyId, secret } };
}

const creditSchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  mode: z.enum(CREDIT_MODES),
  userId: z.string().max(100, tooLong(100)).optional().nullable(),
  label: z.string().trim().max(60).optional().or(z.literal("")),
});

/**
 * Who a key's leads are raised and sourced by from now on (owner, 9 Nov 2026 — src/lib/lead-capture/credit.ts): nobody,
 * with a name shown instead; the key's maker; or a person. Leads already in keep what they had.
 */
export async function setCaptureKeyCredit(input: unknown): Promise<ActionResult<null>> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage API keys." };
  const parsed = creditSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, mode, userId, label } = parsed.data;
  const key = await db.leadCaptureKey.findUnique({ where: { id }, select: { name: true } });
  if (!key) return { ok: false, error: "That key no longer exists." };
  let person: { name: string } | null = null;
  if (mode === "PERSON") {
    const found = userId ? await db.user.findUnique({ where: { id: userId }, select: { name: true, active: true, kind: true } }) : null;
    if (!found || !found.active || isAutomationKind(found.kind)) return { ok: false, error: "Choose somebody who works here to credit its leads to." };
    person = { name: found.name };
  }
  await db.leadCaptureKey.update({
    where: { id },
    data: { creditMode: mode, creditUserId: mode === "PERSON" ? userId! : null, creditLabel: mode === "NOBODY" ? label || null : null },
  });
  const words = mode === "PERSON" ? person!.name : mode === "MAKER" ? "the key's maker" : `no person, shown as “${label || DEFAULT_CREDIT_LABEL}”`;
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadCaptureKey", entityId: id, entityLabel: `API key “${key.name}”: leads raised by ${words}` });
  revalidatePath("/settings/lead-capture");
  return { ok: true, data: null };
}

export async function revokeCaptureKey(id: string): Promise<ActionResult<null>> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage API keys." };
  const key = await db.leadCaptureKey.findUnique({ where: { id }, select: { name: true, revokedAt: true } });
  if (!key) return { ok: false, error: "That key no longer exists." };
  if (key.revokedAt) return { ok: true, data: null };

  await db.leadCaptureKey.update({ where: { id }, data: { active: false, revokedAt: new Date() } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LeadCaptureKey", entityId: id, entityLabel: `API key “${key.name}” revoked` });
  revalidatePath("/settings/lead-capture");
  return { ok: true, data: null };
}
