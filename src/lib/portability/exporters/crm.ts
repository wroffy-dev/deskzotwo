import { db } from "@/lib/db";
import { boughtFromUsWhere } from "@/lib/customers/bought";
import { companyMasker, type CompanyField } from "@/lib/companies/masking";
import { formatContactId } from "@/lib/order-id";
import { contactDetailFieldKeys, seesResellerContactDetails } from "@/lib/authz/contact-access";
import { exportCells } from "@/lib/custom-fields/sheets";
import { paymentTermsLabels } from "@/lib/gst";
import { isResellerManaged, redactContactDetails } from "@/lib/reseller";
import { companyAccess, contactAccess, ticketAccess } from "@/lib/authz/access";
import type { Exporter, ExportScope } from "./types";
import { contactsForExport, customLeftBlank, maskedOnlyInExports } from "./field-export";

/**
 * The four kinds of party, their people, and the records that hang off them.
 *
 * Companies, vendors, resellers and commission parties are one table separated by
 * `relationshipType`, so each area filters on its own kind. Without that filter an export of
 * "vendors" returns the customer list too, and a target system merges your suppliers into it.
 */

function partyExporter(area: string): Exporter {
  const relationshipType =
    area === "vendors"
      ? "VENDOR"
      : area === "resellers"
        ? "RESELLER"
        : area === "commission-parties"
          ? "COMMISSION_PARTY"
          : "CLIENT";

  return async (scope: ExportScope) => {
    const rows = await db.company.findMany({
      where: {
        // The accounts this person may open — customers and vendors each at their own level.
        // A customer is a company that has actually bought something — an order, or an invoice here or in the
        // old system's archive (src/lib/customers/bought.ts) — as distinct from one marked CUSTOMER by somebody optimistic.
        AND: [await companyAccess(scope.userId, "view"), ...(area === "customers" ? [await boughtFromUsWhere()] : [])],
        relationshipType,
      },
      include: {
        owner: { select: { name: true } },
        industry: { select: { name: true } },
        managedByReseller: { select: { name: true } },
        _count: { select: { contacts: true, products: true } },
        // Its offices, main first (src/lib/portability/importers/companies.ts `mainLocation`).
        locations: {
          select: { address: true, city: true, state: true, pincode: true, country: true, gstNumber: true },
          orderBy: [{ isPrimary: "desc" }, { isBilling: "desc" }, { createdAt: "asc" }],
        },
      },
      orderBy: { name: "asc" },
    });

    // Field access, as a list shows a company (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2): an export is a
    // list. A masked cell goes out masked, and the import reads it back as "leave alone"
    // (src/lib/portability/importers/companies.ts). With each field's export answer on top (audit H.4.4) — and a cell the
    // export masks though the list doesn't goes out blank instead, as the import would read it as typed
    // (`maskedOnlyInExports`); a PAN or GSTIN of stars would refuse the row besides.
    const [shown, unsafe] = await Promise.all([companyMasker(scope.userId, "export"), maskedOnlyInExports(scope.userId, "companies")]);
    const cell = (field: CompanyField, value: string | null | undefined) => (unsafe(field) ? "" : (value ?? ""));
    const office = (stored: (typeof rows)[number]["locations"][number] | undefined) => {
      const l = stored ? shown.location(stored) : undefined;
      return {
        GSTIN: cell("gstin", l?.gstNumber),
        Address: cell("address", l?.address),
        City: cell("address", l?.city),
        State: cell("address", l?.state),
        PIN: cell("address", l?.pincode),
        Country: l?.country ?? "",
      };
    };
    const base = rows.map((c) => ({
      Key: c.normalizedName,
      Name: c.name,
      Type: c.relationshipType,
      "Managed by reseller": c.managedByReseller?.name ?? "",
      Stage: c.stage,
      Industry: c.industry?.name ?? "",
      Source: c.source ?? "",
      // Exported because the importer accepts it: a column somebody can edit but never receives is
      // a round trip that quietly drops their change.
      Website: cell("website", shown.present("website", c.website)),
      "Account manager": c.owner?.name ?? "",
      // The main office, PAN, and a vendor's terms and code — read back by the import (owner, 28 Oct 2026).
      ...office(c.locations[0]),
      PAN: cell("pan", shown.present("pan", c.panNumber)),
      "Payment terms": area === "vendors" ? paymentTermsLabels[c.paymentTerms] : "",
      "Vendor code": c.vendorCode ?? "",
      Contacts: c._count.contacts,
      Orders: c._count.products,
      "Added on": c.createdAt,
    }));
    // The workspace's own fields this person may see, after the built-in columns (src/lib/custom-fields/sheets.ts) —
    // a vendor's on the vendors export, as its import reads them. The Companies set's blank where its export answer
    // leaves them out, or masks them though the list doesn't (`customLeftBlank`; a vendor's set has no field access).
    const blankCustom = area === "vendors" ? new Set<string>() : await customLeftBlank(scope.userId, "companies");
    const custom = await exportCells(area === "vendors" ? "VENDOR" : "COMPANY", scope.userId, rows.map((c) => c.id), Object.keys(base[0] ?? {}), {
      hiddenFor: () => (blankCustom.size ? blankCustom : undefined),
    });
    // Each other office with a GSTIN on a row of its own under the company's name — the import adds it back as a branch.
    const blank = Object.fromEntries(Object.keys(base[0] ?? {}).map((k) => [k, ""]));
    return base.flatMap((b, i) => [
      { ...b, ...custom(rows[i]!.id) },
      ...rows[i]!.locations.slice(1).filter((l) => l.gstNumber).map((l) => ({ ...blank, Key: b.Key, Name: b.Name, Type: b.Type, ...office(l) })),
    ]);
  };
}

