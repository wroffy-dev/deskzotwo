import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { mayAccessAccount } from "@/lib/authz/access";
import { moduleAccessFor, moduleAvailableForTenant } from "@/lib/modules-access";
import { documentWriteKey } from "@/lib/documents/write-permission";
import { STILL_THERE } from "@/lib/contacts/left";
import { contactMasker } from "@/lib/contacts/masking";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { resolveResellerPrice, type ResellerPriceSource } from "@/lib/reseller-pricing";
import { keepDataUrl, storedFile } from "@/lib/storage/files";
import { fileRefusal, isStorageFull } from "@/lib/file-refusal";
import { checkAttachedFile } from "@/lib/projects/questionnaire-server";
import { companyPath } from "@/lib/record-links";
import { LIMITS, formatRequestId } from "@/lib/quote-requests-shared";

/**
 * Quote requests from resellers (owner, 26 Nov 2026: "can we add same kind of feature?" — a partner's own "Request a
 * quotation" link — then "Yes, build it" on the mockup).
 *
 * A seller gives one person at a reseller their own link (/rfq/<token>). The reseller's company and that person are fixed
 * by the link, so a request is always theirs; they say who it is for (the end customer — never contacted directly, as
 * every reseller's customer), what, by when and where, and may attach their RFQ. It lands on the reseller's page as
 * RFQ-000041 and their account manager is told. "Create quote" starts a quotation to the reseller with its lines matched
 * to the catalogue at the reseller's own prices (special price, else their tier discount, else the list price); a line
 * that matches nothing stays as they typed it. A quotation whose reference names the request marks it quoted.
 *
 * Who may: anybody who may open Resellers and sees that reseller works its requests; sending a link also takes Create
 * quotes, since that is what it asks for. No new permission (permissions are Himanshu's). The public side asks only that
 * the workspace has Resellers, the link is live, the company is still a reseller and the person is still there.
 *
 * Plain, not "use server": the actions wrap it, and check scripts call it.
 */

export { LIMITS, RFQ_FILE_ACCEPT, formatRequestId } from "@/lib/quote-requests-shared";
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const requestLinkUrl = (origin: string, token: string) => `${origin.replace(/\/+$/, "")}/rfq/${token}`;

const DAY = 86_400_000;

// ─── Who may ──────────────────────────────────────────────────────────────────────────────────────────

type Reseller = { id: string; name: string; companySeq: number; ownerUserId: string | null; relationshipType: "RESELLER" };

/** The reseller, when this person may work its quote requests — else null, as for one that isn't there. */
export async function resellerFor(userId: string, resellerId: unknown): Promise<Reseller | null> {
  if (typeof resellerId !== "string" || !resellerId) return null;
  if ((await moduleAccessFor(userId, "resellers")) !== "available") return null;
  const company = await db.company.findUnique({ where: { id: resellerId }, select: { id: true, name: true, companySeq: true, ownerUserId: true, relationshipType: true } });
  if (!company || company.relationshipType !== "RESELLER") return null;
  if (!(await mayAccessAccount(userId, "view", company))) return null;
  return company as Reseller;
}

export const maySendLinks = (userId: string) => can(userId, documentWriteKey("PROPOSAL", "create"));

// ─── Links ────────────────────────────────────────────────────────────────────────────────────────────

/** A new link for one person at the reseller. The token is shown once; only its hash is kept. */
export async function createLink(userId: string, resellerId: string, contactId: unknown): Promise<{ ok: true; token: string; contact: { id: string; name: string; email: string | null } } | { ok: false; error: string }> {
  const reseller = await resellerFor(userId, resellerId);
  if (!reseller) return { ok: false, error: "Reseller not found." };
  if (!(await maySendLinks(userId))) return { ok: false, error: "Sending a quote request link needs permission to create quotations." };
  if (typeof contactId !== "string" || !contactId) return { ok: false, error: "Choose who at the reseller it's for." };
  const contact = await db.contact.findFirst({ where: { id: contactId, companyId: reseller.id, ...STILL_THERE }, select: { id: true, name: true, email: true } });
  if (!contact) return { ok: false, error: "That person isn't at this reseller." };
  const token = randomBytes(24).toString("base64url");
  await db.quoteRequestLink.create({ data: { tokenHash: hashToken(token), resellerId: reseller.id, contactId: contact.id, createdById: userId } });
  return { ok: true, token, contact };
}

