import { Prisma } from "@prisma/client";
import { recordAudit } from "@/lib/audit";
import { runBackup } from "@/lib/backup/run";
import { links } from "@/lib/companies/merge";
import { normalizeCompanyName } from "@/lib/company-name";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { companyKeyOf, matchOldProposals, OldProposalsRefused, openPrepared } from "./preview";
import { yearLabel } from "./read";

/**
 * Bringing the Excel proposals in, and taking them back (owner, 25 Nov 2026). Started, it matches again exactly as the
 * preview did, with what was decided for those that needed a look, takes a full backup — no backup, no import — and keeps
 * the plan. Then the page calls `importPart` until it says done: a hundred or so a call, each proposal its own transaction
 * with its key, so stopped anywhere it carries on and nothing comes in twice.
 *
 *   · A proposal goes to its company's Earlier years. Not a document, a lead, or anything in the books; no notification,
 *     no workflow, no mail.
 *   · A company made is a prospect, tagged "Old proposals", dated when its first proposal was, owned by nobody.
 *   · Its contact is added only where nobody there has that address; one said to have left is marked so.
 *
 * Undo takes back the proposals, and each company and contact made that nothing in Deskzo has been built on since.
 */

export const OLD_PROPOSALS_TAG = "Old proposals";
/** For a proposal that needed a look: the company suggested, a company of its own, or not now. */
export type Decision = "SUGGESTED" | "NEW" | "LATER";
export type Plan = Record<string, { to: string } | { make: string }>;
export type ImportProgress = { at: number; total: number; proposals: number; companies: number; contacts: number; failed: { key: string; company: string; why: string }[]; kept?: number };
export type ImportView = { id: string; status: string; createdAt: string; finishedAt: string | null; undoneAt: string | null; progress: ImportProgress; files: number; filesWanted: number };

const empty = (total = 0): ImportProgress => ({ at: 0, total, proposals: 0, companies: 0, contacts: 0, failed: [] });
const progressOf = (p: unknown): ImportProgress => ({ ...empty(), ...((p ?? {}) as Partial<ImportProgress>) });

