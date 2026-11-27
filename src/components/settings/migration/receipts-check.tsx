"use client";

import { CompanyLink } from "@/components/companies/company-link";
import { useRef, useState, useTransition } from "react";
import { carryAdvancesIn, listAdvances, listNotCounted, listVoidOpened, removeNotCounted, removeVoidOpened } from "@/actions/migration";
import type { NotCounted } from "@/lib/migration/not-counted";
import type { Advances } from "@/lib/migration/advances";
import { compareWithZohoPage, receiptsCheckNow } from "@/actions/zoho";
import type { VoidOpened } from "@/lib/migration/opened";
import type { InvoiceDifference, NotInDeskzo, ReceiptsCheck as Check } from "@/lib/receivables/zoho-compare";
import { Button } from "@/components/ui/button";
import { OldOrdersLink } from "@/components/settings/migration/old-orders-link";
import { companyPath } from "@/lib/record-links";
import { csvRow } from "@/lib/csv";
import { formatCurrency } from "@/lib/utils";

const SHOWN = 100;

type Compared = { page: number; done: boolean; checked: number; matches: number; zohoOwing: number; deskzoOwing: number; differences: InvoiceDifference[]; notInDeskzo: NotInDeskzo[] };
const NOTHING: Compared = { page: 0, done: false, checked: 0, matches: 0, zohoOwing: 0, deskzoOwing: 0, differences: [], notInDeskzo: [] };

function download(rows: Compared) {
  // Through the shared guard (security audit, 11 Nov 2026 — SEC-57): a name starting with = + - or @ opens as text, not a formula; numbers stay numbers.
  const quote = (v: string | number) => csvRow([v]);
  const lines = [
    ["Invoice", "Customer", "Date", "Currency", "Zoho owes", "Deskzo owes", "Difference", "Where"].map(quote).join(","),
    ...rows.differences.map((d) => [d.number, d.customer, d.date, d.currency, d.zoho, d.deskzo, d.difference, "Both"].map(quote).join(",")),
    ...rows.notInDeskzo.map((d) => [d.number, d.customer, d.date, d.currency, d.zoho, 0, -d.zoho, d.archived ? "Earlier years, not opened" : "Not in Deskzo"].map(quote).join(",")),
  ];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "compare-with-zoho.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <div className="text-muted">{label}</div>
      <div className="text-sm font-medium text-text">{value}</div>
      {note && <div className="text-subtle">{note}</div>}
    </div>
  );
}

/**
 * Whether what Deskzo says customers owe is right (owner, 6 Nov 2026): the receipts check, from Deskzo alone, and
 * Compare with Zoho, invoice by invoice — src/lib/receivables/zoho-compare.ts. Neither changes anything.
 */
