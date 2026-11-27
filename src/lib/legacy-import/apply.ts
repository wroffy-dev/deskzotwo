import type { CompanySource, GstTreatment, LeadStatus, PaymentTerms, Prisma, TicketStatus, VisitStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { countForBand, type EmployeeBandKey } from "@/lib/company-size";
import { isValidGstin } from "@/lib/gst-engine";
import { noPasswordYet } from "@/lib/no-password";
import { PEOPLE_ONLY } from "@/lib/people";
import { kindOf, MAIN_PIPELINE_ID, meaningOf, MEANINGS } from "@/lib/pipeline/rules";
import { companyTypeFromText, keyForName, type CompanyTypeOption } from "@/lib/companies/company-types";
import { sourceOf, stageMeaning } from "@/lib/portability/importers/leads";
import { claimLeadCapacity, leadCapacityError, markLeadWrite } from "@/lib/leads/limits";
import { legalNameKey } from "@/lib/company-name";
import { formerNameIndex } from "@/lib/companies/former-names";
import { companyKey, deletedInOldCrm, fields, findOrMake, userOf, userOrNull, type Ctx, type LoggedRecord, type Tx } from "./context";
import {
  BUSINESS_TYPE,
  CALL_OUTCOME,
  clean,
  countryName,
  oldPhone,
  designationKind,
  EMPLOYEE_BAND,
  isIndia,
  itemType,
  jsonList,
  LEAD_STATUS,
  money,
  oldDay,
  oldInstant,
  stateName,
  TICKET_PRIORITY,
  TICKET_STATUS,
  TICKET_TYPE,
  titleCase,
  VISIT_PURPOSE,
  type KindKey,
} from "./formats";
import type { SourceRow } from "./store";

/**
 * What each old row becomes (src/lib/legacy-import; the choices: memory "old-crm-migration-tool-decisions"). One
 * row, one transaction: the record, anything it needs that wasn't there (a brand, a prospect company…), and the
 * old-id log entry go in together or not at all.
 *
 *   · A row the old CRM deleted is left behind. A row an earlier import brought is left as it is — or, with
 *     "Update existing records", given the file's values, what it held kept so Undo can put it back.
 *   · A row that meets a record Deskzo already had (a company of the same name, a product of the same SKU, a contact
 *     with the same email) uses that record or is left out, as the preview's choice says; that record is never
 *     changed.
 *   · Who did what is the old user the users step made or matched; anyone unknown is whoever runs the import.
 */

export type Outcome =
  | { kind: "created" | "updated" | "linked" | "unchanged"; recordId: string; warning?: string }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

const created = (recordId: string, warning?: string): Outcome => ({ kind: "created", recordId, warning });
const linked = (recordId: string, warning?: string): Outcome => ({ kind: "linked", recordId, warning });
const unchanged = (recordId: string): Outcome => ({ kind: "unchanged", recordId });
const skipped = (reason: string): Outcome => ({ kind: "skipped", reason });
const error = (message: string): Outcome => ({ kind: "error", message });

class RowError extends Error {}
const fail = (message: string): never => {
  throw new RowError(message);
};

/** Thrown when a row stays behind with something it can't do without; the row is skipped, not failed. */
class RowSkip extends Error {}
const stayBehind = (reason: string): never => {
  throw new RowSkip(reason);
};

/**
 * What a row can't come in without, as it came across. The old CRM deleted it: the row stays behind with it (owner,
 * 27 Oct 2026), as the preview says. Missing otherwise: the row's error.
 */
/*
 * Owner, 30 Oct 2026: "i want all data to come in — missing things can be added in crm later". A row the old CRM left a
 * gap in comes in with a stand-in, marked "(to fix)" so the team can find it and put it right: a company with no name
 * is named for what the row has, an order whose customer has no address gets a head office, and a product that
 * didn't come across becomes one of that name (or its old id). Each stand-in is logged, so an undo takes it away.
 */
const TO_FIX = "(to fix)";

/** A company's name, or one made from what the row has, marked to fix. */
function nameOrStandIn(row: Record<string, string>, what: string, oldId: string): string {
  const typed = clean(row.company);
  if (typed) return typed;
  const person = clean(row.name) || [clean(row.first_name), clean(row.last_name)].filter(Boolean).join(" ");
  const base = person || clean(row.email) || clean(row.official_email) || `Old CRM ${what} ${oldId}`;
  return `${base} ${TO_FIX}`;
}

/** The product a row names, as it came across — else one of that name, marked to fix, made once and kept for every row. */
async function productOrStandIn(tx: Tx, ctx: Ctx, productId: string | null | undefined): Promise<{ id: string; warning?: string }> {
  const id = await ctx.records.id("products", productId);
  if (id) return { id };
  const key = clean(productId) || "none";
  const sku = `OLDCRM-${key}`.toUpperCase();
  const name = ctx.lookups.products[key]?.name;
  const warning = `Its product (${key}) didn't come across; it's on "${name ?? `Old CRM product ${key}`} ${TO_FIX}" for now.`;
  const same = await tx.item.findUnique({ where: { sku }, select: { id: true } });
  if (same) return { id: same.id, warning };
  const made = await tx.item.create({ data: { name: `${name ?? `Old CRM product ${key}`} ${TO_FIX}`, sku, type: "SERVICE", sellingPrice: 0, createdById: ctx.actorId }, select: { id: true } });
  await log(tx, ctx, "stand-in-product", key, made.id, "CREATED");
  return { id: made.id, warning };
}

async function needed(ctx: Ctx, kind: KindKey, oldId: string | null | undefined, what: string): Promise<string> {
  const id = await ctx.records.id(kind, oldId);
  if (id) return id;
  if (deletedInOldCrm(ctx.lookups, kind, oldId)) return stayBehind(`${what} was deleted in the old CRM, so it stays behind with it.`);
  return fail(`${what} didn't come across.`);
}

const deleted = (row: Record<string, string>) => !!clean(row.deletedAt);
const mayUpdate = (ctx: Ctx, logged: LoggedRecord) => ctx.strategy === "UPDATE" && (logged.action === "CREATED" || logged.action === "UPDATED");

/** Logs a row's record, in its transaction, and remembers it for the rest of the batch. */
async function log(tx: Tx, ctx: Ctx, kind: string, oldId: string, recordId: string, action: "CREATED" | "LINKED") {
  await tx.legacyImportRecord.upsert({
    where: { kind_oldId: { kind, oldId } },
    create: { importId: ctx.importId, kind, oldId, recordId, action },
    update: { importId: ctx.importId, recordId, action, before: undefined },
  });
  ctx.records.set(kind, oldId, { recordId, action, importId: ctx.importId, before: null });
}

/**
 * Gives a record an earlier run made the file's values. The first time this run touches it, what it held is kept on
 * its log entry — with the run that made it — so undoing this run puts it back.
 */
async function updateLogged(tx: Tx, ctx: Ctx, kind: string, oldId: string, logged: LoggedRecord, before: () => Promise<Record<string, unknown> | null>, write: () => Promise<void>) {
  if (logged.importId !== ctx.importId) {
    const values = await before();
    await tx.legacyImportRecord.update({
      where: { kind_oldId: { kind, oldId } },
      data: { importId: ctx.importId, action: "UPDATED", before: { values, fromImport: logged.importId, fromAction: logged.action } as unknown as Prisma.InputJsonValue },
    });
    ctx.records.set(kind, oldId, { ...logged, importId: ctx.importId, action: "UPDATED" });
  }
  await write();
}

/** Runs one row in its own transaction; a refusal is the row's error, anything else is too — said plainly. */
export async function applyRow(kind: KindKey | "customer_product_links", src: SourceRow, ctx: Ctx): Promise<Outcome> {
  const handler = HANDLERS[kind];
  if (!handler) return skipped("Not brought across.");
  ctx.records.begin();
  try {
    const outcome = await db.$transaction((tx) => handler(src.row, tx, ctx), { timeout: 60_000 });
    ctx.records.commit();
    return outcome;
  } catch (err) {
    // What the batch remembered of this row's writes didn't happen.
    ctx.records.rollback();
    if (err instanceof RowSkip) return skipped(err.message);
    if (err instanceof RowError) return error(err.message);
    // A lead whose owner is at their lead limit, or past the plan's cap — or the database's backstop saying so in
    // "enforce" mode (owner, 12 Nov 2026 — Phase 4 lead limits): the row's error, in words.
    const full = leadCapacityError(err);
    if (full) return error(full.message);
    const message = err instanceof Error ? err.message.split("\n").filter(Boolean).slice(-1)[0] ?? err.message : String(err);
    return error(`Couldn't be saved: ${message.slice(0, 300)}`);
  }
}

type Handler = (row: Record<string, string>, tx: Tx, ctx: Ctx) => Promise<Outcome>;

// ─── Users ───────────────────────────────────────────────────────────────────────────────────────

async function lowestRole(tx: Tx): Promise<string> {
  const profile = await tx.role.findUnique({ where: { key: "PROFILE" }, select: { key: true } });
  if (profile) return profile.key;
  const any = await tx.role.findFirst({ where: { key: { not: "ADMIN" } }, orderBy: { key: "asc" }, select: { key: true } });
  return any?.key ?? fail("There's no role to give a switched-off account.");
}

const users: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  const logged = await ctx.records.get("users", oldId);
  if (logged) return unchanged(logged.recordId);
  const email = clean(row.email).toLowerCase();
  const chosen = ctx.decisions.users?.[oldId];
  if (chosen && chosen !== "create") {
    const user = await tx.user.findUnique({ where: { id: chosen }, select: { id: true } });
    if (!user) fail("The Deskzo user chosen for this person isn't there any more.");
    await log(tx, ctx, "users", oldId, chosen, "LINKED");
    return linked(chosen);
  }
  if (!email) fail("No email address.");
  const same = await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } });
  if (same) {
    await log(tx, ctx, "users", oldId, same.id, "LINKED");
    return linked(same.id);
  }
  const department = ctx.lookups.users[oldId]?.department;
  const departmentId = department ? await findOrMake(tx, ctx, "department", department, () => tx.department.findFirst({ where: { name: { equals: department, mode: "insensitive" } }, select: { id: true } }), () => tx.department.create({ data: { name: department }, select: { id: true } })) : null;
  const made = await tx.user.create({
    data: {
      name: clean(row.name) || email,
      email,
      phone: oldPhone(row.phone, row.country_code),
      passwordHash: noPasswordYet(),
      role: await lowestRole(tx),
      active: false,
      mustChangePassword: true,
      departmentId,
      createdAt: oldInstant(row.createdAt!) ?? undefined,
    },
    select: { id: true },
  });
  await log(tx, ctx, "users", oldId, made.id, "CREATED");
  return created(made.id);
};

