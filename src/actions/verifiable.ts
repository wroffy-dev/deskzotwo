"use server";

import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { hasEffectivePermission } from "@/actions/permission";
import type { ActionResult } from "@/actions/company";
import { recordAudit } from "@/lib/audit";
import { companyScope } from "@/lib/authz/company-scope";
import { mayAccess } from "@/lib/authz/access";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { protocolFor } from "@/lib/tenancy/host";
import { subdomainHost } from "@/lib/tenancy/registry";
import { currentTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";
import { customFieldsForCreate, customSearchWhere, saveCustomFields } from "@/lib/custom-fields/server";
import { customFilterWhere, type CustomFilterInputs } from "@/lib/custom-fields/filters";
import { safeHex } from "@/lib/id-cards/design";
import { readAccreditations, readTemplate, safeLogo, type Accreditation, type VerifyTemplate } from "@/lib/verifiable/design";
import { numberKeyOf, standingOf, type VerifiableStanding } from "@/lib/verifiable/rules";

/**
 * Verifiable documents (owner, 7 Nov 2026): a certificate, licence, warranty or letter a workspace issues, with a QR code and a
 * public page (/v/<token>) saying whether it still stands. For the "is this real?" call, and for the thing a PDF can't do: say
 * it has been withdrawn.
 *
 * Under CRM, on the documents' permissions: `documents.view` to see them, `certificates.issue` to add or correct, `certificates.withdraw`
 * to withdraw (their own since 9 Nov 2026; they borrowed the sales documents' until then). One linked to a customer is for those who may see that customer. The link is random, so nobody can work through
 * the numbers to collect a client list.
 */

export type VerifiableRow = {
  id: string;
  token: string;
  docType: string;
  number: string;
  title: string;
  holderName: string;
  scope: string | null;
  holderIsPerson: boolean;
  inSearch: boolean;
  companyId: string | null;
  companyName: string | null;
  issuedOn: string;
  expiresOn: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  standing: VerifiableStanding;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const dayOf = (text: unknown): Date | null => {
  const value = String(text ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(at.getTime()) || iso(at) !== value ? null : at;
};

const SELECT = {
  id: true,
  token: true,
  docType: true,
  number: true,
  title: true,
  holderName: true,
  scope: true,
  holderIsPerson: true,
  inSearch: true,
  companyId: true,
  issuedOn: true,
  expiresOn: true,
  withdrawnAt: true,
  withdrawnReason: true,
  company: { select: { name: true } },
} as const;

async function seenBy(userId: string): Promise<Prisma.VerifiableDocumentWhereInput> {
  const scope = await companyScope(userId);
  // Sees every company: nothing to narrow. An empty filter on a relation inside an OR would match nothing.
  if (Object.keys(scope).length === 0) return {};
  return { OR: [{ companyId: null }, { company: scope }] };
}

/** The documents this person may see, soonest to expire first; those with no end after them. */
export async function listVerifiable(params?: { q?: string; standing?: string; customFilters?: CustomFilterInputs }): Promise<{ rows: VerifiableRow[]; mayIssue: boolean; mayWithdraw: boolean } | null> {
  const user = await requireModuleUser("companies");
  if (!(await hasEffectivePermission(user.id, "documents.view"))) return null;
  const q = String(params?.q ?? "").trim().slice(0, 100);
  const today = (await workspaceClock()).calendarDate(new Date());
  const standing: Prisma.VerifiableDocumentWhereInput =
    params?.standing === "WITHDRAWN"
      ? { withdrawnAt: { not: null } }
      : params?.standing === "EXPIRED"
        ? { withdrawnAt: null, expiresOn: { lt: today } }
        : params?.standing === "VALID"
          ? { withdrawnAt: null, OR: [{ expiresOn: null }, { expiresOn: { gte: today } }] }
          : {};
  const rows = await db.verifiableDocument.findMany({
    where: {
      AND: [
        await seenBy(user.id),
        standing,
        q ? { OR: [{ number: { contains: q, mode: "insensitive" } }, { holderName: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }, ...((await customSearchWhere("VERIFIABLE", user.id, q)) as Prisma.VerifiableDocumentWhereInput[])] } : {},
        ...((await customFilterWhere("VERIFIABLE", user.id, params?.customFilters)) as Prisma.VerifiableDocumentWhereInput[]),
      ],
    },
    orderBy: [{ expiresOn: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: 500,
    select: SELECT,
  });
  const [mayIssue, mayWithdraw] = await Promise.all([hasEffectivePermission(user.id, "certificates.issue"), hasEffectivePermission(user.id, "certificates.withdraw")]);
  return {
    mayIssue,
    mayWithdraw,
    rows: rows.map(({ company, ...r }) => ({
      ...r,
      companyName: company?.name ?? null,
      issuedOn: iso(r.issuedOn),
      expiresOn: r.expiresOn ? iso(r.expiresOn) : null,
      withdrawnAt: r.withdrawnAt ? r.withdrawnAt.toISOString() : null,
      standing: standingOf(r, today),
    })),
  };
}

export type VerifiableInput = { id?: string; docType: string; number: string; title: string; holderName: string; scope?: string; companyId?: string; issuedOn: string; expiresOn?: string; holderIsPerson?: boolean; inSearch?: boolean; customFields?: unknown };

/** Adds a document, or corrects one: its link stays, so a QR code already printed keeps working. */
export async function saveVerifiable(input: VerifiableInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("companies");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await hasEffectivePermission(user.id, "certificates.issue"))) return { ok: false, error: "Issuing certificates needs the right to — ask an admin." };
  const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
  const docType = text(input?.docType, 60);
  const number = text(input?.number, 80);
  const title = text(input?.title, 200);
  const holderName = text(input?.holderName, 200);
  if (!docType) return { ok: false, error: "Say what kind of document it is." };
  if (!number) return { ok: false, error: "Enter its number." };
  if (!title) return { ok: false, error: "Say what it is for, such as ISO 9001:2015." };
  if (!holderName) return { ok: false, error: "Say who it was issued to." };
  const issuedOn = dayOf(input?.issuedOn);
  if (!issuedOn) return { ok: false, error: "Enter the day it was issued." };
  const expiresOn = input?.expiresOn ? dayOf(input.expiresOn) : null;
  if (input?.expiresOn && !expiresOn) return { ok: false, error: "That expiry date isn't a date." };
  if (expiresOn && expiresOn < issuedOn) return { ok: false, error: "It can't expire before it was issued." };
  const companyId = text(input?.companyId, 64) || null;
  if (companyId && !(await mayAccess(user.id, "companies", "view", companyId))) return { ok: false, error: "That customer isn't one you can see." };
  if (!numberKeyOf(number)) return { ok: false, error: "A number needs letters or digits, or nobody could search for it." };
  const data = { docType, number, numberKey: numberKeyOf(number), title, holderName, scope: text(input?.scope, 1000) || null, companyId, issuedOn, expiresOn, holderIsPerson: input?.holderIsPerson === true, inSearch: input?.inSearch !== false };
  try {
    const id = String(input?.id ?? "");
    if (id) {
      const seen = await db.verifiableDocument.findFirst({ where: { AND: [{ id }, await seenBy(user.id)] }, select: { id: true } });
      if (!seen) return { ok: false, error: "That document no longer exists." };
    }
    const created = id ? null : await customFieldsForCreate("VERIFIABLE", user.id, input?.customFields);
    if (created && !created.ok) return created;
    const row = id
      ? await db.verifiableDocument.update({ where: { id }, data, select: { id: true } })
      : await db.verifiableDocument.create({ data: { ...data, ...(created?.ok ? created.data : {}), token: randomBytes(18).toString("base64url"), createdById: user.id }, select: { id: true } });
    if (id && input?.customFields !== undefined) {
      const saved = await saveCustomFields("VERIFIABLE", id, user.id, input.customFields);
      if (!saved.ok) return saved;
    }
    await recordAudit({ userId: user.id, action: id ? "UPDATE" : "CREATE", entityType: "VerifiableDocument", entityId: row.id, entityLabel: `${docType} ${number}` });
    revalidatePath("/certificates");
    return { ok: true, data: row };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: `Another document already has the number ${number}.` };
    throw err;
  }
}

/** Withdraws one, with why (kept here, never shown to the public), or puts it back. The page changes at once. */
export async function setVerifiableWithdrawn(id: string, withdrawn: boolean, reason?: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("companies");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await hasEffectivePermission(user.id, "certificates.withdraw"))) return { ok: false, error: "Withdrawing certificates needs the right to — ask an admin." };
  const why = String(reason ?? "").trim().slice(0, 500);
  if (withdrawn && why.length < 3) return { ok: false, error: "Say why it's withdrawn." };
  const doc = await db.verifiableDocument.findFirst({ where: { AND: [{ id: String(id ?? "") }, await seenBy(user.id)] }, select: { id: true, number: true, docType: true } });
  if (!doc) return { ok: false, error: "That document no longer exists." };
  await db.verifiableDocument.update({
    where: { id: doc.id },
    data: withdrawn ? { withdrawnAt: new Date(), withdrawnReason: why, withdrawnById: user.id } : { withdrawnAt: null, withdrawnReason: null, withdrawnById: null },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "VerifiableDocument", entityId: doc.id, entityLabel: `${doc.docType} ${doc.number} ${withdrawn ? `withdrawn: ${why}` : "put back"}` });
  revalidatePath("/certificates");
  return { ok: true, data: null };
}

