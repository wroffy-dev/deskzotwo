/**
 * check:masking-guard — a read of a masked value outside the modules that mask it fails here (owner, 5 Nov 2026 —
 * Phase 3 masking fixes; DESKZO_PERMISSION_SYSTEM_AUDIT.md H.4.3, "a guard against the next bypass").
 *
 * Field masking only works where a value goes through a presenter (src/lib/leads/masking.ts, src/lib/contacts/masking.ts)
 * on its way out. Every bypass the audit listed (C.2) was a read that didn't: a page, an export or an API that read a
 * contact's email or a lead's title straight from Prisma and sent it on. This finds every such read, so the next one
 * is a decision somebody writes down rather than a leak nobody notices.
 *
 * Static, with the TypeScript compiler (parsing only — no type checker, no database, a few seconds):
 *
 *   · The watched columns: a contact's `email` and `phone`; a lead's own masked columns — `title`, `description`,
 *     `source`, `sourceDetail` and `customFields` (the `custom:*` fields); and a company's — its locations' address
 *     parts and GSTIN, its PAN, website and `customFields` (src/lib/companies/masking.ts). Names are not watched: a
 *     contact's or a company's name is how every module labels the record, and is shown as such everywhere.
 *   · A read is a Prisma call (`<client>.<model>.findMany/findFirst/findUnique(OrThrow)/groupBy`, and a write's own
 *     `select`/`include`, which it returns) that reaches a watched column: by `select`, by `include` of the relation
 *     (all its columns), by reading the model with no `select` at all (all its columns, less what `omit` says), or by
 *     `groupBy` on it — through nested relations, from prisma/schema.prisma. Select objects are followed through
 *     constants, spreads, `as const`/`satisfies`, conditionals, local functions that build them, and named imports
 *     of either. Anything else is taken to read everything (a `select` from a parameter, `want.has(…)` for a value).
 *     A plain write (`create`/`update` with no `select`/`include`) is not a read: what it returns isn't shown.
 *   · Raw SQL (`$queryRaw…`) naming the contacts table with its email or phone, or the leads table with a watched
 *     column, is a read too.
 *   · Each file with a read must be in ALLOWED — a presenter, or a module whose reads are known never to reach a
 *     person unmasked, each with why — or in KNOWN_GAPS: real unmasked reads, with what each leaks, until fixed.
 *     A new reading file fails the check; so does an entry that no longer reads anything (take it out).
 *
 * Coverage, not a proof: a module in ALLOWED is trusted for every read in it, and what it does with a value is
 * checked by the behaviour checks (check:field-access, check:contact-masking and the per-screen ones).
 *
 *   npm run check:masking-guard            (`-- --list` prints every read, file:line and the columns it reaches)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const rel = (full: string) => path.relative(ROOT, full).split(path.sep).join("/");

// ─── What is watched ─────────────────────────────────────────────────────────────────────────────

/** Model → its masked columns (src/lib/authz/field-policy.ts SENSITIVE_FIELDS, by where each value is stored). */
const WATCHED: Record<string, string[]> = {
  Contact: ["email", "phone"],
  Lead: ["title", "description", "source", "sourceDetail", "customFields"],
  // Company masking joined in the same wave (owner, 5 Nov 2026 — src/lib/companies/masking.ts): a location's "address"
  // rule covers its street, city, state and PIN code, "gstin" its GST number; "pan", "website" and `custom:*` the company's.
  CompanyLocation: ["address", "city", "state", "pincode", "gstNumber"],
  Company: ["panNumber", "website", "customFields"],
};

/** The presenters themselves: where a watched value is meant to be read and turned into what one person may see. */
const PRESENTERS = ["src/lib/leads/masking.ts", "src/lib/contacts/masking.ts", "src/lib/companies/masking.ts"];

// ─── The tables ──────────────────────────────────────────────────────────────────────────────────
// Keyed by file, sorted. One line each.

