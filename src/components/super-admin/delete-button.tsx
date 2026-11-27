"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteCompany } from "@/actions/company-delete";
import { removeCompanyProduct } from "@/actions/company";
import { deleteItem } from "@/actions/item";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/**
 * The super admin's Delete on a record's page (owner, 27 Oct 2026): a company (customer or vendor), an order or an
 * item. Shown to the super admin only; each action checks again and refuses, saying why, a record with history.
 */
const KINDS = {
  company: { run: deleteCompany, keeps: "its contacts, addresses and bank accounts", refuses: "invoices, bills, payments, orders, leads, tickets or anything else that happened with it" },
  order: { run: removeCompanyProduct, keeps: "its price history, expenses and rebates", refuses: "a payment applied, an invoice raised or addons co-termed to it" },
  item: { run: deleteItem, keeps: "its units and reseller prices", refuses: "orders, leads, documents, stock or assets" },
} as const;

export function SuperAdminDeleteButton({ kind, id, name, noun, backTo }: { kind: keyof typeof KINDS; id: string; name: string; noun: string; backTo: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { run, keeps, refuses } = KINDS[kind];

  const confirm = () =>
    start(async () => {
      setError(null);
      const r = await run(id);
      if (!r.ok) return setError(r.error);
      setOpen(false);
      router.push(backTo);
    });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Delete this ${noun}`}
        aria-label={`Delete this ${noun}`}
        className="inline-grid h-9 w-9 shrink-0 place-items-center rounded-base border border-line-strong bg-surface text-danger shadow-sm transition-colors hover:bg-danger-bg"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Delete ${noun}`}>
        <p className="text-sm text-muted">
          Delete <span className="font-medium text-text">{name}</span> with {keeps}? This can&apos;t be undone. One with {refuses} can&apos;t be deleted.
        </p>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={confirm} disabled={pending}>
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