/** Turns the public search on or off (src/lib/verifiable/search.ts). A setting, so it's for whoever may change settings. */
export async function saveVerifiableSearch(input: { searchOn: boolean; nameSearch: boolean }): Promise<ActionResult<null>> {
  const user = await requireModuleUser("companies");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: "Changing this needs the right to change settings — ask an admin." };
  const searchOn = input?.searchOn === true;
  const nameSearch = searchOn && input?.nameSearch === true;
  await db.verifiableSettings.upsert({ where: { id: "global" }, create: { id: "global", searchOn, nameSearch, updatedById: user.id }, update: { searchOn, nameSearch, updatedById: user.id } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "VerifiableSettings", entityId: "global", entityLabel: `Public document search ${searchOn ? (nameSearch ? "on, by number and company name" : "on, by number") : "off"}` });
  revalidatePath("/certificates");
  return { ok: true, data: null };
}

export type VerifiableDesignInput = { template: VerifyTemplate; heading: string; intro: string; accent: string; contactEmail: string; contactPhone: string; accreditations: Accreditation[] };

/** How the public pages look (src/lib/verifiable/design.ts). Everything is checked here: it reaches an outsider's browser. */
export async function saveVerifiableDesign(input: VerifiableDesignInput): Promise<ActionResult<null>> {
  const user = await requireModuleUser("companies");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: "Changing this needs the right to change settings — ask an admin." };
  const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max) || null;
  const contactEmail = text(input?.contactEmail, 200);
  if (contactEmail && !/^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/.test(contactEmail)) return { ok: false, error: "That contact email doesn't look right." };
  const contactPhone = text(input?.contactPhone, 40);
  if (contactPhone && !/^[+0-9 ()-]{5,40}$/.test(contactPhone)) return { ok: false, error: "That contact phone doesn't look right." };
  const accentGiven = text(input?.accent, 7);
  const accent = accentGiven ? safeHex(accentGiven) : null;
  if (accentGiven && !accent) return { ok: false, error: "That colour isn't one we can use." };
  const given = Array.isArray(input?.accreditations) ? input.accreditations : [];
  if (given.some((a) => a?.logo && !safeLogo(a.logo))) return { ok: false, error: "An accreditation's logo must be a PNG, JPEG or WebP under 150 KB." };
  const data = {
    template: readTemplate(input?.template),
    heading: text(input?.heading, 80),
    intro: text(input?.intro, 240),
    accent,
    contactEmail,
    contactPhone,
    accreditations: readAccreditations(given) as unknown as Prisma.InputJsonValue,
    updatedById: user.id,
  };
  await db.verifiableSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "VerifiableSettings", entityId: "global", entityLabel: `Public certificate pages: ${data.template} template` });
  revalidatePath("/certificates/settings");
  return { ok: true, data: null };
}

