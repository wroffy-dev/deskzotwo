"use server";

import { requireModuleUser } from "@/lib/modules-access";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { publicOrigin } from "@/lib/mail/connect-state";
import { MigrationRefused, openMigration } from "@/lib/migration/state";
import { isStepKey, stepPreview } from "@/lib/migration/steps";
import { callbackPath, DATA_CENTRES, isDataCentre, listOrganisations, zohoAllowance, ZohoBusy, ZohoRefused } from "@/lib/zoho/client";
import { compareInvoicesPage, receiptsCheck } from "@/lib/receivables/zoho-compare";
import { mayUseZoho, ZOHO_BACK } from "@/lib/zoho/access";
import { countZoho } from "@/lib/zoho/count";
import { compareSides, deskzoSide, masterMatches, zohoSide, type Completeness } from "@/lib/zoho/completeness";
import { handOverFetched, latestPull, pullPreview, pullStep, startPull, stopPulls } from "@/lib/zoho/pull";
import { nightlySetting, setNightly } from "@/lib/zoho/nightly";
import { fillIrnsFromZoho, irnsToAsk } from "@/lib/zoho/einvoices";
import { fillGstFromZoho, itemsWithoutGst } from "@/lib/zoho/item-gst";
import { bringOpenedLines } from "@/lib/migration/opened-lines";
import type { ActionResult } from "@/actions/company";

/**
 * Switch to Deskzo › Zoho's API (src/lib/zoho; owner, 26 Oct 2026): the workspace's own Zoho app, its connection,
 * and the pull. Whoever may bring a year across (`mayUseZoho`), on every call.
 */

async function gate() {
  // The switch is the books': Accounting in the plan, as every other action of the switch asks (src/actions/migration.ts).
  const user = await requireModuleUser("accounting");
  if (!(await mayUseZoho(user.id))) throw new MigrationRefused("Connecting to Zoho needs the rights to post journal entries and to import finance data.");
  return user;
}

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    if (err instanceof MigrationRefused || err instanceof ZohoRefused) return { ok: false, error: err.message };
    throw err;
  }
}

/** The kinds of the archive Zoho keeps a PDF of. */
const PDF_KINDS = ["INVOICE", "CREDIT_NOTE", "QUOTE", "SALES_ORDER", "PURCHASE_ORDER"];

/**
 * The archive's PDFs, for "Fetch the archive's PDFs only" (owner, 26 Nov 2026: "why this is fade" — make it say why):
 * how many still to fetch, how many have theirs, and how many can't be asked for, having no Zoho id — the backup's
 * files carry none; a pull reads them.
 */
async function archivePdfStanding(migrationId: string | null) {
  if (!migrationId) return { archivePdfs: 0, archivePdfsHave: 0, archivePdfsNoId: 0 };
  const where = { migrationId, kind: { in: PDF_KINDS } };
  const [archivePdfs, archivePdfsHave, archivePdfsNoId] = await Promise.all([
    db.archivedDocument.count({ where: { ...where, oldId: { not: null }, file: null } }),
    db.archivedDocument.count({ where: { ...where, NOT: { file: null } } }),
    db.archivedDocument.count({ where: { ...where, oldId: null, file: null } }),
  ]);
  return { archivePdfs, archivePdfsHave, archivePdfsNoId };
}

