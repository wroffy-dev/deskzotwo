"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Landmark, Link2, Plus, Upload, X } from "lucide-react";
import type { listBankAccounts, reconciliationView, unclearedCheques } from "@/actions/bank";
import {
  acceptSuggestedMatches,
  clearCheque,
  completeReconciliation,
  importStatement,
  matchStatementLine,
  saveBankAccount,
  setBankAccountActive,
  setDefaultBankAccount,
  unmatchStatementLine,
} from "@/actions/bank";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { CURRENCIES, isBaseCurrency } from "@/lib/currency";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay, indiaClock } from "@/lib/time/zone";
import { Amount } from "@/components/accounting/report-chrome";
import { confirmAction } from "@/components/ui/confirm";
import type { MoneyInPanel } from "@/actions/bank-match";
import { MoneyInProposals } from "@/components/accounting/money-in-proposals";

type Account = Awaited<ReturnType<typeof listBankAccounts>>[number];
type Cheque = Awaited<ReturnType<typeof unclearedCheques>>[number];
type View = NonNullable<Awaited<ReturnType<typeof reconciliationView>>>;

/**
 * Bank accounts, cheques in transit, and the reconciliation.
 *
 * The three sit on one page because they are one job: the reason a book balance disagrees with a
 * statement is almost always a cheque that hasn't cleared or a charge nobody recorded, and both are
 * fixed from here.
 */
export function BankingManager({
  accounts,
  cheques,
  view,
  moneyIn = null,
}: {
  accounts: Account[];
  cheques: Cheque[];
  view: View | null;
  /** Arjun's reading of the money in nothing matches yet (src/lib/bank-match). */
  moneyIn?: MoneyInPanel | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  // The row behind the reconciliation view, which is where `isDefault` and `active` live.
  const selected = view ? accounts.find((a) => a.id === view.account.id) : undefined;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      onOk?.();
      router.refresh();
    });
  }

  function selectAccount(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("account", id);
    router.push(`/accounting/banking?${params.toString()}`);
  }

  return (
    <div className="space-y-4">
      {error && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}
      {message && <Card className="border-success/40 bg-success-bg px-4 py-3 text-sm text-success">{message}</Card>}

      {/* ── Accounts ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
          <span>Bank accounts</span>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add an account
          </Button>
        </CardHeader>
        <CardContent>
          {accounts.length === 0 ? (
            <p className="text-sm text-subtle">
              None yet. Until one exists, every payment posts to the single &ldquo;Bank Accounts&rdquo; account in the
              chart — which can tell you the total but not what is in the current account. The first one you add
              adopts that account, so nothing already posted moves.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => selectAccount(a.id)}
                  className={`rounded-base border px-3 py-2 text-left transition-colors ${
                    view?.account.id === a.id
                      ? "border-brand bg-brand-subtle"
                      : "border-line hover:bg-surface-sunken"
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                    <Landmark className="h-3.5 w-3.5 text-subtle" />
                    {a.name}
                    {a.isDefault && <Badge tone="blue">Default</Badge>}
                    {a.currency && <Badge tone="amber">{a.currency}</Badge>}
                    {!a.active && <Badge tone="default">Inactive</Badge>}
                  </span>
                  {/* Its balance today: a foreign account's in its own currency, then what the books hold for it (owner, 30 Oct 2026). */}
                  <span className="block text-xs tabular-nums text-muted">
                    {a.currency ? `${formatCurrency(a.foreignBalance ?? 0, a.currency)} · ${formatCurrency(a.balance)} in the books` : formatCurrency(a.balance)}
                  </span>
                  <span className="block text-xs text-subtle">
                    {a.bankName ?? "—"}
                    {a.accountNumber && ` · ${a.accountNumber}`}
                    {a.ifsc && ` · IFSC ${a.ifsc}`}
                    {a.branch && ` · ${a.branch}`} · {a.ledgerAccount.code}
                  </span>
                </button>
              ))}
            </div>
          )}
          {view && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
              {/* Its name and bank details, changed (owner, 28 Oct 2026) — its ledger account takes the new name too. */}
              {selected && (
                <button type="button" disabled={pending} onClick={() => setEditing(true)} className="text-xs text-brand hover:underline">
                  Rename or edit {view.account.name}
                </button>
              )}
              {accounts.length > 1 && !selected?.isDefault && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => setDefaultBankAccount(view.account.id))}
                  className="text-xs text-brand hover:underline"
                >
                  Make {view.account.name} the default
                </button>
              )}

              {/**
               * Closing an account.
               *
               * `setBankAccountActive` has been here since banking was built and nothing ever called
               * it — so the "Inactive" badge two lines up could be rendered by the seed and by
               * nothing a person could do. An account closed at the bank stayed in every payment
               * picker and every reconciliation list indefinitely, and the only way out was the
               * database. The action already refuses to retire the default, which is why that case
               * is not special-cased here: the refusal is shown rather than pre-empted.
               */}
              {selected && !selected.isDefault && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={async () => {
                    if (
                      selected.active &&
                      !(await confirmAction(`Stop using ${selected.name}? It stays on every past transaction and comes off the lists for new ones.`))
                    ) {
                      return;
                    }
                    run(() => setBankAccountActive(view.account.id, !selected.active));
                  }}
                  className="text-xs text-muted hover:text-text hover:underline"
                >
                  {selected.active ? `Stop using ${view.account.name}` : `Start using ${view.account.name} again`}
                </button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Cheques in transit ────────────────────────────────────────── */}
      {cheques.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Cheques that haven&apos;t cleared</CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted">
              These are in cheques-in-hand, not in the bank — which is where the money actually is. Clearing one
              moves it, and is usually what explains a reconciliation difference.
            </p>
            <ul className="divide-y divide-line">
              {cheques.map((c) => (
                <ChequeRow key={c.id} cheque={c} accounts={accounts} pending={pending} run={run} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {view ? (
        <Reconciliation view={view} pending={pending} run={run} setMessage={setMessage} moneyIn={moneyIn} />
      ) : (
        accounts.length > 0 && (
          <Card className="px-6 py-10 text-center text-sm text-subtle">
            Pick an account above to reconcile it.
          </Card>
        )
      )}

      <AccountDialog open={adding} onClose={() => setAdding(false)} pending={pending} run={run} />
      {/* Mounted while open, so it starts from the account chosen rather than the last one edited. */}
      {editing && selected && <AccountDialog open account={selected} onClose={() => setEditing(false)} pending={pending} run={run} />}
    </div>
  );
}

function ChequeRow({
  cheque,
  accounts,
  pending,
  run,
}: {
  cheque: Cheque;
  accounts: Account[];
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) => void;
}) {
  // Banking is the books', so every day on this screen is India's, in every workspace — today too.
  const [date, setDate] = useState(() => indiaClock.today());
  const defaultAccount = accounts.find((a) => a.isDefault)?.id;

  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-text">
          {cheque.company.name}
          {cheque.reference && <span className="ml-1.5 font-mono text-xs text-subtle">#{cheque.reference}</span>}
        </span>
        <span className="block text-xs text-subtle">
          {cheque.direction === "PAID" ? "Paid out" : "Received"} on {indiaClock.date(cheque.paidOn)}
        </span>
      </span>
      <Amount value={Number(cheque.amount)} />
      <Input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="w-40"
        aria-label={`Date the cheque from ${cheque.company.name} cleared`}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          run(() =>
            clearCheque({
              paymentId: cheque.id,
              clearedOn: date,
              bankAccountId: cheque.bankAccountId ?? defaultAccount,
            }),
          )
        }
      >
        <Check className="mr-1.5 h-3.5 w-3.5" />
        Cleared
      </Button>
    </li>
  );
}