/**
 * A document's public address and its QR code, to put on the certificate. The address to copy is the one this person is on. The
 * QR code is always the workspace's Deskzo address (owner, 7 Nov 2026): a certificate outlives a custom domain, and a printed code
 * that stops opening makes a real certificate look fake. While a custom domain works, that address redirects to it
 * (src/lib/tenancy/browse-host.ts), so a person scanning still lands there.
 */
export async function verifiableLink(id: string): Promise<ActionResult<{ url: string; qrUrl: string; qr: string }>> {
  const user = await requireModuleUser("companies");
  if (!(await hasEffectivePermission(user.id, "documents.view"))) return { ok: false, error: "You can't see documents." };
  const doc = await db.verifiableDocument.findFirst({ where: { AND: [{ id: String(id ?? "") }, await seenBy(user.id)] }, select: { token: true } });
  if (!doc) return { ok: false, error: "That document no longer exists." };
  const host = subdomainHost((await currentTenant()).slug);
  const qrUrl = `${protocolFor(host)}://${host}/v/${doc.token}`;
  return { ok: true, data: { url: `${await tenantOrigin()}/v/${doc.token}`, qrUrl, qr: await QRCode.toDataURL(qrUrl, { errorCorrectionLevel: "M", margin: 1, width: 480 }) } };
}
