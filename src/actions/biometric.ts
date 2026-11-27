"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { parseAttlog } from "@/lib/hr/iclock";
import { linkPunchesToUsers, rollupPunches } from "@/lib/hr/punch-rollup";
import { dateOnly } from "@/lib/hr/calendar";
import { claimDeviceSerial, releaseDeviceSerial } from "@/lib/platform/device-routes";
import { workspaceZone } from "@/lib/time/workspace";
import { cidrSize, normaliseIp, parseCidr } from "@/lib/access/ip";
import { deviceKeyDigest, deviceKeyPath, devicesWithKey, newDeviceKey } from "@/lib/hr/device-key";
import { notMigratedYet } from "@/lib/not-migrated";
import { refuseWhileViewingAs } from "@/lib/session";
import type { ActionResult } from "@/actions/company";
import { clip, clipOrNull, TEXT_MAX } from "@/lib/text/bounded";
import { readTimeZone } from "@/lib/time/zones";

/**
 * Registering terminals, mapping enrolment numbers to people, and the manual import fallback.
 *
 * All of it is HR's, behind `hr.manage`: a terminal registration decides whose uploads are believed,
 * and an enrolment mapping decides whose attendance a punch becomes.
 */

async function requireHr() {
  const user = await requireModuleAccess("hr");
  const allowed = await hasEffectivePermission(user.id, "hr.manage");
  return { user, allowed };
}

// ─── Devices ──────────────────────────────────────────────────────────────────

export async function listBiometricDevices() {
  const { allowed } = await requireHr();
  if (!allowed) return [];
  const rows = await db.biometricDevice.findMany({
    // A removed terminal is gone from the list; its punches stay (removeBiometricDevice).
    where: { removedAt: null },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { punches: true } } },
  });
  // Whether each has its own secret address (SEC-06) — never the key, which is shown once when made.
  const keyed = await devicesWithKey(rows.map((r) => r.id));
  return toPlain(rows.map((r) => ({ ...r, hasKey: keyed.has(r.id) })));
}

/**
 * Gives a terminal its own secret address, or a new one (owner, 12 Nov 2026 — security audit SEC-06;
 * src/lib/hr/device-key.ts). From this moment the terminal is answered only at that address, so it stops sending until
 * the address is typed into it — the key is returned here once and never shown again.
 */
