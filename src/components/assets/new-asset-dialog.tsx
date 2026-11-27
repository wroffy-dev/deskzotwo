"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Plus } from "lucide-react";
import type { AssetKind, AssetOwnership } from "@prisma/client";
import { locationsFor, saveAsset } from "@/actions/it-asset";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import { searchCompanyOptions } from "@/actions/company-options";
import { assetKindLabels, isPhysical, mayBeCapitalised, ownershipLabels } from "@/lib/assets/lifecycle";

type Options = {
  companies: { id: string; name: string }[];
  people: { id: string; name: string }[];
  items: { id: string; name: string }[];
  fixedAssets: { id: string; tag: string; name: string }[];
  /** The workspace's asset types in order (src/lib/assets/types.ts); Deskzo's eleven when not given. */
  types?: { id: string; name: string; kind: AssetKind }[];
};

const OWNERSHIPS: AssetOwnership[] = ["INTERNAL", "DEPLOYED", "CLIENT_OWNED"];

/**
 * Adding something to the register.
 *
 * The ownership question comes first and visibly changes the rest of the form, because it is the
 * field with real consequences: a client's machine can't carry a financial record, and the form
 * should make that obvious rather than refusing on save.
 */
/**
 * Opened from a company's own page, the company is not a question — it is the page you are on. A
 * preset fixes it and starts from the ownership that page is about, so nobody scrolls a list of
 * five hundred names to pick the customer already on screen.
 */
export type AssetPreset = {
  companyId: string;
  companyName: string;
  ownership: AssetOwnership;
};

