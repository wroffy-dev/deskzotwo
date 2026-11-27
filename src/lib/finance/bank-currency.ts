import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { baseCurrency, CURRENCY_CODES, isBaseCurrency } from "@/lib/currency";

/**
 * Foreign-currency bank accounts — EEFC accounts (owner, 30 Oct 2026). Server only.
 *
 * An account with a currency takes payments in that currency only: its own-currency balance is the sum of its
 * payments' amounts (src/lib/ledger/fx-revaluation.ts `foreignBankBalances`), so a rupee receipt landing in a dollar
 * account would be a balance nobody could state. The ledger is unchanged — every payment posts base amounts at its
 * own rate, as before — and Revalue foreign balances brings the account to the closing rate at a period end.
 *
 * A workspace not migrated to 20261201120000_fx_revaluation_and_bank_currency has no column: every account reads as
 * the workspace's own currency, as before.
 */

export type BankAccountOption = { id: string; name: string; currency: string | null; isDefault: boolean };

/** A currency a bank account may be kept in: one of CURRENCIES; the workspace's own is stored as null. */
export function bankCurrencyValue(code: string | null | undefined): string | null | "invalid" {
  const c = (code ?? "").trim().toUpperCase();
  if (!c || isBaseCurrency(c)) return null;
  return (CURRENCY_CODES as readonly string[]).includes(c) ? c : "invalid";
}

/** Each account's currency (null = base), by id; empty where the column isn't there yet. */
export async function bankCurrencies(ids?: string[]): Promise<Map<string, string | null>> {
  try {
    const rows = await db.bankAccount.findMany({
      where: ids ? { id: { in: ids } } : {},
      select: { id: true, currency: true },
    });
    return new Map(rows.map((r) => [r.id, r.currency]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
}

/** The active accounts a payment form offers, with each one's currency. */
export async function bankAccountOptions(): Promise<BankAccountOption[]> {
  const rows = await db.bankAccount.findMany({
    where: { active: true },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, name: true, isDefault: true },
  });
  const currencies = await bankCurrencies(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, currency: currencies.get(r.id) ?? null }));
}

/**
 * Why a payment in `currency` can't go into (or out of) this account, or null when it can. An account in the
 * workspace's own currency takes any — a dollar receipt converted into a rupee account at the bank's rate is how most
 * foreign money arrives; a foreign one takes only its own.
 */
export async function bankCurrencyRefusal(bankAccountId: string | null | undefined, currency: string): Promise<string | null> {
  if (!bankAccountId) return null;
  const account = await db.bankAccount.findUnique({ where: { id: bankAccountId }, select: { name: true, active: true } });
  if (!account) return "That bank account no longer exists.";
  if (!account.active) return `${account.name} is inactive. Choose another account.`;
  const accountCurrency = (await bankCurrencies([bankAccountId])).get(bankAccountId) ?? null;
  if (!accountCurrency || accountCurrency === (isBaseCurrency(currency) ? null : currency)) return null;
  return `${account.name} is a ${accountCurrency} account; this payment is in ${isBaseCurrency(currency) ? baseCurrency() : currency}. A foreign-currency account takes payments in its own currency only — choose another account, or record the payment in ${accountCurrency}.`;
}