export async function issueBiometricDeviceKey(id: string): Promise<ActionResult<{ path: string }>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can change a terminal." };
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  if (typeof id !== "string") return { ok: false, error: "Which terminal?" };
  const device = await db.biometricDevice.findUnique({ where: { id }, select: { name: true, serialNumber: true, removedAt: true } });
  if (!device || device.removedAt) return { ok: false, error: "That terminal has been removed." };
  const key = newDeviceKey();
  try {
    await db.biometricDevice.update({ where: { id }, data: { accessKeyHash: await deviceKeyDigest(key) }, select: { id: true } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace is being updated — try again in a few minutes." };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "BiometricDevice", entityId: id, entityLabel: `${device.name} (${device.serialNumber}) given a secret address — it is answered only there now` });
  revalidatePath("/people/devices");
  return { ok: true, data: { path: deviceKeyPath(key) } };
}

/** Back to the plain address: the terminal is answered by its serial alone again. */
export async function clearBiometricDeviceKey(id: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can change a terminal." };
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  if (typeof id !== "string") return { ok: false, error: "Which terminal?" };
  const device = await db.biometricDevice.findUnique({ where: { id }, select: { name: true, serialNumber: true } });
  if (!device) return { ok: false, error: "That terminal has been removed." };
  try {
    await db.biometricDevice.update({ where: { id }, data: { accessKeyHash: null }, select: { id: true } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: true, data: null };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "BiometricDevice", entityId: id, entityLabel: `${device.name} (${device.serialNumber}) secret address removed — its serial alone is believed again` });
  revalidatePath("/people/devices");
  return { ok: true, data: null };
}

/** More than any terminal needs; a list this long is a paste gone wrong. */
const MAX_ALLOWED_IPS = 20;

/**
 * The addresses a terminal may call from, as HR typed them (audit M-8): each an exact IP or a CIDR range, checked
 * and stored in its one canonical spelling — an exact address as itself, a range with its host bits cleared — so
 * the Edit dialog shows what the list actually covers. Blanks and repeats are dropped; anything that isn't an
 * address refuses the save, rather than being dropped and leaving a list that admits less, or more, than HR meant.
 * A range wider than any office (as the network rules refuse, src/actions/access-control.ts) is refused too: it
 * would look like a lock while holding nothing — the empty list says "any address" honestly.
 */
function readAllowedIps(raw: unknown): { ok: true; list: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) return { ok: false, error: "List the addresses one by one." };
  const list: string[] = [];
  for (const entry of (raw as string[]).map((e) => e.trim()).filter(Boolean)) {
    const cidr = entry.length <= 64 ? parseCidr(entry) : null;
    if (!cidr) return { ok: false, error: `“${entry.slice(0, 64)}” isn't an address or a range. Try 203.0.113.7 or 203.0.113.0/24.` };
    if (cidr.prefix < (cidr.version === 4 ? 8 : 16)) {
      return { ok: false, error: `${cidr.text} covers ${cidrSize(cidr).toString()} addresses — far more than any office. Narrow it down, or leave the list empty to accept the terminal from anywhere.` };
    }
    const exact = cidr.prefix === (cidr.version === 4 ? 32 : 128);
    const canonical = exact ? (normaliseIp(entry.split("/")[0]) ?? cidr.text) : cidr.text;
    if (!list.includes(canonical)) list.push(canonical);
  }
  if (list.length > MAX_ALLOWED_IPS) return { ok: false, error: `At most ${MAX_ALLOWED_IPS} addresses — use a range for an office network.` };
  return { ok: true, list };
}

export async function saveBiometricDevice(input: {
  id?: string;
  serialNumber: string;
  name: string;
  location?: string;
  timezone?: string;
  active?: boolean;
  /**
   * The addresses it may call from (audit M-8); empty for any. Left out, an edit keeps the list it has and a new
   * terminal starts with none — so a caller that doesn't know about the list can't clear it by accident.
   */
  allowedIps?: string[];
  /**
   * With no list, whether its uploads are taken from any address (security audit, Nov 2026). Left out, an edit keeps
   * what it has and a new terminal starts with it off — refused until it has a list or this is ticked.
   */
  acceptAnyAddress?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can register a biometric terminal." };

  // Capped as read (owner, 15 Nov 2026 — input bounds); a zone sent has to be a real one.
  const serialNumber = clip(input.serialNumber, TEXT_MAX.id).toUpperCase();
  const name = clip(input.name, TEXT_MAX.name);
  const timezone = typeof input.timezone === "string" && input.timezone.trim() ? readTimeZone(input.timezone) : null;
  if (typeof input.timezone === "string" && input.timezone.trim() && !timezone) return { ok: false, error: "That isn't a time zone we know." };
  if (!serialNumber) return { ok: false, error: "The serial number is what identifies the device — it can't be blank." };
  if (!name) return { ok: false, error: "Give the terminal a name." };
  const allowedIps = input.allowedIps === undefined ? null : readAllowedIps(input.allowedIps);
  if (allowedIps && !allowedIps.ok) return allowedIps;
  // Without TRUST_PROXY=1 no caller's address is known (src/lib/client-ip.ts), so a list would refuse the terminal
  // on every call — said now, not discovered when its punches stop arriving (as the platform health page warns).
  if (allowedIps?.list.length && process.env.TRUST_PROXY?.trim() !== "1") {
    return { ok: false, error: "This server can't see the address a call comes from, so a list would refuse the terminal every time. Leave it empty, or ask whoever runs the server to set it up behind its proxy (TRUST_PROXY)." };
  }

  const payload = {
    serialNumber,
    name,
    location: clipOrNull(input.location, TEXT_MAX.name),
    // A terminal keeps the office's time, which is the workspace's unless HR says otherwise.
    timezone: timezone || (await workspaceZone()),
    active: input.active ?? true,
    ...(allowedIps ? { allowedIps: allowedIps.list } : {}),
    ...(typeof input.acceptAnyAddress === "boolean" ? { acceptAnyAddress: input.acceptAnyAddress } : {}),
  };

  /**
   * The serial is claimed for this workspace first (src/lib/platform/device-routes.ts): a terminal on
   * a bare IP address reaches its workspace by it, so one registered in another workspace is refused
   * here rather than silently sharing its punches. The serial it replaces, if any, is let go only once
   * the change is saved — until then the terminal still sends under the old one.
   */
  const claim = await claimDeviceSerial(serialNumber);
  if (!claim.ok) return claim;
  const before = input.id ? await db.biometricDevice.findUnique({ where: { id: input.id }, select: { serialNumber: true } }) : null;
  // A serial registered again after its terminal was removed brings that terminal back, punches and all.
  const removed = input.id ? null : await db.biometricDevice.findFirst({ where: { serialNumber, removedAt: { not: null } }, select: { id: true } });

  try {
    const select = { id: true, allowedIps: true, acceptAnyAddress: true } as const;
    const row = input.id
      ? await db.biometricDevice.update({ where: { id: input.id }, data: payload, select })
      : removed
        ? await db.biometricDevice.update({ where: { id: removed.id }, data: { ...payload, removedAt: null, removedById: null }, select })
        : await db.biometricDevice.create({ data: payload, select });
    if (before && before.serialNumber !== serialNumber) await releaseDeviceSerial(before.serialNumber);

    await recordAudit({
      userId: user.id,
      action: input.id ? "UPDATE" : "CREATE",
      entityType: "BiometricDevice",
      entityId: row.id,
      // Which addresses it is answered from is part of who is believed (M-8), so the entry says.
      entityLabel: `${name} (${serialNumber})${payload.active ? "" : " — disabled"} — ${row.allowedIps.length ? `accepted only from ${row.allowedIps.join(", ")}` : row.acceptAnyAddress ? "accepted from any address" : "uploads refused until it has an address list"}`,
    });
    revalidatePath("/people/devices");
    return { ok: true, data: { id: row.id } };
  } catch {
    return { ok: false, error: `Serial ${serialNumber} is already registered.` };
  }
}

export async function setBiometricDeviceActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can change a terminal." };
  if (typeof id !== "string" || typeof active !== "boolean") return { ok: false, error: "On or off?" };

  const current = await db.biometricDevice.findUnique({ where: { id }, select: { removedAt: true } });
  if (!current || current.removedAt) return { ok: false, error: "That terminal has been removed." };
  const device = await db.biometricDevice.update({
    where: { id },
    data: { active },
    select: { name: true, serialNumber: true },
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "BiometricDevice",
    entityId: id,
    entityLabel: `${device.name} (${device.serialNumber}) ${active ? "enabled" : "disabled — its uploads are now refused"}`,
  });
  revalidatePath("/people/devices");
  return { ok: true, data: null };
}

/**
 * Takes a terminal off the list (owner, 2 Nov 2026). It is refused from that moment, like one switched off, and
 * its serial is let go — but the row stays, hidden, with every punch it sent: they are the evidence behind
 * attendance already worked out, and deleting the row would delete them with it. Registering the same serial
 * again brings it back.
 */
export async function removeBiometricDevice(id: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can remove a terminal." };
  if (typeof id !== "string") return { ok: false, error: "Which terminal?" };

  const device = await db.biometricDevice.findUnique({ where: { id }, select: { name: true, serialNumber: true, removedAt: true, _count: { select: { punches: true } } } });
  if (!device) return { ok: false, error: "That terminal is no longer there." };
  if (device.removedAt) return { ok: true, data: null };

  await db.biometricDevice.update({ where: { id }, data: { removedAt: new Date(), removedById: user.id, active: false } });
  await releaseDeviceSerial(device.serialNumber);
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "BiometricDevice",
    entityId: id,
    entityLabel: `${device.name} (${device.serialNumber}) removed — its uploads are refused; its ${device._count.punches} punch(es) are kept`,
  });
  revalidatePath("/people/devices");
  return { ok: true, data: null };
}