// ─── Products ────────────────────────────────────────────────────────────────────────────────────

const products: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  const name = clean(row.name) || fail("No name.");
  const sku = clean(row.sku) || fail("No SKU.");
  const category = ctx.lookups.categories[row.category_id ?? ""];
  const brand = ctx.lookups.brands[row.brand_id ?? ""];
  const type = itemType(row.type!, category?.type ?? null);
  const price = money(row.selling_price!) ?? money(row.display_price!) ?? 0;
  const hsn = /^\d{4,8}$/.test(clean(row.identification_code)) ? clean(row.identification_code) : null;
  const description = clean(row.description);
  const values = {
    name,
    type,
    category: category ? category.name : null,
    hsnCode: hsn,
    sellingPrice: price,
    billingCycle: type === "SUBSCRIPTION" ? (/month/i.test(description) ? ("MONTHLY" as const) : ("ANNUAL" as const)) : null,
    description: description && !/^(annual|monthly|yearly)$/i.test(description) ? description.slice(0, 4000) : null,
    active: !deleted(row),
  };
  // An item names its category; the category list holds it too, so it can be picked.
  const relations = async () => {
    if (category) await findOrMake(tx, ctx, "item-category", category.name, () => tx.itemCategory.findFirst({ where: { name: { equals: category.name, mode: "insensitive" } }, select: { id: true } }), () => tx.itemCategory.create({ data: { name: category.name }, select: { id: true } }));
    return { brandId: brand ? await findOrMake(tx, ctx, "brand", brand, () => tx.brand.findFirst({ where: { name: { equals: brand, mode: "insensitive" } }, select: { id: true } }), () => tx.brand.create({ data: { name: brand }, select: { id: true } })) : null };
  };

  const logged = await ctx.records.get("products", oldId);
  if (logged) {
    if (!mayUpdate(ctx, logged)) return unchanged(logged.recordId);
    const { brandId } = await relations();
    await updateLogged(tx, ctx, "products", oldId, logged, () => tx.item.findUnique({ where: { id: logged.recordId }, select: { name: true, type: true, category: true, hsnCode: true, sellingPrice: true, billingCycle: true, description: true, active: true, brandId: true } }), async () => {
      await tx.item.update({ where: { id: logged.recordId }, data: { ...values, brandId } });
    });
    return { kind: "updated", recordId: logged.recordId };
  }
  // The Zoho item the master list took it as: that item, filled in where Zoho left it blank.
  const twin = ctx.withZoho ? await zohoTwin(tx, ctx, "products", ["zoho_items"], oldId) : null;
  if (twin) {
    if (twin.ours) {
      const { brandId } = await relations();
      const current = await tx.item.findUniqueOrThrow({ where: { id: twin.recordId }, select: { sku: true, category: true, hsnCode: true, billingCycle: true, description: true, brandId: true } });
      // An item Zoho kept without a SKU was given a stand-in one; WroffyCRM's takes its place when it's free.
      const skuFree = current.sku.startsWith(ZOHO_SKU) && !(await tx.item.findFirst({ where: { sku: { equals: sku, mode: "insensitive" }, id: { not: twin.recordId } }, select: { id: true } }));
      await tx.item.update({
        where: { id: twin.recordId },
        // Zoho has no subscriptions: WroffyCRM's word for one stands.
        data: { ...blanksOnly(current, { category: values.category, hsnCode: values.hsnCode, billingCycle: values.billingCycle, description: values.description, brandId }), ...(type === "SUBSCRIPTION" ? { type } : {}), ...(skuFree ? { sku } : {}) },
      });
    }
    await log(tx, ctx, "products", oldId, twin.recordId, "LINKED");
    return linked(twin.recordId);
  }
  const same = await tx.item.findFirst({ where: { sku: { equals: sku, mode: "insensitive" } }, select: { id: true } });
  if (same) {
    const decision = ctx.decisions.matches?.products;
    if (decision === "skip") return skipped(`Deskzo already has SKU ${sku}; left out as chosen.`);
    if (decision !== "link") fail(`Deskzo already has SKU ${sku} — choose on the preview whether to use it.`);
    await log(tx, ctx, "products", oldId, same.id, "LINKED");
    return linked(same.id);
  }
  const { brandId } = await relations();
  const made = await tx.item.create({ data: { ...values, sku, brandId, createdById: ctx.actorId, createdAt: oldInstant(row.createdAt!) ?? undefined }, select: { id: true } });
  await log(tx, ctx, "products", oldId, made.id, "CREATED");
  return created(made.id);
};

// ─── Companies ───────────────────────────────────────────────────────────────────────────────────

const COMPANY_SOURCES: Record<string, CompanySource> = { referral: "REFERRAL", linkedin: "LINKEDIN", "social-media": "LINKEDIN", website: "INBOUND", mail: "INBOUND", indiamart: "INBOUND" };

function employees(band: string): number | null {
  const key = EMPLOYEE_BAND[clean(band)] as EmployeeBandKey | undefined;
  return key ? countForBand(key, null) : null;
}

function gstOf(gst: string): string | null {
  const g = clean(gst).toUpperCase();
  return g && isValidGstin(g) ? g : null;
}

function treatment(gst: string | null, country: string): GstTreatment {
  if (!isIndia(country)) return "OVERSEAS";
  return gst ? "REGISTERED_REGULAR" : "UNREGISTERED";
}

/** The workspace's company types, read once a batch (src/lib/companies/company-types.ts). */
const typeOptions = new WeakMap<Ctx, Promise<CompanyTypeOption[]>>();

/**
 * A row's company type, as a key of the workspace's list (owner, 27 Oct 2026). The old CRM's slugs and the free
 * text its lead form let through ("Pvt Ltd") find the type they mean; a name company_types.csv lists that the
 * workspace hasn't got is made, logged for the undo; any other text ("Construction") leaves the type blank.
 */
async function companyTypeKey(tx: Tx, ctx: Ctx, text: string | null | undefined): Promise<string | null> {
  if (!typeOptions.has(ctx)) typeOptions.set(ctx, tx.companyTypeOption.findMany({ select: { key: true, name: true } }));
  const options = await typeOptions.get(ctx)!;
  const found = companyTypeFromText(text, options);
  if (found) return found;
  const listed = (ctx.lookups.companyTypes ?? []).find((n) => n.toLowerCase() === clean(text).toLowerCase());
  if (!listed) return null;
  const name = listed.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  const id = await findOrMake(tx, ctx, "company-type", name, () => tx.companyTypeOption.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } }), async () => {
    const last = await tx.companyTypeOption.aggregate({ _max: { sortOrder: true } });
    let key = keyForName(name) || "TYPE";
    for (let n = 2; await tx.companyTypeOption.findUnique({ where: { key }, select: { id: true } }); n++) key = `${keyForName(name) || "TYPE"}_${n}`;
    return tx.companyTypeOption.create({ data: { key, name, sortOrder: (last._max.sortOrder ?? 0) + 1 }, select: { id: true } });
  });
  const made = await tx.companyTypeOption.findUniqueOrThrow({ where: { id }, select: { key: true, name: true } });
  if (!options.some((o) => o.key === made.key)) options.push(made);
  return made.key;
}

async function industryId(tx: Tx, ctx: Ctx, text: string): Promise<string | null> {
  const name = titleCase(text);
  if (!name || /^other$/i.test(name)) return null;
  return findOrMake(tx, ctx, "industry", name, () => tx.industry.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } }), () => tx.industry.create({ data: { name }, select: { id: true } }));
}

/** Tags joined without repeats, the record's own first. */
const tagsOf = (...lists: (string[] | undefined)[]) => [...new Set(lists.flat().filter((t): t is string => !!t && !!t.trim()))];

/** A company the import made or found by name; null when Deskzo has none by it. Whether the import made it, too. */
/**
 * The company an old-CRM name means (owner, 23 Nov 2026 — "if i import leads again … merged with another customer because
 * of duplicates?"): the name as it is, else the one company with the same legal name ("Pvt Ltd" is "Private Limited"),
 * else the one that once went by it — a duplicate merged into it, or a rename. Never a guess between two.
 */
export async function companyByName(tx: Tx, name: string) {
  const select = { id: true, tags: true, stage: true } as const;
  let company = await tx.company.findUnique({ where: { normalizedName: companyKey(name) }, select });
  if (!company) {
    const key = legalNameKey(name);
    const first = key.split(" ")[0] ?? "";
    if (first.length >= 2) {
      const like = await tx.company.findMany({ where: { name: { startsWith: first, mode: "insensitive" } }, take: 200, select: { ...select, name: true } });
      const same = like.filter((c) => legalNameKey(c.name) === key);
      if (same.length === 1) company = same[0]!;
    }
  }
  if (!company) {
    const was = (await formerNameIndex())(name);
    if (was) company = await tx.company.findUnique({ where: { id: was.id }, select });
  }
  if (!company) return null;
  const made = await tx.legacyImportRecord.findFirst({ where: { recordId: company.id, action: { in: ["CREATED", "UPDATED", "KEPT"] }, kind: { in: ["customers", "prospect-company", "vendor", "vendors", "zoho_contacts", "zoho_vendors"] } }, select: { id: true } });
  return { ...company, madeByImport: !!made };
}

async function headOffice(tx: Tx, companyId: string, row: Record<string, string>) {
  const gst = gstOf(row.gst_no ?? "");
  return tx.companyLocation.create({
    data: {
      companyId,
      label: "Head office",
      address: clean(row.address) || null,
      city: clean(row.city) || null,
      state: stateName(row.state ?? "", row.country ?? ""),
      country: countryName(row.country ?? ""),
      pincode: clean(row.zipcode) || null,
      gstNumber: gst,
      gstTreatment: treatment(gst, row.country ?? ""),
      isPrimary: true,
    },
    select: { id: true },
  });
}

