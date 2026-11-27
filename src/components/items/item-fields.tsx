"use client";

import { useState, useTransition } from "react";
import type { FieldErrors, FieldValues, UseFormRegister } from "react-hook-form";
import { createBrand } from "@/actions/brand";
import { Button } from "@/components/ui/button";
import { revenuePatternLabels, revenuePatternValues, type itemTypeValues } from "@/lib/validation/item";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { OptionCombobox } from "@/components/ui/option-combobox";
import { HsnCombobox } from "@/components/items/hsn-combobox";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";
import { itemTaxRates, workspacePack } from "@/lib/country-pack";
import { CURRENCIES, getCurrency } from "@/lib/currency";
import { TAX_CATEGORIES, taxCategoryLabels } from "@/lib/vat/rules";

export type BrandOption = { id: string; name: string; families: { id: string; name: string }[] };

export function ItemDetailFields({
  register,
  errors,
  itemType,
  brands = [],
  brandId,
  onBrandChange,
  trackInventory,
  showOpeningStock,
  showRevenuePattern = false,
  hsnCode,
  onHsnChange,
  hsnRequired = false,
  onTypeChange,
  categories = [],
  category = "",
  onCategoryChange,
  subscriptions = false,
  taxRate,
}: {
  register: UseFormRegister<FieldValues>;
  errors: FieldErrors<FieldValues>;
  itemType: string;
  /** The rate as the form holds it, so one saved before the list (18.11) is shown as it is until it's changed. */
  taxRate?: unknown;
  brands?: BrandOption[];
  brandId?: string;
  /** The brand picker searches rather than scrolls, so it sets the value itself rather than through `register`. */
  onBrandChange: (brandId: string) => void;
  trackInventory: boolean;
  showOpeningStock?: boolean;
  /**
   * Whether to ask how revenue is recognised: only where Revenue & Close is available, which the page
   * decides (`isModuleEnabled("revenue_close")`). The actions ignore the field otherwise.
   */
  showRevenuePattern?: boolean;
  /** The HSN/SAC field searches the GST directory, so it sets the value itself rather than through `register`. */
  hsnCode: string;
  onHsnChange: (code: string) => void;
  /** An Indian workspace, where the code is the tax's classification and an item must carry one. */
  hsnRequired?: boolean;
  /**
   * The type is asked as two questions — goods or service, then for a service how it's sold — and set
   * here as the one value it is stored as (GOOD, SERVICE, SUBSCRIPTION, PERPETUAL).
   */
  onTypeChange: (type: (typeof itemTypeValues)[number]) => void;
  /** The workspace's item categories (Items › Categories); the field picks one by name. */
  categories?: { id: string; name: string }[];
  category?: string;
  onCategoryChange: (name: string) => void;
  /** Renewals is in the plan and switched on, so a service may be managed as a subscription. */
  subscriptions?: boolean;
}) {
  // The workspace country pack: its currency on the prices, its tax by name, HSN only in India (src/lib/country-pack.ts).
  const pack = workspacePack();
  const symbol = getCurrency(pack.currency).symbol;
  // A brand added from the form itself (owner, 29 Oct 2026: "option to add brand if not available from here only").
  const [added, setAdded] = useState<BrandOption[]>([]);
  const allBrands = [...brands, ...added.filter((a) => !brands.some((b) => b.id === a.id))];
  const selectedBrand = allBrands.find((b) => b.id === brandId);
  // The workspace's own word for an item (Settings → Wording). Only ever rendered inside the item
  // forms, which are client components.
  const wording = useWording();
  return (
    <div className="space-y-6">
      {/* Laid out as Zoho's (owner, 23 Nov 2026: "optimize the ui and view better"): what the item is, then what it
          sells for and how it's taxed — two cards with no gaps, two columns on a wide screen and one on a phone. */}
      <Card>
        <CardHeader className="text-sm font-medium text-text">{slot(wording, "Item details", "item", "{one} details")}</CardHeader>
        <CardContent className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {/* Goods or a service decides the GST side — HSN or SAC, and whether stock is tracked — so it's asked first. */}
          <div className="space-y-1.5 sm:col-span-2">
            <span id="type-label" className="block text-sm font-medium text-text">
              Goods or service *
            </span>
            <div role="radiogroup" aria-labelledby="type-label" className="inline-flex rounded-lg border border-line bg-surface-sunken p-0.5">
              {(["GOOD", "SERVICE"] as const).map((t) => {
                const on = t === "GOOD" ? itemType === "GOOD" : itemType !== "GOOD";
                return (
                  <button
                    key={t}
                    id={t === "GOOD" ? "type" : undefined}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onTypeChange(t)}
                    className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${on ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"}`}
                  >
                    {t === "GOOD" ? "Goods" : "Service"}
                  </button>
                );
              })}
            </div>
          </div>
          {itemType !== "GOOD" && (subscriptions || itemType === "SUBSCRIPTION") ? (
            <div className="space-y-1 sm:col-span-2">
              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  checked={itemType === "SUBSCRIPTION"}
                  onChange={(e) => onTypeChange(e.target.checked ? "SUBSCRIPTION" : "SERVICE")}
                  aria-describedby="subscription-help"
                />
                Manage as a subscription — it renews
              </label>
              <p id="subscription-help" className="text-xs text-muted">
                {itemType === "SUBSCRIPTION" && !subscriptions
                  ? "Renewals isn't in your plan, so nothing will renew it — untick to make it a one-time service."
                  : "For anything sold for a term and renewed: a subscription, an AMC, a yearly support contract. It comes up in Renewals before its term ends, with reminders. Each order sets its own term."}
              </p>
            </div>
          ) : null}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="name">{slot(wording, "Item name *", "item", "{one} name *")}</Label>
            <Input id="name" {...register("name")} />
            {errors.name && <p className="text-xs text-danger">{String(errors.name.message)}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sku">SKU *</Label>
            <Input id="sku" placeholder="e.g. MS365-BSTD" {...register("sku")} />
            {errors.sku && <p className="text-xs text-danger">{String(errors.sku.message)}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="unit">Unit</Label>
            <Input id="unit" placeholder="e.g. Seat, Piece, License" {...register("unit")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="brandId">Brand</Label>
            {/* Searched rather than scrolled: a reseller's catalogue runs to a thousand brands. */}
            <OptionCombobox
              id="brandId"
              listLabel="Brands"
              options={allBrands.map((b) => ({ id: b.id, name: b.name, hint: b.families.length ? `${b.families.length} famil${b.families.length === 1 ? "y" : "ies"}` : undefined }))}
              value={brandId ?? ""}
              onSelect={(b) => onBrandChange(b?.id ?? "")}
              placeholder="Search brands…"
              emptyText="No brand by that name."
            />
            <AddBrand
              onAdded={(b) => {
                setAdded((now) => [...now, b]);
                onBrandChange(b.id);
              }}
            />
            {allBrands.length === 0 && (
              <p className="text-xs text-subtle">
                No brands yet — add one here, or under{" "}
                <Link href="/items/brands" className="underline underline-offset-2">
                  Brands &amp; families
                </Link>
                .
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="productFamilyId">Product family</Label>
            <Select id="productFamilyId" {...register("productFamilyId")} disabled={!selectedBrand}>
              <option value="">Not set</option>
              {selectedBrand?.families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
            {!selectedBrand && <p className="text-xs text-subtle">Pick a brand first.</p>}
            {selectedBrand && selectedBrand.families.length === 0 && (
              <p className="text-xs text-subtle">
                {selectedBrand.name} has no families yet — add them under{" "}
                <Link href={`/items/brands?q=${encodeURIComponent(selectedBrand.name)}`} className="underline underline-offset-2">
                  Brands &amp; families
                </Link>
                .
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category">Category</Label>
            {/* Picked from the workspace's own list, so one kind of thing isn't filed three ways. */}
            <OptionCombobox
              id="category"
              listLabel="Categories"
              // The item's own, if the list doesn't have it (a workspace from before the list), so it still shows.
              options={[...categories, ...(category && !categories.some((c) => c.name === category) ? [{ id: category, name: category }] : [])].map((c) => ({ id: c.name, name: c.name }))}
              value={category}
              onSelect={(c) => onCategoryChange(c?.id ?? "")}
              placeholder="Search categories…"
              emptyText="No category by that name."
            />
            <p className="text-xs text-subtle">
              {categories.length === 0 ? "No categories yet — add them under " : "Missing one? Add it under "}
              <Link href="/items/categories" className="underline underline-offset-2">
                Categories
              </Link>
              .
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vendor">Supplier note</Label>
            <Input id="vendor" placeholder="e.g. sourced via Ingram" {...register("vendor")} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" rows={3} placeholder="What it is — printed on quotes and invoices under the name" {...register("description")} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Price &amp; tax</CardHeader>
        <CardContent className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sellingPrice">Selling price ({symbol}) *</Label>
            <Input id="sellingPrice" type="number" min={0} step="0.01" placeholder="0.00" {...register("sellingPrice")} />
            {errors.sellingPrice ? <p className="text-xs text-danger">{String(errors.sellingPrice.message)}</p> : <p className="text-xs text-subtle">Before tax.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="costPrice">Cost price ({symbol})</Label>
            <Input id="costPrice" type="number" min={0} step="0.01" placeholder="0.00" {...register("costPrice")} />
            <p className="text-xs text-subtle">What you pay for it — for margins.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="taxRatePercent">{pack.tax.name} rate</Label>
            <TaxRateSelect register={register} current={taxRate} />
            {errors.taxRatePercent && <p className="text-xs text-danger">{String(errors.taxRatePercent.message)}</p>}
          </div>
          {pack.india && (
            <div className="space-y-1.5">
              <Label htmlFor="hsnCode">HSN / SAC code{hsnRequired ? " *" : ""}</Label>
              <HsnCombobox
                id="hsnCode"
                value={hsnCode}
                onChange={onHsnChange}
                itemType={itemType}
                aria-invalid={!!errors.hsnCode}
                aria-describedby="hsnCode-help"
              />
              {errors.hsnCode ? (
                <p id="hsnCode-help" className="text-xs text-danger">{String(errors.hsnCode.message)}</p>
              ) : (
                // What every invoice line for this item will carry, and what the GST return groups by.
                <p id="hsnCode-help" className="text-xs text-subtle">
                  {itemType === "GOOD"
                    ? "HSN, from the GST portal's directory. Copied onto every document line."
                    : "SAC — services start with 99. Copied onto every document line."}
                </p>
              )}
            </div>
          )}
          {!pack.india && (
            <div className="space-y-1.5">
              <Label htmlFor="taxCategory">{pack.tax.name} category</Label>
              <Select id="taxCategory" {...register("taxCategory")}>
                <option value="">From the rate</option>
                {TAX_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {taxCategoryLabels[category]}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {showRevenuePattern && (
            <div className="space-y-1.5">
              <Label htmlFor="revenuePattern">Revenue is recognised</Label>
              <Select id="revenuePattern" {...register("revenuePattern")}>
                <option value="">{slot(wording, "Automatic (from the item type)", "item", "Automatic (from the {one:lower} type)")}</option>
                {revenuePatternValues.map((p) => (
                  <option key={p} value={p}>
                    {revenuePatternLabels[p]}
                  </option>
                ))}
              </Select>
              {/* What "automatic" means for this type, so the choice isn't made blind. */}
              <p className="text-xs text-subtle">
                {itemType === "SUBSCRIPTION"
                  ? "Automatic: over the service period, as a subscription is earned."
                  : "Automatic: when invoiced — or over the service period when an invoice line's period runs past the month it was issued in."}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {itemType === "GOOD" && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Inventory</CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <label className="col-span-2 flex items-center gap-2 text-sm text-text">
              <input type="checkbox" {...register("trackInventory")} />
              {slot(wording, "Track inventory for this item", "item", "Track inventory for this {one:lower}")}
            </label>
            {trackInventory && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="reorderLevel">Reorder level</Label>
                  <Input id="reorderLevel" type="number" min={0} {...register("reorderLevel")} />
                </div>
                {showOpeningStock && (
                  <div className="space-y-1.5">
                    <Label htmlFor="openingStock">Opening stock</Label>
                    <Input id="openingStock" type="number" min={0} {...register("openingStock")} />
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-5">
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" {...register("active")} />
            Active (sellable / orderable)
          </label>
        </CardContent>
      </Card>
    </div>
  );
}

/** One row of "Prices in other currencies", as typed. */
export type CurrencyPriceDraft = { currency: string; sellingPrice: string; costPrice: string };

/** The stored prices as the form's rows. */
export function currencyPriceDrafts(rows: readonly { currency: string; sellingPrice: number; costPrice: number | null }[] = []): CurrencyPriceDraft[] {
  return rows.map((r) => ({ currency: r.currency, sellingPrice: String(r.sellingPrice), costPrice: r.costPrice === null ? "" : String(r.costPrice) }));
}

/** The rows as the actions take them, or what's wrong with them. The server checks again. */
export function currencyPricesForSave(
  drafts: readonly CurrencyPriceDraft[],
): { ok: true; rows: { currency: string; sellingPrice: number; costPrice?: number }[] } | { ok: false; error: string } {
  const rows: { currency: string; sellingPrice: number; costPrice?: number }[] = [];
  for (const d of drafts) {
    const selling = Number(d.sellingPrice);
    if (d.sellingPrice.trim() === "" || !Number.isFinite(selling) || selling < 0) return { ok: false, error: `Give the ${d.currency} selling price, or remove ${d.currency}.` };
    const cost = d.costPrice.trim() === "" ? undefined : Number(d.costPrice);
    if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) return { ok: false, error: `The ${d.currency} cost price must be zero or more.` };
    rows.push({ currency: d.currency, sellingPrice: selling, ...(cost !== undefined ? { costPrice: cost } : {}) });
  }
  return { ok: true, rows };
}

/**
 * The item's own prices in other currencies (owner, 30 Oct 2026): Microsoft and Autodesk licences have real dollar
 * list prices, and a USD quote should carry the item's USD price rather than the main price converted at the day's
 * rate. A currency without a row here still converts. The workspace's own currency is the main price, so not offered.
 */
export function CurrencyPricesCard({ value, onChange }: { value: CurrencyPriceDraft[]; onChange: (next: CurrencyPriceDraft[]) => void }) {
  const base = workspacePack().currency;
  const free = CURRENCIES.filter((c) => c.code !== base && !value.some((v) => v.currency === c.code));
  const [adding, setAdding] = useState("");
  const update = (code: string, patch: Partial<CurrencyPriceDraft>) => onChange(value.map((v) => (v.currency === code ? { ...v, ...patch } : v)));
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Prices in other currencies</CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-subtle">
          A document in one of these currencies takes this price as it is. Any other currency converts the {base} price at the document&apos;s
          exchange rate.
        </p>
        {value.map((row) => {
          const symbol = getCurrency(row.currency).symbol;
          return (
            <div key={row.currency} className="grid grid-cols-[5rem_1fr_1fr_auto] items-end gap-3">
              <p className="pb-2 text-sm font-medium text-text">{row.currency}</p>
              <div className="space-y-1.5">
                <Label htmlFor={`price-${row.currency}`}>Selling price ({symbol}) *</Label>
                <Input
                  id={`price-${row.currency}`}
                  type="number"
                  min={0}
                  step="0.01"
                  value={row.sellingPrice}
                  onChange={(e) => update(row.currency, { sellingPrice: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`cost-${row.currency}`}>Cost price ({symbol})</Label>
                <Input
                  id={`cost-${row.currency}`}
                  type="number"
                  min={0}
                  step="0.01"
                  value={row.costPrice}
                  onChange={(e) => update(row.currency, { costPrice: e.target.value })}
                />
              </div>
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove the ${row.currency} price`} onClick={() => onChange(value.filter((v) => v.currency !== row.currency))}>
                Remove
              </Button>
            </div>
          );
        })}
        {free.length > 0 && (
          <div className="flex items-center gap-2">
            <Select aria-label="Currency to add a price in" value={adding} onChange={(e) => setAdding(e.target.value)} className="w-64">
              <option value="">Add a currency…</option>
              {free.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.label}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!adding}
              onClick={() => {
                onChange([...value, { currency: adding, sellingPrice: "", costPrice: "" }]);
                setAdding("");
              }}
            >
              Add
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A brand not in the catalogue yet, added without leaving the item (owner, 29 Oct 2026) — the same rule as Brands &
 * families: the right to manage the catalogue, and no second brand by the same name. Its families are added there.
 */
function AddBrand({ onAdded }: { onAdded: (brand: BrandOption) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const add = () =>
    start(async () => {
      setError(null);
      const r = await createBrand({ name });
      if (!r.ok) return setError(r.error);
      onAdded({ id: r.data.id, name: r.data.name, families: [] });
      setName("");
      setOpen(false);
    });
  if (!open) {
    return (
      <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={() => setOpen(true)}>
        + Add a brand
      </button>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Input
          aria-label="New brand's name"
          placeholder="Brand name, e.g. Lenovo"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds the brand, not the item: the form around it would otherwise be sent.
            if (e.key === "Enter") {
              e.preventDefault();
              if (name.trim()) add();
            }
          }}
        />
        <Button type="button" size="sm" disabled={pending || !name.trim()} onClick={add}>
          Add
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => (setOpen(false), setError(null))}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/**
 * The item's tax rate, picked from the country's (owner, 23 Nov 2026: "this is a wrong input field … it should be a list
 * of gst … the default rate should show here along with option to edit and select other, just like zoho has"): the
 * workspace's default (Settings › Taxes) marked, and in India GST's special rates below. A rate saved before the list
 * that isn't one of them is shown as it is, to be changed; "Not set" only for an item that has none yet. Where the
 * country has no list, any rate is typed.
 */
function TaxRateSelect({ register, current }: { register: UseFormRegister<FieldValues>; current: unknown }) {
  const [editing, setEditing] = useState(false);
  const pack = workspacePack();
  const { main, special } = itemTaxRates(pack);
  if (!main.length) return <Input id="taxRatePercent" type="number" min={0} max={100} step="0.01" {...register("taxRatePercent")} />;
  const value = current === undefined || current === null ? "" : String(current);
  const known = [...main, ...special].some((r) => value !== "" && Math.abs(r - Number(value)) < 0.0001);
  // Locked until the pencil is pressed (owner, 23 Nov 2026: "keep it locked along with edit icon ! once click on edit
  // icon then allow to change" — Zoho's Default Tax Rates). One that's missing or isn't a rate opens, to be fixed.
  const locked = !editing && known;
  const rate = Number(value);
  const half = Math.round((rate / 2) * 1000) / 1000;
  return (
    <>
      {locked && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">
              {rate}%{rate === pack.tax.defaultRate ? " (default)" : ""}
              {special.some((r) => Math.abs(r - rate) < 0.0001) ? " — special rate" : ""}
            </p>
            {pack.india && (
              <p className="text-xs text-muted">
                {rate === 0 ? "No GST charged" : `Within your state CGST ${half}% + SGST ${half}% · to another state IGST ${rate}%`}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              requestAnimationFrame(() => document.getElementById("taxRatePercent")?.focus());
            }}
            className="shrink-0 rounded-md p-1.5 text-muted hover:bg-surface hover:text-text"
            aria-label={`Change the ${pack.tax.name} rate`}
            title={`Change the ${pack.tax.name} rate`}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
      {/* Kept in the form while locked, so its value is saved with the rest. */}
      <Select id="taxRatePercent" {...register("taxRatePercent")} aria-describedby="taxRatePercent-note" className={locked ? "hidden" : undefined}>
        {value === "" && <option value="">Not set</option>}
        {value !== "" && !known && <option value={value}>{value}% — not a {pack.tax.name} rate; choose one</option>}
        <optgroup label={`${pack.tax.name} rates`}>
          {main.map((r) => (
            <option key={r} value={String(r)}>
              {r}%{r === pack.tax.defaultRate ? " (default)" : ""}
            </option>
          ))}
        </optgroup>
        {special.length > 0 && (
          <optgroup label="Special rates">
            {special.map((r) => (
              <option key={r} value={String(r)}>
                {r}%
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      <p id="taxRatePercent-note" className="text-xs text-subtle">
        New items start at the default, set under{" "}
        <Link href="/settings/taxes" className="underline underline-offset-2 hover:text-text">
          Settings › Taxes
        </Link>
        .
      </p>
    </>
  );
}