/** Files that read a watched column and are right to: why — what masks the value, or why it never reaches a person. */
const ALLOWED: Record<string, string> = {
  "src/actions/addon-proposal.ts":
    "a proposal raised from an add-on quote: a trade document's party address, GSTIN and PAN — out of field masking's reach by decision: a document is the workspace's own legal record, printed as issued (src/lib/companies/masking.ts)",
  "src/actions/calendar.ts": "meetings name their lead as a list does (`maskLeadTitle`, list answers)",
  "src/actions/call.ts":
    "the dialler's numbers through `maskContactRows` (a masked number is dialled by the server, `dialledNumber`); calls name their lead through `leadsSeenBy`",
  "src/actions/chat.ts": "a lead's card in a chat through `maskLead` with the list answers",
  "src/actions/commission-party.ts": "reads the company it links or creates a commission party for, to write it; returns only the party's id",
  "src/actions/company-location.ts": "a location read to check its reach and to delete it; a saved form keeps the hidden parts (`keepHiddenLocationParts`)",
  "src/actions/company.ts":
    "the company lists and page through `maskCompanyRows`/`companyMasker` and their contacts through `maskContactRows` (Agent J, this wave); the other reads load a row to write it",
  "src/actions/contact.ts": "the Contacts list through `maskContactRows` (`redactList`); its search skips masked details (`maskedInLists`)",
  "src/actions/dashboard.ts": "the dashboard's leads through `maskLeads` with the list answers",
  "src/actions/document-lead.ts": "a party's leads, for a document, through `maskLeads`",
  "src/actions/expense.ts": "claims name their lead through `leadsSeenBy`",
  "src/actions/forecast.ts": "the forecast's leads through `maskLeads`",
  "src/actions/mail-log.ts":
    "a contact recipient's address, number and name, and the message's own words about them, through the contacts presenter (`maskRecipient`); its search skips a masked address",
  "src/actions/marketing-subscribers.ts": "a contact's email read to suppress it on the server; nothing of it is returned",
  "src/actions/note.ts": "notes name their lead through `leadsSeenBy`",
  "src/actions/order-punch.ts": "the punch form's proposals name their lead through `maskLeadRefs`",
  "src/actions/order.ts":
    "proposal options name their lead through `maskLeadRefs`; creating, approving, processing and fulfilling an order read its company and location to write it",
  "src/actions/payment.ts": "recording a payment reads its company to write it; returns the payment",
  "src/actions/quick-lead.ts": "a typed number or email matched against one company's people on the server; returns only the contact's id",
  "src/actions/renewal-proposal.ts":
    "a proposal raised from a renewal: a trade document's party address, GSTIN and PAN — out of field masking's reach by decision: a document is the workspace's own legal record, printed as issued (src/lib/companies/masking.ts)",
  "src/actions/super-admin-delete.ts": "the super admin's alone, who sees every field in the clear: the lead's title names it in the audit log",
  "src/actions/task-extras.ts": "a task's panel names its lead through `leadsSeenBy`",
  "src/actions/task.ts": "tasks name their lead through `leadsSeenBy`",
  "src/actions/tax-reports.ts":
    "statutory returns and statements (GSTR, TDS, MSME interest) name each party's PAN, GSTIN and address as filed — the books, out of field masking's reach as trade documents are",
  "src/actions/trade-document.ts":
    "the document form's party locations and e-invoicing: a trade document's party address, GSTIN and PAN — out of field masking's reach by decision: a document is the workspace's own legal record, printed as issued (src/lib/companies/masking.ts)",
  "src/actions/unmask-log.ts": "the super admin's Unmasking log, who sees every field in the clear",
  "src/app/(dashboard)/receivables/msme/[id]/page.tsx":
    "statutory returns and statements (GSTR, TDS, MSME interest) name each party's PAN, GSTIN and address as filed — the books, out of field masking's reach as trade documents are",
  "src/app/api/contacts/[id]/whatsapp/route.ts":
    "the owner's design (3 Nov 2026, its header): a masked number leaves only in the redirect to WhatsApp, which shows it — never listed or exported; refused for a restricted number",
  "src/lib/activity/timeline.ts":
    "a lead's own feed through its page's redactor; a customer's and a person's feed through the contacts presenter and the list redactor (owner, 5 Nov 2026); locations read only to redact",
  "src/lib/analytics/sources.ts":
    "report rows through `maskLeads`/the list masker and `companiesAsListed` before any dimension reads them; only dimension values and measures leave",
  "src/lib/api/v1/companies.ts": "API v1 companies through `companyMasker` (Agent J, this wave)",
  "src/lib/app/match.ts": "an incoming number matched to the contact it is, on the server; the phone already has the number",
  "src/lib/automate/actions/lead-assign.ts":
    "server-side automation, as the workflow's owner: the step's run data is shown summarised, only to who may see the owner's (`seesStepData`)",
  "src/lib/automate/actions/lead-note.ts": "server-side automation, as the workflow's owner: the note goes on the lead itself",
  "src/lib/automate/actions/record-get.ts": "server-side automation: the lead read as its owner sees it (`detailLeadMasker`)",
  "src/lib/automate/dates.ts": "server-side: date events for workflows, run as their owner",
  "src/lib/automate/emit-leads.ts": "server-side: a lead's facts for workflow events, run as their owner (but see KNOWN_GAPS samples.ts)",
  "src/lib/calendar/invitees.ts": "screens addresses somebody typed; a verdict names a contact who left (name, company), never a stored address",
  "src/lib/collect/charge.ts":
    "an interest charge's draft: a trade document's party address, GSTIN and PAN — out of field masking's reach by decision: a document is the workspace's own legal record, printed as issued (src/lib/companies/masking.ts)",
  "src/lib/collect/links.ts": "the payer's email and phone handed to the payment gateway for a pay link, on the server",
  "src/lib/contacts/masking.ts": "the contacts presenter; `dialledNumber` reads the number the server dials",
  "src/lib/dashboard/data.ts": "the dashboard's leads through `maskLeads`; leads by source are counts, never one lead's value",
  "src/lib/documents/create-draft.ts":
    "a document's draft: a trade document's party address, GSTIN and PAN — out of field masking's reach by decision: a document is the workspace's own legal record, printed as issued (src/lib/companies/masking.ts)",
  "src/lib/documents/load.ts":
    "a document's page: a trade document's party address, GSTIN and PAN — out of field masking's reach by decision: a document is the workspace's own legal record, printed as issued (src/lib/companies/masking.ts); it names its lead through `leadsSeenBy`",
  "src/lib/inbox/server.ts":
    "a visitor's number matched to a contact on the server; a linked conversation's number and email through the contacts presenter (`customerAsSeen`)",
  "src/lib/leads/assign.ts": "assignment rules read a lead's source and place on the server",
  "src/lib/leads/masking.ts": "the leads presenter: reads each lead's values to mask and redact them",
  "src/lib/leads/response.ts": "the response-time sweep, on the server",
  "src/lib/leads/score-store.ts": "lead scoring, on the server",
  "src/lib/leads/stage-move.ts": "a stage move reads the lead to write it",
  "src/lib/legacy-import/analyse.ts": "the super admin's legacy import, matching on the server",
  "src/lib/legacy-import/apply.ts": "the super admin's legacy import, writing on the server",
  "src/lib/marketing/double-opt-in.ts": "the confirmation goes to the contact's own address, and its page is theirs",
  "src/lib/marketing/engagement-tasks.ts": "a click becomes a task on the lead; the title isn't used",
  "src/lib/marketing/enrol.ts": "a journey's merge values, in its email to the customer themselves",
  "src/lib/marketing/list-import.ts": "a marketing list import, matching addresses on the server",
  "src/lib/marketing/pipeline.ts": "who a message goes to, worked out on the server to send it (eligibility, suppression)",
  "src/lib/marketing/unsubscribe.ts": "the public preference page: a contact's own token shows them their own address",
  "src/lib/migration/ledger.ts": "the ledger migration's state code, on the server",
  "src/lib/orders/invoice-draft.ts":
    "an invoice draft from orders: a trade document's party address, GSTIN and PAN — out of field masking's reach by decision: a document is the workspace's own legal record, printed as issued (src/lib/companies/masking.ts)",
  "src/lib/orders/vendor-po.ts":
    "a vendor purchase order: a trade document's party address, GSTIN and PAN — out of field masking's reach by decision: a document is the workspace's own legal record, printed as issued (src/lib/companies/masking.ts)",
  "src/lib/pipeline/carry-on.ts": "a won lead carried on into the next pipeline: copied on the server",
  "src/lib/portability/documents.ts":
    "the documents import: a trade document's party address, GSTIN and PAN — out of field masking's reach by decision: a document is the workspace's own legal record, printed as issued (src/lib/companies/masking.ts)",
  "src/lib/portability/export.ts": "the account bundle through `maskLeads`, `maskContactRows` and `companyMasker`",
  "src/lib/portability/exporters/crm.ts": "the contacts and parties exports through `maskContactRows` and `companyMasker`",
  "src/lib/portability/exporters/leads.ts":
    "the leads export through the list masker, the contacts presenter and the lead redactor; locations read only to redact",
  "src/lib/portability/importers/companies.ts": "the companies import reads to compare and write; a masked cell is left alone (`companyMasker`)",
  "src/lib/portability/importers/contacts.ts": "the contacts import reads to compare and write; a masked cell is left alone",
  "src/lib/portability/importers/leads.ts": "the leads import reads to compare and write; a cell masked by the lead's rules is left alone",
  "src/lib/reconcile/data.ts": "a vendor statement matched against what was sold, by website, on the server",
  "src/lib/recurring-billing/run.ts":
    "recurring billing's invoices: a trade document's party address, GSTIN and PAN — out of field masking's reach by decision: a document is the workspace's own legal record, printed as issued (src/lib/companies/masking.ts)",
  "src/lib/statements/print-data.ts":
    "statutory returns and statements (GSTR, TDS, MSME interest) name each party's PAN, GSTIN and address as filed — the books, out of field masking's reach as trade documents are",
  "src/lib/support-mail/domain-match.ts": "an incoming sender's domain matched to companies on the server; returns the companies",
  "src/lib/support-mail/receive.ts": "an incoming email matched to its ticket's contact on the server",
  "src/lib/tds/challans.ts":
    "statutory returns and statements (GSTR, TDS, MSME interest) name each party's PAN, GSTIN and address as filed — the books, out of field masking's reach as trade documents are",
  "src/lib/tds/form140.ts":
    "statutory returns and statements (GSTR, TDS, MSME interest) name each party's PAN, GSTIN and address as filed — the books, out of field masking's reach as trade documents are",
  "src/lib/tds/vendor.ts":
    "statutory returns and statements (GSTR, TDS, MSME interest) name each party's PAN, GSTIN and address as filed — the books, out of field masking's reach as trade documents are",
  "src/lib/ticket-open.ts": "a new ticket's company and contact read to check it, on the server",
  "src/lib/wins/detect.ts": "a won deal becomes a celebration; each is masked for whoever looks (`maskDealWins`)",
  "src/actions/calling-activity.ts": "the cold-calling queue goes out through maskContactRows and maskCompanyWith (Phase 3 wave B); masked numbers dial by contact id",
  "src/actions/company-merge.ts": "duplicates are found on real values on the server; what is shown goes through the presenters, and the merge preview through planMerge's viewer (Phase 3 wave B)",
  "src/actions/consignment.ts": "deliveriesAsSeen masks the destination and the recipient (Phase 3 wave B); the delivery challan is a document",
  "src/actions/domain-check.ts": "a ticket's domain panel offers no domain taken from a masked website or contact email (Phase 3 wave B)",
  "src/actions/domain.ts": "domain profiles and briefings mask the website and redact the domain where quoted (src/lib/domain-intel/masking.ts, Phase 3 wave B)",
  "src/actions/email-builder-tools.ts": "the test picker and a contact-filled test go through the contacts presenter; a search skips masked addresses (Phase 3 wave B)",
  "src/actions/email-verification.ts": "Bad emails through maskContactRows; a masked address's finding is returned blank (Phase 3 wave B)",
  "src/actions/feedback.ts": "requests and the request form's contacts through the contacts presenter, the sent-to snapshot too (Phase 3 wave B)",
  "src/actions/forms.ts": "invitee search, invitations and the Invite dialog through the contacts presenter; sends use real addresses on the server (Phase 3 wave B)",
  "src/actions/it-asset.ts": "placedAsSeen masks location city and state on every asset read (Phase 3 wave B)",
  "src/actions/lead-reminder.ts": "the reminder's title copies the lead title as its author sees it in a list (Phase 3 wave B)",
  "src/actions/lead.ts": "the leads presenter on every read; the page's company website and address through the companies presenter too (leadAccountView); createLead/resolveOwner read the company server-side only (Phase 3 wave B)",
  "src/actions/portal.ts": "portal links and requests mask the copied person name and email by the contact's policy (Phase 3 wave B)",
  "src/actions/project.ts": "stakeholder contacts through maskContactRows (Phase 3 wave B); a milestone invoice is a document",
  "src/actions/renewal.ts": "\"who to ring\" through the contacts presenter in both renewal lists (Phase 3 wave B)",
  "src/actions/reseller.ts": "onboarding's PAN and GSTIN through the companies presenter (Phase 3 wave B)",
  "src/actions/support-mail.ts": "the reply-to fallback is shown masked; the reply is addressed on the server (Phase 3 wave B)",
  "src/actions/ticket.ts": "getTicket's contact through maskContactRows, so the API's ticket read too (Phase 3 wave B)",
  "src/actions/verification.ts": "lists mask the contact and its original and corrected values; a verdict is filed against the stored value (Phase 3 wave B)",
  "src/actions/visit.ts": "visit contacts, locations and the copied address through the presenters; saving keeps the stored address (Phase 3 wave B)",
  "src/actions/workspace.ts": "rows through the presenters; City and State options only where seen in the clear (Phase 3 wave B)",
  "src/lib/app/calls.ts": "due callbacks through contactMasker and contactRedactor (Phase 3 wave B)",
  "src/lib/automate/email-report.ts": "recipients through the contacts presenter, subject and reason through contactRedactor (Phase 3 wave B)",
  "src/lib/calendar/records.ts": "people read to invite by id; the dialog shows them through meetingContactsSeenBy (Phase 3 wave B)",
  "src/lib/companies/merge.ts": "pairs found on real values; the plan shown through planSeenBy (Phase 3 wave B)",
  "src/lib/documents/send-email.ts": "recipients read and mailed by id; the dialogs show them through recipientsShownTo (Phase 3 wave B)",
  "src/lib/forms/send-invites.ts": "candidates read to invite on the server; the Invite dialog shows them through the viewer's presenter (Phase 3 wave B)",
  "src/lib/leads/duplicates.ts": "grouped on the server; shown through listLeadMasker (Phase 3 wave B)",
  "src/lib/leads/phone-repair.ts": "matched and written on the server; the plan shown through contactMasker (Phase 3 wave B)",
  "src/lib/marketing/order-notice.ts": "worked out and mailed by id; the list and preview through the presenter (Phase 3 wave B)",
  "src/lib/marketing/subscribers.ts": "rows through maskContactRows, the search skipping masked addresses (Phase 3 wave B)",
  "src/lib/api/v1/leads.ts": "API v1 leads: one lead, and an API list's export answers, presented again through maskLead with the list or export answers (Phase 3 wave B, M-11/H.4.4)",
  "src/actions/lead-limits.ts": "the lead limit warnings list names each lead by its title, shown to the super admin alone (leadLimitTriggerState returns null for anybody else; Phase 4)",
};