const customers: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  if (deleted(row)) return skipped("Deleted in the old CRM.");
  const name = nameOrStandIn(row, "customer", oldId);
  const gst = gstOf(row.gst_no ?? "");
  const category = ctx.lookups.customerCategories[row.cust_cat_id ?? ""];
  const values = async () => ({
    industryId: await industryId(tx, ctx, clean(row.industry_type) === "other" && clean(row.specify_other) ? row.specify_other! : row.industry_type!),
    customerCategoryId: category ? await findOrMake(tx, ctx, "customer-category", category, () => tx.customerCategory.findFirst({ where: { name: { equals: category, mode: "insensitive" } }, select: { id: true } }), () => tx.customerCategory.create({ data: { name: category }, select: { id: true } })) : null,
    companyType: await companyTypeKey(tx, ctx, row.company_type),
    website: clean(row.website) || null,
    linkedinUrl: clean(row.linkedin_url) || null,
    employeeCount: employees(row.employee_count!),
    panNumber: gst ? gst.slice(2, 12) : null,
    source: COMPANY_SOURCES[clean(row.source).toLowerCase()] ?? ("OTHER" as const),
  });
  const custom = fields({
    oldcrm_id: oldId,
    cin: clean(row.cin_number).toUpperCase() || null,
    incorporated_on: oldDay(row.anniversary!)?.toISOString().slice(0, 10) ?? null,
    currency: clean(row.currency).toUpperCase() || null,
    official_email: clean(row.official_email) || null,
    official_phone: oldPhone(row.phone, row.country_code),
  });
  const tags = tagsOf(jsonList(row.tags!), ctx.lookups.entityTags[`customer:${oldId}`]);

  const logged = await ctx.records.get("customers", oldId);
  if (logged) {
    if (!mayUpdate(ctx, logged)) return unchanged(logged.recordId);
    const v = await values();
    await updateLogged(tx, ctx, "customers", oldId, logged, () => tx.company.findUnique({ where: { id: logged.recordId }, select: { industryId: true, customerCategoryId: true, companyType: true, website: true, linkedinUrl: true, employeeCount: true, panNumber: true, source: true, tags: true, customFields: true } }), async () => {
      const current = await tx.company.findUniqueOrThrow({ where: { id: logged.recordId }, select: { tags: true, customFields: true } });
      await tx.company.update({ where: { id: logged.recordId }, data: { ...v, tags: tagsOf(current.tags, tags), customFields: { ...((current.customFields ?? {}) as object), ...custom } } });
    });
    return { kind: "updated", recordId: logged.recordId };
  }

  // The Zoho customer the master list took it as: that company, filled in where Zoho left it blank.
  const twin = ctx.withZoho ? await zohoTwin(tx, ctx, "customers", ["zoho_contacts"], oldId) : null;
  if (twin) {
    if (twin.ours) {
      const v = await values();
      const current = await tx.company.findUniqueOrThrow({ where: { id: twin.recordId }, select: { industryId: true, customerCategoryId: true, companyType: true, website: true, linkedinUrl: true, employeeCount: true, panNumber: true, source: true, tags: true, customFields: true } });
      const { source, ...rest } = v;
      await tx.company.update({
        where: { id: twin.recordId },
        data: { ...blanksOnly(current, rest), ...(current.source === "OTHER" ? { source } : {}), tags: tagsOf(current.tags, tags), customFields: { ...custom, ...((current.customFields ?? {}) as object) } },
      });
    }
    await log(tx, ctx, "customers", oldId, twin.recordId, "LINKED");
    return linked(twin.recordId);
  }

  const existing = await companyByName(tx, name);
  if (existing) {
    if (existing.madeByImport) {
      // Two old customers of one name, or a prospect this run already made of it: one company.
      if (existing.stage !== "CUSTOMER" && !ctx.withZoho) await tx.company.update({ where: { id: existing.id }, data: { stage: "CUSTOMER", tags: tagsOf(existing.tags, tags) } });
      await log(tx, ctx, "customers", oldId, existing.id, "LINKED");
      return linked(existing.id, `Another customer of the same name came across already; this one's records go to that company.`);
    }
    const decision = ctx.decisions.matches?.customers;
    if (decision === "skip") return skipped(`Deskzo already has ${name}; left out as chosen.`);
    if (decision !== "link") fail(`Deskzo already has a company called ${name} — choose on the preview whether to use it.`);
    await log(tx, ctx, "customers", oldId, existing.id, "LINKED");
    return linked(existing.id);
  }

  const owner = await userOf(ctx, row.created_by);
  const made = await tx.company.create({
    data: {
      name,
      normalizedName: companyKey(name),
      relationshipType: "CLIENT",
      // Beside Zoho's books, a customer Zoho never billed is a prospect.
      stage: ctx.withZoho ? "PROSPECT" : "CUSTOMER",
      ...(await values()),
      tags,
      createdById: owner,
      createdAt: oldInstant(row.createdAt!) ?? undefined,
      customFields: custom,
    },
    select: { id: true },
  });
  const office = await headOffice(tx, made.id, row);
  await log(tx, ctx, "customers", oldId, made.id, "CREATED");
  await log(tx, ctx, "head-office", oldId, office.id, "CREATED");
  return created(made.id);
};

/** A billing or shipping address: a location of its customer's company, or the same one if it's there already. */
function addressHandler(kind: "billing_addresses" | "shipping_addresses"): Handler {
  const billing = kind === "billing_addresses";
  return async (row, tx, ctx) => {
    const oldId = row.id!;
    if (deleted(row)) return skipped("Deleted in the old CRM.");
    const companyId = await needed(ctx, "customers", row.customer_id, `Its customer (${row.customer_id})`);
    const gst = gstOf(row.gst_no ?? "");
    const address = clean(row.address) || null;
    const pincode = clean(row.zipcode) || null;
    const flags = billing ? { isBilling: true } : { isShipping: true };
    const logged = await ctx.records.get(kind, oldId);
    if (logged) return unchanged(logged.recordId);
    const locations = await tx.companyLocation.findMany({ where: { companyId }, select: { id: true, address: true, pincode: true, gstNumber: true, isBilling: true, isShipping: true } });
    const words = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const same = locations.find((l) => (gst && l.gstNumber === gst && l.pincode === pincode) || (address && words(l.address) === words(address)));
    if (same) {
      // The head office this import made from the same address: it is the billing (or shipping) one too.
      const ours = await tx.legacyImportRecord.findFirst({ where: { recordId: same.id, kind: "head-office" }, select: { id: true } });
      if (ours) await tx.companyLocation.update({ where: { id: same.id }, data: flags });
      await log(tx, ctx, kind, oldId, same.id, "LINKED");
      return linked(same.id);
    }
    const made = await tx.companyLocation.create({
      data: {
        companyId,
        label: `${billing ? "Billing" : "Shipping"}${clean(row.city) ? ` — ${clean(row.city)}` : ""}`,
        address,
        city: clean(row.city) || null,
        state: stateName(row.state ?? "", row.country ?? ""),
        country: countryName(row.country ?? ""),
        pincode,
        gstNumber: gst,
        gstTreatment: treatment(gst, row.country ?? ""),
        ...flags,
      },
      select: { id: true },
    });
    await log(tx, ctx, kind, oldId, made.id, "CREATED");
    return created(made.id);
  };
}

// ─── Contacts ────────────────────────────────────────────────────────────────────────────────────

async function designationId(tx: Tx, ctx: Ctx, title: string) {
  const name = clean(title);
  if (!name) return null;
  return findOrMake(tx, ctx, "designation", name, () => tx.designation.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } }), () => tx.designation.create({ data: { name, kind: designationKind(name) }, select: { id: true } }));
}

const contactsFromEmployees: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  if (deleted(row)) return skipped("Deleted in the old CRM.");
  const name = [clean(row.first_name), clean(row.last_name)].filter((n) => n && n !== "N/A").join(" ");
  const email = clean(row.email) || null;
  const phone = oldPhone(row.phone, row.country_code);
  if (!name && !email && !phone) return skipped("A placeholder with no name, email or phone.");
  const companyId = await needed(ctx, "customers", row.customer_id, `Its customer (${row.customer_id})`);
  const title = ctx.lookups.designations[row.designation_id ?? ""] ?? "";
  const values = async () => ({
    name: name || email || phone || "Contact",
    email,
    phone,
    isPrimary: row.is_contact_person === "1",
    designation: designationKind(title),
    designationId: await designationId(tx, ctx, title),
    leftAt: clean(row.status) && clean(row.status).toLowerCase() !== "active" ? (oldInstant(row.updatedAt!) ?? new Date()) : null,
  });
  const logged = await ctx.records.get("employees", oldId);
  if (logged) {
    if (!mayUpdate(ctx, logged)) return unchanged(logged.recordId);
    const v = await values();
    await updateLogged(tx, ctx, "employees", oldId, logged, () => tx.contact.findUnique({ where: { id: logged.recordId }, select: { name: true, email: true, phone: true, isPrimary: true, designation: true, designationId: true, leftAt: true } }), async () => {
      await tx.contact.update({ where: { id: logged.recordId }, data: v });
    });
    return { kind: "updated", recordId: logged.recordId };
  }
  // The Zoho person the master list took them as: that contact, filled in where Zoho left it blank.
  const twin = ctx.withZoho ? await zohoTwin(tx, ctx, "contacts", ["zoho_contact_persons", "zoho_vendor_contact_persons"], oldId) : null;
  if (twin) {
    if (twin.ours) {
      const v = await values();
      const current = await tx.contact.findUniqueOrThrow({ where: { id: twin.recordId }, select: { email: true, phone: true, designation: true, designationId: true, customFields: true } });
      await tx.contact.update({
        where: { id: twin.recordId },
        data: {
          ...blanksOnly(current, { email: v.email, phone: v.phone, designationId: v.designationId }),
          ...(current.designation === "OTHER" ? { designation: v.designation } : {}),
          customFields: { ...fields({ oldcrm_id: oldId, job_title: title || null }), ...((current.customFields ?? {}) as object) },
        },
      });
    }
    await log(tx, ctx, "employees", oldId, twin.recordId, "LINKED");
    return linked(twin.recordId);
  }
  if (email) {
    const same = await tx.contact.findFirst({ where: { companyId, email: { equals: email, mode: "insensitive" } }, select: { id: true } });
    if (same) {
      const ours = await tx.legacyImportRecord.findFirst({ where: { recordId: same.id }, select: { id: true } });
      if (!ours) {
        const decision = ctx.decisions.matches?.employees;
        if (decision === "skip") return skipped(`The company already has a contact with ${email}; left out as chosen.`);
        if (decision !== "link") fail(`The company already has a contact with ${email} — choose on the preview whether to use it.`);
      }
      await log(tx, ctx, "employees", oldId, same.id, "LINKED");
      return linked(same.id);
    }
  }
  const made = await tx.contact.create({ data: { companyId, ...(await values()), createdByUserId: ctx.actorId, createdAt: oldInstant(row.createdAt!) ?? undefined, customFields: fields({ oldcrm_id: oldId, job_title: title || null }) }, select: { id: true } });
  await log(tx, ctx, "employees", oldId, made.id, "CREATED");
  return created(made.id);
};

