import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { can } from "@/lib/authz/resolve";
import { valuesFor } from "@/lib/custom-fields/server";
import { db } from "@/lib/db";
import { numberKeyOf } from "@/lib/verifiable/rules";
import { createRow, diff, errorRow, updateRow, RowReader, type Importer, type ImportContext, type Resolved } from "./types";

/**
 * Verifiable documents from a spreadsheet (owner, 7 Nov 2026 — src/actions/verifiable.ts): a certification company's thousands of
 * existing certificates, in one go. Matched on the number, so handing the same file in again changes nothing and an edited one
 * corrects what differs; a corrected row keeps its link, so a printed QR code keeps working.
 *
 * Withdrawing isn't done by spreadsheet: a file can't withdraw a certificate, nor bring one back. That's one deliberate act on
 * the screen, with a reason. Whoever imports must hold `certificates.issue`, as adding one by hand asks, as well as the import right.
 */

type Row = {
  number: string;
  docType: string;
  title: string;
  holderName: string;
  scope?: string;
  issuedOn?: Date;
  expiresOn?: Date;
  companyId?: string;
  holderIsPerson?: boolean;
  inSearch?: boolean;
  existing: { id: string; docType: string; title: string; holderName: string; scope: string | null; issuedOn: Date; expiresOn: Date | null; companyId: string | null; holderIsPerson: boolean; inSearch: boolean } | null;
};

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
/** A day as the column holds it: the date cell's own day, at UTC midnight. */
const typedDay = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);

function yesNo(raw: string, column: string): { value?: boolean; error?: string } {
  const v = raw.trim().toLowerCase();
  if (!v) return {};
  if (["yes", "y", "true", "1"].includes(v)) return { value: true };
  if (["no", "n", "false", "0"].includes(v)) return { value: false };
  return { error: `${column} is yes or no, not "${raw}".` };
}

async function resolve(row: Record<string, string>): Promise<Resolved<Row>> {
  const r = new RowReader(row);
  const number = r.text("Number").slice(0, 80);
  const docType = r.text("Type").slice(0, 60);
  const title = r.text("For").slice(0, 200);
  const holderName = r.text("Issued to").slice(0, 200);
  const scope = r.text("Scope").slice(0, 1000);
  const issuedOn = r.date("Issued on");
  const expiresOn = r.date("Valid until");
  if (r.error) return { error: r.error };
  if (!number) return { error: "Number is required." };
  if (!numberKeyOf(number)) return { error: `"${number}" has no letters or digits, so it could never be searched for.` };
  const person = yesNo(r.text("Issued to a person"), "Issued to a person");
  if (person.error) return { error: person.error };
  const search = yesNo(r.text("In search"), "In search");
  if (search.error) return { error: search.error };
  const existing = await db.verifiableDocument.findUnique({
    where: { number },
    select: { id: true, docType: true, title: true, holderName: true, scope: true, issuedOn: true, expiresOn: true, companyId: true, holderIsPerson: true, inSearch: true },
  });
  if (!existing) {
    if (!docType) return { error: "Type is required on a new document, such as Certificate." };
    if (!title) return { error: "For is required on a new document, such as ISO 9001:2015." };
    if (!holderName) return { error: "Issued to is required on a new document." };
    if (!issuedOn) return { error: "Issued on is required on a new document." };
  }
  const start = issuedOn ?? existing?.issuedOn;
  if (expiresOn && start && typedDay(expiresOn) < typedDay(start)) return { error: `It can't expire (${day(expiresOn)}) before it was issued (${day(start)}).` };
  let companyId: string | undefined;
  const customer = r.text("Customer");
  if (customer) {
    const found = await db.company.findMany({ where: { name: { equals: customer, mode: "insensitive" } }, select: { id: true }, take: 2 });
    if (found.length !== 1) return { error: found.length ? `More than one customer is called "${customer}". Leave it empty and link it on the screen.` : `No customer is called "${customer}". Leave Customer empty, or add them first.` };
    companyId = found[0]!.id;
  }
  return {
    value: { number, docType, title, holderName, scope: scope || undefined, issuedOn: issuedOn && typedDay(issuedOn), expiresOn: expiresOn && typedDay(expiresOn), companyId, holderIsPerson: person.value, inSearch: search.value, existing },
  };
}

async function refusal(ctx: ImportContext): Promise<string | null> {
  return (await can(ctx.actorUserId, "certificates.issue")) ? null : "Importing documents needs the right to issue them — ask an admin.";
}