/**
 * Real unmasked reads this check found (owner, 5 Nov 2026 — Phase 3 masking fixes), left for the agents that own
 * those files: what reaches whom. The check passes while each still reads, and fails once one reads nothing watched
 * — then it is fixed (or moved), and its line comes out of this table.
 */
const KNOWN_GAPS: Record<string, string> = {};

// ─── The schema ──────────────────────────────────────────────────────────────────────────────────

type Model = { name: string; scalars: Set<string>; relations: Map<string, string> };

function readSchema(file: string): Map<string, Model> {
  const text = readFileSync(file, "utf8");
  const blocks = [...text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  const models = new Map<string, Model>(blocks.map(([, name]) => [name, { name, scalars: new Set<string>(), relations: new Map<string, string>() }]));
  for (const [, name, body] of blocks) {
    const model = models.get(name)!;
    for (const line of body.split("\n")) {
      const m = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
      if (!m || line.trim().startsWith("//") || line.trim().startsWith("@@")) continue;
      const [, field, type, , , rest] = m;
      if (models.has(type)) model.relations.set(field, type);
      // An `@ignore`d column isn't in the client at all.
      else if (!/@ignore\b/.test(rest)) model.scalars.add(field);
    }
  }
  return models;
}

const SCHEMA = readSchema(path.join(ROOT, "prisma", "schema.prisma"));
const DELEGATE = new Map([...SCHEMA.keys()].map((name) => [name[0]!.toLowerCase() + name.slice(1), name]));

// ─── Source files ────────────────────────────────────────────────────────────────────────────────

const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) files.push(full);
  }
})(SRC);

