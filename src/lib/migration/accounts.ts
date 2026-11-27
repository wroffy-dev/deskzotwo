import type { AccountType } from "@prisma/client";
import { db } from "@/lib/db";
import { ensureChartOfAccounts } from "@/lib/ledger/journal";
import { RowReader } from "@/lib/portability/importers/types";
import { MigrationRefused, type MigrationRow } from "./state";

/**
 * The old system's chart of accounts, read as Deskzo's (phase 2 of the Zoho plan, owner 26 Oct 2026).
 *
 * Zoho Books names an account on every bill line, expense and journal ("Rent Expense", "Undeposited Funds") and
 * on every row of its trial balance; Deskzo's chart names them its own way ("Rent", the bank). Each of Zoho's
 * accounts is kept here (MigrationAccount) with the Deskzo account it is read as — suggested, then confirmed,
 * changed or made new — and the switch reads every account a file names through it before Deskzo's own codes
 * and names (`accountAliases`). Two of Zoho's may be read as one of Deskzo's; the month-end check adds them up.
 *
 *   · **Suggested** by the same code, else the same name, else the bank account of that name, else what Zoho's
 *     own default accounts are in Deskzo's chart (`ZOHO_DEFAULTS`). The rest wait for a choice.
 *   · **Made new** under the group Zoho's type belongs in (`GROUP_OF`), with the next free code there, and taken
 *     back by the migration's Undo while nothing has posted to it.
 *   · Receivable and payable accounts are always Deskzo's own: they are kept by party.
 */

export const CHART_COLUMNS = { name: "Account Name", code: "Account Code", type: "Account Type", parent: "Parent Account", status: "Account Status" } as const;
const K = CHART_COLUMNS;

/** Zoho's chart, by the heading its export always has. */
export const isZohoChart = (rows: Record<string, string>[]) => rows.length > 0 && K.name in rows[0]! && K.type in rows[0]!;

/** A Deskzo account by its system key, or by name where it has none. */
type Default = { key: string; why?: string } | { name: string };

/** Zoho Books' own accounts — every organisation starts with these — and what each is in Deskzo's chart. */
const ZOHO_DEFAULTS: Record<string, Default> = {
  "undeposited funds": { key: "BANK", why: "Zoho's Undeposited Funds holds money received until it is banked; its transfers to the bank don't come across, so it is read as the bank" },
  "petty cash": { key: "CASH" },
  "accounts receivable": { key: "AR" },
  "accounts payable": { key: "AP" },
  "furniture and equipment": { name: "Furniture & Fixtures" },
  "retained earnings": { key: "RETAINED_EARNINGS" },
  "owner's equity": { name: "Owner's Capital" },
  "opening balance offset": { key: "OPENING_BALANCE_EQUITY" },
  "opening balance adjustments": { key: "OPENING_BALANCE_EQUITY" },
  sales: { key: "SALES" },
  "general income": { key: "ADJUSTMENTS" },
  "other charges": { key: "ADJUSTMENTS" },
  "unearned revenue": { key: "DEFERRED_REVENUE" },
  "office supplies": { key: "EXP_OFFICE_SUPPLIES" },
  "advertising and marketing": { key: "EXP_MARKETING" },
  "exchange gain or loss": { key: "FX_GAIN_LOSS" },
  "travel expense": { key: "EXP_TRAVEL" },
  "telephone expense": { key: "EXP_PHONE_INTERNET" },
  "rent expense": { name: "Rent" },
  "shipping charge": { key: "FREIGHT_RECOVERED" },
  postage: { key: "EXP_COURIER" },
  "employee reimbursements": { key: "EMPLOYEE_PAYABLE" },
  "reimbursements payable": { key: "EMPLOYEE_PAYABLE" },
  "salaries and employee wages": { key: "SALARIES" },
  "net salary payable": { key: "SALARY_PAYABLE" },
  "meals and entertainment": { key: "EXP_MEALS" },
  lodging: { key: "EXP_ACCOMMODATION" },
  parking: { key: "EXP_TOLL_PARKING" },
  "fuel/mileage expenses": { key: "EXP_FUEL" },
  "depreciation expense": { key: "DEPRECIATION" },
  "consultant expense": { key: "EXP_PROFESSIONAL_FEES" },
  "repairs and maintenance": { key: "EXP_REPAIRS_MAINTENANCE" },
  "other expenses": { key: "EXP_OTHER" },
  "inventory asset": { key: "INVENTORY" },
  "cost of goods sold": { key: "COGS" },
  "prepaid expenses": { key: "PREPAID_EXPENSES" },
  "input cgst": { key: "INPUT_CGST" },
  "input sgst": { key: "INPUT_SGST" },
  "input igst": { key: "INPUT_IGST" },
  "output cgst": { key: "OUTPUT_CGST" },
  "output sgst": { key: "OUTPUT_SGST" },
  "output igst": { key: "OUTPUT_IGST" },
  "tds payable": { key: "TDS_PAYABLE" },
  "tds receivable": { key: "TDS_RECEIVABLE" },
  "tcs receivable": { key: "TDS_RECEIVABLE", why: "Deskzo keeps TDS and TCS receivable in one account" },
  "tcs payable": { key: "TCS_PAYABLE" },
  "round off": { key: "ROUND_OFF" },
  "purchase discounts": { key: "PURCHASE_REBATES" },
};

