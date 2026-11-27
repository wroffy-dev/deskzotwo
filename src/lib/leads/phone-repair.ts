import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { normalisePhone, phoneCountry } from "@/lib/phone";
import { workspaceCountry } from "@/lib/country-pack";
import { SHORTENED_NUMBER } from "@/lib/portability/importers/types";
import { contactMasker } from "@/lib/contacts/masking";

/**
 * Putting back the phone numbers Excel shortened (owner, 30 Oct 2026). A leads file saved from Excel as CSV wrote
 * 919876543210 as "9.20E+11"; the import kept that text, and 13,979 leads came in with it. The digits are gone from
 * Deskzo — only the file they came from can give them back.
 *
 *   · **Broken** is a contact phone shaped like Excel's shortening (SHORTENED_NUMBER). Nothing else is touched.
 *   · **Matched** by the lead's Old system ID first (`Lead.externalId`, what the import kept of the other CRM's id),
 *     then by the contact's email. An email the file gives two different phones is ambiguous and left alone.
 *   · **The file's phone** must be whole itself: a file still holding 9.20E+11 is refused, with how to export it.
 *   · **Cleared, if asked**: a broken phone the file can't fix is emptied, so nobody rings a number that isn't one.
 *   · One audit entry for the run, with the counts.
 */

export const SAMPLE = 50;

const HEADINGS = {
  oldId: ["old system id", "record id", "lead id", "deal id", "opportunity id", "id"],
  email: ["contact email", "email", "email address", "email id"],
  phone: ["contact phone", "phone", "phone number", "contact mobile", "mobile", "mobile number", "mobile phone"],
};

function column(headers: string[], names: string[]): string | null {
  const plain = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const name of names) {
    const found = headers.find((h) => plain(h) === name);
    if (found) return found;
  }
  return null;
}

export type PhoneFix = { contactId: string; name: string; lead: number | null; from: string; to: string; by: "old system ID" | "email" };

export type PhoneRepairPlan = {
  columns: { oldId: string | null; email: string | null; phone: string };
  /** Contacts holding a shortened phone now. */
  broken: number;
  /** How many of those the file puts right, and the first few. */
  fixable: number;
  sample: PhoneFix[];
  /** Broken phones the file has nothing for. */
  unmatched: number;
  /** Emails the file gives more than one phone. */
  ambiguous: number;
};

/** What a phone becomes: written the way the phone fields write one, else as typed. */
function tidy(raw: string): string {
  const typed = raw.trim();
  const digits = typed.replace(/\D/g, "");
  if (digits.length < 7) return typed;
  // 919876543210 is India's own dial code and ten digits, as a CRM export writes it — not a ten-digit number to put +91 before.
  const dial = phoneCountry(workspaceCountry()).dial.replace(/\D/g, "");
  const international = !/^(\+|00)/.test(typed) && digits.length > 10 && dial && digits.startsWith(dial) ? `+${digits}` : typed;
  return normalisePhone(international, workspaceCountry()) || typed;
}

type Broken = { id: string; name: string; email: string | null; phone: string; leads: { leadSeq: number; externalId: string | null }[] };

/**
 * `only` keeps to those contacts — a check suite's own fixture, so a run never touches the rest of the workspace.
 */
async function brokenContacts(only?: string[]): Promise<Broken[]> {
  // "E+" narrows it in the database; the pattern decides.
  const rows = await db.contact.findMany({
    where: { phone: { contains: "E+", mode: "insensitive" }, ...(only ? { id: { in: only } } : {}) },
    select: { id: true, name: true, email: true, phone: true, leads: { select: { leadSeq: true, externalId: true }, orderBy: { leadSeq: "asc" } } },
  });
  return rows.filter((c): c is Broken => !!c.phone && SHORTENED_NUMBER.test(c.phone.trim()));
}

