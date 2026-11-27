import { companyScope } from "@/lib/authz/company-scope";
import { exportCells } from "@/lib/custom-fields/sheets";
import { db } from "@/lib/db";
import type { Exporter } from "./types";

/**
 * Verifiable documents, as the import template has them (src/lib/portability/importers/verifiable.ts). Those the person may see: one
 * linked to a customer follows that customer. Not the public link, which opens without signing in, nor why one was withdrawn.
 */
export const verifiableExporter: Exporter = async ({ userId }) => {
  const scope = await companyScope(userId);
  const rows = await db.verifiableDocument.findMany({
    // Sees every company: nothing to narrow. An empty filter on a relation inside an OR would match nothing.
    where: Object.keys(scope).length === 0 ? {} : { OR: [{ companyId: null }, { company: scope }] },
    orderBy: { number: "asc" },
    select: { id: true, number: true, docType: true, title: true, holderName: true, issuedOn: true, expiresOn: true, scope: true, holderIsPerson: true, inSearch: true, withdrawnAt: true, company: { select: { name: true } } },
  });
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
  const columns = ["Number", "Type", "For", "Issued to", "Issued on", "Valid until", "Scope", "Customer", "Issued to a person", "In search", "Withdrawn"];
  const custom = await exportCells("VERIFIABLE", userId, rows.map((r) => r.id), columns);
  return rows.map((r) => ({
    Number: r.number,
    Type: r.docType,
    For: r.title,
    "Issued to": r.holderName,
    "Issued on": day(r.issuedOn),
    "Valid until": day(r.expiresOn),
    Scope: r.scope ?? "",
    Customer: r.company?.name ?? "",
    "Issued to a person": r.holderIsPerson ? "Yes" : "No",
    "In search": r.inSearch ? "Yes" : "No",
    // Read by no import: a file doesn't withdraw a certificate.
    Withdrawn: r.withdrawnAt ? "Yes" : "No",
    ...custom(r.id),
  }));
};
