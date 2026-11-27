import { db } from "@/lib/db";
import { compareMonths } from "@/lib/migration/balances";
import { WAIT_LABELS, type WaitFor } from "@/lib/migration/sections";
import { openMigration } from "@/lib/migration/state";
import { STEPS, stepFiles } from "@/lib/migration/steps";
import { withClient } from "@/lib/tenancy/clients";
import { activeTenants } from "@/lib/tenancy/registry";
import type { Tenant } from "@/lib/tenancy/state";
import { OPENED_CALL } from "@/lib/zoho/archive-pdf";
import { latestPull } from "@/lib/zoho/pull";

/**
 * The console's onboarding board (owner, 29 Oct 2026): every workspace bringing its data into Deskzo, and where each
 * is stuck — read from inside each workspace, a few at a time, each with a time limit, so the team sees who needs a
 * hand without going in. Progress only: counts, a section's reasons for waiting, the month check's tally, the Zoho
 * pull's state. Never a document, an amount or anyone's name from the workspace — going in is support access, which
 * only the workspace's super admin grants (src/lib/platform/support.ts).
 */

const CONCURRENCY = 4;
const TIMEOUT_MS = 8_000;
const CACHE_MS = 30_000;
const DAY = 86_400_000;
/** Quiet this long, and a switch is flagged. */
export const QUIET_DAYS = 3;
/** Finished this recently, and it's listed below the ones in progress. */
const FINISHED_DAYS = 30;

export type Tone = "neutral" | "success" | "info" | "warning" | "danger";
export type Flag = { tone: Tone; label: string };

export type SectionProgress = { key: string; label: string; brought: number; units: number; done: number; waiting: number; refused: number };

export type SwitchProgress = {
  tenantId: string;
  slug: string;
  name: string;
  source: string;
  yearStart: string;
  switchDate: string;
  startedAt: Date;
  lastActivity: Date;
  sections: SectionProgress[];
  /** Rows waiting, by what they wait for — "Invoices: 3". */
  waitingFor: { label: string; n: number }[];
  waiting: number;
  refused: number;
  months: { total: number; uploaded: number; agreeing: number };
  pull: { status: string; module: string | null; callsToday: number; allowance: number; error: string | null } | null;
  /** The old-CRM import's latest run: customers, vendors and items. */
  masters: { status: string; at: Date } | null;
  flags: Flag[];
};

export type FinishedSwitch = { tenantId: string; slug: string; name: string; source: string; finishedAt: Date };
export type Unread = { tenantId: string; slug: string; name: string; reason: string };

export type OnboardingBoard = { asOf: Date; inProgress: SwitchProgress[]; finished: FinishedSwitch[]; unread: Unread[]; workspaces: number };

type Found = { open: Omit<SwitchProgress, "tenantId" | "slug" | "name" | "flags"> | null; finishedAt: Date | null; source: string | null };

class NoAnswer extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NoAnswer()), ms);
    timer.unref?.();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function eachAtMost<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

const latest = (...dates: (Date | null | undefined)[]) => new Date(Math.max(...dates.filter((d): d is Date => !!d).map((d) => d.getTime())));

