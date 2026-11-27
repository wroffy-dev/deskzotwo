import { randomInt, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { digestSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * A biometric terminal's own secret address (owner, 12 Nov 2026 — security audit of 11 Nov, SEC-06).
 *
 * The iclock protocol carries no password: a terminal names its serial number, which is printed on the box, and is
 * believed. The one thing its settings do let HR choose is the server address — and on terminals that take a web
 * address there ("Enable domain name"), that address can carry a path. So a terminal can be given a key as part of the
 * address it calls (/iclock-k/<key>/iclock/…), and from then on a request naming its serial without the key is refused
 * exactly as an unknown serial is. Only the key's digest is stored; the key is shown once, when made.
 *
 * It is the terminal's to opt into: one with no key answers at the plain address as before, and is as trustworthy as
 * its address list (allowedIps) makes it.
 */

/** Typed on a keypad: lower-case letters and digits, without the ones that read alike (0/o, 1/l/i). About 80 bits. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const DEVICE_KEY_LENGTH = 16;
export const DEVICE_KEY_PATTERN = /^[a-z0-9]{16}$/;

export function newDeviceKey(): string {
  let key = "";
  for (let i = 0; i < DEVICE_KEY_LENGTH; i += 1) key += ALPHABET[randomInt(ALPHABET.length)];
  return key;
}

export const deviceKeyDigest = (key: string) => digestSecret(`biometric-device-key:${key}`);

/** The path a terminal with this key calls, before the firmware's own /iclock/…. */
export const deviceKeyPath = (key: string) => `/iclock-k/${key}`;

/** The stored digest of a terminal's key — null when it has none, or in a workspace not migrated to the column yet. */
export async function deviceKeyHashOf(deviceId: string): Promise<string | null> {
  try {
    const row = await db.biometricDevice.findUnique({ where: { id: deviceId }, select: { accessKeyHash: true } });
    return row?.accessKeyHash ?? null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Which of these terminals have a key, for the list. */
export async function devicesWithKey(deviceIds: string[]): Promise<Set<string>> {
  if (deviceIds.length === 0) return new Set();
  try {
    const rows = await db.biometricDevice.findMany({ where: { id: { in: deviceIds }, accessKeyHash: { not: null } }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    if (notMigratedYet(err)) return new Set();
    throw err;
  }
}

/** Whether the key a request came with is this terminal's. A terminal with no key asks for none. */
export async function deviceKeyAccepted(storedHash: string | null, given: string | null | undefined): Promise<boolean> {
  if (!storedHash) return true;
  if (!given || !DEVICE_KEY_PATTERN.test(given)) return false;
  const expected = Buffer.from(storedHash);
  const got = Buffer.from(await deviceKeyDigest(given));
  return expected.length === got.length && timingSafeEqual(expected, got);
}