/** Where the connection stands, for the page — never the secret or a token. */
export async function zohoState() {
  return run(async () => {
    await gate();
    const row = await db.zohoConnection.findUnique({ where: { id: "default" }, select: { dataCentre: true, clientId: true, refreshToken: true, organizationId: true, organizationName: true, planName: true, connectedAt: true } });
    const origin = await publicOrigin();
    const organisations = row?.refreshToken && !row.organizationId ? await listOrganisations().catch(() => []) : [];
    const m = await openMigration();
    return {
      app: row ? { dataCentre: row.dataCentre, clientId: row.clientId } : null,
      connected: !!row?.refreshToken,
      organisation: row?.organizationId ? { id: row.organizationId, name: row.organizationName, plan: row.planName, ...(await zohoAllowance()) } : null,
      organisations,
      homepage: origin,
      callback: `${origin}${callbackPath}`,
      dataCentres: DATA_CENTRES.map((d) => ({ value: d.value, label: d.label })),
      pull: m ? await latestPull(m.id) : null,
      nightly: await nightlySetting(),
      // When the switch's files last came in — a backup's day, the top-up's natural start.
      lastUpload: m ? ((await db.migrationFile.findFirst({ where: { migrationId: m.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }))?.createdAt.toISOString().slice(0, 10) ?? null) : null,
      ...(await archivePdfStanding(m?.id ?? null)),
    };
  });
}

/** The workspace's Zoho app: its client id and secret, and the data centre the organisation is in. */
export async function saveZohoApp(input: { dataCentre: string; clientId: string; clientSecret: string }) {
  return run(async () => {
    const user = await gate();
    const clientId = String(input?.clientId ?? "").trim();
    const secret = String(input?.clientSecret ?? "").trim();
    if (!isDataCentre(input?.dataCentre)) throw new MigrationRefused("Choose the data centre your Zoho account is in.");
    if (!/^[\w.]{10,120}$/.test(clientId)) throw new MigrationRefused("That isn't a Zoho client id — copy it from the app in Zoho's API console.");
    if (secret.length < 10 || secret.length > 200) throw new MigrationRefused("Give the app's client secret, from the same page.");
    const data = { dataCentre: input.dataCentre, clientId, clientSecret: await encryptSecret(secret), refreshToken: null, accessToken: null, accessExpiresAt: null, organizationId: null, organizationName: null, planName: null, connectedById: null, connectedAt: null };
    await db.zohoConnection.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ZohoConnection", entityId: "default", entityLabel: `Saved the workspace's Zoho app (${input.dataCentre} data centre)` });
    revalidatePath(ZOHO_BACK);
    return null;
  });
}

/** Of the organisations the Zoho sign-in can see, the one to pull from. */
export async function chooseZohoOrganisation(organisationId: string) {
  return run(async () => {
    const user = await gate();
    const org = (await listOrganisations()).find((o) => o.id === String(organisationId));
    if (!org) throw new MigrationRefused("That organisation isn't one this Zoho sign-in can see.");
    await db.zohoConnection.update({ where: { id: "default" }, data: { organizationId: org.id, organizationName: org.name, planName: org.plan } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ZohoConnection", entityId: "default", entityLabel: `Chose the Zoho Books organisation ${org.name}` });
    return null;
  });
}

/** Forgets the connection and the app; what was pulled stays. Revoke the app in Zoho too. */
export async function disconnectZoho() {
  return run(async () => {
    const user = await gate();
    await db.zohoConnection.deleteMany({ where: { id: "default" } });
    // A pull can't go on without the connection; left going, it would hold Finish back for good.
    const m = await openMigration();
    if (m) await stopPulls(m.id, "Stopped: Deskzo was disconnected from Zoho. What it brought across stays.");
    await recordAudit({ userId: user.id, action: "DELETE", entityType: "ZohoConnection", entityId: "default", entityLabel: "Disconnected Deskzo from Zoho Books" });
    revalidatePath(ZOHO_BACK);
    return null;
  });
}

async function open() {
  const m = await openMigration();
  if (!m) throw new MigrationRefused("Start the switch first — the pull brings the year it is for.");
  return m;
}

/** How many of each kind Zoho holds, this year's apart, and about how many calls and days the pull will take. */
export async function countZohoRecords() {
  return run(async () => {
    await gate();
    const m = await open();
    const conn = await db.zohoConnection.findUnique({ where: { id: "default" }, select: { refreshToken: true, organizationId: true, planName: true } });
    if (!conn?.refreshToken || !conn.organizationId) throw new MigrationRefused("Connect Deskzo to your Zoho Books organisation first.");
    return countZoho(m.yearStart, (await zohoAllowance()).allowance);
  });
}

/**
 * "Is everything in?" (owner, 20 Nov 2026): Zoho's count of each kind for the year beside what Deskzo imported, with
 * what each difference means — src/lib/zoho/completeness.ts. About 15 of Zoho's calls, and one more for every 200
 * invoices, credit notes and bills, and every 200 customers, vendors and items; changes nothing.
 */
export async function checkZohoCompleteness() {
  return run(async () => {
    await gate();
    const m = await open();
    const conn = await db.zohoConnection.findUnique({ where: { id: "default" }, select: { refreshToken: true, organizationId: true } });
    if (!conn?.refreshToken || !conn.organizationId) throw new MigrationRefused("Connect Deskzo to your Zoho Books organisation first.");
    const [zoho, deskzo] = await Promise.all([zohoSide(m.yearStart), deskzoSide(m.id)]);
    // Customers, vendors and items found by what they are, not only by Zoho's id (owner, 23 Nov 2026 — "fix the check").
    const masters = await masterMatches();
    const rows = compareSides(zoho.counts, deskzo, masters.byKey);
    return { rows, calls: zoho.calls + masters.calls, checkedAt: new Date().toISOString(), behind: rows.filter((r) => r.state === "behind" || r.state === "missing").length } satisfies Completeness;
  });
}

/**
 * Zoho's calls a day for the organisation, as Zoho shows it (Settings › Developer Space › API usage) — Zoho can raise
 * it past the plan's. Empty goes back to the plan's. Deskzo uses nine in ten of it, leaving the rest to the team.
 */
export async function setZohoDailyLimit(limit: number | null) {
  return run(async () => {
    const user = await gate();
    const value = limit === null ? null : Math.round(Number(limit));
    if (value !== null && !(Number.isFinite(value) && value >= 100 && value <= 1_000_000)) {
      throw new MigrationRefused("Type Zoho's calls a day as a number, at least 100 — or leave it empty for the plan's.");
    }
    const conn = await db.zohoConnection.findUnique({ where: { id: "default" }, select: { id: true } });
    if (!conn) throw new MigrationRefused("Connect Deskzo to Zoho Books first.");
    await db.zohoConnection.update({ where: { id: "default" }, data: { dailyCallLimit: value } });
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "ZohoConnection",
      entityId: "default",
      entityLabel: value === null ? "Set Zoho's calls a day back to the plan's" : `Set Zoho's calls a day to ${value.toLocaleString("en-IN")}`,
    });
    return zohoAllowance();
  });
}

/**
 * A pull: everything ("full"), only what Zoho has changed since a day — the backup's — added on top ("topup"), or only
 * Zoho's PDFs of the archive ("pdfs").
 */
export async function startZohoPull(expected: Record<string, number> = {}, options: { mode?: "full" | "topup" | "pdfs"; since?: string; only?: string[]; everything?: boolean; earlier?: boolean } = {}) {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const mode = options?.mode === "topup" || options?.mode === "pdfs" ? options.mode : "full";
    // "Pull this from Zoho" on a section: only its modules (owner, 28 Oct 2026).
    const only = Array.isArray(options?.only) ? options.only.map(String).slice(0, 20) : undefined;
    // A pull already going is carried on, not started again (`startPull`) — and logged as that (owner, 20 Nov 2026: the
    // log said "Started pulling everything" for "Carry on pulling", which only woke last night's top-up).
    const going = await db.zohoPull.findFirst({ where: { migrationId: m.id, status: { in: ["FETCHING", "STORING", "PDFS", "WAITING"] } }, select: { id: true } });
    const pull = await startPull(m, user.id, expected && typeof expected === "object" ? expected : {}, { mode, since: typeof options?.since === "string" ? options.since : undefined, only, everything: options?.everything === true, earlier: options?.earlier === true });
    if (going && pull.id === going.id) {
      await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ZohoPull", entityId: pull.id, entityLabel: "Carried on the Zoho Books pull" });
      return pull;
    }
    // "Pull again" after a whole pull is a top-up from that pull's day (src/lib/zoho/pull.ts `again`) — said as that.
    const again = pull.progress.again ? pull.progress.since : null;
    const what = again
      ? `again — what Zoho has changed since ${again}`
      : mode === "topup"
        ? `what Zoho has changed since ${options.since}`
        : mode === "pdfs"
          ? "Zoho's PDFs of the earlier years"
          : pull.progress.earlier
            ? "the earlier years' quotes"
            : only?.length
              ? `only ${only.join(", ")}`
              : options?.everything
                ? "everything, every record read again"
                : "everything";
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "ZohoPull", entityId: pull.id, entityLabel: `Started pulling ${what} from Zoho Books` });
    return pull;
  });
}

