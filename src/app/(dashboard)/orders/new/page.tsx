import Link from "next/link";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { listCompanyOptions, listAssignableUsers, listCommissionPartyOptions, listVendorOptions } from "@/actions/company";
import { itemOptionById, listItemOptions } from "@/actions/item";
import { quoteForOrder } from "@/lib/orders/from-quote";
import { punchCustomerContext } from "@/actions/order-punch";
import { isModuleEnabled, moduleAccess } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { isModuleEntitled } from "@/lib/modules-access";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
import { formSetup } from "@/lib/custom-fields/server";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { NewOrderForm } from "@/components/orders/new-order-form";
import { isCustomerSide } from "@/lib/companies/roles";

/**
 * How many customers and products the page sends with the form. Each list is asked for one row more:
 * when that row comes back the list is incomplete, and the picker searches the server instead of
 * filtering what it was given. The pickers show a handful of matches at a time, so a book of
 * thousands only made the page slow to arrive.
 */
const CUSTOMERS_SENT = 300;
const ITEMS_SENT = 500;

/**
 * The customer the URL names (`?companyId=`, from a company's Products tab), as the picker shows it,
 * with what the form loads once a customer is chosen — or null.
 *
 * The prefill names a company in the URL, so it is checked rather than filtered: it is a lookup keyed
 * on an id a caller chose. Left unchecked it hands out that account's offices, its open proposals,
 * its end customers and which commission parties it is tied to, to anybody who can guess an id.
 *
 * Treated as absent rather than refused: this is a blank order form, not somebody's record, and an
 * unusable prefill is not a reason to deny the page. Only a company the customer picker itself would
 * offer is taken — in scope, a customer, not disqualified, not a reseller's end customer — so the
 * form opens either with that customer chosen or with nothing chosen.
 */
async function prefillFor(userId: string, companyId: unknown) {
  // A repeated query parameter arrives as an array; that is no id.
  if (typeof companyId !== "string" || !companyId) return null;
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      relationshipType: true,
      customerCategory: { select: CATEGORY_SELECT },
      ownerUserId: true,
      stage: true,
      managedByResellerId: true,
    },
  });
  if (!company || !(await isCustomerSide(company))) return null;
  if (company.stage === "DISQUALIFIED" || company.managedByResellerId !== null) return null;
  if (!(await canSeeCompany(userId, company))) return null;
  const context = await punchCustomerContext(company.id);
  if (!context) return null;
  const { id, name, relationshipType, customerCategory } = company;
  return { option: { id, name, relationshipType, customerCategory }, context };
}

export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; fromQuote?: string; line?: string }>;
}) {
  // None of these waits on another, so they are asked together rather than one after the next.
  const [ordersEnabled, itemsEnabled, user, creditInPlan, resellersInPlan, canSeeRebates, { companyId: companyParam, fromQuote, line }] = await Promise.all([
    isModuleEnabled("orders"),
    // In the plan and switched on is enough (owner, 2 Nov 2026 — "sales executive can't punch order"): a role without the
    // Items & Inventory section loses the catalogue's pages, not the products it puts on an order. The lookups behind
    // the form ask only the plan (requireModuleUser), so it was this page alone that refused.
    moduleAccess("items").then((access) => access === "available" || access === "no-permission"),
    requireUser(),
    isModuleEntitled("receivables"),
    isModuleEntitled("resellers"),
    viewerHas("rebates.view"),
    searchParams,
  ]);
  if (!ordersEnabled) {
    return <ModuleDisabledNotice moduleKey="orders" />;
  }
  if (!itemsEnabled) {
    return <ModuleDisabledNotice moduleKey="items" />;
  }

  // From a quote (src/lib/orders/from-quote.ts): its customer, and the line asked for or the next without an order.
  const quote = fromQuote ? await quoteForOrder(fromQuote, user.id) : null;
  const quoteLine = quote ? (quote.lines.find((l) => l.id === line && !l.ordered) ?? quote.next) : null;
  const companyId = quote?.companyId ?? companyParam;
  const quoteItem = quoteLine?.itemId ? await itemOptionById(quoteLine.itemId) : null;

  // The prefill's lookups run beside the lists rather than before them.
  const [customerRows, itemRows, users, commissionParties, vendors, prefill, customFields] = await Promise.all([
    listCompanyOptions({ side: "customer", withContacts: false, take: CUSTOMERS_SENT + 1 }),
    listItemOptions({ take: ITEMS_SENT + 1 }),
    listAssignableUsers(),
    // Every party, unflagged: which of them are tied to the customer comes with the customer's context.
    listCommissionPartyOptions(),
    // The distributors a salesperson may have a price from — the purchase side's vendors.
    listVendorOptions(),
    prefillFor(user.id, companyId),
    // The workspace's own order fields (src/lib/custom-fields) this person fills in, empty to start.
    formSetup("ORDER", user.id),
  ]);

  const customerSearch = customerRows.length > CUSTOMERS_SENT;
  const sentCustomers = customerRows.slice(0, CUSTOMERS_SENT);
  // The prefilled customer is always in the list, wherever it falls in the alphabet, so the picker can name it.
  const companies =
    prefill && !sentCustomers.some((c) => c.id === prefill.option.id) ? [prefill.option, ...sentCustomers] : sentCustomers;
  const itemSearch = itemRows.length > ITEMS_SENT;
  // The workspace's own word for an order (Settings → Wording).
  const wording = await getWording();

  return (
    <div>
      <div className="mb-5">
        <Link href="/orders" className="text-sm text-muted hover:text-text">
          {slot(wording, "← Orders", "order", "← {many}")}
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">{slot(wording, "Punch order", "order", "Punch {one:lower}")}</h1>
        <p className="mt-1 text-sm text-muted">
          {slot(wording, "Log an order you received — Accounts approves its payment terms, then it goes to Purchasing.", "order", "Log {a} you received — Accounts approves its payment terms, then it goes to Purchasing.")}
        </p>
      </div>
      <NewOrderForm
        companies={companies}
        items={quoteItem && !itemRows.slice(0, ITEMS_SENT).some((i) => i.id === quoteItem.id) ? [quoteItem, ...itemRows.slice(0, ITEMS_SENT)] : itemRows.slice(0, ITEMS_SENT)}
        fromQuote={quote && quoteLine ? { id: quote.id, docNumber: quote.docNumber, kind: quote.kind, locationId: quote.locationId, lines: quote.lines, line: quoteLine, itemKnown: !!quoteItem } : null}
        // Only what the form shows: the people's email and phone stay on the server.
        users={users.map((u) => ({ id: u.id, name: u.name }))}
        commissionParties={commissionParties.map((p) => ({ id: p.id, name: p.name }))}
        vendors={vendors.map((v) => ({ id: v.id, name: v.name }))}
        initialCompanyId={prefill?.option.id}
        initialContext={prefill?.context ?? null}
        customerSearch={customerSearch}
        itemSearch={itemSearch}
        creditInPlan={creditInPlan}
        resellersInPlan={resellersInPlan}
        canSeeRebates={canSeeRebates}
        customFields={customFields}
      />
    </div>
  );
}
