"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, X } from "lucide-react";
import type { LeadSource } from "@prisma/client";
import { quickCreateLead } from "@/actions/quick-lead";
import { findCompanyMatches, searchCustomerOptions } from "@/actions/company";
import { searchItemOptions } from "@/actions/item";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { ItemCombobox, type ItemComboOption } from "@/components/items/item-combobox";
import { toast } from "@/components/ui/toast";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { leadPath } from "@/lib/record-links";

/**
 * Create › Quick lead (owner, 27 Oct 2026; src/actions/quick-lead.ts): the company, the person, what they need, the
 * products and where they came from — saved, and either opened or cleared for the next caller. Everything else is
 * filled in on the lead.
 */

const LAST_SOURCE = "deskzo.quickLead.source";

const readSource = (): LeadSource => {
  try {
    const kept = localStorage.getItem(LAST_SOURCE);
    return kept && (LEAD_SOURCE_VALUES as string[]).includes(kept) ? (kept as LeadSource) : "CALLING";
  } catch {
    return "CALLING";
  }
};

type ProductRow = { key: number; item: ItemComboOption | null; quantity: string };

export function QuickLeadDialog({ open, onClose, withProducts }: { open: boolean; onClose: () => void; withProducts: boolean }) {
  const router = useRouter();
  const ids = useId();
  const [company, setCompany] = useState<CompanyComboOption | null>(null);
  const [newCompany, setNewCompany] = useState("");
  // Said when "Create new" turned out to name a company that's here in another spelling.
  const [companyNote, setCompanyNote] = useState<string | null>(null);
  const [person, setPerson] = useState({ name: "", phone: "", email: "" });
  const [title, setTitle] = useState("");
  const [source, setSource] = useState<LeadSource>(readSource);
  const [products, setProducts] = useState<ProductRow[]>([{ key: 0, item: null, quantity: "1" }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One lead per filled form, however many times it's sent (createLead keeps the token); a fresh one per lead.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const busy = useRef(false);
  const nextKey = useRef(1);

  const reset = () => {
    setCompany(null);
    setNewCompany("");
    setCompanyNote(null);
    setPerson({ name: "", phone: "", email: "" });
    setTitle("");
    setProducts([{ key: nextKey.current++, item: null, quantity: "1" }]);
    setError(null);
    setRequestId(crypto.randomUUID());
  };

  async function save(then: "open" | "another") {
    if (busy.current) return;
    setError(null);
    if (!company && newCompany.trim().length < 2) return setError("Pick the company, or type a new one's name.");
    if (title.trim().length < 2) return setError("Say what they need — a few words.");
    busy.current = true;
    setSaving(true);
    try {
      localStorage.setItem(LAST_SOURCE, source);
    } catch {}
    const result = await quickCreateLead({
      companyId: company?.id ?? "",
      companyName: company ? "" : newCompany.trim(),
      contactName: person.name,
      phone: person.phone,
      email: person.email,
      title,
      source,
      requirements: products.filter((p) => p.item).map((p) => ({ itemId: p.item!.id, quantity: Number(p.quantity) || 1 })),
      requestId,
    }).catch(() => ({ ok: false as const, error: "Couldn't save just now — try again." }));
    busy.current = false;
    setSaving(false);
    if (!result.ok) return setError(result.error);
    if (then === "open") {
      onClose();
      router.push(leadPath(result.data.leadSeq));
      return;
    }
    toast.success(`Lead saved for ${result.data.companyName}.`);
    reset();
  }

  const setRow = (key: number, patch: Partial<ProductRow>) => setProducts((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <Dialog open={open} onClose={onClose} title="Quick lead">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save("open");
        }}
      >
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-company`}>Company *</Label>
          {newCompany ? (
            <div className="flex items-center gap-2 rounded-base border border-line px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                <span className="text-text">{newCompany}</span> <span className="text-xs text-subtle">— new, made with the lead</span>
              </span>
              <button
                type="button"
                className="text-xs text-brand hover:underline"
                onClick={() => {
                  setNewCompany("");
                  setCompanyNote(null);
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <CompanyCombobox
              id={`${ids}-company`}
              // The one picked — by hand or because "Create new" named it — so the field shows its name.
              companies={company ? [company] : []}
              value={company?.id ?? ""}
              search={searchCustomerOptions}
              onSelect={(picked) => {
                setCompany(picked);
                setCompanyNote(null);
              }}
              onCreateNew={(query) => {
                const typed = query.trim();
                setCompany(null);
                setNewCompany(typed);
                setCompanyNote(null);
                // "Summit Motors Private Limited" when "Summit Motors Pvt Ltd" is here (src/lib/companies/by-name.ts):
                // that company, picked — the save would use it anyway, and the field shouldn't say "new".
                void findCompanyMatches(typed, "CLIENT")
                  .then(({ duplicate }) => {
                    if (!duplicate) return;
                    if (duplicate.visible && duplicate.customer) {
                      setNewCompany("");
                      setCompany({ id: duplicate.match.id, name: duplicate.match.name });
                      setCompanyNote(`Already here as ${duplicate.match.name} — the lead goes on it.`);
                    } else {
                      setCompanyNote(duplicate.visible ? `${duplicate.match.name} is already here, as a vendor — a lead is with a customer.` : "A company of that name is already here, but it isn't one of yours — ask its account manager.");
                    }
                  })
                  .catch(() => {});
              }}
              placeholder="Type to search, or a new company's name…"
              autoHighlightFirst="typed"
            />
          )}
        </div>

        {companyNote && <p className="-mt-1 text-xs text-muted">{companyNote}</p>}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-name`}>Person</Label>
            <Input id={`${ids}-name`} value={person.name} onChange={(e) => setPerson({ ...person, name: e.target.value })} placeholder="Their name" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-phone`}>Mobile</Label>
            <Input id={`${ids}-phone`} type="tel" value={person.phone} onChange={(e) => setPerson({ ...person, phone: e.target.value })} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-email`}>Email</Label>
            <Input id={`${ids}-email`} type="email" value={person.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} autoComplete="off" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-title`}>What they need *</Label>
          <Input id={`${ids}-title`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="50 Microsoft 365 licences, firewall renewal…" autoComplete="off" />
        </div>

        {withProducts && (
          <div className="space-y-1.5">
            <Label>Products required</Label>
            {products.map((row, index) => (
              <div key={row.key} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <ItemCombobox items={[]} value={row.item?.id ?? ""} search={searchItemOptions} onSelect={(item) => setRow(row.key, { item })} ariaLabel={`Product ${index + 1}`} />
                </div>
                <Input aria-label={`Quantity of product ${index + 1}`} type="number" min={1} value={row.quantity} onChange={(e) => setRow(row.key, { quantity: e.target.value })} className="w-20" />
                {products.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove product ${index + 1}`}
                    className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-base text-subtle hover:bg-surface-sunken hover:text-text"
                    onClick={() => setProducts((rows) => rows.filter((r) => r.key !== row.key))}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="inline-flex items-center gap-1 text-xs text-brand hover:underline" onClick={() => setProducts((rows) => [...rows, { key: nextKey.current++, item: null, quantity: "1" }])}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add a product
            </button>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-source`}>Source</Label>
          <Select id={`${ids}-source`} value={source} onChange={(e) => setSource(e.target.value as LeadSource)}>
            {LEAD_SOURCE_VALUES.map((s) => (
              <option key={s} value={s}>
                {LEAD_SOURCE_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>

        <p className="text-xs text-subtle">The salesperson comes from your lead assignment rules. Value, close date and the rest go on the lead.</p>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void save("another")} disabled={saving}>
            Save &amp; add another
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
            Save &amp; open
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