/**
 * The company a lead or a profiling is at: the one of that name (a customer the import brought, a prospect it made
 * earlier, or one Deskzo had), else a prospect made now — with the row's address as its head office.
 */
async function prospectCompany(tx: Tx, ctx: Ctx, row: Record<string, string>, tags: string[], ownerOldId: string | undefined, createdBy: string | undefined) {
  const name = nameOrStandIn(row, "company", row.id ?? "");
  const existing = await companyByName(tx, name);
  if (existing) {
    if (existing.madeByImport && tags.some((t) => !existing.tags.includes(t))) await tx.company.update({ where: { id: existing.id }, data: { tags: tagsOf(existing.tags, tags) } });
    return existing.id;
  }
  const made = await tx.company.create({
    data: {
      name,
      normalizedName: companyKey(name),
      relationshipType: "CLIENT",
      stage: "PROSPECT",
      industryId: await industryId(tx, ctx, row.industry_type ?? ""),
      companyType: await companyTypeKey(tx, ctx, row.company_type),
      website: clean(row.website) || null,
      employeeCount: employees(row.employee_count ?? ""),
      tags,
      ownerUserId: await userOrNull(ctx, ownerOldId),
      createdById: await userOf(ctx, createdBy),
      createdAt: oldInstant(row.createdAt!) ?? undefined,
    },
    select: { id: true },
  });
  await log(tx, ctx, "prospect-company", companyKey(name), made.id, "CREATED");
  if (clean(row.address) || clean(row.city)) {
    const office = await headOffice(tx, made.id, { ...row, gst_no: "" });
    await log(tx, ctx, "head-office", `prospect:${companyKey(name)}`, office.id, "CREATED");
  }
  return made.id;
}

const profilings: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  if (deleted(row)) return skipped("Deleted in the old CRM.");
  const logged = await ctx.records.get("profilings", oldId);
  if (logged && !mayUpdate(ctx, logged)) return unchanged(logged.recordId);
  const email = clean(row.email) || null;
  const phone = oldPhone(row.mobile_no || row.phone, row.country_code);
  const title = clean(row.designation) || clean(row.department);
  const status = [clean(row.status), clean(row.source) && !/^profl?iling$/i.test(clean(row.source)) ? `source: ${clean(row.source)}` : ""].filter(Boolean).join("; ");
  const values = { name: clean(row.name) || email || phone || "Unnamed", email, phone, linkedinUrl: clean(row.linkedin_url) || null, designation: designationKind(title) };
  const custom = fields({ oldcrm_id: `profiling ${oldId}`, job_title: title || null, profiling_status: status || null });
  if (logged) {
    await updateLogged(tx, ctx, "profilings", oldId, logged, () => tx.contact.findUnique({ where: { id: logged.recordId }, select: { name: true, email: true, phone: true, linkedinUrl: true, designation: true, customFields: true } }), async () => {
      const current = await tx.contact.findUniqueOrThrow({ where: { id: logged.recordId }, select: { customFields: true } });
      await tx.contact.update({ where: { id: logged.recordId }, data: { ...values, customFields: { ...((current.customFields ?? {}) as object), ...custom } } });
    });
    return { kind: "updated", recordId: logged.recordId };
  }
  const companyId = await prospectCompany(tx, ctx, row, tagsOf(["Profiling"], ctx.lookups.entityTags[`profiling:${oldId}`]), row.assigned_to, row.created_by);
  if (email) {
    const same = await tx.contact.findFirst({ where: { companyId, email: { equals: email, mode: "insensitive" } }, select: { id: true } });
    if (same) {
      await log(tx, ctx, "profilings", oldId, same.id, "LINKED");
      return linked(same.id);
    }
  }
  const made = await tx.contact.create({ data: { companyId, ...values, createdByUserId: await userOf(ctx, row.created_by), createdAt: oldInstant(row.createdAt!) ?? undefined, customFields: custom }, select: { id: true } });
  await log(tx, ctx, "profilings", oldId, made.id, "CREATED");
  return created(made.id);
};

// ─── Leads ───────────────────────────────────────────────────────────────────────────────────────

const LEAD_SOURCES: Record<string, string> = { "old-client": "EXISTING_CUSTOMER", "cold-call": "CALLING", "warm-call": "CALLING", "field-sales-calling": "CALLING", mail: "EMAIL", mailer: "EMAIL", referral: "REFERRAL", website: "WEBSITE", microsoft: "PARTNER", broadline: "PARTNER" };

/**
 * The main pipeline's stage for a lead's meaning. A pipeline without one (owner, 27 Oct 2026): an open meaning comes
 * in at the nearest earlier open stage — no Contacted stage, it waits at New — else the first open one; a won or lost
 * one at a stage of its kind, which every pipeline keeps.
 */
async function stageFor(tx: Tx, wanted: LeadStatus): Promise<{ id: string; status: LeadStatus; label: string }> {
  const stages = await tx.leadStage.findMany({ where: { pipelineId: MAIN_PIPELINE_ID, archivedAt: null }, orderBy: { sortOrder: "asc" }, select: { id: true, status: true, label: true } });
  const exact = stages.find((s) => s.status === wanted);
  if (exact) return exact;
  const rank = (s: LeadStatus) => MEANINGS.findIndex((m) => m.status === s);
  const open = stages.filter((s) => kindOf(s.status) === "OPEN");
  const fallback =
    kindOf(wanted) === "OPEN"
      ? // Nearest earlier first; of stages with one meaning, the first in the pipeline (the sort keeps their order).
        (open.filter((s) => rank(s.status) < rank(wanted)).sort((a, b) => rank(b.status) - rank(a.status))[0] ?? open[0])
      : stages.find((s) => kindOf(s.status) === kindOf(wanted));
  return fallback ?? fail(`The main pipeline has no stage for a ${meaningOf(wanted).label.toLowerCase()} lead.`);
}

const leads: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  if (deleted(row)) return skipped("Deleted in the old CRM.");
  const raw = clean(row.status).toLowerCase();
  const wanted: LeadStatus = LEAD_STATUS[raw] ?? stageMeaning(raw) ?? "NEW";
  const stage = await stageFor(tx, wanted);
  // The lead means what its stage means, so a lead and its stage never disagree.
  const status = stage.status;
  const warning = [
    LEAD_STATUS[raw] || stageMeaning(raw) ? null : `Status "${row.status}" isn't one the tool knows; the lead starts as New.`,
    stage.status === wanted ? null : `The main pipeline has no ${meaningOf(wanted).label} stage; it came in at "${stage.label}".`,
  ]
    .filter(Boolean)
    .join(" ") || undefined;
  const product = ctx.lookups.products[row.product_id ?? ""];
  const company = clean(row.company) || clean(row.name);
  const oldSource = clean(row.source).toLowerCase();
  const mapped = LEAD_SOURCES[oldSource];
  const source = mapped ? { source: mapped as never } : sourceOf(oldSource);
  const createdAt = oldInstant(row.createdAt!) ?? new Date();
  const closed = status === "WON" || status === "LOST" || status === "DISQUALIFIED";
  // The old CRM's "value" is often a placeholder 1; its BOM is the deal's value.
  const value = money(row.bom ?? "") ?? money(row.value ?? "");
  const values = {
    title: product ? `${product.name} — ${company}` : company || "Lead from the old CRM",
    status,
    stageId: stage.id,
    pipelineId: MAIN_PIPELINE_ID,
    stageChangedAt: closed ? (oldInstant(row.updatedAt!) ?? createdAt) : createdAt,
    estimatedValue: value !== null && value > 1 ? value : null,
    lostReason: closed && status !== "WON" ? clean(row.reason) || null : null,
    description: [clean(row.description), /^on[- ]hold$/.test(raw) ? "On hold in the old CRM." : ""].filter(Boolean).join("\n") || null,
    source: source.source,
    sourceDetail: clean(row.source) || null,
  };
  /**
   * Lead limits (owner, 12 Nov 2026 — Phase 4, audit H.6.5): whoever a lead is given to takes their room in this row's
   * transaction, and a new lead counts against the plan's cap — so a row whose owner is full fails with the reason
   * (`applyRow`), and the rows around it go on. A closed lead takes no open place.
   */
  await markLeadWrite(tx, "legacyImport");
  const logged = await ctx.records.get("leads", oldId);
  if (logged) {
    if (!mayUpdate(ctx, logged)) return unchanged(logged.recordId);
    await updateLogged(tx, ctx, "leads", oldId, logged, () => tx.lead.findUnique({ where: { id: logged.recordId }, select: { title: true, status: true, stageId: true, pipelineId: true, stageChangedAt: true, estimatedValue: true, lostReason: true, description: true, source: true, sourceDetail: true, ownerUserId: true } }), async () => {
      const ownerUserId = (await userOrNull(ctx, row.assigned_to)) ?? undefined;
      const was = ownerUserId ? (await tx.lead.findUnique({ where: { id: logged.recordId }, select: { ownerUserId: true } }))?.ownerUserId : undefined;
      if (ownerUserId && ownerUserId !== was) await claimLeadCapacity(tx, [ownerUserId], { creating: false, open: closed ? 0 : 1 });
      await tx.lead.update({ where: { id: logged.recordId }, data: { ...values, ownerUserId } });
    });
    return { kind: "updated", recordId: logged.recordId };
  }
  // Its room first, before the company or contact: the workspace's lead queue before any row, as every path takes them.
  const ownerUserId = (await userOrNull(ctx, row.assigned_to)) ?? (await userOf(ctx, row.created_by));
  await claimLeadCapacity(tx, [ownerUserId], { creating: true, open: closed ? 0 : 1 });
  const companyId = await prospectCompany(tx, ctx, { ...row, company }, tagsOf(ctx.lookups.entityTags[`lead:${oldId}`]), row.assigned_to, row.created_by);
  const email = clean(row.email) || null;
  let contactId: string | null = null;
  if (email) contactId = (await tx.contact.findFirst({ where: { companyId, email: { equals: email, mode: "insensitive" } }, select: { id: true } }))?.id ?? null;
  if (!contactId && (clean(row.name) || email)) {
    const contact = await tx.contact.create({
      data: { companyId, name: clean(row.name) || email!, email, phone: oldPhone(row.phone, row.country_code), designation: designationKind(row.designation ?? ""), createdByUserId: await userOf(ctx, row.created_by), customFields: fields({ job_title: clean(row.designation) || null }) },
      select: { id: true },
    });
    await log(tx, ctx, "lead-contact", oldId, contact.id, "CREATED");
    contactId = contact.id;
  }
  const made = await tx.lead.create({
    data: {
      ...values,
      companyId,
      contactId,
      ownerUserId,
      sourcedByUserId: await userOrNull(ctx, row.created_by),
      createdByUserId: await userOf(ctx, row.created_by),
      createdAt,
      externalId: `oldcrm:${oldId}`,
    },
    select: { id: true },
  });
  const itemId = await ctx.records.id("products", row.product_id);
  if (itemId) await tx.leadRequirement.create({ data: { leadId: made.id, itemId, quantity: 1 } });
  await log(tx, ctx, "leads", oldId, made.id, "CREATED");
  return created(made.id, warning);
};