export const companiesExporter = partyExporter("companies");
export const customersExporter = partyExporter("customers");
export const vendorsExporter = partyExporter("vendors");
export const resellersExporter = partyExporter("resellers");
export const commissionPartiesExporter = partyExporter("commission-parties");

/**
 * A reseller's end customer's contact details leave only with somebody who may see them
 * (src/lib/authz/contact-access.ts) — redacted here as the screens redact them, so export never widens
 * what this person sees. Their cells go out blank, the email's check status with them, and blank is
 * "leave alone" when the file comes back.
 */
export const contactsExporter: Exporter = async (scope) => {
  const stored = await db.contact.findMany({
    where: await contactAccess(scope.userId, "view"),
    include: { company: { select: { name: true, managedByResellerId: true } } },
    orderBy: { contactSeq: "asc" },
  });
  const canViewRestricted = stored.some((c) => isResellerManaged(c.company)) ? await seesResellerContactDetails(scope.userId) : true;
  // Then field access, as the Contacts list shows them (owner, 3 Nov 2026): a masked value goes out masked, and the
  // importer reads it back as "leave alone" (src/lib/portability/importers/contacts.ts) — by its stars, so a value the
  // export alone masks (owner, 5 Nov 2026 — audit H.4.4: `contactsForExport`) goes out masked too; one left out, blank.
  const rows = await contactsForExport(scope.userId, stored.map((c) => redactContactDetails(c, { restricted: isResellerManaged(c.company), canViewRestricted })));
  const base = rows.map((c) => ({
    Key: formatContactId(c.contactSeq),
    Name: c.name,
    Company: c.company.name,
    Designation: c.designation,
    Email: c.email ?? "",
    Phone: c.phone ?? "",
    Primary: c.isPrimary,
    "Email status": c.detailsRedacted || c.masked.email ? "" : c.emailStatus,
  }));
  const hidden = new Set(rows.filter((c) => c.detailsRedacted).map((c) => c.id));
  const hiddenKeys = new Set(hidden.size > 0 ? await contactDetailFieldKeys() : []);
  // Custom fields the export leaves out, or masks though the list doesn't, blank on every row (`customLeftBlank`).
  const blankCustom = await customLeftBlank(scope.userId, "contacts");
  const both = new Set([...hiddenKeys, ...blankCustom]);
  const custom = await exportCells("CONTACT", scope.userId, rows.map((c) => c.id), Object.keys(base[0] ?? {}), {
    hiddenFor: (id) => (hidden.has(id) ? both : blankCustom.size ? blankCustom : undefined),
  });
  return base.map((b, i) => ({ ...b, ...custom(rows[i]!.id) }));
};

export const ticketsExporter: Exporter = async (scope) => {
  const rows = await db.ticket.findMany({
    where: await ticketAccess(scope.userId, "view"),
    include: { company: { select: { name: true } }, assignedTo: { select: { name: true } } },
    orderBy: { ticketSeq: "asc" },
  });
  return rows.map((t) => ({
    Ticket: `TKT-${String(t.ticketSeq).padStart(6, "0")}`,
    Company: t.company.name,
    Title: t.title,
    Status: t.status,
    Priority: t.priority,
    "Assigned to": t.assignedTo?.name ?? "",
    Raised: t.createdAt,
  }));
};

export const suppressionExporter: Exporter = async () => {
  const rows = await db.suppression.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map((s) => ({
    Scope: s.scope,
    Value: s.value,
    Reason: s.reason,
    Added: s.createdAt,
    Expires: s.expiresAt,
  }));
};