// ─── Mapping enrolment numbers to people ──────────────────────────────────────

/**
 * Enrolment numbers seen on the terminals that belong to nobody yet.
 *
 * The whole reason unmatched punches are kept: this list is the work queue, and mapping a number
 * recovers everything already collected against it rather than starting from today.
 */
export async function unmappedEnrolments() {
  const { allowed } = await requireHr();
  if (!allowed) return [];

  const rows = await db.biometricPunch.groupBy({
    by: ["deviceUserId"],
    where: { userId: null },
    _count: { _all: true },
    _min: { punchedAt: true },
    _max: { punchedAt: true },
    orderBy: { _max: { punchedAt: "desc" } },
    take: 100,
  });

  return rows.map((r) => ({
    deviceUserId: r.deviceUserId,
    punches: r._count._all,
    firstSeen: r._min.punchedAt?.toISOString() ?? null,
    lastSeen: r._max.punchedAt?.toISOString() ?? null,
  }));
}

/**
 * Attaches a terminal enrolment number to a person, then replays the punches it already has.
 *
 * The replay is the point. Somebody enrolled on Monday and mapped on Friday gets the week's
 * attendance rather than losing it — and without it the obvious workaround would be re-syncing the
 * whole terminal, which is exactly the operation most likely to go wrong.
 */
