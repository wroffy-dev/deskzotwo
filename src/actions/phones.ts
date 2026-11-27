"use server";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { toPlain } from "@/lib/serialize";
import { notMigratedYet } from "@/lib/not-migrated";
import { PEOPLE_ONLY } from "@/lib/people";
import { phoneDescription, phoneHealth, type PhoneHealth } from "@/lib/app/phone-rules";

export type PhoneShow = "all" | "attention" | "off" | "none";

export type PhoneRow = {
  id: string;
  person: { id: string; name: string; email: string };
  phone: string;
  callSync: boolean;
  pairedAt: Date;
  lastSeenAt: Date;
  lastCallSyncAt: Date | null;
  /** Null where the workspace hasn't the column yet: not known, rather than never. */
  syncKnown: boolean;
  health: PhoneHealth;
};

export type PhonesView = {
  rows: PhoneRow[];
  /** Active people with no phone paired — for "Nobody's phone". */
  unpaired: { id: string; name: string; email: string }[];
  counts: { phones: number; attention: number; off: number; unpaired: number };
};

type DeviceRow = {
  id: string;
  platform: string;
  model: string | null;
  appVersion: string | null;
  callSync: boolean;
  createdAt: Date;
  lastCallSyncAt?: Date | null;
  user: { id: string; name: string; email: string };
  device: { status: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED"; lastSeenAt: Date };
};

/**
 * Settings › Security › Access › Phones (owner, 31 Oct 2026): every phone paired with the Deskzo app — whose, which
 * phone and app version, call sync on or off, last seen, and when it last sent its calls — for whoever works the
 * device queue or the access rules, as the Devices tab is. Active people only; a person's phones newest first.
 */
export async function listPhones(params: { q?: string; show?: string } = {}): Promise<PhonesView | null> {
  const user = await requireUser();
  const [manage, approve] = await Promise.all([can(user.id, "security.manage"), can(user.id, "access.approveDevices")]);
  if (!manage && !approve) return null;

  const q = params.q?.trim();
  const people = { active: true, ...PEOPLE_ONLY, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { email: { contains: q, mode: "insensitive" as const } }] } : {}) };
  const base = {
    id: true,
    platform: true,
    model: true,
    appVersion: true,
    callSync: true,
    createdAt: true,
    user: { select: { id: true, name: true, email: true } },
    device: { select: { status: true, lastSeenAt: true } },
  } as const;
  const where = { user: people };
  const orderBy = [{ user: { name: "asc" as const } }, { createdAt: "desc" as const }];
  let syncKnown = true;
  const devices: DeviceRow[] = await db.appDevice.findMany({ where, orderBy, select: { ...base, lastCallSyncAt: true } }).catch(async (err) => {
    if (!notMigratedYet(err)) throw err;
    syncKnown = false;
    return db.appDevice.findMany({ where, orderBy, select: base });
  });

  const now = new Date();
  const all: PhoneRow[] = devices.map((d) => {
    const lastCallSyncAt = d.lastCallSyncAt ?? null;
    return {
      id: d.id,
      person: d.user,
      phone: phoneDescription(d) || "A phone",
      callSync: d.callSync,
      pairedAt: d.createdAt,
      lastSeenAt: d.device.lastSeenAt,
      lastCallSyncAt,
      syncKnown,
      health: phoneHealth({ status: d.device.status, callSync: d.callSync, pairedAt: d.createdAt, lastCallSyncAt }, now),
    };
  });
  const live = all.filter((r) => r.health.label !== "Signed out");
  const unpaired = await db.user.findMany({
    where: { ...people, appDevices: { none: { device: { status: { in: ["APPROVED", "PENDING"] } } } } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true },
    take: 500,
  });

  const show: PhoneShow = (["all", "attention", "off", "none"] as const).find((s) => s === params.show) ?? "all";
  const rows = show === "attention" ? live.filter((r) => r.health.tone === "warn") : show === "off" ? live.filter((r) => !r.callSync) : show === "none" ? [] : all;
  return toPlain({
    rows,
    unpaired: show === "none" ? unpaired : [],
    counts: { phones: live.length, attention: live.filter((r) => r.health.tone === "warn").length, off: live.filter((r) => !r.callSync).length, unpaired: unpaired.length },
  });
}
