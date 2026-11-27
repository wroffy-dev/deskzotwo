"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { TEAMMATES, TEAMMATE_PHOTO_MAX, cleanTeammateName, isTeammateKey, isTeammatePhoto } from "@/lib/ai/teammates";
import { EVERY_COUNTRY, saveLook } from "@/lib/ai/teammate-looks";
import { MANAGERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * Settings › AI teammates in the console (owner, 23 Nov 2026 — src/lib/ai/teammate-looks.ts): owners and admins set each
 * teammate's name and photo for every country, or one country — or take theirs away, back to what's under it. Audited
 * by what changed, never the picture. Workspaces pick it up within a minute.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

function refuse(message: string): never {
  throw new ConsoleRefused(message);
}

function countryOf(value: unknown): string {
  const c = String(value ?? "").trim().toUpperCase();
  if (c === EVERY_COUNTRY || /^[A-Z]{2}$/.test(c)) return c;
  refuse("Choose a country.");
}

function keyOf(value: unknown) {
  if (!isTeammateKey(value)) refuse("There's no such teammate.");
  return value;
}

/** A name for a teammate in a country — empty takes it away. */
export async function setTeammateName(input: { country: unknown; key: unknown; name: unknown }): Promise<ConsoleResult<{ name: string | null }>> {
  return asStaff(MANAGERS, async (staff) => {
    const country = countryOf(input?.country);
    const key = keyOf(input?.key);
    const raw = String(input?.name ?? "").trim();
    const name = cleanTeammateName(raw);
    if (raw && !name) refuse("A name: letters, spaces, and . ' & - at most.");
    await saveLook(country, key, { name: name || null }, staff.id);
    await consoleAudit(staff, "ai.teammate.name", { country, teammate: key, name: name || `(${TEAMMATES[key].defaultName}, from under it)` });
    revalidateConsole();
    return { name: name || null };
  });
}

/** A photo for a teammate in a country — square, shrunk in the browser first — or null to take it away. */
export async function setTeammateLookPhoto(input: { country: unknown; key: unknown; photo: unknown }): Promise<ConsoleResult<{ photo: string | null }>> {
  return asStaff(MANAGERS, async (staff) => {
    const country = countryOf(input?.country);
    const key = keyOf(input?.key);
    if (key === "deskzo") refuse("Deskzo AI is its mark, never a face.");
    const value = input?.photo === null || input?.photo === "" ? null : input?.photo;
    if (value !== null) {
      if (typeof value === "string" && value.length > TEAMMATE_PHOTO_MAX) refuse("That picture is too large — try a smaller one.");
      if (!isTeammatePhoto(value) || !looksLikeImage(value)) refuse("Choose a JPEG, PNG or WebP picture.");
    }
    await saveLook(country, key, { photo: (value as string | null) ?? null }, staff.id);
    await consoleAudit(staff, "ai.teammate.photo", { country, teammate: key, photo: value ? "set" : "taken away" });
    revalidateConsole();
    return { photo: (value as string | null) ?? null };
  });
}

/** The picture's own first bytes, not only what its data: URL says it is. */
function looksLikeImage(dataUrl: string): boolean {
  const kind = /^data:image\/(jpeg|png|webp);/.exec(dataUrl)?.[1];
  const head = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1, dataUrl.indexOf(",") + 1 + 24), "base64");
  if (kind === "jpeg") return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (kind === "png") return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (kind === "webp") return head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}