export async function mapEnrolment(userId: string, biometricId: string): Promise<ActionResult<{ linked: number; days: number }>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can map a biometric number." };

  const value = biometricId.trim();
  if (!value) return { ok: false, error: "Enter the enrolment number from the terminal." };

  const target = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  const clash = await db.employeeProfile.findFirst({
    where: { biometricId: value, userId: { not: userId } },
    select: { user: { select: { name: true } } },
  });
  if (clash) {
    return { ok: false, error: `Enrolment number ${value} already belongs to ${clash.user.name}.` };
  }

  await db.employeeProfile.upsert({
    where: { userId },
    create: { userId, biometricId: value },
    update: { biometricId: value },
  });

  const linked = await linkPunchesToUsers([value]);
  const rollup = await rollupPunches({ userId });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EmployeeProfile",
    entityId: userId,
    entityLabel: `Biometric enrolment ${value} mapped to ${target.name} — ${linked} punch(es) recovered`,
  });
  revalidatePath("/people/devices");
  revalidatePath("/people/attendance");
  return { ok: true, data: { linked, days: rollup.daysWritten } };
}

export async function clearEnrolment(userId: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can change a biometric mapping." };

  await db.employeeProfile.update({ where: { userId }, data: { biometricId: null } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EmployeeProfile",
    entityId: userId,
    entityLabel: "Biometric enrolment unmapped",
  });
  revalidatePath("/people/devices");
  return { ok: true, data: null };
}

/** Everyone with a mapping, for the devices page. */
export async function mappedEnrolments() {
  const { allowed } = await requireHr();
  if (!allowed) return [];
  return toPlain(
    await db.employeeProfile.findMany({
      where: { biometricId: { not: null } },
      select: {
        userId: true,
        biometricId: true,
        employeeCode: true,
        user: { select: { id: true, userSeq: true, name: true, active: true } },
      },
      orderBy: { user: { name: "asc" } },
    }),
  );
}

// ─── Manual import ────────────────────────────────────────────────────────────

/**
 * The fallback for sites that cannot point a terminal at this server.
 *
 * Plenty of eSSL installations run eTimeTrackLite on a PC in the office with no route in from
 * outside, and the realistic answer there is the .dat / .txt export that software produces — which
 * is the same tab-separated ATTLOG format the push protocol uses, so the same parser reads it.
 */
export async function importPunchFile(deviceId: string, contents: string): Promise<
  ActionResult<{ parsed: number; stored: number; rejected: number; linked: number; days: number }>
> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can import attendance." };

  const device = await db.biometricDevice.findUnique({ where: { id: deviceId }, select: { id: true, name: true, removedAt: true } });
  if (!device || device.removedAt) return { ok: false, error: "Pick the terminal this file came from." };

  const { punches, rejected } = parseAttlog(contents);
  if (punches.length === 0) {
    return {
      ok: false,
      error: rejected.length
        ? `Nothing readable in that file — the first line failed with "${rejected[0].why}".`
        : "That file has no attendance rows in it.",
    };
  }

  const created = await db.biometricPunch.createMany({
    data: punches.map((p) => ({
      deviceId: device.id,
      deviceUserId: p.deviceUserId,
      punchedAt: p.punchedAt,
      punchType: p.punchType,
      verifyMode: p.verifyMode,
      raw: p.raw,
    })),
    skipDuplicates: true,
  });

  const linked = await linkPunchesToUsers([...new Set(punches.map((p) => p.deviceUserId))]);
  const rollup = await rollupPunches();

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "BiometricPunch",
    entityId: device.id,
    entityLabel: `Imported ${created.count} punch(es) from a file for ${device.name}`,
  });
  revalidatePath("/people/devices");
  revalidatePath("/people/attendance");
  return {
    ok: true,
    data: { parsed: punches.length, stored: created.count, rejected: rejected.length, linked, days: rollup.daysWritten },
  };
}

/** Re-runs the rollup by hand, for when a mapping or a leave cancellation changes what a day means. */
export async function reprocessPunches(): Promise<ActionResult<{ days: number; punches: number; skipped: number }>> {
  const { allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can reprocess attendance." };

  await linkPunchesToUsers();
  // Every mapped punch's day again, so days written under older rules (a punch's time before it was read in
  // the terminal's zone) come out right. Leave and hand-corrected days are still never touched.
  const result = await rollupPunches({ rebuild: true });
  revalidatePath("/people/attendance");
  revalidatePath("/people/devices");
  return { ok: true, data: { days: result.daysWritten, punches: result.punchesProcessed, skipped: result.skipped.length } };
}

/** The raw log for one person and day, for settling a dispute about a time. */
export async function punchesFor(userId: string, date: string) {
  const user = await requireModuleAccess("hr");
  const canSeeOthers =
    (await hasEffectivePermission(user.id, "hr.manage")) || (await hasEffectivePermission(user.id, "hr.viewAll"));
  if (userId !== user.id && !canSeeOthers) return [];

  const day = dateOnly(date);
  const end = new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1);
  return toPlain(
    await db.biometricPunch.findMany({
      where: { userId, punchedAt: { gte: day, lte: end } },
      orderBy: { punchedAt: "asc" },
      include: { device: { select: { name: true } } },
    }),
  );
}

/**
 * Recent activity across all terminals, so "is it working" has an answer — each person's day as its first and last
 * punch only (owner, 27 Oct 2026). The terminal opens the gate too, and the punches between are only people going
 * out and coming back; the day is in at the first and out at the last (src/lib/hr/punch-rollup.ts).
 */
export async function recentPunches(limit = 25) {
  const { allowed } = await requireHr();
  if (!allowed) return [];
  // Enough recent punches to fill `limit` rows even on a day of gate traffic; a day cut short at the far end of
  // the window shows a later punch as its first, which is the oldest row of the list.
  const rows = await db.biometricPunch.findMany({
    orderBy: { punchedAt: "desc" },
    take: limit * 40,
    include: {
      device: { select: { name: true } },
      user: { select: { id: true, userSeq: true, name: true } },
    },
  });

  // Newest first, so the first row seen for a day is its last punch and the final one its first.
  type Row = (typeof rows)[number];
  const days = new Map<string, { last: Row; first: Row }>();
  for (const row of rows) {
    const key = `${row.userId ?? `#${row.deviceUserId}`}:${row.punchedAt.toISOString().slice(0, 10)}`;
    const day = days.get(key);
    if (day) day.first = row;
    else days.set(key, { last: row, first: row });
  }

  const shown = [...days.values()].flatMap(({ first, last }) =>
    first.id === last.id ? [{ ...first, role: "first" as const }] : [{ ...last, role: "last" as const }, { ...first, role: "first" as const }],
  );
  shown.sort((a, b) => b.punchedAt.getTime() - a.punchedAt.getTime());
  return toPlain(shown.slice(0, limit));
}