/** One workspace's switch, as the workspace — inside `withClient`, `db` is its database. */
async function readWorkspace(now: Date): Promise<Found> {
  // Asked first: `openMigration` takes any error for "none open", and a workspace that can't be reached isn't one not switching.
  await db.$queryRaw`select 1`;
  const m = await openMigration();
  if (!m) {
    const done = await db.migration
      .findFirst({ where: { status: "FINISHED", finishedAt: { gte: new Date(now.getTime() - FINISHED_DAYS * DAY) } }, orderBy: { finishedAt: "desc" }, select: { finishedAt: true, source: true } })
      .catch(() => null);
    return { open: null, finishedAt: done?.finishedAt ?? null, source: done?.source ?? null };
  }
  const [files, months, pull, record, masters] = await Promise.all([
    stepFiles(m),
    compareMonths(m),
    latestPull(m.id).catch(() => null),
    // Somebody opening an earlier year's PDF isn't somebody at the switch.
    db.migrationRecord.findFirst({ where: { migrationId: m.id, kind: { not: OPENED_CALL } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.legacyImport.findFirst({ orderBy: { createdAt: "desc" }, select: { status: true, createdAt: true, startedAt: true, finishedAt: true } }).catch(() => null),
  ]);
  const waitingFor = new Map<WaitFor, number>();
  const sections: SectionProgress[] = [];
  for (const step of STEPS) {
    const file = files.find((f) => f.step === step.key);
    const brought = m.counts[step.key] ?? 0;
    if (!file && !brought) continue;
    const waiting = file?.failures.filter((f) => f.waitFor) ?? [];
    for (const w of waiting) waitingFor.set(w.waitFor!, (waitingFor.get(w.waitFor!) ?? 0) + 1);
    sections.push({ key: step.key, label: step.label, brought, units: file?.units ?? 0, done: file?.done ?? 0, waiting: waiting.length, refused: (file?.failures.length ?? 0) - waiting.length });
  }
  const pullStatus = pull ? { status: pull.status, module: pull.module, callsToday: pull.callsToday, allowance: pull.allowance, error: pull.error } : null;
  return {
    open: {
      source: m.source,
      yearStart: m.yearStart,
      switchDate: m.switchDate,
      startedAt: m.createdAt,
      // The last sign of anyone at it: a file, a record brought across, the pull, the old-CRM import.
      lastActivity: latest(m.createdAt, ...files.map((f) => (f.createdAt ? new Date(f.createdAt) : null)), record?.createdAt, masters?.finishedAt ?? masters?.startedAt ?? null),
      sections,
      waitingFor: [...waitingFor].map(([w, n]) => ({ label: WAIT_LABELS[w], n })),
      waiting: sections.reduce((n, s) => n + s.waiting, 0),
      refused: sections.reduce((n, s) => n + s.refused, 0),
      months: { total: months.length, uploaded: months.filter((x) => x.uploaded).length, agreeing: months.filter((x) => x.agrees).length },
      pull: pullStatus,
      masters: masters ? { status: masters.status, at: masters.finishedAt ?? masters.startedAt ?? masters.createdAt } : null,
    },
    finishedAt: null,
    source: m.source,
  };
}

/** What wants a look, worst first. */
export function flagsFor(s: Omit<SwitchProgress, "flags" | "tenantId" | "slug" | "name">, now: Date): Flag[] {
  const flags: Flag[] = [];
  if (s.pull?.status === "FAILED") flags.push({ tone: "danger", label: "Zoho pull stopped" });
  if (s.refused > 0) flags.push({ tone: "danger", label: `${s.refused.toLocaleString("en-IN")} refused` });
  if (s.pull?.status === "WAITING") flags.push({ tone: "warning", label: "Zoho's calls used for today" });
  if (s.waiting > 0) flags.push({ tone: "warning", label: `${s.waiting.toLocaleString("en-IN")} waiting` });
  const quiet = Math.floor((now.getTime() - s.lastActivity.getTime()) / DAY);
  if (quiet >= QUIET_DAYS) flags.push({ tone: "warning", label: `Quiet ${quiet} days` });
  const off = s.months.uploaded - s.months.agreeing;
  if (off > 0) flags.push({ tone: "info", label: `${off} month${off === 1 ? "" : "s"} off` });
  if (s.months.total > 0 && s.months.agreeing === s.months.total) flags.push({ tone: "success", label: "Ready to finish" });
  if (s.pull && ["FETCHING", "STORING", "PDFS"].includes(s.pull.status)) flags.push({ tone: "info", label: "Pulling from Zoho" });
  return flags;
}

let cached: { at: number; board: OnboardingBoard } | null = null;

export async function onboardingBoard(now = new Date(), options: { fresh?: boolean; tenants?: Tenant[] } = {}): Promise<OnboardingBoard> {
  if (!options.fresh && !options.tenants && cached && Date.now() - cached.at < CACHE_MS) return cached.board;
  const tenants = (options.tenants ?? (await activeTenants())).filter((t) => !!t.dbUrl);
  const inProgress: SwitchProgress[] = [];
  const finished: FinishedSwitch[] = [];
  const unread: Unread[] = [];
  await eachAtMost(tenants, CONCURRENCY, async (tenant) => {
    const base = { tenantId: tenant.id, slug: tenant.slug, name: tenant.name };
    try {
      const found = await within(withClient(tenant, () => readWorkspace(now)), TIMEOUT_MS);
      if (found.open) inProgress.push({ ...base, ...found.open, flags: flagsFor(found.open, now) });
      else if (found.finishedAt) finished.push({ ...base, source: found.source ?? "", finishedAt: found.finishedAt });
    } catch (err) {
      unread.push({ ...base, reason: err instanceof NoAnswer ? `No answer in ${TIMEOUT_MS / 1000} s` : err instanceof Error ? err.message.slice(0, 160) : "Couldn't be read" });
    }
  });
  // The ones needing a hand first: anything red, then amber, then the longest quiet.
  const weight = (s: SwitchProgress) => (s.flags.some((f) => f.tone === "danger") ? 0 : s.flags.some((f) => f.tone === "warning") ? 1 : 2);
  inProgress.sort((a, b) => weight(a) - weight(b) || a.lastActivity.getTime() - b.lastActivity.getTime());
  finished.sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());
  const board = { asOf: now, inProgress, finished, unread, workspaces: tenants.length };
  if (!options.tenants) cached = { at: Date.now(), board };
  return board;
}
