import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { automationUserId } from "@/lib/automation-user";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { canSeeCompany } from "@/lib/authz/company-scope";

export * from "@/lib/customers/elsewhere-rules";

/**
 * Installed elsewhere (owner, 2 Nov 2026: "our sales manager knows this customer uses a Sophos firewall bought from xyz
 * reseller, renewing 2 Mar 2027, and Google Workspace, 100 seats from abc reseller, renewing 9 Apr 2027 — they enter
 * it for future reference, for better decisions and sale signals").
 *
 * What a customer uses that it didn't buy from us, on the customer's "Installed elsewhere" tab: the product, how many,
 * who sold it, when it renews, roughly what it costs a year, how we know, and a note. Seen and changed by whoever may
 * see the customer (src/lib/authz/company-scope.ts) — there's no permission of its own. Phase 1 makes it useful three
 * ways: a task for the account manager `remindDays` before it renews (`runElsewhereReminders`, on the heartbeat), the
 * list across every customer (Customers › Installed elsewhere, with its Excel), and "Make a lead" from any of them.
 */

const DAY = 86_400_000;
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date from the calendar.");
const blank = (s: string | null | undefined) => (s ?? "").trim();

export const elsewhereSchema = z
  .object({
    productName: z.string().trim().min(1, "Say what they use — Sophos XGS firewall, Google Workspace…").max(200),
    itemId: z.string().max(40).nullish(),
    // One of the workspace's categories (src/lib/customers/elsewhere-categories.ts) — saveElsewhere checks which.
    category: z.string().trim().max(40).nullish().or(z.literal("")),
    quantity: z.coerce.number().int().min(1, "Quantity is 1 or more.").max(1_000_000).nullish(),
    boughtFrom: z.string().trim().max(200).nullish(),
    renewsOn: dayKey.nullish().or(z.literal("")),
    yearlyValue: z.coerce.number().min(0, "The value can't be negative.").max(1e11).nullish(),
    source: z.enum(["CUSTOMER_SAID", "SAW_INVOICE", "ESTIMATE"]).default("CUSTOMER_SAID"),
    notes: z.string().trim().max(2000).nullish(),
    remindDays: z.coerce.number().int().min(1).max(365).nullish(),
  })
  .strict();
export type ElsewhereInput = z.input<typeof elsewhereSchema>;

/** A typed day as a @db.Date holds one: midnight UTC. */
export const dayOf = (key: string | null | undefined) => (key ? new Date(`${key}T00:00:00.000Z`) : null);

/** The columns a parsed form writes. */
export function elsewhereData(input: z.output<typeof elsewhereSchema>) {
  return {
    productName: input.productName,
    itemId: input.itemId || null,
    category: input.category || null,
    quantity: input.quantity ?? null,
    boughtFrom: blank(input.boughtFrom) || null,
    renewsOn: dayOf(input.renewsOn || null),
    yearlyValue: input.yearlyValue === null || input.yearlyValue === undefined ? null : new Prisma.Decimal(input.yearlyValue),
    source: input.source,
    notes: blank(input.notes) || null,
    remindDays: input.remindDays ?? null,
  };
}