/** Where an account of each of Zoho's types is made in Deskzo's chart: the group's code, and the account type. */
const GROUP_OF: Record<string, { group: string; type: AccountType }> = {
  income: { group: "4000", type: "INCOME" },
  "other income": { group: "4000", type: "INCOME" },
  expense: { group: "5000", type: "EXPENSE" },
  "other expense": { group: "5000", type: "EXPENSE" },
  "cost of goods sold": { group: "5000", type: "EXPENSE" },
  "fixed asset": { group: "1200", type: "ASSET" },
  "other current asset": { group: "1100", type: "ASSET" },
  "other asset": { group: "1000", type: "ASSET" },
  cash: { group: "1100", type: "ASSET" },
  stock: { group: "1100", type: "ASSET" },
  "payment clearing": { group: "1100", type: "ASSET" },
  "other current liability": { group: "2100", type: "LIABILITY" },
  "credit card": { group: "2100", type: "LIABILITY" },
  "other liability": { group: "2000", type: "LIABILITY" },
  "long term liability": { group: "2000", type: "LIABILITY" },
  equity: { group: "3000", type: "EQUITY" },
};
const PARTY_TYPES = new Set(["accounts receivable", "accounts payable"]);

type DeskzoAccount = { id: string; code: string; name: string; isGroup: boolean; active: boolean; systemKey: string | null; bankName: string | null };

async function deskzoChart(): Promise<DeskzoAccount[]> {
  await ensureChartOfAccounts();
  const rows = await db.ledgerAccount.findMany({ select: { id: true, code: true, name: true, isGroup: true, active: true, systemKey: true, bankAccount: { select: { name: true } } }, orderBy: { code: "asc" } });
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, isGroup: r.isGroup, active: r.active, systemKey: r.systemKey, bankName: r.bankAccount?.name ?? null }));
}

/** The Deskzo account one of Zoho's is most likely, and why — or null and why not. */
function suggest(chart: DeskzoAccount[], name: string, code: string, type: string): { accountId: string | null; reason: string } {
  const usable = chart.filter((a) => !a.isGroup && a.active);
  const lower = name.toLowerCase();
  const byCode = code ? usable.find((a) => a.code.toLowerCase() === code.toLowerCase()) : undefined;
  if (byCode) return { accountId: byCode.id, reason: `The same code, ${byCode.code}` };
  const byName = usable.filter((a) => a.name.toLowerCase() === lower);
  if (byName.length === 1) return { accountId: byName[0]!.id, reason: "The same name" };
  const bank = usable.find((a) => a.bankName?.toLowerCase() === lower);
  if (bank) return { accountId: bank.id, reason: "The bank account of that name" };
  const known = ZOHO_DEFAULTS[lower];
  if (known) {
    const found = "key" in known ? usable.find((a) => a.systemKey === known.key) : usable.find((a) => a.name.toLowerCase() === known.name.toLowerCase());
    if (found) return { accountId: found.id, reason: "key" in known && known.why ? known.why : `Zoho's own ${name} is Deskzo's ${found.name}` };
  }
  const t = type.toLowerCase();
  if (t === "bank") return { accountId: null, reason: "A bank account — choose which of Deskzo's it is, or add it under Accounting › Banking first" };
  if (PARTY_TYPES.has(t)) return { accountId: usable.find((a) => a.systemKey === (t === "accounts receivable" ? "AR" : "AP"))?.id ?? null, reason: "Deskzo keeps receivables and payables by party, in its own account" };
  return { accountId: null, reason: "Not in Deskzo's chart — choose one, or make it new" };
}

export type ChartUpload = { accounts: number; suggested: number; waiting: number };

/**
 * Keeps the old chart against the migration and suggests a Deskzo account for each. Uploading it again keeps
 * every choice somebody made and suggests afresh for the rest.
 */