export async function revokeLink(userId: string, linkId: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof linkId !== "string" || !linkId) return { ok: false, error: "Link not found." };
  const link = await db.quoteRequestLink.findUnique({ where: { id: linkId }, select: { resellerId: true, revokedAt: true } });
  if (!link || !(await resellerFor(userId, link.resellerId))) return { ok: false, error: "Link not found." };
  if (!link.revokedAt) await db.quoteRequestLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
  return { ok: true };
}

/** The live link a token opens, with its reseller and person — null for every way it can be wrong. */
export async function linkForToken(token: unknown) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{30,64}$/.test(token)) return null;
  try {
    if (!(await moduleAvailableForTenant("resellers"))) return null;
    const link = await db.quoteRequestLink.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!link || link.revokedAt) return null;
    const [reseller, contact] = await Promise.all([
      db.company.findUnique({ where: { id: link.resellerId }, select: { id: true, name: true, ownerUserId: true, relationshipType: true } }),
      db.contact.findFirst({ where: { id: link.contactId, companyId: link.resellerId, ...STILL_THERE }, select: { id: true, name: true, email: true, phone: true } }),
    ]);
    if (!reseller || reseller.relationshipType !== "RESELLER" || !contact) return null;
    return { link, reseller, contact };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

// ─── A request, sent ──────────────────────────────────────────────────────────────────────────────────

export type RequestInput = {
  endCustomerName: string;
  endCustomerCountry: string;
  dealReference: string;
  neededBy: string;
  deliveryLocation: string;
  budget: string;
  notes: string;
  lines: { description: string; quantity: string; brand: string; notes: string }[];
};

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/** The form, read and checked: what is kept, or what to fix. */
export function checkRequest(raw: unknown, today: string): { ok: true; value: RequestInput } | { ok: false; error: string; errors: Record<string, string> } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const lines = (Array.isArray(r.lines) ? r.lines : [])
    .slice(0, LIMITS.lines + 1)
    .map((l) => {
      const o = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
      return { description: text(o.description, LIMITS.text), quantity: text(o.quantity, 9), brand: text(o.brand, LIMITS.text), notes: text(o.notes, LIMITS.text) };
    })
    .filter((l) => l.description || l.quantity || l.brand || l.notes);
  if (lines.length === 0) errors.lines = "Add at least one item.";
  if (lines.length > LIMITS.lines) errors.lines = `${LIMITS.lines} items at most — attach a list for more.`;
  lines.forEach((l, i) => {
    if (!l.description) errors[`lines.${i}`] = "Say what the item is.";
    else if (l.quantity && !/^[1-9]\d{0,6}$/.test(l.quantity)) errors[`lines.${i}`] = "The quantity is a whole number.";
  });
  const value: RequestInput = {
    endCustomerName: text(r.endCustomerName, 200),
    endCustomerCountry: text(r.endCustomerCountry, 80),
    dealReference: text(r.dealReference, 120),
    neededBy: text(r.neededBy, 10),
    deliveryLocation: text(r.deliveryLocation, 200),
    budget: text(r.budget, 80),
    notes: text(r.notes, LIMITS.notes),
    lines,
  };
  if (!value.endCustomerName) errors.endCustomerName = "Who is it for? Their company name is enough.";
  if (value.neededBy && (!/^\d{4}-\d{2}-\d{2}$/.test(value.neededBy) || Number.isNaN(Date.parse(`${value.neededBy}T00:00:00Z`)))) errors.neededBy = "That isn't a date.";
  else if (value.neededBy && value.neededBy < today) errors.neededBy = "That day has passed.";
  if (Object.keys(errors).length) return { ok: false, error: "A few things need another look.", errors };
  return { ok: true, value };
}

