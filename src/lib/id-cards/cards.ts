import { timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { dataUrlOrNull } from "@/lib/storage/files";
import { digestSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";
import { getOrganisation } from "@/lib/organisation";
import { getBranding } from "@/actions/branding";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";
import { DEFAULT_DESIGN, applyDesign, initialsOf, safeHex, type IdCardData, type IdCardDesign, type IdCardIssuer } from "@/lib/id-cards/design";

/**
 * Employee ID cards (owner, 31 Oct 2026): the design as stored, each card's details from the employee record, and the
 * address its QR code opens — `/id/<id>.<mac>`, the MAC under the workspace's own key, so an address can't be made up
 * for somebody else and a guard scanning a card sees whether it is still good (src/app/(public)/id/[token]).
 */

export async function readIdCardDesign(): Promise<IdCardDesign> {
  try {
    const row = await db.idCardSettings.findUnique({ where: { id: "global" } });
    if (!row) return DEFAULT_DESIGN;
    return {
      accentColor: safeHex(row.accentColor),
      showDepartment: row.showDepartment,
      showBloodGroup: row.showBloodGroup,
      showEmergencyContact: row.showEmergencyContact,
      showJoinedOn: row.showJoinedOn,
      showWorkPhone: row.showWorkPhone,
      showEmail: row.showEmail,
      showSignature: row.showSignature,
      backNote: row.backNote?.trim() || null,
    };
  } catch (err) {
    if (notMigratedYet(err)) return DEFAULT_DESIGN;
    throw err;
  }
}

// ── The check address ────────────────────────────────────────────────────────────────────────────────

/**
 * Which of a person's cards is the valid one (security audit, 11 Nov 2026 — SEC-66). A card's QR was the same for
 * life, so a lost card kept checking out as valid for as long as its owner worked here. Each reissue raises this, and
 * the address is made from it; version 0 is every card printed before, which stays valid until one is reissued.
 */
async function cardVersion(userId: string): Promise<number> {
  try {
    const row = await db.employeeProfile.findUnique({ where: { userId }, select: { idCardVersion: true } });
    return row?.idCardVersion ?? 0;
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}

async function cardMac(userId: string, version: number): Promise<string> {
  const what = version > 0 ? `id-card:${userId}:${version}` : `id-card:${userId}`;
  return (await digestSecret(what)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

export async function idCardToken(userId: string): Promise<string> {
  return `${userId}.${await cardMac(userId, await cardVersion(userId))}`;
}

/** A lost card: the person's next card has a new address, and the old one's no longer checks out. */
export async function reissueIdCard(userId: string): Promise<void> {
  await db.employeeProfile.upsert({
    where: { userId },
    create: { userId, idCardVersion: 1 },
    update: { idCardVersion: { increment: 1 } },
    select: { id: true },
  });
}

/** The person a card's address names, when its MAC is right. */
export async function userOfIdCardToken(token: string): Promise<string | null> {
  const [userId, mac, extra] = token.split(".");
  if (extra !== undefined || !userId || !mac || !/^[a-z0-9]{10,40}$/.test(userId)) return null;
  const expected = Buffer.from(await cardMac(userId, await cardVersion(userId)));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given) ? userId : null;
}

// ── Who issued them ──────────────────────────────────────────────────────────────────────────────────

const joinAddress = (parts: (string | null | undefined)[]) => parts.map((p) => p?.trim()).filter(Boolean).join(", ");

export async function idCardIssuer(design: IdCardDesign): Promise<IdCardIssuer> {
  const [org, branding] = await Promise.all([getOrganisation(), getBranding()]);
  return {
    company: org.tradeName?.trim() || org.legalName.trim() || branding.appName,
    logoDataUrl: branding.logoDataUrl,
    address: joinAddress([org.addressLine1, org.addressLine2, org.city, org.state, org.pincode]),
    phone: org.phone?.trim() || null,
    signatureDataUrl: design.showSignature ? org.signatureDataUrl : null,
    accent: design.accentColor ?? safeHex(branding.primaryColor) ?? "#0249fe",
  };
}

// ── Each card ────────────────────────────────────────────────────────────────────────────────────────

/** The cards of these people, in the order asked, showing what the design shows — somebody with no account here has none. */
export async function idCardsFor(userIds: string[], design: IdCardDesign): Promise<IdCardData[]> {
  return (await fullIdCards(userIds)).map((c) => applyDesign(c, design));
}

/** Every detail a card can show, before the design picks — what the design page's preview turns on and off as it is edited. */
export async function fullIdCards(userIds: string[]): Promise<IdCardData[]> {
  if (userIds.length === 0) return [];
  const [people, origin, clock] = await Promise.all([
    db.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        department: { select: { name: true } },
        photo: { select: { dataUrl: true } },
        employeeProfile: {
          select: {
            employeeCode: true,
            designation: true,
            bloodGroup: true,
            joinedOn: true,
            emergencyContactName: true,
            emergencyContactPhone: true,
            emergencyContactRelation: true,
          },
        },
      },
    }),
    tenantOrigin(),
    workspaceClock(),
  ]);
  const byId = new Map(people.map((p) => [p.id, p]));
  const cards: IdCardData[] = [];
  for (const id of userIds) {
    const p = byId.get(id);
    if (!p) continue;
    const e = p.employeeProfile;
    const qrDataUrl = await QRCode.toDataURL(`${origin}/id/${await idCardToken(p.id)}`, { errorCorrectionLevel: "M", margin: 1, width: 240 });
    cards.push({
      userId: p.id,
      name: p.name,
      // A photo kept in the storage box comes back as the same data URL; one the box has lost is simply not drawn.
      photoDataUrl: await dataUrlOrNull(p.photo?.dataUrl),
      initials: initialsOf(p.name),
      employeeCode: e?.employeeCode ?? null,
      designation: e?.designation?.trim() || null,
      department: p.department?.name ?? null,
      bloodGroup: e?.bloodGroup?.trim() || null,
      joinedOn: e?.joinedOn ? clock.date(e.joinedOn) : null,
      workPhone: p.phone?.trim() || null,
      email: p.email,
      emergency: e?.emergencyContactPhone?.trim()
        ? { name: e.emergencyContactName?.trim() || null, phone: e.emergencyContactPhone.trim(), relation: e.emergencyContactRelation?.trim() || null }
        : null,
      qrDataUrl,
    });
  }
  return cards;
}

/**
 * What a scanned card shows anybody: whose it is, and whether it is still good — an active account whose last day, if
 * one is recorded, hasn't passed. Nothing else from the record: no blood group, phone or contact.
 */
export async function idCardCheck(userId: string): Promise<{ name: string; designation: string | null; employeeCode: string | null; photoDataUrl: string | null; valid: boolean } | null> {
  const [person, clock] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { name: true, active: true, photo: { select: { dataUrl: true } }, employeeProfile: { select: { designation: true, employeeCode: true, exitedOn: true } } },
    }),
    workspaceClock(),
  ]);
  if (!person) return null;
  const today = clock.calendarDate(new Date());
  const exited = person.employeeProfile?.exitedOn;
  const valid = person.active && (!exited || exited >= today);
  return {
    name: person.name,
    designation: valid ? (person.employeeProfile?.designation ?? null) : null,
    employeeCode: person.employeeProfile?.employeeCode ?? null,
    photoDataUrl: valid ? await dataUrlOrNull(person.photo?.dataUrl) : null,
    valid,
  };
}

