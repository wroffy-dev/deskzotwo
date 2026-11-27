"use server";

import type { ConsoleResult } from "@/actions/platform/console";
import { OWNERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { ConsoleRefused } from "@/lib/platform/refused";
import { getSetting, setSetting } from "@/lib/platform/settings";
import { StaffRefused, requireStaff } from "@/lib/platform/staff-session";

/**
 * Settings › Alerts: who the alerts are emailed to (src/lib/platform/alert-notify.ts — owner, 30 Oct 2026). Up to ten
 * addresses; none means every active owner. Owners only, as every platform-wide setting is; audited.
 */
export async function consoleSetAlertEmails(raw: unknown): Promise<ConsoleResult<{ emails: string[] }>> {
  let staff;
  try {
    staff = await requireStaff(OWNERS);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    const parts = String(raw ?? "")
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const bad = parts.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || e.length > 254);
    if (bad) throw new ConsoleRefused(`"${bad}" isn't an email address.`);
    const emails = [...new Set(parts)];
    if (emails.length > 10) throw new ConsoleRefused("Ten addresses at most — a team address can stand for more.");
    const before = (await getSetting("alerts.emails")) ?? "";
    const value = emails.join(", ");
    if (before === value) return { ok: true, data: { emails } };
    await setSetting("alerts.emails", value || null, staff.id);
    await consoleAudit(staff, "console.alert-emails", { from: before || null, to: value || null });
    revalidateConsole();
    return { ok: true, data: { emails } };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}