/** Whether the workspace has the tables yet. */
export async function oldProposalsReady(): Promise<boolean> {
  try {
    await db.oldProposalImport.count();
    await db.oldProposal.findFirst({ select: { attachments: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

export async function startOldProposals(bytes: Buffer, decisions: Record<string, Decision>, userId: string): Promise<string> {
  if (!(await oldProposalsReady())) throw new OldProposalsRefused("This workspace's database is still to be updated for this. Try again after the next update.");
  if (await db.oldProposalImport.findFirst({ where: { status: "IMPORTING" }, select: { id: true } })) throw new OldProposalsRefused("An import of old proposals is going already. Let it finish first.");
  const file = openPrepared(bytes);
  const ids = new Map<string, string>();
  const preview = await matchOldProposals(file, ids);
  const plan: Plan = {};
  for (const r of preview.rows) {
    if (r.outcome === "HERE") continue;
    const to = ids.get(r.key);
    if (r.outcome === "BRING" && to) plan[r.key] = { to };
    else if (r.outcome === "CREATE") plan[r.key] = { make: r.company };
    else if (r.outcome === "LOOK") {
      const decided = decisions[r.key];
      if (decided === "SUGGESTED" && to) plan[r.key] = { to };
      else if (decided === "NEW") plan[r.key] = { make: r.company };
    }
  }
  const total = Object.keys(plan).length;
  if (total === 0) throw new OldProposalsRefused("There's nothing to bring in: each is here already, or waits for a decision.");
  const backup = await runBackup({ kind: "FULL", triggeredById: userId, reason: "Before bringing in the old proposals", keepUntil: new Date(Date.now() + 30 * 86_400_000) });
  if (!backup.ok) throw new OldProposalsRefused(`The safety backup couldn't be taken, so nothing was brought in: ${backup.error ?? "unknown error"}`);
  const made = await db.oldProposalImport.create({ data: { source: new Uint8Array(bytes), plan: plan as Prisma.InputJsonValue, progress: empty(total) as unknown as Prisma.InputJsonValue, backupId: backup.id, createdById: userId }, select: { id: true } });
  await recordAudit({ userId, action: "CREATE", entityType: "OldProposalImport", entityId: made.id, entityLabel: `Started bringing in ${total.toLocaleString("en-IN")} old proposals; backup taken first` });
  return made.id;
}

type Tx = Prisma.TransactionClient;

/** The company to put a proposal on, made if the plan says and no run has made it yet. */
async function companyFor(tx: Tx, importId: string, step: Plan[string], p: { company: string; address: string; date: string | null }, actor: string): Promise<{ id: string; made: boolean }> {
  if ("to" in step) {
    if (await tx.company.findUnique({ where: { id: step.to }, select: { id: true } })) return { id: step.to, made: false };
    // Merged into another since the preview: the company it became.
    const merge = await tx.companyMerge.findUnique({ where: { fromCompanyId: step.to }, select: { intoCompanyId: true } });
    if (merge) return { id: merge.intoCompanyId, made: false };
    throw new OldProposalsRefused("Its company isn't in Deskzo any more");
  }
  const name = step.make.replace(/\s+/g, " ").trim().slice(0, 200);
  const same = await tx.company.findUnique({ where: { normalizedName: normalizeCompanyName(name) }, select: { id: true } });
  if (same) return { id: same.id, made: false };
  // One this tool made for another proposal of theirs, its name spaced or ended otherwise.
  const key = companyKeyOf(name);
  const earlier = await tx.$queryRaw<{ id: string; name: string }[]>`select c."id", c."name" from "old_proposal_made" m join "companies" c on c."id" = m."recordId" where m."kind" = 'COMPANY' and lower(left(c."name", 1)) = ${name.slice(0, 1).toLowerCase()}`;
  const twin = earlier.find((c) => companyKeyOf(c.name) === key);
  if (twin) return { id: twin.id, made: false };
  const made = await tx.company.create({
    data: { name, normalizedName: normalizeCompanyName(name), relationshipType: "CLIENT", stage: "PROSPECT", tags: [OLD_PROPOSALS_TAG], createdById: actor, ...(p.date ? { createdAt: new Date(`${p.date}T06:30:00Z`) } : {}) },
    select: { id: true },
  });
  await tx.oldProposalMade.create({ data: { importId, kind: "COMPANY", recordId: made.id } });
  if (p.address) {
    const place = await tx.companyLocation.create({ data: { companyId: made.id, label: "Head office", address: p.address.slice(0, 500), isPrimary: true }, select: { id: true } });
    await tx.oldProposalMade.create({ data: { importId, kind: "LOCATION", recordId: place.id } });
  }
  return { id: made.id, made: true };
}

/** Works an import forward for up to `budgetMs`. */
export async function importPart(importId: string, userId: string, budgetMs = 8000): Promise<ImportView> {
  const run = await db.oldProposalImport.findUnique({ where: { id: importId }, select: { status: true, source: true, plan: true, progress: true } });
  if (!run) throw new OldProposalsRefused("That import isn't there.");
  if (run.status !== "IMPORTING") return viewOf(importId);
  // One step at a time: two tabs on one import would each make the same company.
  const until = new Date(Date.now() + budgetMs + 60_000).toISOString();
  const claimed = await db.$executeRaw`update "old_proposal_imports" set "progress" = jsonb_set("progress", '{lease}', to_jsonb(${until}::text)) where "id" = ${importId} and coalesce("progress"->>'lease', '') < ${new Date().toISOString()}`;
  if (claimed === 0) return viewOf(importId);
  const progress = progressOf((await db.oldProposalImport.findUniqueOrThrow({ where: { id: importId }, select: { progress: true } })).progress);
  const plan = run.plan as unknown as Plan;
  const rows = openPrepared(Buffer.from(run.source)).proposals.filter((p) => plan[p.key]);
  const started = Date.now();
  while (progress.at < rows.length && Date.now() - started < budgetMs) {
    const p = rows[progress.at]!;
    try {
      const done = await db.$transaction(async (tx) => {
        if (await tx.oldProposal.findUnique({ where: { key: p.key }, select: { id: true } })) return null;
        const company = await companyFor(tx, importId, plan[p.key]!, p, userId);
        await tx.oldProposal.create({
          data: {
            importId,
            key: p.key,
            companyId: company.id,
            ref: p.ref,
            year: yearLabel(p.year),
            date: p.date ? new Date(`${p.date}T00:00:00Z`) : null,
            status: p.status,
            product: p.product,
            madeBy: p.madeBy,
            madeFor: p.company,
            contact: [p.contact, p.phone, p.email].filter(Boolean).join(" · "),
            remarks: p.remarks,
            total: p.total === null || Math.abs(p.total) >= 1e12 ? null : new Prisma.Decimal(p.total),
            lines: p.lines as unknown as Prisma.InputJsonValue,
            paths: p.files,
            attachments: p.attachments,
          },
        });
        let contact = false;
        const email = p.email.trim().toLowerCase();
        if (email && !(await tx.contact.findFirst({ where: { companyId: company.id, email: { equals: email, mode: "insensitive" } }, select: { id: true } }))) {
          const added = await tx.contact.create({ data: { companyId: company.id, name: (p.contact || email.split("@")[0]!).slice(0, 120), email, phone: p.phone || null, createdByUserId: userId, ...(p.left ? { leftAt: new Date() } : {}) }, select: { id: true } });
          await tx.oldProposalMade.create({ data: { importId, kind: "CONTACT", recordId: added.id } });
          contact = true;
        }
        return { made: company.made, contact };
      });
      if (done) {
        progress.proposals += 1;
        if (done.made) progress.companies += 1;
        if (done.contact) progress.contacts += 1;
      }
    } catch (err) {
      const why = err instanceof OldProposalsRefused ? err.message : err instanceof Prisma.PrismaClientKnownRequestError ? `Couldn't be saved (${err.code})` : null;
      if (why === null) {
        await save(importId, "IMPORTING", progress);
        throw err;
      }
      progress.failed.push({ key: p.key, company: p.company, why });
    }
    progress.at += 1;
  }
  const done = progress.at >= rows.length;
  await save(importId, done ? "DONE" : "IMPORTING", progress, done ? { finishedAt: new Date() } : {});
  if (done) await recordAudit({ userId, action: "UPDATE", entityType: "OldProposalImport", entityId: importId, entityLabel: `Brought in ${progress.proposals.toLocaleString("en-IN")} old proposals: ${progress.companies.toLocaleString("en-IN")} companies and ${progress.contacts.toLocaleString("en-IN")} contacts made${progress.failed.length ? `, ${progress.failed.length} not brought` : ""}` });
  return viewOf(importId);
}

/** Written without its lease, so the next step can take it. */
const save = (id: string, status: string, progress: ImportProgress, extra: { finishedAt?: Date; undoneAt?: Date; undoneById?: string } = {}) =>
  db.oldProposalImport.update({ where: { id }, data: { status, progress: { ...progress, lease: undefined } as unknown as Prisma.InputJsonValue, ...extra }, select: { id: true } });

export async function viewOf(importId: string): Promise<ImportView> {
  const r = await db.oldProposalImport.findUnique({ where: { id: importId }, select: { id: true, status: true, createdAt: true, finishedAt: true, undoneAt: true, progress: true } });
  if (!r) throw new OldProposalsRefused("That import isn't there.");
  const [files, latest, papers] = await Promise.all([
    db.oldProposalFile.count({ where: { proposal: { importId } } }),
    db.oldProposal.count({ where: { importId, NOT: { paths: { isEmpty: true } } } }),
    db.oldProposal.findMany({ where: { importId, NOT: { attachments: { isEmpty: true } } }, select: { attachments: true } }),
  ]);
  const filesWanted = latest + papers.reduce((t, p) => t + p.attachments.length, 0);
  return { id: r.id, status: r.status, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, undoneAt: r.undoneAt?.toISOString() ?? null, progress: progressOf(r.progress), files, filesWanted };
}

export async function oldProposalImports(): Promise<ImportView[]> {
  const rows = await db.oldProposalImport.findMany({ orderBy: { createdAt: "desc" }, take: 20, select: { id: true } });
  return Promise.all(rows.map((r) => viewOf(r.id)));
}

/** Rows elsewhere that point at any of these, by the database's own foreign keys — whatever table they are in. */
async function pointedAt(target: "company" | "contact", ids: string[], except: ReadonlySet<string>): Promise<Set<string>> {
  const used = new Set<string>();
  if (!ids.length) return used;
  for (const l of (await links())[target]) {
    // Names from the schema itself, never from anybody's typing.
    const table = Prisma.dmmf.datamodel.models.find((m) => m.name === l.model)?.dbName ?? l.model;
    if (except.has(table)) continue;
    const t = Prisma.raw(`"${table}"`);
    const c = Prisma.raw(`"${l.field}"`);
    for (const r of await db.$queryRaw<{ id: string }[]>(Prisma.sql`select distinct ${c} as id from ${t} where ${c} = any(${ids})`)) used.add(r.id);
  }
  return used;
}

/** Takes an import back, a part at a time. */
export async function undoPart(importId: string, userId: string): Promise<{ done: boolean; left: number; kept: number }> {
  const run = await db.oldProposalImport.findUnique({ where: { id: importId }, select: { status: true, progress: true } });
  if (!run) throw new OldProposalsRefused("That import isn't there.");
  if (run.status === "UNDONE") throw new OldProposalsRefused("It has been undone already.");
  const progress = progressOf(run.progress);
  // Stops an import still going; what it made is taken back.
  if (run.status === "IMPORTING") await save(importId, "FAILED", progress);
  const some = await db.oldProposal.findMany({ where: { importId }, take: 500, select: { id: true } });
  if (some.length) {
    await db.oldProposal.deleteMany({ where: { id: { in: some.map((s) => s.id) } } });
    return { done: false, left: await db.oldProposal.count({ where: { importId } }), kept: 0 };
  }
  const made = async (kind: string) => (await db.oldProposalMade.findMany({ where: { importId, kind }, select: { recordId: true } })).map((m) => m.recordId);
  const contacts = await made("CONTACT");
  const usedContacts = await pointedAt("contact", contacts, new Set());
  const goContacts = contacts.filter((id) => !usedContacts.has(id));
  for (let i = 0; i < goContacts.length; i += 500) await db.contact.deleteMany({ where: { id: { in: goContacts.slice(i, i + 500) } } });
  const companies = await made("COMPANY");
  const own = new Set(await made("LOCATION"));
  // Its own address goes with it; another, or anybody at it, or a lead, a call, a note — anything at all — keeps it.
  const used = await pointedAt("company", companies, new Set(["company_locations", "domain_profiles"]));
  for (let i = 0; i < companies.length; i += 1000) {
    for (const l of await db.companyLocation.findMany({ where: { companyId: { in: companies.slice(i, i + 1000) } }, select: { id: true, companyId: true } })) if (!own.has(l.id)) used.add(l.companyId);
  }
  const go = companies.filter((id) => !used.has(id));
  let kept = companies.length - go.length;
  for (const id of go) {
    try {
      await db.company.delete({ where: { id }, select: { id: true } });
    } catch (err) {
      // Something without a foreign key's leave: it stays.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError)) throw err;
      if (err.code !== "P2025") kept += 1;
    }
  }
  kept += contacts.length - goContacts.length;
  await save(importId, "UNDONE", { ...progress, kept }, { undoneAt: new Date(), undoneById: userId });
  await recordAudit({ userId, action: "DELETE", entityType: "OldProposalImport", entityId: importId, entityLabel: `Took back the old proposals brought in: ${go.length.toLocaleString("en-IN")} companies and ${goContacts.length.toLocaleString("en-IN")} contacts it made went; ${kept} kept, built on since` });
  return { done: true, left: 0, kept };
}

/**
 * Moves one proposal, with its files, to the company it was for (owner, 25 Nov 2026): one that came in by an address or a
 * domain can be on the wrong one. To a company here, or — `to` null — one of its own name, made if it isn't here.
 *
 * The contact the import added for it goes too, unless another old proposal there names it or anything has been built on
 * it; where the other company has that address already, it goes. Somebody who was there before the import never moves.
 */
export async function moveOldProposal(proposalId: string, to: string | null, userId: string): Promise<{ seq: number; name: string; contact: boolean }> {
  const p = await db.oldProposal.findUnique({ where: { id: proposalId }, select: { id: true, importId: true, companyId: true, ref: true, madeFor: true, contact: true, date: true, company: { select: { name: true } } } });
  if (!p) throw new OldProposalsRefused("That proposal isn't there any more.");
  const email = /[^\s·]+@[^\s·]+/.exec(p.contact)?.[0]?.toLowerCase() ?? "";
  const added = email ? await db.contact.findFirst({ where: { companyId: p.companyId, email: { equals: email, mode: "insensitive" } }, select: { id: true } }) : null;
  const ours = added && (await db.oldProposalMade.count({ where: { kind: "CONTACT", recordId: added.id } })) > 0;
  const others = ours ? await db.oldProposal.count({ where: { companyId: p.companyId, id: { not: p.id }, contact: { contains: email, mode: "insensitive" } } }) : 0;
  const free = ours && others === 0 && !(await pointedAt("contact", [added.id], new Set())).has(added.id) ? added.id : null;
  const done = await db.$transaction(async (tx) => {
    const company = to === null ? await companyFor(tx, p.importId, { make: p.madeFor }, { company: p.madeFor, address: "", date: p.date?.toISOString().slice(0, 10) ?? null }, userId) : await companyFor(tx, p.importId, { to }, { company: p.madeFor, address: "", date: null }, userId);
    if (company.id === p.companyId) throw new OldProposalsRefused(to === null ? `"${p.madeFor}" is this company. Choose the one it belongs to.` : "It's on that company already.");
    // Where it was when it was looked at: somebody else may have moved it since.
    const moved = await tx.oldProposal.updateMany({ where: { id: p.id, companyId: p.companyId }, data: { companyId: company.id } });
    if (moved.count === 0) throw new OldProposalsRefused("It has been moved already. Reload the page.");
    if (free) {
      if (await tx.contact.findFirst({ where: { companyId: company.id, email: { equals: email, mode: "insensitive" } }, select: { id: true } })) {
        await tx.contact.delete({ where: { id: free }, select: { id: true } });
        await tx.oldProposalMade.deleteMany({ where: { kind: "CONTACT", recordId: free } });
      } else await tx.contact.update({ where: { id: free }, data: { companyId: company.id, isPrimary: false }, select: { id: true } });
    }
    return tx.company.findUniqueOrThrow({ where: { id: company.id }, select: { id: true, companySeq: true, name: true } });
  });
  await recordAudit({ userId, action: "UPDATE", entityType: "OldProposal", entityId: p.id, entityLabel: `Moved old proposal ${p.ref || p.madeFor} from ${p.company.name} to ${done.name}` });
  return { seq: done.companySeq, name: done.name, contact: free !== null };
}

// ─── On the company ──────────────────────────────────────────────────────────────────────────────

export const companyHasOldProposals = async (companyId: string): Promise<boolean> => (await db.oldProposal.count({ where: { companyId } }).catch((err: unknown) => (notMigratedYet(err) ? 0 : Promise.reject(err)))) > 0;

export async function companyOldProposals(companyId: string) {
  try {
    return await db.oldProposal.findMany({
      where: { companyId },
      orderBy: [{ date: { sort: "desc", nulls: "last" } }, { ref: "desc" }],
      select: { id: true, ref: true, year: true, date: true, status: true, product: true, madeBy: true, madeFor: true, contact: true, remarks: true, total: true, lines: true, files: { select: { id: true, name: true, path: true } } },
    });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}