function Reconciliation({
  view,
  pending,
  run,
  setMessage,
  moneyIn,
}: {
  view: View;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) => void;
  setMessage: (m: string) => void;
  moneyIn: MoneyInPanel | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [statementBalance, setStatementBalance] = useState("");
  const router = useRouter();
  const searchParams = useSearchParams();

  const matchedStatement = new Set(view.matchedStatementIds);
  const matchedBook = new Set(view.matchedBookIds);

  function applyBalance() {
    const params = new URLSearchParams(searchParams.toString());
    if (statementBalance) params.set("balance", statementBalance);
    else params.delete("balance");
    router.push(`/accounting/banking?${params.toString()}`);
  }

  function upload(file: File) {
    const reader = new FileReader();
    reader.onload = () =>
      run(
        async () => {
          const result = await importStatement({ bankAccountId: view.account.id, csv: String(reader.result) });
          if (result.ok) {
            setMessage(
              `Imported ${result.data.imported} row(s). ${result.data.duplicates} were already held, ${result.data.skipped} weren't transactions.`,
            );
          }
          return result;
        },
        () => setImporting(false),
      );
    reader.readAsText(file);
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
          <span>Reconciling {view.account.name}</span>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload(file);
                e.target.value = "";
              }}
            />
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={pending}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {importing ? "Reading…" : "Import a statement"}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="stmtBalance">Closing balance on the statement</Label>
              <Input
                id="stmtBalance"
                type="number"
                value={statementBalance}
                onChange={(e) => setStatementBalance(e.target.value)}
                placeholder={String(view.summary.bookBalance)}
                className="w-48"
              />
            </div>
            <Button variant="secondary" onClick={applyBalance}>
              Compare
            </Button>
          </div>

          {view.account.currency && (
            <p className="text-xs text-subtle">
              A {view.account.currency} account: both sides are in {view.account.currency} — each payment&apos;s own amount, not the
              rupees it posted. Entries with no payment behind them (a revaluation, a journal) have no {view.account.currency} amount
              and aren&apos;t listed.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Figure label="Books say" value={view.summary.bookBalance} currency={view.account.currency} />
            <Figure label="Bank says" value={view.summary.statementBalance} currency={view.account.currency} />
            <Figure
              label="Adjusted for what's in flight"
              value={view.summary.adjustedBalance}
              hint="The bank's figure, less what it recorded and we didn't, plus what we recorded and it hasn't seen"
              currency={view.account.currency}
            />
            <Figure
              label="Difference"
              value={view.summary.difference}
              tone={view.summary.reconciled ? "success" : "danger"}
              currency={view.account.currency}
            />
          </div>

          {view.summary.reconciled ? (
            <Card className="border-success/40 bg-success-bg px-4 py-2.5 text-sm text-success">
              Everything is accounted for. The books and the bank agree once the items in flight are allowed for.
            </Card>
          ) : (
            <Card className="border-warning/40 bg-warning-bg px-4 py-2.5 text-sm text-warning">
              Out by {formatCurrency(Math.abs(view.summary.difference))}. Match the rows below, and look for bank
              charges or interest nobody has recorded.
            </Card>
          )}

          {view.lastReconciliation && (
            <p className="text-xs text-subtle">
              Last reconciled to {formatCalendarDay(view.lastReconciliation.statementDate)} by{" "}
              {view.lastReconciliation.completedBy.name}, difference{" "}
              {formatCurrency(Number(view.lastReconciliation.difference))}.
            </p>
          )}
        </CardContent>
      </Card>

      {view.suggestions.length > 0 && (
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
            <span>{view.suggestions.length} suggested match(es)</span>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await acceptSuggestedMatches(
                    view.account.id,
                    view.suggestions.map((s) => ({ statementLineId: s.statementLineId, bookLineId: s.bookLineId })),
                  );
                  if (result.ok) setMessage(`Matched ${result.data.matched}, ${result.data.failed} couldn't be.`);
                  return result;
                })
              }
            >
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
              Accept all
            </Button>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-muted">
              Only suggested where exactly one entry fits. Two payments of the same amount in the same week are left
              for you — guessing there produces a reconciliation that is wrong and looks right.
            </p>
            <ul className="divide-y divide-line">
              {view.suggestions.map((s) => {
                const stmt = view.statement.find((x) => x.id === s.statementLineId);
                const book = view.book.find((x) => x.id === s.bookLineId);
                return (
                  <li key={s.statementLineId} className="flex flex-wrap items-center gap-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text">{stmt?.narration}</span>
                      <span className="block text-xs text-subtle">
                        {book?.narration} · {s.why}
                      </span>
                    </span>
                    <Badge tone={s.confidence === "EXACT" ? "green" : "amber"}>{s.confidence === "EXACT" ? "Exact" : "Likely"}</Badge>
                    <Amount value={stmt?.amount ?? 0} />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => run(() => matchStatementLine(s.statementLineId, s.bookLineId))}
                    >
                      Match
                    </Button>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {moneyIn && <MoneyInProposals bankAccountId={view.account.id} panel={moneyIn} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden p-0">
          <div className="border-b border-line px-4 py-3">
            <h3 className="text-sm font-medium text-text">On the statement</h3>
            <p className="mt-0.5 text-xs text-muted">
              Unmatched rows are usually charges, interest or a receipt nobody has recorded yet.
            </p>
          </div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {view.statement.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text">{s.narration}</span>
                  <span className="block text-xs text-subtle">
                    {formatCalendarDay(s.date)}
                    {s.reference && ` · ${s.reference}`}
                  </span>
                </span>
                <Amount value={s.amount} />
                {matchedStatement.has(s.id) ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => unmatchStatementLine(s.id))}
                    className="text-success transition-colors hover:text-danger"
                    title="Matched — click to undo"
                    aria-label="Undo this match"
                  >
                    <Check className="h-4 w-4" />
                  </button>
                ) : (
                  <X className="h-4 w-4 text-subtle" aria-label="Not matched" />
                )}
              </li>
            ))}
            {view.statement.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-subtle">
                No statement imported for this account yet.
              </li>
            )}
          </ul>
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-line px-4 py-3">
            <h3 className="text-sm font-medium text-text">In the books</h3>
            <p className="mt-0.5 text-xs text-muted">
              Unmatched entries are what the bank hasn&apos;t seen yet — usually a cheque in the post.
            </p>
          </div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {view.book.map((b) => (
              <li key={b.id} className="flex items-center gap-3 px-4 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text">{b.narration}</span>
                  <span className="block text-xs text-subtle">
                    {indiaClock.date(b.date)}
                    {b.reference && ` · ${b.reference}`}
                  </span>
                </span>
                <Amount value={b.amount} />
                {matchedBook.has(b.id) ? (
                  <Check className="h-4 w-4 text-success" aria-label="Matched" />
                ) : (
                  <X className="h-4 w-4 text-subtle" aria-label="Not matched" />
                )}
              </li>
            ))}
            {view.book.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-subtle">Nothing posted to this account yet.</li>
            )}
          </ul>
        </Card>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <p className="min-w-48 flex-1 text-sm text-muted">
            Signing off records the date, both balances and the difference — including when it isn&apos;t nil. A
            reconciliation that only gets saved when it balances is one nobody ever saves.
          </p>
          <Button
            disabled={pending || !statementBalance}
            onClick={() =>
              run(
                () =>
                  completeReconciliation({
                    bankAccountId: view.account.id,
                    // The India day the view runs to, not the UTC day of its last moment.
                    statementDate: indiaClock.dateKey(new Date(view.asAt)),
                    statementBalance: Number(statementBalance),
                  }),
                () => setMessage("Reconciliation recorded."),
              )
            }
          >
            Sign this off
          </Button>
        </CardContent>
      </Card>
    </>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
  currency,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "success" | "danger";
  /** A foreign-currency account's (owner, 30 Oct 2026); its statement is in it. */
  currency?: string | null;
}) {
  return (
    <div className="rounded-base border border-line px-3 py-2.5">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div
        className={`mt-1 text-lg font-semibold tabular-nums ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-text"}`}
      >
        {currency ? formatCurrency(value, currency) : formatCurrency(value)}
      </div>
      {hint && <div className="mt-0.5 text-[11px] leading-tight text-subtle">{hint}</div>}
    </div>
  );
}