export const ELSEWHERE_SELECT = {
  id: true,
  companyId: true,
  productName: true,
  itemId: true,
  category: true,
  quantity: true,
  boughtFrom: true,
  renewsOn: true,
  yearlyValue: true,
  source: true,
  notes: true,
  remindDays: true,
  remindedFor: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.InstalledElsewhereSelect;

/** The workspace has no table yet, or a running server's client predates it — nothing noted, nothing worse. */
export function elsewhereNotKeptYet(err: unknown): boolean {
  return notMigratedYet(err) || err instanceof TypeError || (err instanceof Prisma.PrismaClientValidationError && /installedElsewhere/i.test(err.message));
}

/** The task's title — one per entry and renewal, so it is found again rather than raised twice. */
export const reminderTitle = (productName: string, companyName: string) => `Renewal elsewhere: ${productName} — ${companyName}`;

export type ElsewhereReminderRun = { raised: number; reason?: string };

/**
 * The reminder (owner, 2 Nov 2026): `remindDays` before an entry renews, a task for the customer's account manager —
 * "Renewal elsewhere: Sophos XGS — Acme", due that day, saying who it's with and when it renews — once for each renewal
 * date (`remindedFor`), so a date moved on raises a new one and nothing raises twice. A customer with no active account
 * manager gets the task unassigned, on the customer, where the Tasks list shows it. Where Companies is on, by the
 * Automation account, on the heartbeat.
 */
export async function runElsewhereReminders(now = new Date()): Promise<ElsewhereReminderRun> {
  if (!(await moduleAvailableForTenant("companies"))) return { raised: 0, reason: "companies are off" };
  const today = (await workspaceClock()).calendarDate(now);
  let due;
  try {
    // Renewing from today out to the longest reminder; each row's own lead is checked below.
    due = await db.installedElsewhere.findMany({
      where: { renewsOn: { gte: today, lte: new Date(today.getTime() + 365 * DAY) }, remindDays: { not: null } },
      orderBy: { renewsOn: "asc" },
      take: 500,
      select: { ...ELSEWHERE_SELECT, company: { select: { name: true, ownerUserId: true, owner: { select: { active: true } } } } },
    });
  } catch (err) {
    if (elsewhereNotKeptYet(err)) return { raised: 0, reason: "not migrated" };
    throw err;
  }
  const ready = due.filter((e) => e.renewsOn && e.remindDays !== null && e.renewsOn.getTime() - e.remindDays * DAY <= today.getTime() && e.remindedFor?.getTime() !== e.renewsOn.getTime());
  if (ready.length === 0) return { raised: 0 };

  const automation = await automationUserId();
  let raised = 0;
  for (const e of ready) {
    const assignee = e.company.owner?.active ? e.company.ownerUserId : null;
    const title = reminderTitle(e.productName, e.company.name);
    const facts = [e.quantity ? `${e.quantity} × ${e.productName}` : e.productName, e.boughtFrom ? `bought from ${e.boughtFrom}` : null, `renews ${formatCalendarDay(e.renewsOn)}`].filter(Boolean).join(", ");
    // Claimed first, so two heartbeats never both raise it.
    const claimed = await db.installedElsewhere.updateMany({ where: { id: e.id, OR: [{ remindedFor: null }, { remindedFor: { not: e.renewsOn } }] }, data: { remindedFor: e.renewsOn } });
    if (claimed.count === 0) continue;
    await db.task.create({
      data: {
        title,
        description: `${facts}. Noted on the customer's "Installed elsewhere" tab — a chance to win it at renewal. Raised ${e.remindDays} days ahead.`,
        dueDate: today,
        companyId: e.companyId,
        assignedToUserId: assignee,
        createdByUserId: automation,
      },
    });
    raised += 1;
    if (assignee) await notifyUser({ userId: assignee, type: "TASK_ASSIGNED", title: "A renewal elsewhere is coming up", message: title, link: "/tasks" });
  }
  return { raised };
}

/**
 * "Make a lead" from a customer's Installed elsewhere entry (owner, 2 Nov 2026 — src/lib/customers/elsewhere.ts): the
 * title, what is known, the close date at its renewal and — when it is one of our items — the product, filled in. Only
 * an entry on the company the URL names, which this person may see; anything else opens the form as it would.
 */
export async function leadPrefillFromElsewhere(userId: string, companyId: unknown, entryId: unknown) {
  if (typeof entryId !== "string" || !entryId || typeof companyId !== "string") return null;
  const entry = await db.installedElsewhere
    .findUnique({ where: { id: entryId }, select: { companyId: true, productName: true, itemId: true, quantity: true, boughtFrom: true, renewsOn: true, notes: true, company: { select: { ownerUserId: true, relationshipType: true } } } })
    .catch(() => null);
  if (!entry || entry.companyId !== companyId || !(await canSeeCompany(userId, { ...entry.company, id: entry.companyId }))) return null;
  const renews = entry.renewsOn ? entry.renewsOn.toISOString().slice(0, 10) : "";
  const facts = [
    `${entry.quantity ? `${entry.quantity} × ` : ""}${entry.productName}${entry.boughtFrom ? `, bought from ${entry.boughtFrom}` : ""}${renews ? `, renews ${formatCalendarDay(entry.renewsOn)}` : ""}.`,
    entry.notes,
  ].filter(Boolean);
  const item = entry.itemId ? await db.item.findFirst({ where: { id: entry.itemId, active: true }, select: { id: true } }) : null;
  return {
    title: `${entry.productName}${entry.boughtFrom ? ` — win from ${entry.boughtFrom}` : " — win at renewal"}`.slice(0, 200),
    description: `From Installed elsewhere: ${facts.join("\n")}`,
    expectedCloseDate: renews,
    requirements: item ? [{ itemId: item.id, quantity: entry.quantity ?? 1, notes: "", renewalDate: renews }] : [],
  };
}