export async function uploadChart(m: MigrationRow, fileRows: Record<string, string>[]): Promise<ChartUpload> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  if (!isZohoChart(fileRows)) throw new MigrationRefused(`That isn't a chart of accounts — Zoho's has ${K.name} and ${K.type} columns.`);
  const chart = await deskzoChart();
  const kept = new Map((await db.migrationAccount.findMany({ where: { migrationId: m.id }, select: { name: true, accountId: true, reason: true, created: true } })).map((a) => [a.name.toLowerCase(), a]));
  const seen = new Set<string>();
  const rows: { name: string; code: string | null; type: string; parent: string | null; accountId: string | null; reason: string | null; created: boolean }[] = [];
  for (const row of fileRows) {
    const r = new RowReader(row);
    const name = r.text(K.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const code = r.text(K.code);
    const type = r.text(K.type);
    const earlier = kept.get(name.toLowerCase());
    // A choice made by hand (no reason left on it), or an account made for it, stays.
    if (earlier && earlier.accountId && (!earlier.reason || earlier.created)) {
      rows.push({ name, code: code || null, type, parent: r.text(K.parent) || null, accountId: earlier.accountId, reason: earlier.reason, created: earlier.created });
      continue;
    }
    const s = suggest(chart, name, code, type);
    rows.push({ name, code: code || null, type, parent: r.text(K.parent) || null, accountId: s.accountId, reason: s.reason, created: false });
  }
  if (rows.length === 0) throw new MigrationRefused("There are no accounts in that file.");
  await db.$transaction(async (tx) => {
    await tx.migrationAccount.deleteMany({ where: { migrationId: m.id, name: { notIn: rows.map((r) => r.name) }, created: false } });
    for (const row of rows) {
      await tx.migrationAccount.upsert({ where: { migrationId_name: { migrationId: m.id, name: row.name } }, create: { migrationId: m.id, ...row }, update: row });
    }
  });
  return { accounts: rows.length, suggested: rows.filter((r) => r.accountId).length, waiting: rows.filter((r) => !r.accountId).length };
}

export type AccountRow = { id: string; name: string; code: string | null; type: string; parent: string | null; accountId: string | null; reason: string | null; created: boolean; canMake: boolean };

/** The old chart beside Deskzo's, for the page: each old account and what it is read as, and the accounts to choose from. */
export async function listAccounts(m: MigrationRow): Promise<{ rows: AccountRow[]; choices: { id: string; code: string; name: string }[] }> {
  const [rows, chart] = await Promise.all([
    db.migrationAccount.findMany({ where: { migrationId: m.id }, orderBy: [{ accountId: { sort: "asc", nulls: "first" } }, { name: "asc" }] }),
    deskzoChart(),
  ]);
  return {
    rows: rows.map((r) => ({ id: r.id, name: r.name, code: r.code, type: r.type, parent: r.parent, accountId: r.accountId, reason: r.reason, created: r.created, canMake: r.type.toLowerCase() in GROUP_OF })),
    choices: chart.filter((a) => !a.isGroup && a.active).map((a) => ({ id: a.id, code: a.code, name: a.bankName && a.bankName !== a.name ? `${a.name} (${a.bankName})` : a.name })),
  };
}

/** The next code free in a group: after the highest under it, within its block (5000 → 5001–5999, 1100 → 1101–1199). */
function nextCode(group: string, taken: Set<string>): string | null {
  const base = Number(group);
  const span = group.endsWith("000") ? 999 : 99;
  const inBlock = [...taken].map(Number).filter((c) => Number.isInteger(c) && c > base && c <= base + span);
  const start = inBlock.length ? Math.max(...inBlock) + 1 : base + 1;
  for (let c = start; c <= base + span; c++) if (!taken.has(String(c))) return String(c);
  for (let c = base + 1; c <= base + span; c++) if (!taken.has(String(c))) return String(c);
  return null;
}

/**
 * What one old account is read as: a Deskzo account, `"new"` to make one like it in Deskzo's chart, or null to
 * leave it waiting.
 */