/** The night's top-up on or off (src/lib/zoho/nightly.ts); on, it acts as whoever turned it on. */
export async function setZohoNightly(on: boolean) {
  return run(async () => {
    const user = await gate();
    await open();
    const conn = await db.zohoConnection.findUnique({ where: { id: "default" }, select: { refreshToken: true, organizationId: true } });
    if (on && (!conn?.refreshToken || !conn.organizationId)) throw new ZohoRefused("Connect Deskzo to your Zoho Books organisation first.");
    await setNightly(!!on, user.id);
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ZohoConnection", entityId: "default", entityLabel: on ? "Turned on the nightly top-up from Zoho Books" : "Turned off the nightly top-up from Zoho Books" });
    revalidatePath(ZOHO_BACK);
    return null;
  });
}

/** Stops the pull that is still going — what it brought stays — so the switch can finish without the rest. */
export async function stopZohoPull() {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const stopped = await stopPulls(m.id, "Stopped by hand. What it brought across stays.");
    if (stopped) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ZohoPull", entityId: m.id, entityLabel: "Stopped the Zoho Books pull" });
    revalidatePath(ZOHO_BACK);
    return { stopped };
  });
}

/** The pull a few seconds further; the page calls it until it is done, waiting, or failed. */
export async function stepZohoPull(pullId: string) {
  return run(async () => {
    const user = await gate();
    const result = await pullStep(await open(), String(pullId ?? ""), user.id);
    if (result.status === "DONE") revalidatePath(ZOHO_BACK);
    return result;
  });
}