/** Everyone a card can be printed for, with what their card is missing: those still working here, by name. */
export async function idCardPeople(): Promise<
  { id: string; name: string; employeeCode: string | null; designation: string | null; departmentId: string | null; department: string | null; hasPhoto: boolean; missing: string[] }[]
> {
  const [people, clock] = await Promise.all([
    db.user.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        photoUpdatedAt: true,
        departmentId: true,
        department: { select: { name: true } },
        employeeProfile: { select: { employeeCode: true, designation: true, bloodGroup: true, emergencyContactPhone: true, exitedOn: true } },
      },
    }),
    workspaceClock(),
  ]);
  const today = clock.calendarDate(new Date());
  return people
    .filter((p) => !p.employeeProfile?.exitedOn || p.employeeProfile.exitedOn >= today)
    .map((p) => {
      const e = p.employeeProfile;
      const missing = [
        !p.photoUpdatedAt && "photo",
        !e?.employeeCode && "employee code",
        !e?.designation && "designation",
        !e?.bloodGroup && "blood group",
        !e?.emergencyContactPhone && "emergency contact",
      ].filter((m): m is string => !!m);
      return { id: p.id, name: p.name, employeeCode: e?.employeeCode ?? null, designation: e?.designation ?? null, departmentId: p.departmentId, department: p.department?.name ?? null, hasPhoto: !!p.photoUpdatedAt, missing };
    });
}