function resolveModule(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx"), base]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

type Parsed = { file: string; sf: ts.SourceFile; imports: Map<string, { file: string | null; name: string }>; tops: Map<string, ts.Node> };
const parsed = new Map<string, Parsed>();
function parse(file: string): Parsed {
  const known = parsed.get(file);
  if (known) return known;
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const p: Parsed = { file, sf, imports: new Map(), tops: new Map() };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) p.imports.set(el.name.text, { file: resolveModule(file, st.moduleSpecifier.text), name: (el.propertyName ?? el.name).text });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) p.tops.set(d.name.text, d.initializer);
    } else if (ts.isFunctionDeclaration(st) && st.name) p.tops.set(st.name.text, st);
  }
  parsed.set(file, p);
  return p;
}

// ─── What a value is: following a select object to where it is written ──────────────────────────

/** Unknown: a parameter, a call to something elsewhere — taken to be anything. */
const OPAQUE = Symbol("opaque");
type Value = ts.ObjectLiteralExpression | typeof OPAQUE | boolean;

const strip = (e: ts.Expression): ts.Expression => {
  let x = e;
  for (;;) {
    if (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
    else return x;
  }
};

/** A name's value where the use is: the nearest enclosing declaration, else the file's, else the import's. */
function lookup(name: string, at: ts.Node, p: Parsed, depth: number): ts.Node | null {
  for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
    const statements = ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) ? n.statements : null;
    if (statements) {
      for (const st of statements) {
        if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
        if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
      }
    }
    if (ts.isFunctionLike(n) && n.parameters.some((prm) => ts.isIdentifier(prm.name) && prm.name.text === name)) return null;
  }
  const imported = p.imports.get(name);
  if (imported?.file && depth < 4) {
    const there = parse(imported.file);
    const node = there.tops.get(imported.name);
    if (node) return node;
  }
  return null;
}