/** A lead's product: a requirement on it — the one the lead already names, if it's that product. */
const leadProducts: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  if (deleted(row)) return skipped("Deleted in the old CRM.");
  const leadId = await needed(ctx, "leads", row.lead_id, `Its lead (${row.lead_id})`);
  const { id: itemId, warning: productNote } = await productOrStandIn(tx, ctx, row.product_id);
  const values = { quantity: Math.max(1, Math.round(Number(clean(row.quantity)) || 1)), renewalDate: oldDay(row.renewal_date ?? "") };
  const logged = await ctx.records.get("lead_product", oldId);
  if (logged) {
    if (!mayUpdate(ctx, logged)) return unchanged(logged.recordId);
    await updateLogged(tx, ctx, "lead_product", oldId, logged, () => tx.leadRequirement.findUnique({ where: { id: logged.recordId }, select: { quantity: true, renewalDate: true } }), async () => {
      await tx.leadRequirement.update({ where: { id: logged.recordId }, data: values });
    });
    return { kind: "updated", recordId: logged.recordId };
  }
  const same = await tx.leadRequirement.findFirst({ where: { leadId, itemId }, select: { id: true } });
  if (same) {
    await log(tx, ctx, "lead_product", oldId, same.id, "LINKED");
    return linked(same.id, productNote);
  }
  const made = await tx.leadRequirement.create({ data: { leadId, itemId, ...values }, select: { id: true } });
  await log(tx, ctx, "lead_product", oldId, made.id, "CREATED");
  return created(made.id, productNote);
};

// ─── Orders (the renewals book) ──────────────────────────────────────────────────────────────────

/** The distributor an order was bought from: a vendor Deskzo has by that name, else one made now — never the company itself. */
async function vendorId(tx: Tx, ctx: Ctx, name: string): Promise<string | null> {
  const vendor = clean(name);
  if (!vendor || companyKey(vendor) === ctx.ownName) return null;
  const existing = await tx.company.findUnique({ where: { normalizedName: companyKey(vendor) }, select: { id: true, relationshipType: true, alsoVendor: true } });
  if (existing) return ["VENDOR", "DISTRIBUTOR", "OEM"].includes(existing.relationshipType) || existing.alsoVendor ? existing.id : null;
  const made = await tx.company.create({ data: { name: vendor, normalizedName: companyKey(vendor), relationshipType: "VENDOR", stage: "CUSTOMER", createdById: ctx.actorId }, select: { id: true } });
  await log(tx, ctx, "vendor", companyKey(vendor), made.id, "CREATED");
  return made.id;
}

const customerProducts: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  if (deleted(row)) return skipped("Deleted in the old CRM.");
  const companyId = await needed(ctx, "customers", row.customer_id, `Its customer (${row.customer_id})`);
  const { id: itemId, warning: productNote } = await productOrStandIn(tx, ctx, row.product_id);
  const lost = clean(row.stage).toLowerCase() === "lost";
  const domain = clean(row.domain_tenant);
  const notes = [clean(row.description), domain && /^part code/i.test(domain) ? domain : "", clean(row.stage) && !["no-action", "lost"].includes(clean(row.stage)) ? `Stage in the old CRM: ${clean(row.stage)}` : ""].filter(Boolean).join("\n");
  const values = {
    itemId,
    quantity: Math.max(1, Math.round(Number(clean(row.quantity)) || 1)),
    startDate: oldDay(row.start_date ?? ""),
    endDate: oldDay(row.expiry_date ?? ""),
    ourPoNumber: clean(row.invoice_no) || null,
    businessType: BUSINESS_TYPE[clean(row.product_type).toLowerCase()] ?? ("NEW" as const),
    notes: notes || null,
    renewalStage: lost ? ("LOST" as const) : null,
    renewalStageNote: lost ? clean(row.reason) || null : null,
    customFields: fields({ oldcrm_id: oldId, tenant_domain: domain && !/^part code/i.test(domain) ? domain : null, billing_term: clean(row.payment_terms).replace(/_/g, " ") || null }),
  };
  const logged = await ctx.records.get("customer_product", oldId);
  if (logged) {
    if (!mayUpdate(ctx, logged)) return unchanged(logged.recordId);
    await updateLogged(tx, ctx, "customer_product", oldId, logged, () => tx.companyProduct.findUnique({ where: { id: logged.recordId }, select: { itemId: true, quantity: true, startDate: true, endDate: true, ourPoNumber: true, businessType: true, notes: true, renewalStage: true, renewalStageNote: true, customFields: true } }), async () => {
      await tx.companyProduct.update({ where: { id: logged.recordId }, data: values });
    });
    return { kind: "updated", recordId: logged.recordId };
  }
  const billingLocation = await ctx.records.id("billing_addresses", row.billing_address_id);
  const locationId =
    billingLocation ??
    (await tx.companyLocation.findFirst({ where: { companyId }, orderBy: [{ isBilling: "desc" }, { isPrimary: "desc" }, { createdAt: "asc" }], select: { id: true } }))?.id ??
    (await standInOffice(tx, ctx, companyId));
  const at = oldInstant(row.createdAt!) ?? new Date();
  const made = await tx.companyProduct.create({
    data: {
      ...values,
      companyId,
      locationId,
      vendorId: await vendorId(tx, ctx, row.vendor ?? ""),
      orderStatus: "FULFILLED",
      fulfilledAt: at,
      bookedAt: at,
      createdAt: at,
      addedByUserId: await userOf(ctx, row.created_by),
    },
    select: { id: true },
  });
  await log(tx, ctx, "customer_product", oldId, made.id, "CREATED");
  return created(made.id, productNote);
};

/** A head office for a customer with no address, so its orders have somewhere to be booked — its address to fill in. */
async function standInOffice(tx: Tx, ctx: Ctx, companyId: string): Promise<string> {
  const office = await tx.companyLocation.create({ data: { companyId, label: `Head office ${TO_FIX}`, isPrimary: true, isBilling: true, isShipping: true }, select: { id: true } });
  await log(tx, ctx, "head-office", `stand-in:${companyId}`, office.id, "CREATED");
  return office.id;
}

/** The second pass: each order's add-on parent, and the order it renewed — both made by now. */
const customerProductLinks: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  const logged = await ctx.records.get("customer_product", oldId);
  if (!logged || logged.action === "LINKED") return skipped("Not an order this import made.");
  const parentId = await ctx.records.id("customer_product", row.parent_id);
  const renewedFromId = await ctx.records.id("customer_product", row.renewal_id);
  if (!parentId && !renewedFromId) return unchanged(logged.recordId);
  const current = await tx.companyProduct.findUnique({ where: { id: logged.recordId }, select: { parentId: true, renewedFromId: true } });
  if (!current) return skipped("The order isn't there any more.");
  const data: { parentId?: string; renewedFromId?: string } = {};
  if (parentId && parentId !== logged.recordId && current.parentId !== parentId) data.parentId = parentId;
  if (renewedFromId && renewedFromId !== logged.recordId && current.renewedFromId !== renewedFromId) {
    const taken = await tx.companyProduct.findFirst({ where: { renewedFromId }, select: { id: true } });
    if (!taken) data.renewedFromId = renewedFromId;
  }
  if (Object.keys(data).length === 0) return unchanged(logged.recordId);
  await tx.companyProduct.update({ where: { id: logged.recordId }, data });
  return { kind: "updated", recordId: logged.recordId };
};

// ─── Tickets, replies, visits, calls ─────────────────────────────────────────────────────────────