export function NewAssetDialog({
  options,
  preset,
  label,
}: {
  options: Options;
  preset?: AssetPreset;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Held with the company it was loaded for, so the list can be *derived* during render rather than
  // cleared from inside an effect — which also stops a previous company's sites flashing up while
  // the new ones are still loading.
  const [loadedSites, setLoadedSites] = useState<{
    companyId: string;
    rows: { id: string; label: string; city: string | null }[];
  } | null>(null);

  // The workspace's own list (owner, 18 Nov 2026 — Settings › Asset types), else Deskzo's eleven, as before.
  const types = options.types?.length ? options.types : (Object.keys(assetKindLabels) as AssetKind[]).map((k) => ({ id: `atype_${k.toLowerCase()}`, name: assetKindLabels[k], kind: k }));
  const [form, setForm] = useState({
    assetTag: "",
    serialNumber: "",
    name: "",
    typeId: types[0]?.id ?? "atype_laptop",
    ownership: preset?.ownership ?? ("INTERNAL" as AssetOwnership),
    // Both, so switching "whose is it?" inside the dialog keeps the company the page is about —
    // the submit only sends whichever one the chosen ownership allows.
    ownerCompanyId: preset?.companyId ?? "",
    siteCompanyId: preset?.companyId ?? "",
    locationId: "",
    itemId: "",
    make: "",
    model: "",
    specification: "",
    vendorCompanyId: "",
    fixedAssetId: "",
    purchasedOn: "",
    purchaseCost: "",
    warrantyEndsOn: "",
    amcEndsOn: "",
    licenceKey: "",
    seats: "",
    notes: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const clientOwned = form.ownership === "CLIENT_OWNED";
  // Where it sits: the client's own machine at the client; one deployed at the company it went to; one used internally
  // at our office, which isn't asked (owner, 18 Nov 2026: "if ours - used internally is selected then why sitting at").
  const deployed = form.ownership === "DEPLOYED";
  const siteCompany = clientOwned ? form.ownerCompanyId : deployed || preset ? form.siteCompanyId : "";
  // What the chosen type behaves as: a licence has no site and doesn't move.
  const kind: AssetKind = types.find((t) => t.id === form.typeId)?.kind ?? "LAPTOP";
  const physical = isPhysical(kind);

  // Sites follow whichever company the asset belongs to or sits at.
  const locations = loadedSites?.companyId === siteCompany ? loadedSites.rows : [];

  useEffect(() => {
    if (!siteCompany) return;
    let cancelled = false;
    locationsFor(siteCompany).then((rows) => {
      if (!cancelled) setLoadedSites({ companyId: siteCompany, rows });
    });
    return () => {
      cancelled = true;
    };
  }, [siteCompany]);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveAsset({
        assetTag: form.assetTag,
        serialNumber: form.serialNumber || undefined,
        name: form.name,
        typeId: form.typeId,
        kind,
        ownership: form.ownership,
        ownerCompanyId: clientOwned ? form.ownerCompanyId || undefined : undefined,
        siteCompanyId: siteCompany || undefined,
        locationId: form.locationId || undefined,
        itemId: form.itemId || undefined,
        make: form.make || undefined,
        model: form.model || undefined,
        specification: form.specification || undefined,
        vendorCompanyId: form.vendorCompanyId || undefined,
        fixedAssetId: clientOwned ? undefined : form.fixedAssetId || undefined,
        purchasedOn: form.purchasedOn || undefined,
        purchaseCost: form.purchaseCost ? Number(form.purchaseCost) : undefined,
        warrantyEndsOn: form.warrantyEndsOn || undefined,
        amcEndsOn: form.amcEndsOn || undefined,
        licenceKey: form.licenceKey || undefined,
        seats: form.seats ? Number(form.seats) : undefined,
        notes: form.notes || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.push(`/assets/${result.data.id}`);
    });
  }

  return (
    <>
      <Button size={preset ? "sm" : undefined} onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {label ?? "Add an asset"}
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Add an asset">
        <div className="space-y-4">
          {/* First, because it decides everything below it. */}
          <div className="space-y-1.5">
            <Label htmlFor="ownership">Whose is it?</Label>
            <Select id="ownership" value={form.ownership} onChange={set("ownership")}>
              {OWNERSHIPS.map((o) => (
                <option key={o} value={o}>
                  {ownershipLabels[o]}
                </option>
              ))}
            </Select>
            {clientOwned && (
              <Card className="border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
                <span className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    We look after this, we don&apos;t own it. It can&apos;t carry a fixed-asset record, and it will
                    never appear on our balance sheet.
                  </span>
                </span>
              </Card>
            )}
          </div>

          {clientOwned && !preset && (
            <div className="space-y-1.5">
              <Label htmlFor="owner">Whose?</Label>
              {/* Search, not a list (owner, 18 Nov 2026): the list held only the first 500 companies by name. */}
              <CompanyCombobox
                companies={[]}
                value={form.ownerCompanyId}
                onSelect={(c) => setForm((f) => ({ ...f, ownerCompanyId: c?.id ?? "" }))}
                search={(q) => searchCompanyOptions(q, { side: "customer" })}
                placeholder="Search the client…"
              />
            </div>
          )}

          {preset && (
            <p className="text-xs text-muted">
              {clientOwned ? "Belongs to" : "Goes to"} <span className="font-medium text-text">{preset.companyName}</span>.
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tag">Asset tag</Label>
              <Input id="tag" value={form.assetTag} onChange={set("assetTag")} className="uppercase" placeholder="WRF-LAP-014" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="serial">Serial number</Label>
              <Input id="serial" value={form.serialNumber} onChange={set("serialNumber")} className="uppercase" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kind">What kind</Label>
              <Select id="kind" value={form.typeId} onChange={set("typeId")}>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={form.name} onChange={set("name")} placeholder="ThinkPad T14 Gen 3" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="make">Make</Label>
              <Input id="make" value={form.make} onChange={set("make")} placeholder="Lenovo" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="model">Model</Label>
              <Input id="model" value={form.model} onChange={set("model")} />
            </div>
          </div>

          {physical && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {deployed && !preset && (
                <div className="space-y-1.5">
                  <Label htmlFor="site">Sitting at</Label>
                  {/* Searched for, not scrolled to (owner, 18 Nov 2026): the list held only the first 500 companies by name. */}
                  <CompanyCombobox
                    companies={[]}
                    value={form.siteCompanyId}
                    onSelect={(c) => setForm((f) => ({ ...f, siteCompanyId: c?.id ?? "" }))}
                    search={(q) => searchCompanyOptions(q, { side: "customer" })}
                    placeholder="Search the customer it's deployed at…"
                  />
                  {form.ownership === "DEPLOYED" && !form.siteCompanyId && (
                    <p className="text-xs text-warning">A deployed asset is at somebody&apos;s site — which one?</p>
                  )}
                </div>
              )}
              {locations.length > 0 && (
                <div className="space-y-1.5">
                  <Label htmlFor="loc">Which site</Label>
                  <Select id="loc" value={form.locationId} onChange={set("locationId")}>
                    <option value="">—</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                        {l.city ? ` — ${l.city}` : ""}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>
          )}

          {kind === "SOFTWARE_LICENCE" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="key">Licence key</Label>
                <Input id="key" value={form.licenceKey} onChange={set("licenceKey")} className="font-mono text-xs" />
                <p className="text-xs text-subtle">Only visible to whoever can manage assets.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="seats">Seats</Label>
                <Input id="seats" type="number" value={form.seats} onChange={set("seats")} />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bought">Bought on</Label>
              <Input id="bought" type="date" value={form.purchasedOn} onChange={set("purchasedOn")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cost">Cost</Label>
              <Input id="cost" type="number" value={form.purchaseCost} onChange={set("purchaseCost")} />
              {clientOwned && (
                <p className="text-xs text-subtle">
                  Recorded for identification and for e-way bills. It isn&apos;t ours to capitalise.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="warranty">Warranty ends</Label>
              <Input id="warranty" type="date" value={form.warrantyEndsOn} onChange={set("warrantyEndsOn")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="amc">AMC ends</Label>
              <Input id="amc" type="date" value={form.amcEndsOn} onChange={set("amcEndsOn")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vendor">Bought from</Label>
              {/* Vendors only (owner, 18 Nov 2026) — searched, never the customer book. */}
              <CompanyCombobox
                companies={[]}
                value={form.vendorCompanyId}
                onSelect={(c) => setForm((f) => ({ ...f, vendorCompanyId: c?.id ?? "" }))}
                search={(q) => searchCompanyOptions(q, { side: "vendor" })}
                placeholder="Search the vendor…"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="item">Catalogue item</Label>
              <Select id="item" value={form.itemId} onChange={set("itemId")}>
                <option value="">—</option>
                {options.items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {/* Only for something we actually own. */}
          {mayBeCapitalised(form.ownership) && options.fixedAssets.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="fa">Financial record</Label>
              <Select id="fa" value={form.fixedAssetId} onChange={set("fixedAssetId")}>
                <option value="">Not capitalised</option>
                {options.fixedAssets.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.tag} — {f.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-subtle">
                Links to the fixed asset register, where depreciation is charged. Leave blank for anything expensed
                rather than capitalised.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" rows={2} value={form.notes} onChange={set("notes")} />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button disabled={pending || !form.assetTag.trim() || !form.name.trim()} onClick={submit}>
              {pending ? "Saving…" : "Add"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