type Ctx = { p: Parsed; depth: number };

/** The object literals an expression may be — several where it's conditional — or OPAQUE, or a literal boolean. */
function valuesOf(e: ts.Expression, ctx: Ctx): Array<{ value: Value; ctx: Ctx }> {
  const x = strip(e);
  if (ts.isObjectLiteralExpression(x)) return [{ value: x, ctx }];
  if (x.kind === ts.SyntaxKind.TrueKeyword) return [{ value: true, ctx }];
  if (x.kind === ts.SyntaxKind.FalseKeyword) return [{ value: false, ctx }];
  if (ctx.depth > 6) return [{ value: OPAQUE, ctx }];
  if (ts.isConditionalExpression(x)) return [...valuesOf(x.whenTrue, ctx), ...valuesOf(x.whenFalse, ctx)];
  if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken || x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return [...valuesOf(x.left, ctx), ...valuesOf(x.right, ctx)].filter((v) => v.value !== false || x.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken);
  }
  const named = (name: string, at: ts.Node): Array<{ value: Value; ctx: Ctx }> | null => {
    const node = lookup(name, at, ctx.p, ctx.depth);
    if (!node) return null;
    const there = node.getSourceFile().fileName === ctx.p.file ? ctx.p : parse(node.getSourceFile().fileName);
    const next = { p: there, depth: ctx.depth + 1 };
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return null;
    return valuesOf(node as ts.Expression, next);
  };
  if (ts.isIdentifier(x)) return named(x.text, x) ?? [{ value: OPAQUE, ctx }];
  // A local function that builds the object: what it returns.
  if (ts.isCallExpression(x) && ts.isIdentifier(x.expression)) {
    const node = lookup(x.expression.text, x, ctx.p, ctx.depth);
    const there = node && node.getSourceFile().fileName !== ctx.p.file ? parse(node.getSourceFile().fileName) : ctx.p;
    const next = { p: there, depth: ctx.depth + 1 };
    const fn = node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) ? node : null;
    if (fn?.body) {
      if (!ts.isBlock(fn.body)) return valuesOf(fn.body, next);
      const returns: ts.Expression[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
        else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
      };
      ts.forEachChild(fn.body, visit);
      if (returns.length) return returns.flatMap((r) => valuesOf(r, next));
    }
  }
  return [{ value: OPAQUE, ctx }];
}