export function ReceiptsCheck({ connected }: { connected: boolean }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [compared, setCompared] = useState<Compared>(NOTHING);
  const [error, setError] = useState<string | null>(null);
  const [checking, startCheck] = useTransition();
  const [comparing, setComparing] = useState(false);
  const stop = useRef(false);

  const runCheck = () =>
    startCheck(async () => {
      setError(null);
      const r = await receiptsCheckNow();
      if (r.ok) setCheck(r.data);
      else setError(r.error);
    });

  // A page at a time, so a big list shows how far it has got, can be stopped, and carries on from where Zoho stopped it.
  const compare = async () => {
    setError(null);
    setComparing(true);
    stop.current = false;
    let sofar = compared.done ? NOTHING : compared;
    if (sofar === NOTHING) setCompared(NOTHING);
    try {
      while (!stop.current) {
        const r = await compareWithZohoPage(sofar.page + 1);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        const p = r.data;
        sofar = {
          page: p.page,
          done: !p.hasMore,
          checked: sofar.checked + p.checked,
          matches: sofar.matches + p.matches,
          zohoOwing: sofar.zohoOwing + p.zohoOwing,
          deskzoOwing: sofar.deskzoOwing + p.deskzoOwing,
          differences: [...sofar.differences, ...p.differences],
          notInDeskzo: [...sofar.notInDeskzo, ...p.notInDeskzo],
        };
        setCompared(sofar);
        if (!p.hasMore) return;
      }
    } catch {
      setError("The comparison stopped — the connection dropped. Press Compare again; it carries on from here.");
    } finally {
      setComparing(false);
    }
  };

  const biggest = [...compared.differences].sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)).slice(0, SHOWN);
  const missing = [...compared.notInDeskzo].sort((a, b) => b.zoho - a.zoho).slice(0, SHOWN);
  const differenceTotal = compared.differences.reduce((t, d) => t + d.difference, 0);
  const archivedOwing = compared.notInDeskzo.filter((d) => d.archived).reduce((t, d) => t + d.zoho, 0);
  const elsewhereOwing = compared.notInDeskzo.filter((d) => !d.archived).reduce((t, d) => t + d.zoho, 0);

  return (
    <div className="space-y-3 rounded-lg border border-line px-3 py-3 text-xs">
      <div>
        <h4 className="text-sm font-medium text-text">Is what customers owe right?</h4>
        <p className="text-muted">Two checks, which change nothing, and one repair you confirm.</p>
      </div>
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-danger">{error}</p>}
      <NotCountedRepair onError={setError} />
      <AdvancesRepair onError={setError} />
      <VoidRepair onError={setError} />
      <OldOrdersLink onError={setError} />

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={checking} onClick={runCheck}>
            {checking ? "Checking…" : check ? "Check receipts again" : "Check receipts"}
          </Button>
          <span className="text-muted">Money received, set against invoices, and on account. No calls to Zoho.</span>
        </div>
        {check && (
          <>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Figure label="Received" value={formatCurrency(check.received)} note={`${check.payments.toLocaleString("en-IN")} payments`} />
              <Figure label="Set against invoices" value={formatCurrency(check.applied)} />
              <Figure label="On account" value={formatCurrency(check.onAccount)} note={`${check.withMoneyLeft.toLocaleString("en-IN")} payments with money left`} />
              <Figure label="Owing, as Receivables shows it" value={formatCurrency(check.open)} />
            </div>
            <p className="text-text">
              {check.couldSettle >= 1 ? (
                <>
                  <span className="font-medium">{formatCurrency(check.couldSettle)}</span> is on account for customers who also have invoices open. That part of what shows as owing may be paid already — the money just isn&apos;t set against an invoice.
                </>
              ) : (
                "No customer has money on account and invoices open at once, so unadjusted receipts aren't why the figure is high."
              )}
            </p>
            {check.customers.length > 0 && (
              <div className="max-h-72 overflow-auto rounded-lg border border-line">
                <table className="w-full">
                  <thead className="sticky top-0 bg-surface-sunken text-left text-muted">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Customer</th>
                      <th className="px-2 py-1.5 text-right font-medium">On account</th>
                      <th className="px-2 py-1.5 text-right font-medium">Owing</th>
                      <th className="px-2 py-1.5 text-right font-medium">Could settle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {check.customers.map((c) => (
                      <tr key={c.companyId} className="border-t border-line">
                        <td className="px-2 py-1.5">
                          <CompanyLink href={`${companyPath(c.companySeq)}?tab=statement`} className="text-brand hover:underline">
                            {c.name}
                          </CompanyLink>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(c.onAccount)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(c.open)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(c.couldSettle)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {connected && (
        <div className="space-y-2 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={comparing} onClick={() => void compare()}>
              {comparing ? `Comparing… ${compared.checked.toLocaleString("en-IN")} invoices` : compared.page > 0 && !compared.done ? "Carry on comparing" : compared.done ? "Compare again" : "Compare with Zoho"}
            </Button>
            {comparing && (
              <Button type="button" size="sm" variant="ghost" onClick={() => (stop.current = true)}>
                Stop
              </Button>
            )}
            <span className="text-muted">Each invoice&apos;s balance in Zoho and here. One of Zoho&apos;s calls per 200 invoices.</span>
          </div>
          {compared.page > 0 && (
            <>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <Figure label="Checked" value={compared.checked.toLocaleString("en-IN")} note={compared.done ? "All of Zoho's invoices" : "So far"} />
                <Figure label="Zoho says owing" value={formatCurrency(compared.zohoOwing)} />
                <Figure label="Deskzo says owing, of those" value={formatCurrency(compared.deskzoOwing)} />
                <Figure label="Balances that differ" value={compared.differences.length.toLocaleString("en-IN")} note={`${compared.matches.toLocaleString("en-IN")} agree · net ${formatCurrency(differenceTotal)}`} />
              </div>
              {check && compared.done && Math.abs(check.openInvoices - compared.deskzoOwing) >= 1 && (
                <p className="text-text">{formatCurrency(check.openInvoices - compared.deskzoOwing)} of what Deskzo shows owing is on invoices Zoho doesn&apos;t list under those numbers.</p>
              )}
              {compared.notInDeskzo.length > 0 && (
                <p className="text-text">
                  Owing in Zoho but not open here:
                  {archivedOwing >= 1 && <> {formatCurrency(archivedOwing)} from earlier years, which <span className="font-medium">Open the ones still owing</span> brings.</>}
                  {elsewhereOwing >= 1 && <> {formatCurrency(elsewhereOwing)} on invoices Deskzo hasn&apos;t got yet.</>}
                </p>
              )}
              {(compared.differences.length > 0 || compared.notInDeskzo.length > 0) && (
                <Button type="button" size="sm" variant="ghost" onClick={() => download(compared)}>
                  Download all as CSV
                </Button>
              )}
              {biggest.length > 0 && (
                <div className="max-h-80 overflow-auto rounded-lg border border-line">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-surface-sunken text-left text-muted">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">Invoice</th>
                        <th className="px-2 py-1.5 font-medium">Customer</th>
                        <th className="px-2 py-1.5 text-right font-medium">Zoho owes</th>
                        <th className="px-2 py-1.5 text-right font-medium">Deskzo owes</th>
                        <th className="px-2 py-1.5 text-right font-medium">Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {biggest.map((d) => (
                        <tr key={d.number} className="border-t border-line">
                          <td className="whitespace-nowrap px-2 py-1.5">{d.number}</td>
                          <td className="px-2 py-1.5">
                            {d.companySeq === null ? (
                              d.customer
                            ) : (
                              <CompanyLink href={`${companyPath(d.companySeq)}?tab=statement`} className="text-brand hover:underline">
                                {d.customer}
                              </CompanyLink>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(d.zoho)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(d.deskzo)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(d.difference)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {missing.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-muted">Owing in Zoho, not open here ({compared.notInDeskzo.length.toLocaleString("en-IN")})</summary>
                  <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto">
                    {missing.map((d) => (
                      <li key={d.number} className="text-text">
                        {d.number} · {d.customer} · {formatCurrency(d.zoho)} · {d.archived ? "earlier years" : "not in Deskzo"}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Advances from before the year that Zoho set against this year's invoices (owner, 17 Nov 2026 —
 * src/lib/migration/advances.ts): the list, then a press to carry them in, a hundred at a time.
 */
function AdvancesRepair({ onError }: { onError: (message: string | null) => void }) {
  const [list, setList] = useState<Advances | null>(null);
  const [working, setWorking] = useState(false);
  const [sure, setSure] = useState(false);
  const [done, setDone] = useState<{ count: number; amount: number } | null>(null);

  const look = async () => {
    onError(null);
    setWorking(true);
    setSure(false);
    try {
      const r = await listAdvances();
      if (r.ok) setList(r.data);
      else onError(r.error);
    } catch {
      onError("That didn't go through — reload the page.");
    } finally {
      setWorking(false);
    }
  };

  const carry = async () => {
    onError(null);
    setWorking(true);
    setSure(false);
    let count = 0;
    let amount = 0;
    try {
      for (;;) {
        const r = await carryAdvancesIn();
        if (!r.ok) {
          onError(r.error);
          break;
        }
        count += r.data.carried;
        amount += r.data.amount;
        setDone({ count, amount });
        if (!r.data.more || !r.data.carried) break;
      }
      const again = await listAdvances();
      if (again.ok) setList(again.data);
    } catch {
      onError("It stopped part-way; what was carried stays. Press Look again, then carry on.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="space-y-2 border-b border-line pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={working} onClick={() => void look()}>
          {working ? "Working…" : list ? "Look again" : "Find advances from before the year"}
        </Button>
        <span className="text-muted">
          Money a customer paid before the year that Zoho set against this year&apos;s invoices — those invoices look unpaid until it is carried in. Import this
          year&apos;s receipts first. Looking changes nothing.
        </span>
      </div>
      {done && (
        <p className="rounded-md bg-surface-sunken px-3 py-2 text-text">
          Carried in {done.count.toLocaleString("en-IN")}, {formatCurrency(done.amount)}, each set against the invoices Zoho set it against.
        </p>
      )}
      {list && list.rows.length === 0 && (
        <p className="text-muted">None found. If Zoho has some, pull customer payments again first — the pull now reads when each was applied.</p>
      )}
      {list && list.rows.length > 0 && (
        <>
          <p className="text-text">
            {list.toCarry.toLocaleString("en-IN")} to carry in, {formatCurrency(list.carried)}.
            {list.left > 0 && <> {list.left.toLocaleString("en-IN")} left for you, each saying why.</>}
          </p>
          <div className="max-h-72 overflow-auto rounded-md border border-line">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface-sunken text-left text-muted">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Payment</th>
                  <th className="px-2 py-1.5 font-medium">Customer</th>
                  <th className="px-2 py-1.5 font-medium">Paid</th>
                  <th className="px-2 py-1.5 font-medium">Settles this year</th>
                  <th className="px-2 py-1.5 text-right font-medium">Carried</th>
                  <th className="px-2 py-1.5 font-medium">In the books</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => (
                  <tr key={`${r.party}:${r.number}`} className="border-t border-line align-top">
                    <td className="px-2 py-1.5">{r.number}</td>
                    <td className="px-2 py-1.5">{r.party}</td>
                    <td className="px-2 py-1.5">{r.date}</td>
                    <td className="px-2 py-1.5">
                      {r.applied.map((a) => `${a.number} ${formatCurrency(a.amount)}`).join(", ")}
                      {r.unused > 0 && <span className="text-muted"> · {formatCurrency(r.unused)} still unused</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(r.carried)}</td>
                    <td className="px-2 py-1.5 text-muted">{r.left ?? (r.books === "opening" ? "Already in the opening balances" : "Posted on the year's first day")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.toCarry > 0 && !sure && (
            <Button type="button" size="sm" variant="secondary" disabled={working} onClick={() => setSure(true)}>
              Carry in {list.toCarry.toLocaleString("en-IN")}…
            </Button>
          )}
          {list.toCarry > 0 && sure && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text">
                This adds {list.toCarry.toLocaleString("en-IN")} opening advances, {formatCurrency(list.carried)}, and sets them against those invoices. Undo takes
                them back with the rest.
              </span>
              <Button type="button" size="sm" disabled={working} onClick={() => void carry()}>
                Yes, carry them in
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => setSure(false)}>
                Not now
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * This year's invoices and credit notes brought across though Zoho doesn't count them (owner, 17 Nov 2026 —
 * src/lib/migration/not-counted.ts): rejected, waiting for approval, void or a draft there. The list first, from Zoho,
 * then a press to take them back.
 */
function NotCountedRepair({ onError }: { onError: (message: string | null) => void }) {
  const [list, setList] = useState<NotCounted | null>(null);
  const [working, setWorking] = useState(false);
  const [sure, setSure] = useState(false);
  const [done, setDone] = useState<{ count: number; total: number } | null>(null);

  const look = async () => {
    onError(null);
    setWorking(true);
    setSure(false);
    try {
      const r = await listNotCounted();
      if (r.ok) setList(r.data);
      else onError(r.error);
    } catch {
      onError("That didn't go through — reload the page.");
    } finally {
      setWorking(false);
    }
  };

  const remove = async () => {
    onError(null);
    setWorking(true);
    setSure(false);
    try {
      const r = await removeNotCounted();
      if (!r.ok) onError(r.error);
      else setDone({ count: r.data.takenBack, total: r.data.total });
      const again = await listNotCounted();
      if (again.ok) setList(again.data);
    } catch {
      onError("It stopped part-way, and what went is gone. Press Look again, then carry on.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="space-y-2 border-b border-line pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={working} onClick={() => void look()}>
          {working ? "Working…" : list ? "Look again" : "Find documents Zoho doesn't count"}
        </Button>
        <span className="text-muted">
          This year&apos;s invoices and credit notes brought across though Zoho has them rejected, waiting for approval, void or as a draft. Asks Zoho — about one of
          its calls per 200 — and changes nothing.
        </span>
      </div>
      {done && (
        <p className="rounded-md bg-surface-sunken px-3 py-2 text-text">
          Took back {done.count.toLocaleString("en-IN")}, net {formatCurrency(done.total)}, each with its ledger entry.
        </p>
      )}
      {list && list.rows.length === 0 && <p className="text-muted">None here — everything brought across counts in Zoho too.</p>}
      {list && list.rows.length > 0 && (
        <>
          <p className="text-text">
            {list.toTakeBack.toLocaleString("en-IN")} to take back, net {formatCurrency(list.total)} (with tax).
            {list.held > 0 && <> {list.held.toLocaleString("en-IN")} left for you to look at: something is set against them.</>}
          </p>
          <div className="max-h-72 overflow-auto rounded-md border border-line">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface-sunken text-left text-muted">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Number</th>
                  <th className="px-2 py-1.5 font-medium">Party</th>
                  <th className="px-2 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 text-right font-medium">Total</th>
                  <th className="px-2 py-1.5 font-medium">In Zoho</th>
                  <th className="px-2 py-1.5 font-medium">Held because</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => (
                  <tr key={`${r.kind}:${r.number}`} className="border-t border-line">
                    <td className="px-2 py-1.5">{r.number}</td>
                    <td className="px-2 py-1.5">{r.party}</td>
                    <td className="px-2 py-1.5">{r.date}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(r.kind === "CREDIT_NOTE" ? -r.total : r.total)}</td>
                    <td className="px-2 py-1.5 text-muted">{r.zohoStatus}</td>
                    <td className="px-2 py-1.5 text-muted">{r.held ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.toTakeBack > 0 && !sure && (
            <Button type="button" size="sm" variant="secondary" disabled={working} onClick={() => setSure(true)}>
              Take back {list.toTakeBack.toLocaleString("en-IN")}…
            </Button>
          )}
          {list.toTakeBack > 0 && sure && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text">
                This removes {list.toTakeBack.toLocaleString("en-IN")} from your books with their ledger entries. An approved invoice comes back by itself once it
                is sent in Zoho.
              </span>
              <Button type="button" size="sm" disabled={working} onClick={() => void remove()}>
                Yes, take them back
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => setSure(false)}>
                Not now
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Invoices void, rejected or awaiting approval in the old system that were opened here as owing (owner, 8 and 21 Nov
 * 2026; src/lib/migration/opened.ts): the
 * list first, then a press to take them back, a hundred at a time until none are left.
 */
function VoidRepair({ onError }: { onError: (message: string | null) => void }) {
  const [list, setList] = useState<VoidOpened | null>(null);
  const [working, setWorking] = useState(false);
  const [sure, setSure] = useState(false);
  const [done, setDone] = useState<{ count: number; owing: number } | null>(null);

  const look = async () => {
    onError(null);
    setWorking(true);
    setSure(false);
    try {
      const r = await listVoidOpened();
      if (r.ok) setList(r.data);
      else onError(r.error);
    } catch {
      onError("That didn't go through — reload the page.");
    } finally {
      setWorking(false);
    }
  };

  const remove = async () => {
    onError(null);
    setWorking(true);
    setSure(false);
    let count = 0;
    let owing = 0;
    try {
      for (;;) {
        const r = await removeVoidOpened();
        if (!r.ok) {
          onError(r.error);
          break;
        }
        count += r.data.takenBack;
        owing += r.data.owing;
        setDone({ count, owing });
        if (!r.data.more || !r.data.takenBack) break;
      }
      const again = await listVoidOpened();
      if (again.ok) setList(again.data);
    } catch {
      onError("It stopped part-way, and what went is gone. Press Look again, then carry on.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="space-y-2 border-b border-line pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={working} onClick={() => void look()}>
          {working ? "Working…" : list ? "Look again" : "Find invoices void or rejected in Zoho"}
        </Button>
        <span className="text-muted">Earlier-year invoices and bills void, rejected or still awaiting approval in Zoho, but opened here as owing. Looking changes nothing.</span>
      </div>
      {done && (
        <p className="rounded-md bg-surface-sunken px-3 py-2 text-text">
          Took back {done.count.toLocaleString("en-IN")}, {formatCurrency(done.owing)}, each with its opening entry.
        </p>
      )}
      {list && list.rows.length === 0 && <p className="text-muted">None here.</p>}
      {list && list.rows.length > 0 && (
        <>
          <p className="text-text">
            {list.toTakeBack.toLocaleString("en-IN")} to take back, {formatCurrency(list.owing)}.
            {list.held > 0 && <> {list.held.toLocaleString("en-IN")} left for you to look at: something is set against them.</>}
          </p>
          <div className="max-h-72 overflow-auto rounded-md border border-line">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface-sunken text-left text-muted">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Number</th>
                  <th className="px-2 py-1.5 font-medium">Party</th>
                  <th className="px-2 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 font-medium">In Zoho</th>
                  <th className="px-2 py-1.5 text-right font-medium">Owing here</th>
                  <th className="px-2 py-1.5 font-medium">Left because</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => (
                  <tr key={`${r.kind}:${r.party}:${r.number}`} className="border-t border-line">
                    <td className="px-2 py-1.5">{r.number}</td>
                    <td className="px-2 py-1.5">{r.party}</td>
                    <td className="px-2 py-1.5">{r.date}</td>
                    <td className="px-2 py-1.5 capitalize">{r.zohoStatus.toLowerCase()}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(r.owing)}</td>
                    <td className="px-2 py-1.5 text-muted">{r.held ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.toTakeBack > 0 && !sure && (
            <Button type="button" size="sm" variant="secondary" disabled={working} onClick={() => setSure(true)}>
              Take back {list.toTakeBack.toLocaleString("en-IN")}…
            </Button>
          )}
          {list.toTakeBack > 0 && sure && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text">
                This removes {list.toTakeBack.toLocaleString("en-IN")} from your books with their opening entries, {formatCurrency(list.owing)} in all.
              </span>
              <Button type="button" size="sm" disabled={working} onClick={() => void remove()}>
                Yes, take them back
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => setSure(false)}>
                Not now
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