/** The fixes the file makes, or why it can't be used. */
async function work(rows: Record<string, string>[], only?: string[]): Promise<{ error: string } | { plan: PhoneRepairPlan; fixes: PhoneFix[]; unfixed: string[] }> {
  if (rows.length === 0) return { error: "The file has no rows." };
  const headers = Object.keys(rows[0]!);
  const phoneCol = column(headers, HEADINGS.phone);
  const oldIdCol = column(headers, HEADINGS.oldId);
  const emailCol = column(headers, HEADINGS.email);
  if (!phoneCol) return { error: `The file needs a phone column ("Contact phone", "Phone" or "Mobile"). Its headings: ${headers.join(", ")}.` };
  if (!oldIdCol && !emailCol) return { error: "The file needs an Old system ID or an email column to match leads by." };

  const shortened = rows.filter((r) => SHORTENED_NUMBER.test((r[phoneCol] ?? "").trim())).length;
  if (shortened > 0) {
    return {
      error: `${shortened} phone(s) in this file are shortened too, like ${rows.find((r) => SHORTENED_NUMBER.test((r[phoneCol] ?? "").trim()))![phoneCol]} — it has been through Excel. Export it again from the old system and upload it without opening it, or open it in Excel with Data › From Text/CSV and the phone column set to Text.`,
    };
  }

  const byOldId = new Map<string, string>();
  const byEmail = new Map<string, string | null>();
  for (const r of rows) {
    const phone = (r[phoneCol] ?? "").trim();
    if (!phone) continue;
    const oldId = oldIdCol ? (r[oldIdCol] ?? "").trim() : "";
    if (oldId) byOldId.set(oldId, phone);
    const email = emailCol ? (r[emailCol] ?? "").trim().toLowerCase() : "";
    if (email) {
      const seen = byEmail.get(email);
      // Two different phones for one email: which is this contact's can't be told.
      byEmail.set(email, seen === undefined || seen === phone ? phone : null);
    }
  }

  const broken = await brokenContacts(only);
  const fixes: PhoneFix[] = [];
  const unfixed: string[] = [];
  let ambiguous = 0;
  for (const c of broken) {
    const lead = c.leads.find((l) => l.externalId && byOldId.has(l.externalId));
    let to: string | null = null;
    let by: PhoneFix["by"] = "old system ID";
    if (lead) to = byOldId.get(lead.externalId!)!;
    else if (c.email) {
      const found = byEmail.get(c.email.trim().toLowerCase());
      if (found === null) ambiguous += 1;
      if (found) {
        to = found;
        by = "email";
      }
    }
    if (to) fixes.push({ contactId: c.id, name: c.name, lead: (lead ?? c.leads[0])?.leadSeq ?? null, from: c.phone, to: tidy(to), by });
    else unfixed.push(c.id);
  }

  return {
    plan: {
      columns: { oldId: oldIdCol, email: emailCol, phone: phoneCol },
      broken: broken.length,
      fixable: fixes.length,
      sample: fixes.slice(0, SAMPLE),
      unmatched: unfixed.length,
      ambiguous,
    },
    fixes,
    unfixed,
  };
}

/**
 * `viewerId`, who is looking: the sample's names and numbers — the shortened one and the one it becomes — as their
 * contacts policy shows a contact in a list (owner, 5 Nov 2026 — Phase 3 masking fixes; src/lib/contacts/masking.ts). The
 * tool is the super admin's, who sees every field in the clear; whoever else it opens to sees what a list shows them.
 * Matched and written on the real values; without a viewer, as they will be written.
 */
export async function planPhoneRepair(rows: Record<string, string>[], only?: string[], viewerId?: string): Promise<{ error: string } | PhoneRepairPlan> {
  const result = await work(rows, only);
  if ("error" in result) return result;
  return viewerId ? { ...result.plan, sample: await fixesSeenBy(viewerId, result.plan.sample) } : result.plan;
}

async function fixesSeenBy(userId: string, fixes: PhoneFix[]): Promise<PhoneFix[]> {
  const m = await contactMasker(userId, "list", fixes.map((f) => f.contactId));
  if (!m.active) return fixes;
  return fixes.map((f) => ({ ...f, name: m.present(f.contactId, "name", f.name) ?? "", from: m.present(f.contactId, "phone", f.from) ?? "", to: m.present(f.contactId, "phone", f.to) ?? "" }));
}

export type PhoneRepairResult = { fixed: number; cleared: number; unmatched: number };

/** Puts the file's phones back, and empties the rest of the broken ones when asked. Only a phone still broken changes. */
export async function applyPhoneRepair(
  rows: Record<string, string>[],
  actorId: string,
  clearUnfixed: boolean,
  only?: string[],
): Promise<{ error: string } | PhoneRepairResult> {
  const result = await work(rows, only);
  if ("error" in result) return result;
  let fixed = 0;
  for (let i = 0; i < result.fixes.length; i += 500) {
    const batch = result.fixes.slice(i, i + 500);
    fixed += await db.$transaction(async (tx) => {
      let n = 0;
      // `phone: from` again: one changed between the preview and now is somebody's, and stays.
      for (const f of batch) n += (await tx.contact.updateMany({ where: { id: f.contactId, phone: f.from }, data: { phone: f.to } })).count;
      return n;
    });
  }
  let cleared = 0;
  if (clearUnfixed && result.unfixed.length) {
    const still = (await brokenContacts(only)).filter((c) => result.unfixed.includes(c.id));
    for (let i = 0; i < still.length; i += 500) {
      const batch = still.slice(i, i + 500);
      cleared += await db.$transaction(async (tx) => {
        let n = 0;
        for (const c of batch) n += (await tx.contact.updateMany({ where: { id: c.id, phone: c.phone }, data: { phone: null } })).count;
        return n;
      });
    }
  }
  await recordAudit({
    userId: actorId,
    action: "UPDATE",
    entityType: "Contact",
    entityId: "phone-repair",
    entityLabel: `Phone numbers Excel shortened: ${fixed} put back from the file${clearUnfixed ? `, ${cleared} cleared` : ""}, ${result.unfixed.length - cleared} left`,
  });
  return { fixed, cleared, unmatched: result.unfixed.length - cleared };
}

/** How many contact phones are shortened now — the page's headline. */
export async function countBrokenPhones(): Promise<number> {
  return (await brokenContacts()).length;
}