/** An object literal's properties, spreads followed: key → the expression given for it. */
function propsOf(obj: ts.ObjectLiteralExpression, ctx: Ctx): Array<{ key: string; init: ts.Expression; ctx: Ctx } | { opaque: true }> {
  const out: Array<{ key: string; init: ts.Expression; ctx: Ctx } | { opaque: true }> = [];
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
      if (key) out.push({ key, init: prop.initializer, ctx });
    } else if (ts.isShorthandPropertyAssignment(prop)) out.push({ key: prop.name.text, init: prop.name, ctx });
    else if (ts.isSpreadAssignment(prop)) {
      for (const v of valuesOf(prop.expression, ctx)) {
        if (v.value === OPAQUE) out.push({ opaque: true });
        else if (typeof v.value === "object") out.push(...propsOf(v.value, v.ctx));
      }
    }
  }
  return out;
}

// ─── What a Prisma call reads ────────────────────────────────────────────────────────────────────

type Read = { model: string; field: string; how: string };

function readsOfArgs(model: string, args: ts.Expression | undefined, ctx: Ctx, trail: string, out: Read[], depth = 0, write = false): void {
  const m = SCHEMA.get(model);
  if (!m || depth > 8) return;
  const variants = args ? valuesOf(args, ctx) : [{ value: true as Value, ctx }];
  for (const { value, ctx: c } of variants) {
    if (value === false) continue;
    if (value === OPAQUE) {
      // Arguments we can't see: whatever they select, the model's own columns may be among them.
      if (!write) for (const f of m.scalars) out.push({ model, field: f, how: `${trail} (arguments not followed)` });
      continue;
    }
    if (value === true) {
      if (!write) for (const f of m.scalars) out.push({ model, field: f, how: `${trail} (every column)` });
      continue;
    }
    const props = propsOf(value, c);
    const get = (k: string) => props.filter((p): p is { key: string; init: ts.Expression; ctx: Ctx } => "key" in p && p.key === k);
    const opaqueSpread = props.some((p) => "opaque" in p);
    const select = get("select");
    const include = get("include");
    const omit = get("omit");
    const by = get("by");
    for (const b of by) {
      const arr = strip(b.init);
      const names = ts.isArrayLiteralExpression(arr) ? arr.elements.map((el) => (ts.isStringLiteral(el) ? el.text : null)) : [null];
      for (const n of names) if (n === null) for (const f of m.scalars) out.push({ model, field: f, how: `${trail} groupBy (not followed)` });
      else out.push({ model, field: n, how: `${trail} groupBy` });
    }
    if (by.length) continue;
    if (select.length) {
      for (const s of select) selectInto(model, s.init, s.ctx, `${trail} select`, out, depth);
      continue;
    }
    if (write && !include.length && !opaqueSpread) continue;
    // No select: every column of the model, less what `omit` says for certain.
    const omitted = new Set<string>();
    for (const o of omit) {
      for (const v of valuesOf(o.init, o.ctx)) {
        if (typeof v.value !== "object") continue;
        for (const p of propsOf(v.value, v.ctx)) if ("key" in p && strip(p.init).kind === ts.SyntaxKind.TrueKeyword) omitted.add(p.key);
      }
    }
    for (const f of m.scalars) if (!omitted.has(f)) out.push({ model, field: f, how: `${trail} (every column${opaqueSpread ? ", arguments partly followed" : ""})` });
    for (const inc of include) {
      for (const v of valuesOf(inc.init, inc.ctx)) {
        if (v.value === OPAQUE) {
          out.push({ model, field: "*include", how: `${trail} include (not followed)` });
          continue;
        }
        if (typeof v.value !== "object") continue;
        for (const p of propsOf(v.value, v.ctx)) {
          if (!("key" in p) || p.key === "_count") continue;
          const target = m.relations.get(p.key);
          if (target) readsOfArgs(target, p.init, p.ctx, `${trail} include ${p.key}`, out, depth + 1);
        }
      }
    }
  }
}

