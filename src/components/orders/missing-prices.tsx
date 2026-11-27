"use client";

import { workspacePack } from "@/lib/country-pack";
import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fillAllFromProductPrice, fillMissingPrices, importMissingPrices, type FillOutcome, type MissingPriceRow } from "@/actions/order-prices";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { confirmAction } from "@/components/ui/confirm";
import { formatCurrency } from "@/lib/utils";

type List = { rows: MissingPriceRow[]; total: number; withProductPrice: number; page: number; pages: number };

/** Lines of a price file sent in one request. */
const CSV_PART = 200;

const said = (o: FillOutcome, extra = "") =>
  `${o.filled} order${o.filled === 1 ? "" : "s"} priced.${o.skipped.length ? ` ${o.skipped.length} left: ${o.skipped.slice(0, 3).map((s) => `${s.ref} (${s.reason})`).join(", ")}${o.skipped.length > 3 ? "…" : ""}.` : ""}${extra}`;

/** The missing-prices table: a price box per order, the product's price suggested, saved together. */
export function MissingPrices({ list, q }: { list: List; q: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  // What's been typed; a row nobody has touched shows its product's price — on any page, not only the first one opened.
  const [prices, setPrices] = useState<Record<string, string>>({});
  const priceOf = (r: MissingPriceRow) => prices[r.id] ?? (r.item.sellingPrice ? String(r.item.sellingPrice) : "");
  const [progress, setProgress] = useState<string | null>(null);
  const [search, setSearch] = useState(q);
  const [csv, setCsv] = useState("");

  const go = (params: { q?: string; page?: number }) => {
    const sp = new URLSearchParams();
    if (params.q) sp.set("q", params.q);
    if (params.page && params.page > 1) sp.set("page", String(params.page));
    router.push(`/orders/missing-prices${sp.size ? `?${sp}` : ""}`);
  };

  const savePage = () =>
    start(async () => {
      setNotice(null);
      const entries = list.rows.map((r) => ({ id: r.id, price: priceOf(r) })).filter((e) => e.price.trim());
      const result = await fillMissingPrices({ entries });
      setNotice(result.ok ? { tone: "success", text: said(result.data) } : { tone: "error", text: result.error });
      if (result.ok) router.refresh();
    });

  const fillAll = async () => {
    const yes = await confirmAction({
      title: `Use the product's price for ${list.withProductPrice} order${list.withProductPrice === 1 ? "" : "s"}?`,
      message: `Every order${q ? " matching your search" : ""} still without a price whose product has a selling price gets that price. It goes in batches, so keep this page open until it's done. Orders whose product has no price are left for you. Each is recorded on the order.`,
      confirmLabel: "Fill them",
    });
    if (!yes) return;
    start(async () => {
      setNotice(null);
      // A batch at a time, so no one request runs long enough to be cut off (src/actions/order-prices.ts BATCH).
      const outcome: FillOutcome = { filled: 0, skipped: [] };
      const target = list.withProductPrice;
      let after: string | null = null;
      let failed: string | null = null;
      try {
        do {
          const result: Awaited<ReturnType<typeof fillAllFromProductPrice>> = await fillAllFromProductPrice({ q, after });
          if (!result.ok) {
            failed = result.error;
            break;
          }
          outcome.filled += result.data.filled;
          outcome.skipped.push(...result.data.skipped);
          after = result.data.next;
          setProgress(`Priced ${outcome.filled.toLocaleString("en-IN")} of ${target.toLocaleString("en-IN")}…`);
        } while (after);
      } catch {
        failed = "The connection dropped.";
      }
      setProgress(null);
      setNotice(
        failed
          ? { tone: "error", text: `${failed} ${outcome.filled.toLocaleString("en-IN")} were priced before it stopped — press it again to carry on; those aren't touched twice.` }
          : { tone: "success", text: said(outcome) },
      );
      router.refresh();
    });
  };

  const importCsv = (e: FormEvent) => {
    e.preventDefault();
    start(async () => {
      setNotice(null);
      // A long file a part at a time, for the same reason as the fill above; a part with nothing to read is no failure.
      const lines = csv.split(/\r?\n/);
      const outcome: FillOutcome = { filled: 0, skipped: [] };
      const problems: string[] = [];
      let failed: string | null = null;
      try {
        for (let at = 0; at < lines.length; at += CSV_PART) {
          const part = lines.slice(at, at + CSV_PART).join("\n");
          if (!part.trim()) continue;
          const result = await importMissingPrices({ csv: part, firstLine: at + 1 });
          if (result.ok) {
            outcome.filled += result.data.filled;
            outcome.skipped.push(...result.data.skipped);
            problems.push(...result.data.problems);
          } else problems.push(result.error);
          setProgress(`Read ${Math.min(at + CSV_PART, lines.length).toLocaleString("en-IN")} of ${lines.length.toLocaleString("en-IN")} lines…`);
        }
      } catch {
        failed = "The connection dropped.";
      }
      setProgress(null);
      if (failed) setNotice({ tone: "error", text: `${failed} ${outcome.filled.toLocaleString("en-IN")} were priced before it stopped — import it again to carry on; those aren't touched twice.` });
      else if (!outcome.filled && !outcome.skipped.length) setNotice({ tone: "error", text: problems[0] ?? "No rows of order number and price were found." });
      else {
        setNotice({ tone: "success", text: said(outcome, problems.length ? ` Not read: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? "…" : ""}` : "") });
        setCsv("");
      }
      router.refresh();
    });
  };

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  return (
    <div className="mt-5 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            go({ q: search.trim() });
          }}
        >
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Customer, product or ORD-…" className="w-64" />
          <Button type="submit" variant="secondary" size="sm">
            Search
          </Button>
        </form>
        <p className="text-sm text-muted">
          <strong className="text-text">{list.total}</strong> order{list.total === 1 ? "" : "s"} without a price · {list.withProductPrice} with a product price to use
        </p>
      </div>

      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      {progress && <p className="text-sm text-muted" role="status">{progress} Keep this page open.</p>}

      {list.total === 0 ? (
        <Card className="px-4 py-12 text-center text-sm text-subtle">Every order has a price. Nothing to fill.</Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={savePage} disabled={pending}>
              {pending ? "Saving…" : "Save prices on this page"}
            </Button>
            {list.withProductPrice > 0 && (
              <Button type="button" variant="secondary" onClick={fillAll} disabled={pending}>
                Use the product price for all {list.withProductPrice}
              </Button>
            )}
          </div>
          <Card className="relative overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-subtle">
                <tr>
                  <th className="px-3 py-2.5">Order</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Product</th>
                  <th className="px-3 py-2.5 text-right">Seats</th>
                  <th className="px-3 py-2.5">Term</th>
                  <th className="px-3 py-2.5 text-right">Product price</th>
                  <th className="px-3 py-2.5">Price a seat (before {workspacePack().tax.name})</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link href={`/orders/${r.ref}`} className="text-brand hover:underline">
                        {r.ref}
                      </Link>
                      {r.isAddon && <span className="ml-1 font-sans text-[11px] text-subtle">added seats</span>}
                    </td>
                    <td className="px-3 py-2 text-text">{r.company.name}</td>
                    <td className="px-3 py-2 text-muted">{r.item.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.quantity}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">
                      {r.startDate ?? "—"} → {r.endDate ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{r.item.sellingPrice ? formatCurrency(r.item.sellingPrice) : "None"}</td>
                    <td className="px-3 py-2">
                      <Label htmlFor={`price-${r.id}`} className="sr-only">
                        Price a seat for {r.ref}
                      </Label>
                      <Input
                        id={`price-${r.id}`}
                        inputMode="decimal"
                        value={priceOf(r)}
                        onChange={(e) => setPrices((p) => ({ ...p, [r.id]: e.target.value }))}
                        placeholder="Price"
                        className="h-8 w-32 text-right tabular-nums"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {list.pages > 1 && (
            <div className="flex items-center justify-between text-sm text-muted">
              <span>
                Page {list.page} of {list.pages} — save this page before moving on
              </span>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="secondary" disabled={list.page <= 1} onClick={() => go({ q, page: list.page - 1 })}>
                  Previous
                </Button>
                <Button type="button" size="sm" variant="secondary" disabled={list.page >= list.pages} onClick={() => go({ q, page: list.page + 1 })}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <Card className="p-4">
        <form onSubmit={importCsv} className="space-y-2">
          <p className="text-sm font-medium text-text">Have the real old prices? Import them</p>
          <p className="text-xs text-muted">
            A CSV with the order number and the price a seat before {workspacePack().tax.name}, one order a line — e.g. <span className="font-mono">ORD-035836,1250</span>. A
            heading row is fine. Only orders still without a price are filled.
          </p>
          <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} className="text-xs" />
          <Textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"Order,Price\nORD-035836,1250"} className="font-mono text-xs" />
          <Button type="submit" size="sm" variant="secondary" disabled={pending || !csv.trim()}>
            Import prices
          </Button>
        </form>
      </Card>
    </div>
  );
}