function ticketHandler(kind: "product_tickets" | "anonymous_tickets"): Handler {
  return async (row, tx, ctx) => {
    const oldId = row.id!;
    if (deleted(row)) return skipped("Deleted in the old CRM.");
    const companyId = await needed(ctx, "customers", row.customer_id, `Its customer (${row.customer_id})`);
    const raw = clean(row.status).toLowerCase();
    const status: TicketStatus = TICKET_STATUS[raw] ?? "OPEN";
    const product = kind === "anonymous_tickets" ? ctx.lookups.products[row.product_id ?? ""] : undefined;
    const notes = [
      clean(row.ticket_no) ? `Ticket ${clean(row.ticket_no)} in the old CRM.` : "",
      raw && raw !== status.toLowerCase().replace("_", "-") ? `Status there: ${clean(row.status)}.` : "",
      product ? `Product: ${product.name}.` : "",
    ].filter(Boolean);
    const updatedAt = oldInstant(row.updatedAt!) ?? new Date();
    const values = {
      title: (clean(row.title) || "Ticket from the old CRM").slice(0, 300),
      description: [clean(row.description), notes.join(" ")].filter(Boolean).join("\n\n"),
      status,
      priority: TICKET_PRIORITY[clean(row.priority).toLowerCase()] ?? ("MEDIUM" as const),
      ticketType: kind === "product_tickets" ? ("PRODUCT_SUPPORT" as const) : (TICKET_TYPE[clean(row.type).toLowerCase()] ?? ("OTHER" as const)),
      assignedToUserId: await userOrNull(ctx, row.assigned_to),
      resolvedAt: status === "RESOLVED" || status === "CLOSED" ? updatedAt : null,
      closedAt: status === "CLOSED" ? updatedAt : null,
    };
    const logged = await ctx.records.get(kind, oldId);
    if (logged) {
      if (!mayUpdate(ctx, logged)) return unchanged(logged.recordId);
      await updateLogged(tx, ctx, kind, oldId, logged, () => tx.ticket.findUnique({ where: { id: logged.recordId }, select: { title: true, description: true, status: true, priority: true, ticketType: true, assignedToUserId: true, resolvedAt: true, closedAt: true } }), async () => {
        await tx.ticket.update({ where: { id: logged.recordId }, data: values });
      });
      return { kind: "updated", recordId: logged.recordId };
    }
    const made = await tx.ticket.create({
      data: {
        ...values,
        companyId,
        companyProductId: kind === "product_tickets" ? await ctx.records.id("customer_product", row.customer_product_id) : null,
        contactId: await ctx.records.id("employees", row.contact_person_id),
        createdByUserId: await userOf(ctx, row.created_by),
        createdAt: oldInstant(row.createdAt!) ?? undefined,
      },
      select: { id: true },
    });
    await log(tx, ctx, kind, oldId, made.id, "CREATED");
    return created(made.id);
  };
}

const TICKET_KINDS: Record<string, KindKey> = { product: "product_tickets", anonymous: "anonymous_tickets" };

const replies: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  if (deleted(row)) return skipped("Deleted in the old CRM.");
  const kind = TICKET_KINDS[clean(row.ticket_type).toLowerCase()] ?? fail(`A reply to a "${row.ticket_type}" ticket, which the tool doesn't know.`);
  const ticketId = await needed(ctx, kind, row.ticket_id, `Its ticket (${row.ticket_type} ${row.ticket_id})`);
  const body = clean(row.reply) || fail("An empty reply.");
  const logged = await ctx.records.get("replies", oldId);
  if (logged) {
    if (!mayUpdate(ctx, logged)) return unchanged(logged.recordId);
    await updateLogged(tx, ctx, "replies", oldId, logged, () => tx.ticketComment.findUnique({ where: { id: logged.recordId }, select: { body: true } }), async () => {
      await tx.ticketComment.update({ where: { id: logged.recordId }, data: { body } });
    });
    return { kind: "updated", recordId: logged.recordId };
  }
  const made = await tx.ticketComment.create({ data: { ticketId, userId: await userOf(ctx, row.replier_id), body, createdAt: oldInstant(row.createdAt!) ?? undefined }, select: { id: true } });
  await log(tx, ctx, "replies", oldId, made.id, "CREATED");
  return created(made.id);
};

const visits: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  if (deleted(row)) return skipped("Deleted in the old CRM.");
  const leadId = await ctx.records.id("leads", row.lead_id);
  const companyId = (await ctx.records.id("customers", row.customer_id)) ?? (leadId ? (await tx.lead.findUnique({ where: { id: leadId }, select: { companyId: true } }))?.companyId : null) ?? (deletedInOldCrm(ctx.lookups, "customers", row.customer_id) || deletedInOldCrm(ctx.lookups, "leads", row.lead_id) ? stayBehind("Its customer or lead was deleted in the old CRM, so it stays behind with it.") : fail("Its customer or lead didn't come across."));
  const when = oldInstant(row.visit_date ?? "") ?? fail("No visit date.");
  const raw = clean(row.status).toLowerCase();
  const status: VisitStatus = raw === "cancelled" ? "CANCELLED" : raw === "planned" || raw === "pending" ? (when > new Date() ? "PLANNED" : "NO_SHOW") : "COMPLETED";
  const email = clean(row.contact_person_email);
  const contactId = email ? ((await tx.contact.findFirst({ where: { companyId, email: { equals: email, mode: "insensitive" } }, select: { id: true } }))?.id ?? null) : null;
  const coworker = row.coworker_id ? ctx.lookups.users[row.coworker_id]?.name : null;
  const values = {
    scheduledFor: when,
    status,
    purpose: VISIT_PURPOSE[clean(row.purpose).toLowerCase()] ?? ("OTHER" as const),
    agenda: [clean(row.origin) ? `From ${clean(row.origin)}` : "", coworker ? `with ${coworker}` : "", clean(row.contact_person_name) ? `to meet ${clean(row.contact_person_name)}${clean(row.contact_person_number) ? ` (${oldPhone(row.contact_person_number, row.country_code)})` : ""}` : ""].filter(Boolean).join(", ") || null,
    address: clean(row.destination) || null,
    outcome: [clean(row.remarks), raw && raw !== "completed" ? `Status in the old CRM: ${clean(row.status)}.` : ""].filter(Boolean).join("\n") || null,
  };
  const logged = await ctx.records.get("field_visits", oldId);
  if (logged) {
    if (!mayUpdate(ctx, logged)) return unchanged(logged.recordId);
    await updateLogged(tx, ctx, "field_visits", oldId, logged, () => tx.visit.findUnique({ where: { id: logged.recordId }, select: { scheduledFor: true, status: true, purpose: true, agenda: true, address: true, outcome: true } }), async () => {
      await tx.visit.update({ where: { id: logged.recordId }, data: values });
    });
    return { kind: "updated", recordId: logged.recordId };
  }
  const made = await tx.visit.create({ data: { ...values, companyId, leadId, contactId, userId: await userOf(ctx, row.created_by), createdAt: oldInstant(row.createdAt!) ?? undefined }, select: { id: true } });
  await log(tx, ctx, "field_visits", oldId, made.id, "CREATED");
  return created(made.id);
};

const CALL_TARGETS: Record<string, KindKey> = { lead: "leads", customer: "customers", profiling: "profilings", product_ticket: "product_tickets", anonymous_ticket: "anonymous_tickets", customer_product: "customer_product" };

const calls: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  if (deleted(row)) return skipped("Deleted in the old CRM.");
  const kind = CALL_TARGETS[clean(row.type).toLowerCase()] ?? fail(`A call on a "${row.type}", which the tool doesn't know.`);
  const target = await needed(ctx, kind, row.type_id, `What it was about (${row.type} ${row.type_id})`);
  let link: { companyId: string; contactId?: string | null; leadId?: string | null; ticketId?: string | null; companyProductId?: string | null; phone?: string | null };
  if (kind === "leads") {
    const lead = (await tx.lead.findUnique({ where: { id: target }, select: { companyId: true, contactId: true, contact: { select: { phone: true } } } })) ?? fail("Its lead isn't there any more.");
    link = { companyId: lead.companyId, contactId: lead.contactId, leadId: target, phone: lead.contact?.phone };
  } else if (kind === "profilings") {
    const contact = (await tx.contact.findUnique({ where: { id: target }, select: { companyId: true, phone: true } })) ?? fail("Its contact isn't there any more.");
    link = { companyId: contact.companyId, contactId: target, phone: contact.phone };
  } else if (kind === "product_tickets" || kind === "anonymous_tickets") {
    const ticket = (await tx.ticket.findUnique({ where: { id: target }, select: { companyId: true, contactId: true } })) ?? fail("Its ticket isn't there any more.");
    link = { companyId: ticket.companyId, contactId: ticket.contactId, ticketId: target };
  } else if (kind === "customer_product") {
    const order = (await tx.companyProduct.findUnique({ where: { id: target }, select: { companyId: true } })) ?? fail("Its order isn't there any more.");
    link = { companyId: order.companyId, companyProductId: target };
  } else {
    link = { companyId: target };
  }
  if (!link.phone && link.contactId) link.phone = (await tx.contact.findUnique({ where: { id: link.contactId }, select: { phone: true } }))?.phone ?? null;
  const response = [clean(row.feedback_type), clean(row.response).replace(/_/g, " ")].filter(Boolean).join(", ");
  const followUpAt = oldInstant(row.rescheduled_at || row.reminder_at || "");
  const values = {
    outcome: CALL_OUTCOME[clean(row.status).toLowerCase()] ?? ("CONNECTED" as const),
    notes: [clean(row.remarks), response ? `(${response})` : ""].filter(Boolean).join(" ") || null,
    followUpAt,
    followUpDone: !!followUpAt && followUpAt < new Date(),
  };
  const logged = await ctx.records.get("call_logs", oldId);
  if (logged) {
    if (!mayUpdate(ctx, logged)) return unchanged(logged.recordId);
    await updateLogged(tx, ctx, "call_logs", oldId, logged, () => tx.callLog.findUnique({ where: { id: logged.recordId }, select: { outcome: true, notes: true, followUpAt: true, followUpDone: true } }), async () => {
      await tx.callLog.update({ where: { id: logged.recordId }, data: values });
    });
    return { kind: "updated", recordId: logged.recordId };
  }
  const made = await tx.callLog.create({
    data: {
      ...values,
      companyId: link.companyId,
      contactId: link.contactId ?? null,
      leadId: link.leadId ?? null,
      ticketId: link.ticketId ?? null,
      companyProductId: link.companyProductId ?? null,
      phoneNumber: link.phone || "Not recorded",
      startedAt: oldInstant(row.createdAt!) ?? new Date(),
      userId: await userOf(ctx, row.called_by),
      createdAt: oldInstant(row.createdAt!) ?? undefined,
    },
    select: { id: true },
  });
  await log(tx, ctx, "call_logs", oldId, made.id, "CREATED");
  return created(made.id);
};

// ─── Zoho Books, through the master lists ────────────────────────────────────────────────────────

