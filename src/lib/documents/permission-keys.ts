import type { TradeDocumentType } from "@prisma/client";
import { challanWords } from "@/lib/country-pack";
import type { Role } from "@/lib/roles";

/**
 * Who may do what to which document (owner, 9 Nov 2026: "create, edit, issue, delete, cancel and approve, all
 * separate permissions for separate documents"). One permission per document type and action, laid out as a grid on
 * the role and person screens; they replace "Raise and issue sales documents", "Delete or cancel a sales document",
 * "Raise credit and debit notes" and "Raise purchase orders" (migration 20261209120000_document_permissions copied
 * every stored grant and denial of those onto these, so nobody's access changed on the day).
 *
 * - Create: a new draft — typed in, converted from another document, raised from an order, a renewal, a project.
 * - Edit: change a draft. An issued document stays locked for everyone; a credit note corrects it.
 * - Issue: make it final — the number, the books, the e-invoice; and, once issued, its status (a quote accepted…).
 * - Delete: a draft that was never issued.
 * - Cancel: an issued one, with a reason — the ledger reversed, the IRN cancelled with the portal.
 * - Approve: sign off a document waiting for approval, where Settings › Document approvals asks for it; never one's
 *   own. On top of the approvers that rule names.
 *
 * Dependency-free (types only), so the registry, the screens and the actions read the same list.
 */

export const DOC_ACTIONS = ["create", "edit", "issue", "delete", "cancel", "approve"] as const;
export type DocAction = (typeof DOC_ACTIONS)[number];

export const DOC_ACTION_LABELS: Record<DocAction, string> = {
  create: "Create",
  edit: "Edit",
  issue: "Issue",
  delete: "Delete",
  cancel: "Cancel",
  approve: "Approve",
};

/** The document types with permissions of their own, in the order the grid lists them, by their slug in a key. */
export const DOC_KINDS = [
  { type: "PROPOSAL", slug: "proposal", label: "Proposals", one: "proposal", module: "sales" },
  { type: "PROFORMA", slug: "proforma", label: "Proforma invoices", one: "proforma invoice", module: "sales" },
  { type: "INVOICE", slug: "invoice", label: "Tax invoices", one: "tax invoice", module: "sales" },
  { type: "CREDIT_NOTE", slug: "creditNote", label: "Credit notes", one: "credit note", module: "sales" },
  { type: "DEBIT_NOTE", slug: "debitNote", label: "Debit notes", one: "debit note", module: "sales" },
  {
    type: "DELIVERY_CHALLAN",
    slug: "deliveryChallan",
    // "Delivery notes" outside India (challanWords); the permission keys stay deliveryChallan.
    get label() {
      return challanWords().Many;
    },
    get one() {
      return challanWords().one;
    },
    module: "sales",
  },
  { type: "PURCHASE_ORDER", slug: "purchaseOrder", label: "Purchase orders", one: "purchase order", module: "purchases" },
  { type: "BILL", slug: "bill", label: "Vendor bills", one: "vendor bill", module: "purchases" },
] as const satisfies readonly { type: TradeDocumentType; slug: string; label: string; one: string; module: "sales" | "purchases" }[];

export type DocSlug = (typeof DOC_KINDS)[number]["slug"];
export type DocPermissionKey = `docs.${DocAction}${Capitalize<DocSlug>}`;

/** The key for a kind and an action: docs.createProposal, docs.cancelInvoice — noun.verb, as every key is. */
export function docKeyOf(slug: DocSlug, action: DocAction): DocPermissionKey {
  return `docs.${action}${slug[0]!.toUpperCase()}${slug.slice(1)}` as DocPermissionKey;
}

const KIND_BY_TYPE = new Map<string, (typeof DOC_KINDS)[number]>(DOC_KINDS.map((k) => [k.type, k]));

/** The permission for doing this to a document of this type. */
export function docKey(docType: TradeDocumentType, action: DocAction): DocPermissionKey {
  const kind = KIND_BY_TYPE.get(docType);
  if (!kind) throw new Error(`No permissions for documents of type ${docType}`);
  return docKeyOf(kind.slug, action);
}

/** Whether a key is one of these. */
export const isDocKey = (key: string): key is DocPermissionKey => key.startsWith("docs.");