/** Kept, the account manager told. The file, when there is one, is checked and kept first: refused, nothing is written. */
export async function submitRequest(
  link: { id: string; resellerId: string; contactId: string; createdById: string },
  value: RequestInput,
  file: { name: string; bytes: Buffer } | null,
  now: Date = new Date(),
): Promise<{ ok: true; reference: string } | { ok: false; error: string }> {
  const today = await db.quoteRequest.count({ where: { linkId: link.id, createdAt: { gte: new Date(now.getTime() - DAY) } } });
  if (today >= LIMITS.perLinkPerDay) return { ok: false, error: "That's a lot of requests in a day from this link — send the rest tomorrow, or ask your account manager." };
  let kept: { fileName: string; fileMime: string; fileSize: number; fileDataUrl: string } | null = null;
  if (file) {
    const checked = checkAttachedFile(file.name, file.bytes, LIMITS.fileBytes);
    if (!checked.ok) return checked;
    try {
      const fileDataUrl = await keepDataUrl("quote-requests", `data:${checked.mime};base64,${file.bytes.toString("base64")}`);
      kept = { fileName: checked.name, fileMime: checked.mime, fileSize: file.bytes.length, fileDataUrl };
    } catch (err) {
      if (isStorageFull(err)) return { ok: false, error: `${checked.name} can't be attached just now. Send the request without it, and email the file to your account manager.` };
      const refusal = fileRefusal(err);
      if (refusal !== null) return { ok: false, error: refusal };
      throw err;
    }
  }
  const made = await db.quoteRequest.create({
    data: {
      linkId: link.id,
      resellerId: link.resellerId,
      contactId: link.contactId,
      endCustomerName: value.endCustomerName,
      endCustomerCountry: value.endCustomerCountry || null,
      dealReference: value.dealReference || null,
      neededBy: value.neededBy ? new Date(`${value.neededBy}T00:00:00Z`) : null,
      deliveryLocation: value.deliveryLocation || null,
      budget: value.budget || null,
      notes: value.notes || null,
      ...(kept ?? {}),
      lines: { create: value.lines.map((l, i) => ({ position: i, description: l.description, quantity: l.quantity ? Number(l.quantity) : 1, brand: l.brand || null, notes: l.notes || null })) },
    },
    select: { requestSeq: true },
  });
  await db.quoteRequestLink.update({ where: { id: link.id }, data: { lastUsedAt: now } });
  const reference = formatRequestId(made.requestSeq);
  const reseller = await db.company.findUnique({ where: { id: link.resellerId }, select: { name: true, companySeq: true, ownerUserId: true } });
  // The account manager; with none, whoever sent the link.
  const to = reseller?.ownerUserId ?? link.createdById;
  if (reseller && to) {
    await notifyUser({
      userId: to,
      type: "PORTAL_REQUEST",
      title: `${reseller.name} asked for a quotation — ${reference}`,
      message: `${value.lines.length} item${value.lines.length === 1 ? "" : "s"} for ${value.endCustomerName}`,
      link: `${companyPath(reseller.companySeq)}#quote-requests`,
    });
  }
  return { ok: true, reference };
}

// ─── The catalogue, at the reseller's prices ─────────────────────────────────────────────────────────

export type MatchedLine = {
  id: string;
  description: string;
  quantity: number;
  brand: string | null;
  notes: string | null;
  item: { id: string; name: string; type: string; description: string | null; hsnCode: string | null; unit: string | null; taxRatePercent: number | null } | null;
  price: { unitPrice: number; source: ResellerPriceSource } | null;
};

const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Each line's item: one named or with the SKU exactly what they typed (or with the brand before it), else the one item
 * whose name holds what they typed. Two candidates match neither — a guess on a quotation is worse than a blank.
 */
export async function matchLines(resellerId: string, lines: { id: string; description: string; quantity: number; brand: string | null; notes: string | null }[]): Promise<MatchedLine[]> {
  const select = { id: true, name: true, sku: true, type: true, description: true, hsnCode: true, unit: true, taxRatePercent: true, sellingPrice: true } as const;
  const wanted = [...new Set(lines.flatMap((l) => [l.description, l.brand ? `${l.brand} ${l.description}` : ""]).filter(Boolean))];
  const exact = wanted.length
    ? await db.item.findMany({ where: { active: true, OR: wanted.flatMap((w) => [{ name: { equals: w, mode: "insensitive" as const } }, { sku: { equals: w, mode: "insensitive" as const } }]) }, select })
    : [];
  const [profile, special] = await Promise.all([
    db.resellerProfile.findUnique({ where: { companyId: resellerId }, select: { discountPercent: true } }),
    db.resellerItemPrice.findMany({ where: { resellerId }, select: { itemId: true, price: true } }),
  ]);
  const specialOf = new Map(special.map((s) => [s.itemId, Number(s.price)]));
  const out: MatchedLine[] = [];
  for (const l of lines) {
    const tries = [l.brand ? key(`${l.brand} ${l.description}`) : "", key(l.description)].filter(Boolean);
    let found = exact.filter((i) => tries.some((t) => key(i.name) === t || key(i.sku) === t));
    if (found.length !== 1 && l.description.length >= 4) {
      found = await db.item.findMany({ where: { active: true, name: { contains: l.description, mode: "insensitive" } }, select, take: 2 });
    }
    const item = found.length === 1 ? found[0]! : null;
    out.push({
      ...l,
      item: item ? { id: item.id, name: item.name, type: item.type, description: item.description, hsnCode: item.hsnCode, unit: item.unit, taxRatePercent: item.taxRatePercent === null ? null : Number(item.taxRatePercent) } : null,
      price: item
        ? resolveResellerPrice({ catalogPrice: Number(item.sellingPrice), specialPrice: specialOf.get(item.id) ?? null, discountPercent: profile?.discountPercent == null ? null : Number(profile.discountPercent) })
        : null,
    });
  }
  return out;
}