/** What has been fetched so far, to its sections now — while the pull waits on Zoho's daily allowance, or is still going. */
export async function handOverZohoPull(pullId: string) {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const result = await handOverFetched(m, String(pullId ?? ""), user.id);
    if (!result.busy) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ZohoPull", entityId: m.id, entityLabel: "Handed over what the Zoho pull has fetched so far" });
    revalidatePath(ZOHO_BACK);
    return result;
  });
}

/** The money received against what's set against invoices and what's on account (src/lib/receivables/zoho-compare.ts). Reads only. */
export async function receiptsCheckNow() {
  return run(async () => {
    await gate();
    return receiptsCheck();
  });
}

/** A page of Zoho's invoice list, balance against balance. Reads only; one of Zoho's calls. */
export async function compareWithZohoPage(page: number) {
  return run(async () => {
    await gate();
    try {
      return await compareInvoicesPage(Math.max(1, Math.floor(Number(page)) || 1));
    } catch (err) {
      // Asked to wait, or the day's calls are used: said on the page, which carries on from this page when pressed again.
      if (err instanceof ZohoBusy) throw new ZohoRefused(err.daily ? "Zoho's calls for today are used up. Press Compare again after midnight — it carries on from here." : "Zoho asked Deskzo to slow down. Press Compare again in a minute — it carries on from here.");
      throw err;
    }
  });
}

/** What the pull has fetched so far — each file's count and the newest 200 of one — before it is handed on. */
export async function zohoPullPreview(pullId: string, file: string | null) {
  return run(async () => {
    await gate();
    const m = await open();
    const pull = await db.zohoPull.findFirst({ where: { id: String(pullId ?? ""), migrationId: m.id }, select: { id: true } });
    if (!pull) throw new MigrationRefused("That pull isn't there.");
    return pullPreview(pull.id, file ? String(file) : null);
  });
}