export const verifiableImporter: Importer = {
  customEntity: "VERIFIABLE",
  templateColumns: ["Number", "Type", "For", "Issued to", "Issued on", "Valid until", "Scope", "Customer", "Issued to a person", "In search"],
  // Written by the export, read by nothing here: a file can't withdraw a certificate.
  extraColumns: ["Withdrawn"],
  headerAliases: {
    Number: ["Certificate number", "Certificate no", "Cert no", "Reference", "Ref no"],
    Type: ["Document type", "Kind"],
    For: ["Standard", "Title", "Course"],
    "Issued to": ["Holder", "Company", "Client", "Name"],
    "Issued on": ["Issue date", "Date of issue", "Issued"],
    "Valid until": ["Expiry", "Expiry date", "Valid till", "Expires"],
  },

  async plan(row, line, ctx) {
    const label = String(row.Number ?? "").trim();
    const refused = await refusal(ctx);
    if (refused) return errorRow(line, label, refused);
    const resolved = await resolve(row);
    if ("error" in resolved) return errorRow(line, label, resolved.error);
    const d = resolved.value;
    const custom = ctx.custom ? await ctx.custom.merge(d.existing ? await valuesFor("VERIFIABLE", d.existing.id) : {}, row) : null;
    if (custom && !custom.ok) return errorRow(line, label, custom.error);
    const key = d.number;
    const name = `${d.number}${d.holderName ? `: ${d.holderName}` : ""}`;
    if (!d.existing) {
      // The same number twice in one file would fail on the second when it's written: said now.
      if (ctx.pendingKeys.has(key)) return errorRow(line, label, `${d.number} is in this file twice.`);
      return createRow(line, key, name, { Type: d.docType, For: d.title, "Issued to": d.holderName, "Issued on": d.issuedOn, "Valid until": d.expiresOn, Scope: d.scope, ...(custom?.ok ? Object.fromEntries(custom.changes.map((c) => [c.field, c.to])) : {}) });
    }
    const e = d.existing;
    return updateRow(line, key, name, [
      d.docType ? diff("Type", e.docType, d.docType) : null,
      d.title ? diff("For", e.title, d.title) : null,
      d.holderName ? diff("Issued to", e.holderName, d.holderName) : null,
      d.scope ? diff("Scope", e.scope ?? "", d.scope) : null,
      d.issuedOn ? diff("Issued on", day(e.issuedOn), day(d.issuedOn)) : null,
      d.expiresOn ? diff("Valid until", day(e.expiresOn), day(d.expiresOn)) : null,
      d.companyId ? diff("Customer", e.companyId ?? "", d.companyId) : null,
      d.holderIsPerson !== undefined ? diff("Issued to a person", String(e.holderIsPerson), String(d.holderIsPerson)) : null,
      d.inSearch !== undefined ? diff("In search", String(e.inSearch), String(d.inSearch)) : null,
      ...(custom?.ok ? custom.changes : []),
    ]);
  },

  async apply(row, ctx) {
    const refused = await refusal(ctx);
    if (refused) throw new Error(refused);
    const resolved = await resolve(row);
    if ("error" in resolved) throw new Error(resolved.error);
    const d = resolved.value;
    const custom = ctx.custom ? await ctx.custom.merge(d.existing ? await valuesFor("VERIFIABLE", d.existing.id) : {}, row) : null;
    if (custom && !custom.ok) throw new Error(custom.error);
    const fields = custom?.ok && custom.changes.length > 0 ? { customFields: custom.values as Prisma.InputJsonValue } : {};
    if (d.existing) {
      await db.verifiableDocument.update({
        where: { id: d.existing.id },
        data: {
          ...(d.docType ? { docType: d.docType } : {}),
          ...(d.title ? { title: d.title } : {}),
          ...(d.holderName ? { holderName: d.holderName } : {}),
          ...(d.scope ? { scope: d.scope } : {}),
          ...(d.issuedOn ? { issuedOn: d.issuedOn } : {}),
          ...(d.expiresOn ? { expiresOn: d.expiresOn } : {}),
          ...(d.companyId ? { companyId: d.companyId } : {}),
          ...(d.holderIsPerson !== undefined ? { holderIsPerson: d.holderIsPerson } : {}),
          ...(d.inSearch !== undefined ? { inSearch: d.inSearch } : {}),
          ...fields,
        },
      });
      return;
    }
    await db.verifiableDocument.create({
      data: {
        token: randomBytes(18).toString("base64url"),
        number: d.number,
        numberKey: numberKeyOf(d.number),
        docType: d.docType,
        title: d.title,
        holderName: d.holderName,
        scope: d.scope ?? null,
        // resolve() refuses a new one without it.
        issuedOn: d.issuedOn!,
        expiresOn: d.expiresOn ?? null,
        companyId: d.companyId ?? null,
        holderIsPerson: d.holderIsPerson ?? false,
        inSearch: d.inSearch ?? true,
        createdById: ctx.actorUserId,
        ...fields,
      },
    });
  },
};