// ─── The reseller's page ─────────────────────────────────────────────────────────────────────────────

export type RequestView = {
  id: string;
  reference: string;
  createdAt: Date;
  contactName: string | null;
  endCustomerName: string;
  endCustomerCountry: string | null;
  dealReference: string | null;
  neededBy: string | null;
  deliveryLocation: string | null;
  budget: string | null;
  notes: string | null;
  file: { name: string; size: number } | null;
  assignedTo: { id: string; name: string } | null;
  state: "new" | "quoted" | "declined";
  declineReason: string | null;
  quotes: { id: string; docNumber: string }[];
  lines: MatchedLine[];
};
export type LinkView = { id: string; contactName: string; createdAt: Date; lastUsedAt: Date | null };

/** Its requests, newest first, and its live links — for one this person may work. */
export async function resellerRequests(userId: string, resellerId: string): Promise<{ requests: RequestView[]; links: LinkView[]; maySend: boolean; contacts: { id: string; name: string; email: string | null }[] } | null> {
  const reseller = await resellerFor(userId, resellerId);
  if (!reseller) return null;
  try {
    const [rows, links, contacts, maySend] = await Promise.all([
      db.quoteRequest.findMany({ where: { resellerId }, orderBy: { createdAt: "desc" }, take: 30, include: { lines: { orderBy: { position: "asc" } } } }),
      db.quoteRequestLink.findMany({ where: { resellerId, revokedAt: null }, orderBy: { createdAt: "desc" } }),
      db.contact.findMany({ where: { companyId: resellerId, ...STILL_THERE }, orderBy: [{ isPrimary: "desc" }, { name: "asc" }], select: { id: true, name: true, email: true } }),
      maySendLinks(userId),
    ]);
    const people = await contactMasker(userId, "list", [...new Set([...contacts.map((c) => c.id), ...rows.flatMap((r) => (r.contactId ? [r.contactId] : []))])]);
    const nameOf = (c: { id: string; name: string }) => (people.active ? (people.present(c.id, "name", c.name) ?? "") : c.name);
    const contactNames = new Map(contacts.map((c) => [c.id, nameOf(c)]));
    const others = rows.map((r) => r.contactId).filter((id): id is string => !!id && !contactNames.has(id));
    if (others.length) for (const c of await db.contact.findMany({ where: { id: { in: others } }, select: { id: true, name: true } })) contactNames.set(c.id, nameOf(c));
    const users = [...new Set(rows.map((r) => r.assignedToUserId).filter((id): id is string => !!id))];
    const userNames = new Map((users.length ? await db.user.findMany({ where: { id: { in: users } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
    // A quotation to this reseller that names the request in its reference has quoted it.
    const quotes = rows.length
      ? await db.tradeDocument.findMany({
          where: { companyId: resellerId, docType: "PROPOSAL", status: { not: "CANCELLED" }, OR: rows.map((r) => ({ reference: { contains: formatRequestId(r.requestSeq) } })) },
          select: { id: true, docNumber: true, reference: true },
        })
      : [];
    const requests = await Promise.all(
      rows.map(async (r): Promise<RequestView> => {
        const reference = formatRequestId(r.requestSeq);
        const quoted = quotes.filter((q) => q.reference?.includes(reference)).map((q) => ({ id: q.id, docNumber: q.docNumber }));
        return {
          id: r.id,
          reference,
          createdAt: r.createdAt,
          contactName: r.contactId ? (contactNames.get(r.contactId) ?? null) : null,
          endCustomerName: r.endCustomerName,
          endCustomerCountry: r.endCustomerCountry,
          dealReference: r.dealReference,
          neededBy: r.neededBy ? r.neededBy.toISOString().slice(0, 10) : null,
          deliveryLocation: r.deliveryLocation,
          budget: r.budget,
          notes: r.notes,
          file: r.fileName && r.fileSize ? { name: r.fileName, size: r.fileSize } : null,
          assignedTo: r.assignedToUserId ? { id: r.assignedToUserId, name: userNames.get(r.assignedToUserId) ?? "Somebody who left" } : null,
          state: r.declinedAt ? "declined" : quoted.length ? "quoted" : "new",
          declineReason: r.declineReason,
          quotes: quoted,
          lines: await matchLines(resellerId, r.lines),
        };
      }),
    );
    return {
      requests,
      links: links.map((l) => ({ id: l.id, contactName: contactNames.get(l.contactId) ?? "Somebody who left", createdAt: l.createdAt, lastUsedAt: l.lastUsedAt })),
      maySend,
      contacts: contacts.map((c) => ({ id: c.id, name: contactNames.get(c.id) ?? "", email: c.email })),
    };
  } catch (err) {
    if (notMigratedYet(err)) return { requests: [], links: [], maySend: false, contacts: [] };
    throw err;
  }
}

/** One request this person may work, by id. */
async function requestFor(userId: string, requestId: unknown) {
  if (typeof requestId !== "string" || !requestId) return null;
  const request = await db.quoteRequest.findUnique({ where: { id: requestId }, include: { lines: { orderBy: { position: "asc" } } } });
  if (!request || !(await resellerFor(userId, request.resellerId))) return null;
  return request;
}

export async function assignRequest(userId: string, requestId: unknown, assigneeId: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const request = await requestFor(userId, requestId);
  if (!request) return { ok: false, error: "Request not found." };
  const to = typeof assigneeId === "string" && assigneeId ? await db.user.findFirst({ where: { id: assigneeId, active: true, kind: "MEMBER" }, select: { id: true } }) : null;
  if (assigneeId && !to) return { ok: false, error: "That person can't be given it." };
  await db.quoteRequest.update({ where: { id: request.id }, data: { assignedToUserId: to?.id ?? null } });
  if (to && to.id !== userId) {
    const reseller = await db.company.findUnique({ where: { id: request.resellerId }, select: { name: true, companySeq: true } });
    if (reseller) {
      await notifyUser({ userId: to.id, type: "PORTAL_REQUEST", title: `${formatRequestId(request.requestSeq)} from ${reseller.name} is yours to quote`, message: `For ${request.endCustomerName}`, link: `${companyPath(reseller.companySeq)}#quote-requests` });
    }
  }
  return { ok: true };
}

export async function declineRequest(userId: string, requestId: unknown, reason: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const request = await requestFor(userId, requestId);
  if (!request) return { ok: false, error: "Request not found." };
  const why = text(reason, 300);
  if (!why) return { ok: false, error: "Say why, so whoever reads it later knows." };
  await db.quoteRequest.update({ where: { id: request.id }, data: { declinedAt: new Date(), declinedById: userId, declineReason: why } });
  return { ok: true };
}

/** The file they attached, for somebody who may work the request. */
export async function requestFile(userId: string, requestId: unknown) {
  const request = await requestFor(userId, requestId);
  if (!request?.fileDataUrl) return null;
  const file = await storedFile(request.fileDataUrl, request.fileMime ?? undefined);
  return file ? { ...file, name: request.fileName ?? "attachment" } : null;
}

/** What "Create quote" starts from: the reseller, the reference that marks the request quoted, and its lines priced. */
export async function quoteStart(userId: string, requestId: unknown) {
  const request = await requestFor(userId, requestId);
  if (!request || request.declinedAt) return null;
  const lines = await matchLines(request.resellerId, request.lines);
  const reference = `${formatRequestId(request.requestSeq)} · for ${request.endCustomerName}`.slice(0, 190);
  const notes = [
    `For ${request.endCustomerName}${request.endCustomerCountry ? `, ${request.endCustomerCountry}` : ""}.`,
    request.dealReference ? `Their reference: ${request.dealReference}.` : "",
    request.deliveryLocation ? `Delivery: ${request.deliveryLocation}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { resellerId: request.resellerId, reference, notes, lines };
}