/**
 * Phase 2 of the Zoho plan (owner, 26 Oct 2026): with Zoho Books' files in the upload, each company, item and
 * person comes in once, from Zoho — its name, GSTIN, billing address, payment terms and currency are the books' —
 * with both old ids logged against it. The WroffyCRM row the master list paired with it then only fills in what Zoho
 * hasn't (industry, source, LinkedIn, CIN, company type, tags), and only on a record this import made. A WroffyCRM
 * company Zoho never billed comes in as a prospect.
 */

const ZOHO_TERMS: Record<string, PaymentTerms> = { "due on receipt": "DUE_ON_RECEIPT", "net 15": "NET_15", "net 30": "NET_30", "net 45": "NET_45", "net 60": "NET_60" };
const ZOHO_TREATMENT: Record<string, GstTreatment> = {
  business_gst: "REGISTERED_REGULAR",
  business_registered_regular: "REGISTERED_REGULAR",
  business_registered_composition: "REGISTERED_COMPOSITION",
  business_none: "UNREGISTERED",
  consumer: "CONSUMER",
  overseas: "OVERSEAS",
  business_sez: "SEZ",
  sez_developer: "SEZ",
  deemed_export: "DEEMED_EXPORT",
};
/** The stand-in SKU of an item Zoho kept without one (Deskzo's are required and unique). */
const ZOHO_SKU = "ZOHO-";
const roundedZohoId = (id: string) => /^\d(\.\d+)?E\+\d+$/i.test(id);
const zohoTime = (text: string | undefined) => {
  const t = clean(text);
  const at = t ? new Date(t.replace(" ", "T")) : null;
  return at && !Number.isNaN(at.getTime()) ? at : undefined;
};
const yes = (text: string | undefined) => /^(true|yes|1)$/i.test(clean(text));

/** The other side's id of the pair a master list settled: WroffyCRM's for a Zoho id, or Zoho's for a WroffyCRM one. */
async function pairedId(tx: Tx, ctx: Ctx, list: string, side: "zoho" | "old", id: string): Promise<string | null> {
  const match = await tx.legacyMatch.findFirst({
    where: { importId: ctx.importId, list, status: { in: ["MATCHED", "CONFIRMED"] }, ...(side === "zoho" ? { zohoId: id } : { oldId: id }) },
    select: { zohoId: true, oldId: true },
  });
  return (side === "zoho" ? match?.oldId : match?.zohoId) ?? null;
}

/** The record Zoho's side of a WroffyCRM row's pair became, and whether this import made it (only then is it filled in). */
async function zohoTwin(tx: Tx, ctx: Ctx, list: string, kinds: string[], oldId: string) {
  const zohoId = await pairedId(tx, ctx, list, "old", oldId);
  if (!zohoId) return null;
  for (const kind of kinds) {
    const logged = await ctx.records.get(kind, zohoId);
    if (logged) return { recordId: logged.recordId, ours: logged.action === "CREATED" && logged.importId === ctx.importId };
  }
  return null;
}

/** Only what the record has no value for yet. */
function blanksOnly<T extends Record<string, unknown>>(current: Record<string, unknown>, values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== null && v !== undefined && (current[k] === null || current[k] === undefined || current[k] === ""))) as Partial<T>;
}

/**
 * Zoho's "Owner Name" — who looks after a customer there (owner, 30 Oct 2026) — as a Deskzo person: the one active
 * member of that name, read the way names are typed differently (case, spacing, punctuation). Nobody of that name, or
 * two, is said on the row and left for a person to set. Read once an import.
 */
const deskzoPeopleByName = new WeakMap<Ctx, Promise<Map<string, string | null>>>();
const personKey = (name: string) => clean(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function zohoOwner(tx: Tx, ctx: Ctx, row: Record<string, string>): Promise<{ id: string | null; warning?: string }> {
  const name = clean(row["Owner Name"]);
  if (!name) return { id: null };
  let people = deskzoPeopleByName.get(ctx);
  if (!people) {
    people = tx.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { id: true, name: true } }).then((rows) => {
      const byName = new Map<string, string | null>();
      for (const r of rows) byName.set(personKey(r.name), byName.has(personKey(r.name)) ? null : r.id);
      return byName;
    });
    deskzoPeopleByName.set(ctx, people);
  }
  const found = (await people).get(personKey(name));
  if (found === undefined) return { id: null, warning: `Its owner in Zoho, ${name}, isn't anyone working in Deskzo — set its account manager by hand.` };
  if (found === null) return { id: null, warning: `More than one person in Deskzo is called ${name} — set its account manager by hand.` };
  return { id: found };
}

/**
 * The one company Deskzo already has with a Zoho row's GSTIN, else with its PAN — the same business, a branch in another
 * state (owner, 30 Oct 2026: Contacts.csv uploaded alone, over customers WroffyCRM brought under other names). None, or
 * more than one, and nothing is guessed: the name decides, as before.
 */
const panOfGstin = (gst: string) => gst.slice(2, 12);

async function companyByTaxId(tx: Tx, gst: string | null): Promise<{ id: string; name: string; relationshipType: string; by: "GSTIN" | "PAN" } | { many: "GSTIN" | "PAN" } | null> {
  if (!gst) return null;
  const pick = async (ids: string[], by: "GSTIN" | "PAN") => {
    const unique = [...new Set(ids)];
    if (unique.length > 1) return { many: by };
    if (unique.length === 0) return null;
    const company = await tx.company.findUniqueOrThrow({ where: { id: unique[0] }, select: { id: true, name: true, relationshipType: true } });
    return { ...company, by };
  };
  const sameGst = await tx.companyLocation.findMany({ where: { gstNumber: { equals: gst, mode: "insensitive" } }, select: { companyId: true } });
  const byGst = await pick(sameGst.map((l) => l.companyId), "GSTIN");
  if (byGst) return byGst;
  const pan = panOfGstin(gst);
  const panLocations = await tx.companyLocation.findMany({ where: { gstNumber: { contains: pan, mode: "insensitive" } }, select: { companyId: true, gstNumber: true } });
  const panCompanies = await tx.company.findMany({ where: { panNumber: { equals: pan, mode: "insensitive" } }, select: { id: true } });
  return pick([...panLocations.filter((l) => panOfGstin(l.gstNumber!.toUpperCase()) === pan).map((l) => l.companyId), ...panCompanies.map((c) => c.id)], "PAN");
}

/** The account manager from Zoho's owner, only where the company has none yet: one set in the old CRM, or by hand, stays. */
async function fillOwner(tx: Tx, companyId: string, owner: { id: string | null }): Promise<void> {
  if (owner.id) await tx.company.updateMany({ where: { id: companyId, ownerUserId: null }, data: { ownerUserId: owner.id } });
}

function zohoCompanies(list: "customers" | "vendors"): Handler {
  const kind = list === "customers" ? "zoho_contacts" : "zoho_vendors";
  return async (row, tx, ctx) => {
    const zohoId = clean(row["Contact ID"]) || fail("No Contact ID.");
    if (roundedZohoId(zohoId)) fail(`Its Contact ID (${zohoId}) was rounded by a spreadsheet — upload the file as Zoho exported it.`);
    const owner = await zohoOwner(tx, ctx, row);
    const logged = await ctx.records.get(kind, zohoId);
    if (logged) {
      // Brought across before owners were read: its account manager filled in now, if it has none.
      await fillOwner(tx, logged.recordId, owner);
      return unchanged(logged.recordId);
    }
    const name = clean(row["Company Name"]) || clean(row["Display Name"]) || fail("No name.");
    const gst = gstOf(row["GST Identification Number (GSTIN)"] ?? "");
    const country = row["Billing Country"] ?? "";

    // A vendor that is a Zoho customer too — the same GSTIN — is that one company, a vendor as well.
    if (list === "vendors" && gst) {
      const office = await tx.companyLocation.findFirst({ where: { gstNumber: gst }, select: { companyId: true } });
      const ours = office ? await tx.legacyImportRecord.findFirst({ where: { kind: "zoho_contacts", recordId: office.companyId, importId: ctx.importId, action: "CREATED" }, select: { id: true } }) : null;
      if (office && ours) {
        await tx.company.update({ where: { id: office.companyId }, data: { alsoVendor: true } });
        await log(tx, ctx, kind, zohoId, office.companyId, "LINKED");
        return linked(office.companyId, ["Also a Zoho customer (the same GSTIN): one company, a vendor as well.", owner.warning].filter(Boolean).join(" "));
      }
    }
    // The company Deskzo already has with this GSTIN or PAN, whatever it's called there: that one, no choice needed.
    const taxTwin = await companyByTaxId(tx, gst);
    if (taxTwin && "id" in taxTwin) {
      if (list === "vendors" && taxTwin.relationshipType !== "VENDOR") await tx.company.update({ where: { id: taxTwin.id }, data: { alsoVendor: true } });
      if (list === "customers" && taxTwin.relationshipType === "VENDOR") await tx.company.update({ where: { id: taxTwin.id }, data: { alsoCustomer: true } });
      await fillOwner(tx, taxTwin.id, owner);
      await log(tx, ctx, kind, zohoId, taxTwin.id, "LINKED");
      const why = taxTwin.by === "GSTIN" ? "the same GSTIN" : "the same PAN — a branch in another state";
      return linked(taxTwin.id, [`Deskzo already has it as ${taxTwin.name} (${why}); its Zoho records go to that company.`, owner.warning].filter(Boolean).join(" "));
    }
    const taxWarning = taxTwin ? `More than one Deskzo company has its ${taxTwin.many}; matched by name instead.` : undefined;
    const existing = await companyByName(tx, name);
    if (existing) {
      if (existing.madeByImport) {
        if (list === "vendors") await tx.company.update({ where: { id: existing.id }, data: { alsoVendor: true } });
        await fillOwner(tx, existing.id, owner);
        await log(tx, ctx, kind, zohoId, existing.id, "LINKED");
        return linked(existing.id, [`Another Zoho ${list === "customers" ? "customer" : "vendor"} of the same name came across already; this one's records go to that company.`, taxWarning, owner.warning].filter(Boolean).join(" "));
      }
      // This Zoho list's own choice on the preview; WroffyCRM's customers' when uploaded with them, as before.
      const decision = ctx.decisions.matches?.[kind] ?? ctx.decisions.matches?.customers;
      if (decision === "skip") return skipped(`Deskzo already has ${name}; left out as chosen.`);
      if (decision !== "link") fail(`Deskzo already has a company called ${name} — choose on the preview whether to use it.`);
      await fillOwner(tx, existing.id, owner);
      await log(tx, ctx, kind, zohoId, existing.id, "LINKED");
      return linked(existing.id, [taxWarning, owner.warning].filter(Boolean).join(" ") || undefined);
    }

    const terms = ZOHO_TERMS[clean(row["Payment Terms Label"]).toLowerCase()];
    const made = await tx.company.create({
      data: {
        name,
        normalizedName: companyKey(name),
        relationshipType: list === "customers" ? "CLIENT" : "VENDOR",
        stage: "CUSTOMER",
        website: clean(row.Website) || null,
        panNumber: gst ? gst.slice(2, 12) : null,
        ...(terms ? { paymentTerms: terms } : {}),
        ...(owner.id ? { ownerUserId: owner.id } : {}),
        createdById: ctx.actorId,
        createdAt: zohoTime(row["Created Time"]),
        customFields: fields({ currency: clean(row["Currency Code"]).toUpperCase() || null, official_email: clean(row.EmailID) || null, official_phone: clean(row.Phone) || null }),
      },
      select: { id: true },
    });
    const office = await tx.companyLocation.create({
      data: {
        companyId: made.id,
        label: "Head office",
        address: [clean(row["Billing Address"]), clean(row["Billing Street2"])].filter(Boolean).join(", ") || null,
        city: clean(row["Billing City"]) || null,
        state: stateName(row["Billing State"] ?? "", country),
        country: countryName(country),
        pincode: clean(row["Billing Code"]) || null,
        gstNumber: gst,
        gstTreatment: ZOHO_TREATMENT[clean(row["GST Treatment"]).toLowerCase()] ?? treatment(gst, country),
        isPrimary: true,
        isBilling: true,
      },
      select: { id: true },
    });
    await log(tx, ctx, kind, zohoId, made.id, "CREATED");
    await log(tx, ctx, "head-office", `${kind}:${zohoId}`, office.id, "CREATED");

    // A Zoho customer's own name, email and mobile are its primary contact — the master list's ":primary" person.
    const person = [clean(row["First Name"]), clean(row["Last Name"])].filter(Boolean).join(" ");
    const email = clean(row.EmailID) || null;
    if (person || email) {
      const contact = await tx.contact.create({
        data: { companyId: made.id, name: person || email!, email, phone: clean(row.MobilePhone) || clean(row.Phone) || null, isPrimary: true, createdByUserId: ctx.actorId },
        select: { id: true },
      });
      await log(tx, ctx, list === "customers" ? "zoho_contact_persons" : "zoho_vendor_contact_persons", `${zohoId}:primary`, contact.id, "CREATED");
    }
    return created(made.id, [taxWarning, owner.warning].filter(Boolean).join(" ") || undefined);
  };
}