function selectInto(model: string, sel: ts.Expression, ctx: Ctx, trail: string, out: Read[], depth: number): void {
  const m = SCHEMA.get(model)!;
  for (const v of valuesOf(sel, ctx)) {
    if (v.value === false) continue;
    if (v.value === OPAQUE || v.value === true) {
      for (const f of m.scalars) out.push({ model, field: f, how: `${trail} (not followed)` });
      continue;
    }
    for (const p of propsOf(v.value, v.ctx)) {
      if (!("key" in p)) {
        for (const f of m.scalars) out.push({ model, field: f, how: `${trail} (a spread not followed)` });
        continue;
      }
      if (p.key === "_count") continue;
      const target = m.relations.get(p.key);
      if (target) readsOfArgs(target, p.init, p.ctx, `${trail} ${p.key}`, out, depth + 1);
      else if (m.scalars.has(p.key) && strip(p.init).kind !== ts.SyntaxKind.FalseKeyword) out.push({ model, field: p.key, how: trail });
    }
  }
}

const READS = new Set(["findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "groupBy"]);
const WRITES = new Set(["create", "createManyAndReturn", "update", "updateManyAndReturn", "upsert", "delete"]);
const RAW = new Set(["$queryRaw", "$queryRawUnsafe"]);

/** A raw query naming a watched table and one of its watched columns. */
const RAW_WATCH: Array<{ table: RegExp; column: RegExp; model: string }> = [
  { table: /\bcontacts\b/i, column: /\b(email|phone)\b/i, model: "Contact" },
  { table: /\bleads\b/i, column: /"?\b(title|description|source|"sourceDetail"|"customFields")\b"?/i, model: "Lead" },
];

type Found = { file: string; line: number; fn: string; fields: string[]; how: string };

/** The outermost named function a node is in — the module function a read belongs to. */
function enclosing(node: ts.Node): string {
  let name = "<module>";
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name)) name = n.name.text;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(strip(n.initializer)) || ts.isFunctionExpression(strip(n.initializer)) || ts.isCallExpression(strip(n.initializer)))) name = n.name.text;
  }
  return name;
}