/** The refusal, in words. */
export function docRefusal(docType: TradeDocumentType, action: DocAction): string {
  const one = KIND_BY_TYPE.get(docType)?.one ?? "document";
  const verb = { create: "create", edit: "edit", issue: "issue", delete: "delete", cancel: "cancel", approve: "approve" }[action];
  return `You don't have permission to ${verb} a ${one}.`;
}

/** Who held each before (the old keys' default roles), so a built-in role holds today what it held yesterday. */
const SALES_WRITERS: readonly Role[] = ["SALES", "ACCOUNTS", "MANAGEMENT"];
const UNDOERS: readonly Role[] = ["ACCOUNTS", "MANAGEMENT"];
const NOTE_WRITERS: readonly Role[] = ["ACCOUNTS", "MANAGEMENT"];
const PO_WRITERS: readonly Role[] = ["PURCHASE", "ACCOUNTS", "MANAGEMENT"];

const WRITES = new Set<DocAction>(["create", "edit", "issue"]);
const UNDOES = new Set<DocAction>(["delete", "cancel"]);

/**
 * What the old keys gave, as the new ones: the migration copies each stored grant and denial by this, the presets
 * expand by it, and the default roles below follow it.
 */
export function replacedBy(old: "documents.issue" | "documents.void" | "documents.notes" | "purchase.raiseOrders"): DocPermissionKey[] {
  const keys = (slugs: DocSlug[], actions: Set<DocAction>) => slugs.flatMap((s) => DOC_ACTIONS.filter((a) => actions.has(a)).map((a) => docKeyOf(s, a)));
  switch (old) {
    case "documents.issue":
      return keys(["proposal", "proforma", "invoice", "deliveryChallan", "bill"], WRITES);
    case "documents.void":
      return keys(["proposal", "proforma", "invoice", "creditNote", "debitNote", "deliveryChallan", "bill"], UNDOES);
    case "documents.notes":
      return keys(["creditNote", "debitNote"], WRITES);
    case "purchase.raiseOrders":
      return keys(["purchaseOrder"], new Set([...WRITES, ...UNDOES]));
  }
}

function defaultRolesOf(slug: DocSlug, action: DocAction): readonly Role[] {
  if (action === "approve") return [];
  if (slug === "purchaseOrder") return PO_WRITERS;
  if (UNDOES.has(action)) return UNDOERS;
  if (slug === "creditNote" || slug === "debitNote") return NOTE_WRITERS;
  return SALES_WRITERS;
}

const ACTION_WORDS: Record<DocAction, (one: string) => string> = {
  create: (one) => `Start a new ${one} — typed in, converted from another document, or raised from an order, renewal or project. A draft; issuing it is separate.`,
  edit: (one) => `Change a draft ${one}. An issued one stays locked for everyone.`,
  issue: (one) => `Make a ${one} final: its number, the books${one === "tax invoice" ? ", and the e-invoice with the portal" : ""}; and change its status once issued.`,
  delete: (one) => `Delete a draft ${one} that was never issued.`,
  cancel: (one) => `Cancel an issued ${one}, with a reason: it stays on record as cancelled${one === "tax invoice" ? ", the books are reversed and its IRN is cancelled with the portal (only within 24 hours)" : ", and what it posted is reversed"}.`,
  approve: (one) => `Approve or send back a ${one} waiting for approval, where Settings › Document approvals asks for it — never their own.`,
};

export type DocPermissionDefinition = {
  key: DocPermissionKey;
  label: string;
  description: string;
  defaultRoles: readonly Role[];
  group: string;
  selfExcluded?: boolean;
  tier?: "sensitive";
};

/** The registry's entries for these (src/lib/permissions.ts). */
export const DOCUMENT_PERMISSIONS: readonly DocPermissionDefinition[] = DOC_KINDS.flatMap((kind) =>
  DOC_ACTIONS.map((action) => ({
    key: docKeyOf(kind.slug, action),
    label: `${DOC_ACTION_LABELS[action]} ${kind.label.toLowerCase()}`,
    description: ACTION_WORDS[action](kind.one),
    defaultRoles: defaultRolesOf(kind.slug, action),
    group: "Documents",
    ...(action === "approve" ? { selfExcluded: true } : {}),
    ...(action === "cancel" && (kind.slug === "invoice" || kind.slug === "bill") ? { tier: "sensitive" as const } : {}),
  })),
);