/** Adding an account, or — given `account` — changing one's name and bank details. */
function AccountDialog({
  open,
  onClose,
  pending,
  run,
  account,
}: {
  open: boolean;
  onClose: () => void;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) => void;
  account?: { id: string; name: string; bankName: string | null; accountNumber: string | null; ifsc: string | null; branch: string | null; currency?: string | null; isDefault?: boolean };
}) {
  const [form, setForm] = useState({
    name: account?.name ?? "",
    bankName: account?.bankName ?? "",
    accountNumber: account?.accountNumber ?? "",
    ifsc: account?.ifsc ?? "",
    branch: account?.branch ?? "",
    currency: account?.currency ?? "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog open={open} onClose={onClose} title={account ? `Edit ${account.name}` : "Add a bank account"}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {account
            ? "The new name shows everywhere the account does — payments, vouchers, reports — and on its ledger account in the chart. Past entries stay where they are."
            : "Each account gets its own ledger account, so the trial balance shows them separately and each one reconciles against its own statement."}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="bName">Name</Label>
          <Input id="bName" value={form.name} onChange={set("name")} placeholder="HDFC Current" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="bBank">Bank</Label>
            <Input id="bBank" value={form.bankName} onChange={set("bankName")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bBranch">Branch</Label>
            <Input id="bBranch" value={form.branch} onChange={set("branch")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bNumber">Account number</Label>
            <Input id="bNumber" value={form.accountNumber} onChange={set("accountNumber")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bIfsc">IFSC</Label>
            <Input id="bIfsc" value={form.ifsc} onChange={set("ifsc")} className="uppercase" />
          </div>
          {/* An EEFC account (owner, 30 Oct 2026): its payments are in this currency, and it is revalued at a period end. */}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="bCurrency">Currency</Label>
            <Select id="bCurrency" value={form.currency} onChange={set("currency")} disabled={!!account?.isDefault}>
              {CURRENCIES.map((c) => (
                <option key={c.code} value={isBaseCurrency(c.code) ? "" : c.code}>
                  {c.code} — {c.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-subtle">
              {account?.isDefault
                ? "The default account stays in the workspace's own currency."
                : "A foreign-currency (EEFC) account takes payments in its own currency only, shows its balance in it, and is revalued on Close the Books."}
            </p>
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <Button
            disabled={pending || !form.name.trim()}
            onClick={() =>
              run(
                () => saveBankAccount(account ? { ...form, id: account.id } : form),
                () => {
                  // Empty for the next one, rather than the last account's details waiting to be added twice.
                  setForm({ name: "", bankName: "", accountNumber: "", ifsc: "", branch: "", currency: "" });
                  onClose();
                },
              )
            }
          >
            {pending ? "Saving…" : account ? "Save" : "Add"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