const zohoItems: Handler = async (row, tx, ctx) => {
  const zohoId = clean(row["Item ID"]) || fail("No Item ID.");
  if (roundedZohoId(zohoId)) fail(`Its Item ID (${zohoId}) was rounded by a spreadsheet — upload the file as Zoho exported it.`);
  const logged = await ctx.records.get("zoho_items", zohoId);
  if (logged) return unchanged(logged.recordId);
  const name = clean(row["Item Name"]) || fail("No item name.");
  const sku = clean(row.SKU) || `${ZOHO_SKU}${zohoId.slice(-8)}`;
  const same = await tx.item.findFirst({ where: { sku: { equals: sku, mode: "insensitive" } }, select: { id: true } });
  if (same) {
    const ours = await tx.legacyImportRecord.findFirst({ where: { recordId: same.id, importId: ctx.importId }, select: { id: true } });
    if (!ours) {
      const decision = ctx.decisions.matches?.products;
      if (decision === "skip") return skipped(`Deskzo already has SKU ${sku}; left out as chosen.`);
      if (decision !== "link") fail(`Deskzo already has SKU ${sku} — choose on the preview whether to use it.`);
    }
    await log(tx, ctx, "zoho_items", zohoId, same.id, "LINKED");
    return linked(same.id);
  }
  const hsn = clean(row["HSN/SAC"]);
  const tax = money(row["Intra State Tax Rate"] ?? "");
  const made = await tx.item.create({
    data: {
      name,
      sku,
      type: itemType(row["Product Type"] ?? "", null),
      hsnCode: /^\d{4,8}$/.test(hsn) ? hsn : null,
      sellingPrice: money(row.Rate ?? "") ?? 0,
      costPrice: money(row["Purchase Rate"] ?? ""),
      taxRatePercent: tax !== null && tax >= 0 && tax <= 100 ? tax : null,
      unit: clean(row["Usage unit"]) || null,
      description: clean(row.Description).slice(0, 4000) || null,
      active: !/inactive/i.test(clean(row.Status)),
      createdById: ctx.actorId,
    },
    select: { id: true },
  });
  await log(tx, ctx, "zoho_items", zohoId, made.id, "CREATED");
  return created(made.id);
};

function zohoPeople(kind: "zoho_contact_persons" | "zoho_vendor_contact_persons"): Handler {
  const customers = kind === "zoho_contact_persons";
  return async (row, tx, ctx) => {
    const personId = clean(row["Contact Person ID"]) || fail("No Contact Person ID.");
    const logged = await ctx.records.get(kind, personId);
    if (logged) return unchanged(logged.recordId);
    const parentId = clean(row[customers ? "Customer ID" : "Vendor ID"]);
    const companyId = (await ctx.records.id(customers ? "zoho_contacts" : "zoho_vendors", parentId)) ?? fail(`Its ${customers ? "customer" : "vendor"} (${parentId}) didn't come across.`);
    const name = [clean(row["First Name"]), clean(row["Last Name"])].filter(Boolean).join(" ");
    const email = clean(row.EmailID) || null;
    const phone = clean(row.MobilePhone) || clean(row.Phone) || null;
    if (!name && !email && !phone) return skipped("No name, email or phone.");
    if (email) {
      const same = await tx.contact.findFirst({ where: { companyId, email: { equals: email, mode: "insensitive" } }, select: { id: true } });
      if (same) {
        await log(tx, ctx, kind, personId, same.id, "LINKED");
        return linked(same.id);
      }
    }
    const title = clean(row.Designation) || clean(row.Department);
    const made = await tx.contact.create({
      data: {
        companyId,
        name: name || email || phone!,
        email,
        phone,
        isPrimary: yes(row["Is Primary"]),
        designation: designationKind(title),
        designationId: await designationId(tx, ctx, clean(row.Designation)),
        createdByUserId: ctx.actorId,
        customFields: fields({ job_title: title || null }),
      },
      select: { id: true },
    });
    await log(tx, ctx, kind, personId, made.id, "CREATED");
    return created(made.id);
  };
}

/** WroffyCRM's vendor list: the Zoho vendor its pair became, else a vendor made now. */
const oldVendors: Handler = async (row, tx, ctx) => {
  const oldId = row.id!;
  if (deleted(row)) return skipped("Deleted in the old CRM.");
  const logged = await ctx.records.get("vendors", oldId);
  if (logged) return unchanged(logged.recordId);
  const twin = await zohoTwin(tx, ctx, "vendors", ["zoho_vendors"], oldId);
  if (twin) {
    if (twin.ours) {
      const current = await tx.company.findUniqueOrThrow({ where: { id: twin.recordId }, select: { companyType: true, website: true, customFields: true } });
      const custom = fields({ cin: clean(row.cin_no).toUpperCase() || null, official_email: clean(row.official_email) || null });
      await tx.company.update({ where: { id: twin.recordId }, data: { ...blanksOnly(current, { companyType: await companyTypeKey(tx, ctx, row.company_type), website: clean(row.website) || null }), customFields: { ...custom, ...((current.customFields ?? {}) as object) } } });
    }
    await log(tx, ctx, "vendors", oldId, twin.recordId, "LINKED");
    return linked(twin.recordId);
  }
  const name = nameOrStandIn(row, "vendor", oldId);
  const existing = await companyByName(tx, name);
  if (existing) {
    if (!existing.madeByImport) {
      const decision = ctx.decisions.matches?.customers;
      if (decision === "skip") return skipped(`Deskzo already has ${name}; left out as chosen.`);
      if (decision !== "link") fail(`Deskzo already has a company called ${name} — choose on the preview whether to use it.`);
    }
    await log(tx, ctx, "vendors", oldId, existing.id, "LINKED");
    return linked(existing.id);
  }
  const gst = gstOf(row.gst_no ?? "");
  const made = await tx.company.create({
    data: { name, normalizedName: companyKey(name), relationshipType: "VENDOR", stage: "CUSTOMER", companyType: await companyTypeKey(tx, ctx, row.company_type), website: clean(row.website) || null, panNumber: gst ? gst.slice(2, 12) : clean(row.pan_no).toUpperCase() || null, createdById: await userOf(ctx, row.created_by), createdAt: oldInstant(row.createdAt!) ?? undefined, customFields: fields({ oldcrm_id: oldId, cin: clean(row.cin_no).toUpperCase() || null, official_email: clean(row.official_email) || null }) },
    select: { id: true },
  });
  const office = await headOffice(tx, made.id, row);
  await log(tx, ctx, "vendors", oldId, made.id, "CREATED");
  await log(tx, ctx, "head-office", `vendors:${oldId}`, office.id, "CREATED");
  return created(made.id);
};

const HANDLERS: Partial<Record<KindKey | "customer_product_links", Handler>> = {
  users,
  zoho_items: zohoItems,
  products,
  zoho_contacts: zohoCompanies("customers"),
  zoho_vendors: zohoCompanies("vendors"),
  vendors: oldVendors,
  zoho_contact_persons: zohoPeople("zoho_contact_persons"),
  zoho_vendor_contact_persons: zohoPeople("zoho_vendor_contact_persons"),
  customers,
  billing_addresses: addressHandler("billing_addresses"),
  shipping_addresses: addressHandler("shipping_addresses"),
  employees: contactsFromEmployees,
  profilings,
  leads,
  lead_product: leadProducts,
  customer_product: customerProducts,
  customer_product_links: customerProductLinks,
  product_tickets: ticketHandler("product_tickets"),
  anonymous_tickets: ticketHandler("anonymous_tickets"),
  replies,
  field_visits: visits,
  call_logs: calls,
};