/** What a section holds once the pull handed it over — how many, and the last 200 — to see before checking. Read only. */
export async function zohoHandedPreview(step: string) {
  return run(async () => {
    await gate();
    const m = await open();
    if (!isStepKey(step)) throw new MigrationRefused("There's no such section.");
    return stepPreview(m, step);
  });
}

/** How many invoices brought across have no IRN and haven't been asked of Zoho yet (src/lib/zoho/einvoices.ts). */
export async function zohoIrnsToAsk() {
  return run(async () => {
    await gate();
    return irnsToAsk();
  });
}

/**
 * Asks Zoho for the e-invoice of invoices brought across without one (owner, 21 Nov 2026: "after 29 oct invoices not
 * showing irn"), newest first, for up to 40 seconds; pressed again, it carries on. Zoho's calls, at its pace.
 */
export async function fillZohoIrns() {
  return run(async () => {
    const user = await gate();
    try {
      const r = await fillIrnsFromZoho({ budgetMs: 40_000, userId: user.id });
      if (r.filled) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TradeDocument", entityId: "zoho-irns", entityLabel: `Brought ${r.filled} IRN(s) across from Zoho for invoices pulled without one` });
      if (r.filled) revalidatePath("/sales/invoices");
      return r;
    } catch (err) {
      if (err instanceof ZohoBusy) throw new ZohoRefused(err.daily ? "Zoho's calls for today are used up. Press it again after midnight — it carries on from here." : "Zoho asked Deskzo to slow down. Press it again in a minute — it carries on from here.");
      throw err;
    }
  });
}

/**
 * Puts their own lines on last year's invoices and bills opened as owing, in place of their one "Brought forward" line
 * (owner, 21 Nov 2026 — src/lib/migration/opened-lines.ts): from the archive, else from Zoho, one call each, for up to
 * 40 seconds; pressed again, it carries on. Totals, balances and opening entries stay as they are.
 */
export async function bringOpenedLinesFromZoho() {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const conn = await db.zohoConnection.findUnique({ where: { id: "default" }, select: { refreshToken: true, organizationId: true } });
    const r = await bringOpenedLines(m, { budgetMs: 40_000, zoho: !!conn?.refreshToken && !!conn.organizationId });
    if (r.brought) {
      await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Migration", entityId: m.id, entityLabel: `Earlier years: put their own lines on ${r.brought} invoice(s) and bill(s) opened as "Brought forward"` });
      revalidatePath("/sales/invoices");
    }
    return r;
  });
}

/** How many items have no GST rate or HSN/SAC and haven't been asked of Zoho yet (src/lib/zoho/item-gst.ts). */
export async function zohoItemsWithoutGst() {
  return run(async () => {
    await gate();
    return itemsWithoutGst();
  });
}

/**
 * Fills each item's empty GST rate and HSN/SAC from its own record in Zoho (owner, 21 Nov 2026: "gst rate not set on
 * items" — "can you fetch this from zoho?"), for up to 40 seconds; pressed again, it carries on. Never replaces a value.
 */
export async function fillZohoItemGst() {
  return run(async () => {
    const user = await gate();
    try {
      const r = await fillGstFromZoho({ budgetMs: 40_000 });
      if (r.rates || r.codes) {
        await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Item", entityId: "zoho-gst", entityLabel: `Filled ${r.rates} GST rate(s) and ${r.codes} HSN/SAC code(s) from Zoho on items without one` });
        revalidatePath("/items");
      }
      return r;
    } catch (err) {
      if (err instanceof ZohoBusy) throw new ZohoRefused(err.daily ? "Zoho's calls for today are used up. Press it again after midnight — it carries on from here." : "Zoho asked Deskzo to slow down. Press it again in a minute — it carries on from here.");
      throw err;
    }
  });
}