export async function chooseAccount(m: MigrationRow, rowId: string, choice: string | null): Promise<AccountRow> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const row = await db.migrationAccount.findFirst({ where: { id: rowId, migrationId: m.id } });
  if (!row) throw new MigrationRefused("That account isn't in the old chart any more. Upload it again.");
  let accountId: string | null = null;
  let created = row.created && choice === row.accountId;
  if (choice === "new") {
    const place = GROUP_OF[row.type.toLowerCase()];
    if (!place) throw new MigrationRefused(`An account of Zoho's type ${row.type} can't be made here — choose one of Deskzo's.`);
    const accounts = await db.ledgerAccount.findMany({ select: { id: true, code: true, name: true, isGroup: true } });
    const group = accounts.find((a) => a.code === place.group && a.isGroup);
    if (!group) throw new MigrationRefused(`Deskzo's chart has no group ${place.group} to put it in — add the account under Accounting › Chart of accounts, then choose it.`);
    const same = accounts.find((a) => a.name.toLowerCase() === row.name.toLowerCase());
    if (same) throw new MigrationRefused(`Deskzo's chart has an account called ${same.name} already (${same.code}) — choose it.`);
    const code = nextCode(place.group, new Set(accounts.map((a) => a.code)));
    if (!code) throw new MigrationRefused(`Group ${place.group} has no free code left — add the account by hand, then choose it.`);
    const made = await db.ledgerAccount.create({ data: { code, name: row.name.slice(0, 120), type: place.type, parentId: group.id, description: `Made for ${row.name} in the old system's chart` }, select: { id: true } });
    accountId = made.id;
    created = true;
  } else if (choice) {
    const account = await db.ledgerAccount.findUnique({ where: { id: choice }, select: { id: true, isGroup: true, active: true, name: true } });
    if (!account) throw new MigrationRefused("That account isn't in Deskzo's chart.");
    if (account.isGroup) throw new MigrationRefused(`${account.name} is a group — choose an account inside it.`);
    if (!account.active) throw new MigrationRefused(`${account.name} is closed.`);
    accountId = account.id;
  }
  // An account made for this row and now not wanted goes, while nothing has posted to it.
  if (row.created && row.accountId && row.accountId !== accountId) await dropIfUnused(row.accountId);
  const saved = await db.migrationAccount.update({ where: { id: row.id }, data: { accountId, reason: null, created } });
  return { id: saved.id, name: saved.name, code: saved.code, type: saved.type, parent: saved.parent, accountId: saved.accountId, reason: saved.reason, created: saved.created, canMake: saved.type.toLowerCase() in GROUP_OF };
}

/**
 * Every old account still waiting made new in Deskzo's chart, each as "Make it new" makes it (owner, 27 Oct 2026):
 * Zoho's own accounts that Deskzo's chart hasn't, in one go. One that can't be made — a bank, a type with no group,
 * a name Deskzo has already — is left waiting, with why.
 */
export async function makeRestNew(m: MigrationRow): Promise<{ made: number; left: { name: string; why: string }[] }> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const waiting = await db.migrationAccount.findMany({ where: { migrationId: m.id, accountId: null }, orderBy: { name: "asc" }, select: { id: true, name: true, type: true } });
  let made = 0;
  const left: { name: string; why: string }[] = [];
  for (const row of waiting) {
    if (!(row.type.toLowerCase() in GROUP_OF)) {
      left.push({ name: row.name, why: row.type.toLowerCase() === "bank" ? "a bank account — choose which of Deskzo's it is" : `Zoho's type ${row.type} — choose one of Deskzo's` });
      continue;
    }
    try {
      await chooseAccount(m, row.id, "new");
      made += 1;
    } catch (err) {
      if (!(err instanceof MigrationRefused)) throw err;
      left.push({ name: row.name, why: err.message });
    }
  }
  return { made, left };
}

/** Deletes an account the migration made, unless something has posted to it or uses it; true when it went. */
export async function dropIfUnused(accountId: string): Promise<boolean> {
  const [lines, vouchers] = await Promise.all([db.journalLine.count({ where: { accountId } }), db.accountVoucherLine.count({ where: { accountId } })]);
  if (lines || vouchers) return false;
  return db.ledgerAccount
    .delete({ where: { id: accountId } })
    .then(() => true)
    .catch(() => false);
}

/** The old chart as the switch reads it: an old account's name or code (lower case) → the Deskzo account's id. */
export async function accountAliases(migrationId: string): Promise<Map<string, string>> {
  const rows = await db.migrationAccount.findMany({ where: { migrationId, accountId: { not: null } }, select: { name: true, code: true, accountId: true } });
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.name.toLowerCase(), r.accountId!);
    if (r.code) map.set(r.code.toLowerCase(), r.accountId!);
  }
  return map;
}

/** How many of the old accounts still wait for a choice. */
export const accountsWaiting = (migrationId: string) => db.migrationAccount.count({ where: { migrationId, accountId: null } });

/** The migration's Undo: the accounts it made go, unless something else has posted to them since. */
export async function undoAccounts(migrationId: string): Promise<number> {
  const made = await db.migrationAccount.findMany({ where: { migrationId, created: true, accountId: { not: null } }, select: { accountId: true } });
  let gone = 0;
  for (const a of made) if (await dropIfUnused(a.accountId!)) gone += 1;
  return gone;
}