function scan(file: string): Found[] {
  const p = parse(file);
  const found: Found[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const op = n.expression.name.text;
      const target = n.expression.expression;
      const model = ts.isPropertyAccessExpression(target) ? DELEGATE.get(target.name.text) : undefined;
      if (model && (READS.has(op) || WRITES.has(op))) {
        const reads: Read[] = [];
        readsOfArgs(model, n.arguments[0], { p, depth: 0 }, `${model}.${op}`, reads, 0, WRITES.has(op));
        const hits = reads.filter((r) => WATCHED[r.model]?.includes(r.field));
        if (hits.length) {
          const fields = [...new Set(hits.map((h) => `${h.model}.${h.field}`))].sort();
          found.push({ file, line: p.sf.getLineAndCharacterOfPosition(n.getStart(p.sf)).line + 1, fn: enclosing(n), fields, how: [...new Set(hits.map((h) => h.how))].sort()[0]! });
        }
      }
    }
    // Raw SQL: `$queryRaw\`…\`` (tagged) or `$queryRawUnsafe("…")`.
    const rawText = (() => {
      if (ts.isTaggedTemplateExpression(n) && ts.isPropertyAccessExpression(n.tag) && RAW.has(n.tag.name.text)) return n.template.getText(p.sf);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && RAW.has(n.expression.name.text) && n.arguments[0]) return n.arguments[0].getText(p.sf);
      return null;
    })();
    if (rawText) {
      for (const w of RAW_WATCH) {
        const cols = rawText.match(new RegExp(w.column.source, "gi"));
        if (w.table.test(rawText) && cols) {
          found.push({ file, line: p.sf.getLineAndCharacterOfPosition(n.getStart(p.sf)).line + 1, fn: enclosing(n), fields: [...new Set(cols.map((c) => `${w.model}.${c.replace(/"/g, "")}`))].sort(), how: "raw SQL" });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(p.sf);
  return found;
}

// ─── The check ───────────────────────────────────────────────────────────────────────────────────

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

section("The watched columns");
{
  const missing = Object.entries(WATCHED).flatMap(([model, fields]) => fields.filter((f) => !SCHEMA.get(model)?.scalars.has(f)).map((f) => `${model}.${f}`));
  ok(`every watched column is in prisma/schema.prisma (${Object.values(WATCHED).flat().length})`, missing.length === 0, missing.join(", "));
  const gone = PRESENTERS.filter((f) => !existsSync(path.join(ROOT, f)));
  ok(`every presenter is where it is listed (${PRESENTERS.length})`, gone.length === 0, gone.join(", "));
}

const all = files.flatMap(scan).sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
const byFile = new Map<string, Found[]>();
for (const f of all) byFile.set(rel(f.file), [...(byFile.get(rel(f.file)) ?? []), f]);

section("Reads of a watched column");
ok(`${files.length} files read; ${all.length} reads of a watched column, in ${byFile.size} files`, all.length > 0);
const fresh = [...byFile.keys()].filter((f) => !(f in ALLOWED) && !(f in KNOWN_GAPS));
ok(
  "every file that reads one is in ALLOWED or KNOWN_GAPS",
  fresh.length === 0,
  fresh.length ? `reads a masked value with no reason given:\n${fresh.map((f) => byFile.get(f)!.map((r) => `          ${f}:${r.line} ${r.fn} — ${r.fields.join(", ")}`).join("\n")).join("\n")}` : "",
);
const both = Object.keys(ALLOWED).filter((k) => k in KNOWN_GAPS);
ok("no file is both allowed and a known gap", both.length === 0, both.join(", "));

function entry(table: "ALLOWED" | "KNOWN_GAPS", file: string, reason: string) {
  const reads = byFile.get(file);
  if (!existsSync(path.join(ROOT, file))) return ok(`${file} — ${reason}`, false, `no such file: take it out of ${table}`);
  if (!reads) return ok(`${file} — ${reason}`, false, table === "KNOWN_GAPS" ? "fixed — it reads no watched column now: remove it from KNOWN_GAPS" : `it reads no watched column now: take it out of ${table}`);
  ok(`${file} (${reads.length}) — ${reason}`, true);
}

section(`Allowed (${Object.keys(ALLOWED).length})`);
for (const file of Object.keys(ALLOWED).sort()) entry("ALLOWED", file, ALLOWED[file]!);

section(`Known gaps, still open (${Object.keys(KNOWN_GAPS).length})`);
for (const file of Object.keys(KNOWN_GAPS).sort()) entry("KNOWN_GAPS", file, KNOWN_GAPS[file]!);

if (process.argv.includes("--list")) {
  section("Every read");
  for (const [file, reads] of byFile) for (const r of reads) console.log(`  ${file}:${r.line} ${r.fn} — ${r.fields.join(", ")} [${r.how}]${file in KNOWN_GAPS ? " KNOWN GAP" : file in ALLOWED ? "" : " NOT LISTED"}`);
}

console.log(`\n${passes} passed, ${failures} failed — ${all.length} reads in ${byFile.size} files: ${Object.keys(ALLOWED).length} allowed, ${Object.keys(KNOWN_GAPS).length} known gaps`);
console.error(`(${process.uptime().toFixed(1)}s)`);
process.exitCode = failures ? 1 : 0;
