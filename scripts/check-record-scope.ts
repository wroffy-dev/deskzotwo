/**
 * check:record-scope — every server action that takes a record id reaches a record-scope helper (owner, 3 Nov 2026 —
 * Phase 2 permission fixes; DESKZO_PERMISSION_SYSTEM_AUDIT.md G.3 and J, Phase 2 "scope-coverage check script").
 *
 * Static, with the TypeScript compiler (parsing only — no type checker, no database, a few seconds):
 *
 *   · The records are the access engine's (src/lib/authz/access.ts): a company or vendor, contact, lead, order,
 *     document, payment, ticket, project, visit, call/timeline row/meeting, task and expense — and every model
 *     that cannot exist without one of them (a ticket's comment, a document's line), read from prisma/schema.prisma.
 *   · An action takes a record id when a parameter — a property of one (through `schema.safeParse(input)`,
 *     `(input ?? {}) as T` and destructuring), or a plain string — is used as one: a Prisma `where`/`data` key
 *     naming that model's id or a foreign key to it (followed through copies, objects built first, and the
 *     functions it is handed to), `mayAccess(…, "leads", …, id)`, or, when no use can be seen, a name that means one
 *     record (`leadId`, `companyIds`). Ids of anything else — a pipeline stage, a warehouse, a person — are not.
 *   · Each such action, exported from a "use server" file in src/actions, must reach a helper through its call
 *     graph: local functions, imports through `@/` and relative paths, `import * as`, re-exports, `export *`,
 *     second names (`const canAttachTo = mayAttachTo`) and `await import(…)`. The helpers are the access engine's
 *     primitives, the named record helpers built on them (each asserted to reach a primitive itself), and a few
 *     modules' own rules. The walk does not go through STOP functions, whose reach is about somebody else. The
 *     platform console, CMS and partner portal (src/actions/platform, cms, partners) answer to their own sign-ins,
 *     not a workspace's record levels, and are left out.
 *   · Without a helper, two shapes are verified rather than trusted by name: the super admin's alone (the action
 *     refuses first unless `actingAsSuperAdmin`), and the caller's own rows (every read of the id sits in a Prisma
 *     `where` that also says `userId: user.id`, here or in the function it is handed to with the caller's id, or the
 *     row is loaded and refused unless it is the caller's before anything else reads the id).
 *   · Everything else is in EXCEPTIONS, each with why that is right, or in KNOWN_GAPS — real gaps found here and
 *     left to the agents owning those files. A new unscoped action fails the check; so does an entry in either
 *     table that no longer applies — a known gap that now reaches a helper is fixed, and comes out of the table.
 *
 * Reaching a helper is not proof the id was the thing checked — this is coverage, not a proof; the per-record
 * checks (check:access, check:order-scope, check:write-scope …) test behaviour.
 *
 *   npm run check:record-scope            (`-- --list` prints every action that takes a record id, and how)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const ACTIONS = path.join(SRC, "actions");
const rel = (full: string) => path.relative(ROOT, full).split(path.sep).join("/");

// ─── The helpers ─────────────────────────────────────────────────────────────────────────────────

/** The access engine's record rules (src/lib/authz): a fragment, a level, or a yes/no for one record. */
const PRIMITIVES: Record<string, string[]> = {
  "src/lib/authz/access.ts": [
    "accessLevel",
    "callAccess",
    "companyAccess",
    "contactAccess",
    "customerReachIds",
    "documentAccess",
    "expenseAccess",
    "leadAccess",
    "mayAccess",
    "mayAccessAccount",
    "mayAccessContactsOf",
    "mayAddTo",
    "meetingAccess",
    "orderAccess",
    "paymentAccess",
    "peopleReached",
    "projectAccess",
    "reachesPerson",
    "taskAccess",
    "throughAccount",
    "ticketAccess",
    "timelineAccess",
    "visitAccess",
  ],
  "src/lib/authz/company-scope.ts": ["accountScopeIds", "canSeeCompany", "companyScope", "paymentScope", "viaCompanyScope"],
  "src/lib/authz/contact-access.ts": ["contactIdsInScope", "contactScope", "mayWorkWithContactsOf"],
  "src/lib/authz/scope.ts": ["scopeUserIds"],
};

/**
 * Named record helpers built on the primitives — the audit's G.3, and the others found taking a record id — each
 * asserted to reach a primitive itself (or, for whose people, the reporting line). Listed so the walk's answers
 * read as the code does, and so a helper that stops asking fails here rather than quietly covering its callers.
 */
const WRAPPERS: Record<string, string[]> = {
  "src/actions/attendance.ts": ["visibleUserIds"],
  "src/actions/commission-party.ts": ["reaches"],
  "src/actions/company-bank.ts": ["payee"],
  "src/actions/company-location.ts": ["reachableLocation"],
  "src/actions/consignment.ts": ["reachesConsignment"],
  "src/actions/credit.ts": ["readableCustomer"],
  "src/actions/document-approval.ts": ["loadForApproval"],
  "src/actions/domain.ts": ["visibleCustomer"],
  "src/actions/eway.ts": ["reachesDocument"],
  "src/actions/expense.ts": ["canActFor", "visibleUserIds"],
  "src/actions/hr.ts": ["visibleUserIds"],
  "src/actions/incentive.ts": ["visibleUserIds"],
  "src/actions/lead-reminder.ts": ["reachableLead"],
  "src/actions/lead.ts": ["getLead", "leadInScope"],
  "src/actions/leave.ts": ["visibleUserIds"],
  "src/actions/order-notice.ts": ["mayChangeOrder"],
  "src/actions/order.ts": ["visibleOrder"],
  "src/actions/project-credential.ts": ["credentialAccess"],
  "src/actions/project.ts": ["readable"],
  "src/actions/rebate.ts": ["scopedOrder"],
  "src/actions/receivable.ts": ["maySeeCustomer"],
  "src/actions/renewal-reminder.ts": ["reachableOrder"],
  "src/actions/reseller.ts": ["reaches"],
  "src/actions/support-mail.ts": ["visibleTicket"],
  "src/actions/target.ts": ["visibleUserIds"],
  "src/actions/task-extras.ts": ["taskFor"],
  "src/actions/task.ts": ["reachableTask"],
  "src/actions/tds.ts": ["reachableCompany"],
  "src/actions/ticket.ts": ["reachableTicket"],
  "src/actions/trade-document.ts": ["maySeeParty", "reachesDocument"],
  "src/actions/vendor-credit.ts": ["outOfReach"],
  "src/actions/visit.ts": ["canActFor"],
  "src/lib/authz/attachments.ts": ["mayAttachTo"],
  "src/lib/statements/print-data.ts": ["maySeeStatement"],
  "src/lib/tasks/server.ts": ["workableTask"],
};

/**
 * A module's own reach rule, for what the access engine gives no level of its own: counted as a helper, each with
 * what it is. Not held to reaching a primitive — it is the rule.
 */
const OWN_RULES: Record<string, Record<string, string>> = {
  "src/actions/feedback.ts": { visibleTo: "feedback without feedback.viewAll: about you, asked for by you, or on an account you run" },
  "src/actions/portal-public.ts": { resolve: "the customer portal's public token: a verified link's own company, and only the sections it shows" },
  "src/lib/vault/policy.ts": { visibleCredentialsWhere: "the credential vault: its owner, whom it is shared with, or vault.viewAll" },
};

/** Functions the walk does not go through: what they reach is a question about somebody other than the caller. */
const STOP: Record<string, string> = {
  "src/lib/automate/trigger-reach.ts::eventAsOwner": "whether an automation's owner may see the record an event is about",
};

// ─── The tables ──────────────────────────────────────────────────────────────────────────────────
// Keyed "<file under src/actions> <action>", sorted. One line each.

/** Actions that take a record id and rightly reach no record-scope helper: why that is right. */
const EXCEPTIONS: Record<string, string> = {
  "accounts-reports.ts registerParty": "the books are the whole workspace's: a register's party filter, by name, for ledger.viewReports",
  "asset.ts saveAsset": "the fixed-asset register is the books' (payments.manage): the vendor it was bought from is a counterparty, only named on it",
  "calling-activity.ts openRecord": "own row: refused unless the calling-queue row is assigned to the caller (the ADMIN escape kept on purpose, see its note)",
  "calling-activity.ts completeRecord":
    "own row, as openRecord; input.callId (the screen never sends it) is linked to that row unchecked, and nothing but the data export reads the link back",
  "commission-party.ts listCommissionPartyAccountOptions": "the order form's account picker, open to whoever punches an order on purpose: a label and the default flag, never PAN or bank",
  "company-delete.ts bulkDeleteVendors": "vendors have no delete scope (access.ts, vendors): deleting one is the super admin's or \"Delete vendors\" alone",
  "company-delete.ts deleteCompany": "the super admin's (actingAsSuperAdmin); a vendor also \"Delete vendors\" — vendors have no delete scope (access.ts)",
  "company.ts createCompany": "the reseller managing the new account is a counterparty: resellers are unscoped on purpose (listResellerOptions)",
  "company.ts listCommissionPartyOptions": "a counterparty picker, unscoped on purpose (its note): every party's name; forCompanyId only sorts the linked ones first",
  "expense.ts decideExpense": "deciding a claim is an action of its own, not a level (access.ts, expenses): canDecide — its routed approver, or HR at HR's step",
  "expense.ts postExpensesToLedger": "posting approved claims the ledger missed is expenses.reimburse's, for every claim: accounts' payment run, not a level",
  "expense.ts reimburseExpenses": "reimbursing is an action of its own, not a level (access.ts, expenses): expenses.reimburse pays every approved claim in a batch",
  "feedback.ts cancelFeedbackRequest": "feedback's own rule: whoever asked, or feedback.viewAll — never a request about yourself",
  "forms.ts recordRsvp": "parent-scoped: the invitation's form (formFor, may invite), the rule the form's own invitation list follows",
  "forms.ts revokeInvite": "parent-scoped: the invitation's form (formFor, may invite), the rule the form's own invitation list follows",
  "inbox.ts inboxLinkCustomer": "parent-scoped: a conversation the viewer may see (visibleConversation), and only a contact its own visitor matches (customersOnFile)",
  "inventory.ts receiptLinesFromPurchaseOrder": "the store receives against every issued purchase order — openPurchaseOrders lists them all to inventory.receive",
  "inventory.ts saveStockDocument": "a stock voucher's vendor, purchase order and bill: the warehouse works every purchase (openPurchaseOrders, searchVendors)",
  "inventory.ts stockPasteContext": "a pasted stock voucher's vendor, by name, for inventory.view — searchVendors lists every company to it",
  "it-asset.ts estateCount": "a count, for whether the company page shows the tab, for assets.viewAll — which sees the whole asset register",
  "it-asset.ts listAssets": "only narrows the asset register the caller already sees: what they hold, or assets.viewAll's whole register",
  "it-asset.ts moveAsset": "assets.manage works the whole register and picks from every company (assetFormOptions): the place, person, ticket and visit label the move",
  "it-asset.ts saveAsset": "assets.manage works the whole register and picks from every company (assetFormOptions): owner, site, vendor, place and the order or AMC it came with label the asset",
  "ledger-reports.ts accountLedger": "narrows the general ledger, which the books' readers see whole (mayReadBooks)",
  "marketing-subscribers.ts unsubscribeSubscriber": "consent is the marketing desk's, workspace-wide (marketing.manage), as the Subscribers list and the unsubscribe link are",
  "marketing.ts companyMarketing": "marketing.viewAll sees the whole workspace's marketing; this is the company tab's slice of it",
  "marketing.ts setConsent": "consent is the marketing desk's, workspace-wide (marketing.manage), as the Subscribers list and the unsubscribe link are",
  "portal.ts createPortalLogin": "portal.manage administers every customer's portal (MANAGEMENT, not delegable): issuing a link is its own",
  "portal.ts portalLogins": "portal.manage administers every customer's portal (MANAGEMENT, not delegable): its links, to re-send",
  "portal.ts portalStatusFor": "portal.manage administers every customer's portal (MANAGEMENT, not delegable): whether one may use it",
  "portal.ts revokePortalLogin": "portal.manage administers every customer's portal (MANAGEMENT, not delegable): revoking a link is its own",
  "portal.ts setCompanyPortalAccess": "portal.manage administers every customer's portal (MANAGEMENT, not delegable): switching one on or off",
  "portal.ts setPortalRequestStatus": "portal.manage works every customer's portal requests (MANAGEMENT, not delegable; listPortalRequests lists them all)",
  "rebate.ts saveRebateProgramme": "a programme names its distributor, a counterparty: vendors are unscoped on purpose (listVendorOptions)",
  "reconcile.ts deleteStatement": "vendor reconciliation is the purchase desk's, across every vendor (purchase.reconcile; reconcilableVendors)",
  "reconcile.ts previewStatement": "vendor reconciliation is the purchase desk's, across every vendor (purchase.reconcile); the vendor only recalls its saved columns",
  "vault.ts saveCredential": "the vault is its own reach (entitlementFor on an edit); the client company only tags the card",
  "vouchers.ts saveVoucher": "a journal voucher's party, in the books (vouchers.create): accounting is the whole workspace's",
};

/**
 * Real gaps this check found (owner, 3 Nov 2026 — Phase 2 permission fixes, audit G.3), left for the agents that own
 * those files: what an attacker reaches. The check passes while each is as it was, and fails once one reaches a
 * helper — then it is fixed, and its line comes out of this table.
 */
// The seven gaps this check found when it was written (owner, 3 Nov 2026) were fixed in the same change: the marketing
// test send, the IT estate and AMC lists, the payment reminders' pause, and approving, re-planning and cancelling a
// revenue schedule. A new real gap goes here, with what it reaches, until it is fixed.
const KNOWN_GAPS: Record<string, string> = {};

// ─── The schema: models, their relations and foreign keys ───────────────────────────────────────

type Model = { name: string; relations: Map<string, string>; fks: Map<string, string>; required: Set<string> };

function readSchema(file: string): Map<string, Model> {
  const text = readFileSync(file, "utf8");
  const models = new Map<string, Model>();
  const blocks = [...text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  for (const [, name] of blocks) models.set(name, { name, relations: new Map(), fks: new Map(), required: new Set() });
  for (const [, name, body] of blocks) {
    const model = models.get(name)!;
    // Either line ending: on Windows the schema is checked out with CRLF, and a line ending in a carriage return matched nothing.
    for (const line of body.split(/\r?\n/)) {
      const m = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
      if (!m || !models.has(m[2])) continue;
      const [, field, target, list, optional, rest] = m;
      model.relations.set(field, target);
      const fields = /fields:\s*\[([^\]]*)\]/.exec(rest);
      if (!fields) continue;
      for (const fk of fields[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        model.fks.set(fk, target);
        if (!list && !optional) model.required.add(fk);
      }
    }
  }
  return models;
}

const SCHEMA = readSchema(path.join(ROOT, "prisma", "schema.prisma"));
const ACCESSOR = new Map([...SCHEMA.keys()].map((name) => [name[0].toLowerCase() + name.slice(1), name]));

/** The access engine's records, by the model its fragment for each is for (src/lib/authz/access.ts) — checked against it. */
const ROOT_MODELS: Record<string, string> = {
  Company: "companies",
  Contact: "contacts",
  Lead: "leads",
  CompanyProduct: "orders",
  TradeDocument: "documents",
  Payment: "payments",
  Ticket: "tickets",
  Project: "projects",
  Visit: "visits",
  CallLog: "activities",
  Activity: "activities",
  CalendarEvent: "activities",
  Task: "tasks",
  Expense: "expenses",
};

/** A record model, or a model that cannot exist without one (a ticket's comment, a document's line). */
function recordOf(model: string): { record: string; parent: string | null } | null {
  if (ROOT_MODELS[model]) return { record: ROOT_MODELS[model], parent: null };
  const m = SCHEMA.get(model);
  if (!m) return null;
  for (const fk of [...m.required].sort()) {
    const target = m.fks.get(fk)!;
    if (ROOT_MODELS[target]) return { record: ROOT_MODELS[target], parent: target };
  }
  return null;
}

// ─── Source files: functions, imports and exports ────────────────────────────────────────────────

type Fn = { key: string; file: string; name: string; node: ts.SignatureDeclaration & { body?: ts.Node }; body: ts.Node; params: ts.NodeArray<ts.ParameterDeclaration>; exported: boolean; line: number };
type Index = {
  file: string;
  sf: ts.SourceFile;
  fns: Map<string, Fn>;
  imports: Map<string, { file: string | null; name: string }>;
  exports: Map<string, string>;
  reexports: Map<string, { file: string | null; name: string }>;
  stars: (string | null)[];
  /** `const canAttachTo = mayAttachTo` — a second name for a function. */
  aliases: Map<string, ts.Expression>;
  useServer: boolean;
};

function resolveModule(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx"), base]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

const indexes = new Map<string, Index>();
function indexOf(file: string): Index {
  const known = indexes.get(file);
  if (known) return known;
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const idx: Index = { file, sf, fns: new Map(), imports: new Map(), exports: new Map(), reexports: new Map(), stars: [], aliases: new Map(), useServer: false };
  const first = sf.statements[0];
  idx.useServer = !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server";
  const exported = (node: ts.Node) => !!(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
  const addFn = (name: string, node: ts.SignatureDeclaration & { body?: ts.Node }, isExported: boolean) => {
    if (!node.body) return;
    idx.fns.set(name, { key: `${rel(file)}::${name}`, file, name, node, body: node.body, params: node.parameters, exported: isExported, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    if (isExported) idx.exports.set(name, name);
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
      const target = resolveModule(file, st.moduleSpecifier.text);
      const clause = st.importClause;
      if (clause.name) idx.imports.set(clause.name.text, { file: target, name: "default" });
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) idx.imports.set(nb.name.text, { file: target, name: "*" });
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) idx.imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      addFn(st.name.text, st, exported(st));
      if (st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) idx.exports.set("default", st.name.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        let init: ts.Expression = d.initializer;
        // `cache(async (…) => …)` and the like: the function is the wrapped one.
        if (ts.isCallExpression(init)) init = init.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) ?? init;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) addFn(d.name.text, init, exported(st));
        else if (ts.isIdentifier(init) || (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression))) {
          idx.aliases.set(d.name.text, init);
          if (exported(st)) idx.exports.set(d.name.text, d.name.text);
        }
      }
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      const target = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? resolveModule(file, st.moduleSpecifier.text) : undefined;
      if (!st.exportClause) {
        if (target !== undefined) idx.stars.push(target);
      } else if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          if (target !== undefined) idx.reexports.set(el.name.text, { file: target, name: local });
          else idx.exports.set(el.name.text, local);
        }
      }
    }
  }
  // `const { payLinkFor } = await import("@/lib/collect/links")`, anywhere in the file: imports too.
  const dynamic = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
      let init: ts.Expression = n.initializer;
      while (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      const spec = ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword ? init.arguments[0] : undefined;
      if (spec && ts.isStringLiteral(spec)) {
        const target = resolveModule(file, spec.text);
        for (const el of n.name.elements) {
          if (ts.isIdentifier(el.name) && !idx.imports.has(el.name.text) && !idx.fns.has(el.name.text)) idx.imports.set(el.name.text, { file: target, name: ((el.propertyName ?? el.name) as ts.Identifier).text });
        }
      }
    }
    ts.forEachChild(n, dynamic);
  };
  dynamic(sf);
  indexes.set(file, idx);
  return idx;
}

function resolveExport(file: string | null, name: string, seen = new Set<string>()): Fn | null {
  if (!file || seen.has(`${file}::${name}`)) return null;
  seen.add(`${file}::${name}`);
  const idx = indexOf(file);
  const local = idx.exports.get(name);
  if (local !== undefined) return resolveLocal(idx, local, seen);
  const re = idx.reexports.get(name);
  if (re) return resolveExport(re.file, re.name, seen);
  for (const star of idx.stars) {
    const hit = resolveExport(star, name, seen);
    if (hit) return hit;
  }
  return null;
}

function resolveLocal(idx: Index, name: string, seen = new Set<string>()): Fn | null {
  const fn = idx.fns.get(name);
  if (fn) return fn;
  const alias = idx.aliases.get(name);
  if (alias && !seen.has(`${idx.file}#${name}`)) {
    seen.add(`${idx.file}#${name}`);
    return ts.isIdentifier(alias) ? resolveLocal(idx, alias.text, seen) : resolveCallee(idx, alias);
  }
  const imp = idx.imports.get(name);
  if (imp && imp.name !== "*") return resolveExport(imp.file, imp.name, seen);
  return null;
}

/** What a call or reference names: a function in this file or one imported, `ns.fn` through `import * as ns`. */
function resolveCallee(idx: Index, expr: ts.Expression): Fn | null {
  if (ts.isIdentifier(expr)) return resolveLocal(idx, expr.text);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const imp = idx.imports.get(expr.expression.text);
    if (imp?.name === "*") return resolveExport(imp.file, expr.name.text);
  }
  return null;
}

const calleeCache = new Map<string, Fn[]>();
function calleesOf(fn: Fn): Fn[] {
  const known = calleeCache.get(fn.key);
  if (known) return known;
  const idx = indexOf(fn.file);
  const out: Fn[] = [];
  const seen = new Set<string>();
  const visit = (n: ts.Node) => {
    let target: Fn | null = null;
    if (ts.isIdentifier(n) && isReference(n)) target = resolveCallee(idx, n);
    else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) target = resolveCallee(idx, n);
    if (target && target.key !== fn.key && !seen.has(target.key)) {
      seen.add(target.key);
      out.push(target);
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  calleeCache.set(fn.key, out);
  return out;
}

/** An identifier read as a value — not a property name, a declaration's name or a type. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) || ts.isTypeQueryNode(p)) return false;
  return true;
}

const primitiveKeys = new Set(Object.entries(PRIMITIVES).flatMap(([f, names]) => names.map((n) => `${f}::${n}`)));
const wrapperKeys = new Set(Object.entries(WRAPPERS).flatMap(([f, names]) => names.map((n) => `${f}::${n}`)));
const ruleKeys = new Set(Object.entries(OWN_RULES).flatMap(([f, rules]) => Object.keys(rules).map((n) => `${f}::${n}`)));
const isHelper = (key: string) => primitiveKeys.has(key) || wrapperKeys.has(key) || ruleKeys.has(key);
const isStop = (key: string) => key in STOP;

// ─── Which functions reach a helper ──────────────────────────────────────────────────────────────

const graph = new Map<string, Fn>();
/** Every function the actions call, and what those call, down to the primitives (not through them, or through a STOP). */
function discover(roots: Fn[]) {
  const stack = [...roots];
  while (stack.length) {
    const fn = stack.pop()!;
    if (graph.has(fn.key)) continue;
    graph.set(fn.key, fn);
    if (primitiveKeys.has(fn.key) || isStop(fn.key)) continue;
    for (const c of calleesOf(fn)) if (!graph.has(c.key)) stack.push(c);
  }
}

/** The functions that reach one of these targets, by walking callers back from them. Targets are not walked through. */
function reachingSet(targets: Set<string>): Set<string> {
  const callers = new Map<string, string[]>();
  for (const fn of graph.values()) {
    if (targets.has(fn.key) || primitiveKeys.has(fn.key) || isStop(fn.key)) continue;
    for (const c of calleesOf(fn)) {
      if (isStop(c.key)) continue;
      const list = callers.get(c.key) ?? [];
      list.push(fn.key);
      callers.set(c.key, list);
    }
  }
  const out = new Set([...graph.keys()].filter((k) => targets.has(k)));
  const queue = [...out];
  while (queue.length) {
    for (const caller of callers.get(queue.shift()!) ?? []) {
      if (out.has(caller)) continue;
      out.add(caller);
      queue.push(caller);
    }
  }
  return out;
}

let reaching = new Set<string>();

/** The way a function reaches a target: the first callee, in source order, that does — down to the target. */
function chainOf(fn: Fn, reach: Set<string>, isTarget: (key: string) => boolean): string[] | null {
  if (!reach.has(fn.key)) return null;
  const chain: string[] = [];
  const seen = new Set<string>();
  let at: Fn | undefined = fn;
  while (at && !seen.has(at.key)) {
    seen.add(at.key);
    if (at !== fn) chain.push(at.name);
    if (isTarget(at.key)) return chain;
    at = calleesOf(at).find((c) => reach.has(c.key) && !isStop(c.key) && !seen.has(c.key));
  }
  return chain;
}

// ─── Which record ids an action takes ─────────────────────────────────────────────────────────────

const ID_NAME = /^(id|ids)$|[a-z0-9](Id|Ids)$/;
const PRISMA_OPS = new Set([
  "aggregate", "count", "create", "createMany", "createManyAndReturn", "delete", "deleteMany", "findFirst", "findFirstOrThrow",
  "findMany", "findUnique", "findUniqueOrThrow", "groupBy", "update", "updateMany", "updateManyAndReturn", "upsert",
]);
const PRISMA_ARGS = new Set(["where", "data", "create", "update"]);
const PRISMA_OPERATORS = new Set(["AND", "OR", "NOT", "in", "notIn", "equals", "not", "some", "every", "none", "is", "isNot", "connect", "connectOrCreate", "set", "disconnect"]);

/** By name, for an id whose use the walk below could not see: only names that mean one record. */
const NAME_MODELS: Record<string, string> = {
  callId: "CallLog",
  callLogId: "CallLog",
  companyId: "Company",
  companyProductId: "CompanyProduct",
  contactId: "Contact",
  documentId: "TradeDocument",
  expenseId: "Expense",
  leadId: "Lead",
  orderId: "CompanyProduct",
  paymentId: "Payment",
  projectId: "Project",
  taskId: "Task",
  ticketId: "Ticket",
  visitId: "Visit",
};

/** A model a value names, how that was seen, and — for a Prisma call — which argument it sat in (`where`, `data`…). */
type Use = { model: string; via: string; arg?: string };

const isOp = (e: ts.BinaryExpression, ...kinds: ts.SyntaxKind[]) => kinds.includes(e.operatorToken.kind);

/** Up through syntax that hands the same value on: parentheses, casts, `await`, spreads, array items, `a ?? b`, `c ? a : b`. */
const skipWrappers = (n: ts.Node): ts.Node => {
  let at = n;
  for (;;) {
    const p = at.parent;
    if (!p) return at;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isAwaitExpression(p) || ts.isSatisfiesExpression(p) || ts.isSpreadElement(p) || ts.isArrayLiteralExpression(p)) at = p;
    else if (ts.isConditionalExpression(p) && p.condition !== at) at = p;
    else if (ts.isBinaryExpression(p) && isOp(p, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken)) at = p;
    else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === at) at = p;
    else return at;
  }
};

/**
 * The Prisma call a value is written into, and where: the property path from the call's argument down to
 * it, through objects built first and spread in (`const data = { … }; db.x.create({ data })`).
 */
function prismaUse(ref: ts.Node, path: string[] = [], depth = 0): Use | null {
  const keys = [...path];
  let at: ts.Node = ref;
  for (;;) {
    at = skipWrappers(at);
    const p = at.parent;
    if (!p) return null;
    if (ts.isShorthandPropertyAssignment(p)) {
      keys.unshift(p.name.text);
      at = p.parent;
    } else if (ts.isPropertyAssignment(p) && p.initializer === at) {
      keys.unshift(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : "?");
      at = p.parent;
    } else if (ts.isSpreadAssignment(p) && p.expression === at) {
      at = p.parent;
    } else if (ts.isVariableDeclaration(p) && p.initializer === at && ts.isIdentifier(p.name) && ts.isObjectLiteralExpression(at) && keys.length && depth < 3) {
      const name = p.name.text;
      for (const r of identRefs(bodyAround(p), name)) {
        if (r.pos < p.end) continue;
        const u = prismaUse(r, keys, depth + 1);
        if (u) return u;
      }
      return null;
    } else if (ts.isCallExpression(p) && p.arguments[0] === at && ts.isPropertyAccessExpression(p.expression) && PRISMA_OPS.has(p.expression.name.text)) {
      const recv = p.expression.expression;
      const model = ts.isPropertyAccessExpression(recv) ? ACCESSOR.get(recv.name.text) : undefined;
      if (!model || !PRISMA_ARGS.has(keys[0] ?? "")) return null;
      const use = resolveKeys(model, keys.slice(1));
      return use && { ...use, arg: keys[0] };
    } else return null;
  }
}

function resolveKeys(start: string, keys: string[]): Use | null {
  let model = start;
  let field: string | null = null;
  for (const k of keys) {
    if (PRISMA_OPERATORS.has(k)) continue;
    const m = SCHEMA.get(model)!;
    const target = m.relations.get(k);
    if (target) {
      model = target;
      field = null;
    } else field = k;
  }
  if (field === null) return null;
  if (field === "id") return { model, via: `${model}.id` };
  const target = SCHEMA.get(model)!.fks.get(field);
  return target ? { model: target, via: `${model}.${field}` } : null;
}

/** Up through what leaves a value the same id or ids: `String(x)`, `x.trim()`, `x.filter(…)`, `new Set(x)`, `parseRecordRef(x).id`. */
function transparent(n: ts.Node): ts.Node {
  let at = skipWrappers(n);
  for (;;) {
    const p = at.parent;
    if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "String" && p.arguments[0] === at) at = skipWrappers(p);
    else if (ts.isNewExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "Set" && p.arguments?.[0] === at) at = skipWrappers(p);
    else if (ts.isPropertyAccessExpression(p) && p.expression === at && TRANSPARENT_METHODS.has(p.name.text) && ts.isCallExpression(p.parent) && p.parent.expression === p) at = skipWrappers(p.parent);
    else if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "parseRecordRef" && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) {
      // `const ref = parseRecordRef(segment)` — a URL segment that is an id or a sequence number: its `ref.id`.
      const ref = p.parent.name.text;
      const read = identRefs(bodyAround(p.parent), ref).find((r) => ts.isPropertyAccessExpression(r.parent) && r.parent.name.text === "id");
      if (!read) return at;
      at = skipWrappers(read.parent);
    } else return at;
  }
}
const TRANSPARENT_METHODS = new Set(["trim", "toString", "filter", "slice", "concat", "map"]);

/** Where a value goes: the call it is an argument of (directly, or as a property of an object argument). */
function climb(ref: ts.Node): { call: ts.CallExpression; arg: number; keys: string[] } | null {
  const keys: string[] = [];
  let at: ts.Node = ref;
  for (;;) {
    at = skipWrappers(at);
    const p = at.parent;
    if (!p) return null;
    if (ts.isShorthandPropertyAssignment(p)) {
      keys.unshift(p.name.text);
      at = p.parent;
    } else if (ts.isPropertyAssignment(p) && p.initializer === at) {
      keys.unshift(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : "?");
      at = p.parent;
    } else if (ts.isCallExpression(p) && p.arguments.includes(at as ts.Expression)) {
      return { call: p, arg: p.arguments.indexOf(at as ts.Expression), keys };
    } else return null;
  }
}

/** Identifiers in a body that read a local of this name (shorthand properties included). */
function identRefs(body: ts.Node, name: string): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === name && isReference(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out;
}

/** `mayAccess`'s record keys, by the model each is asked of. */
const RECORD_MODEL: Record<string, string> = {
  companies: "Company",
  vendors: "Company",
  contacts: "Contact",
  leads: "Lead",
  orders: "CompanyProduct",
  documents: "TradeDocument",
  payments: "Payment",
  tickets: "Ticket",
  projects: "Project",
  visits: "Visit",
  activities: "CallLog",
  tasks: "Task",
  expenses: "Expense",
};
const MAY_ACCESS = "src/lib/authz/access.ts::mayAccess";

const fileOf = (n: ts.Node) => indexOf(n.getSourceFile().fileName);
const bodyAround = (n: ts.Node): ts.Node => {
  let at: ts.Node | undefined = n.parent;
  while (at && !(ts.isFunctionLike(at) && (at as ts.FunctionLikeDeclaration).body)) at = at.parent;
  return at ? (at as ts.FunctionLikeDeclaration).body! : n.getSourceFile();
};

const paramUseCache = new Map<string, Use[]>();
/** What the value of one parameter of a function (or one property of it) is used as — memoised. */
function paramUses(fn: Fn, index: number, member: string | null, depth: number): Use[] {
  const key = `${fn.key}#${index}#${member ?? ""}`;
  const known = paramUseCache.get(key);
  if (known) return known;
  paramUseCache.set(key, []);
  const p = fn.params[index];
  let refs: ts.Node[] = [];
  if (p && member === null && ts.isIdentifier(p.name)) refs = identRefs(fn.body, p.name.text);
  else if (p && member !== null && ts.isIdentifier(p.name)) refs = memberRefs(fn.body, p.name.text).get(member) ?? [];
  else if (p && member !== null && ts.isObjectBindingPattern(p.name)) {
    const el = p.name.elements.find((e) => ((e.propertyName ?? e.name) as ts.Identifier).text === member);
    if (el && ts.isIdentifier(el.name)) refs = identRefs(fn.body, el.name.text);
  }
  const uses = usesOf(refs, depth);
  paramUseCache.set(key, uses);
  return uses;
}

/** What these reads of one value are used as: a Prisma where/data key, or a parameter of a function followed down. */
function usesOf(refs: ts.Node[], depth: number): Use[] {
  const out: Use[] = [];
  for (const ref of refs) {
    const value = transparent(ref);
    const u = prismaUse(value);
    if (u) {
      out.push(u);
      continue;
    }
    // `const leadId = input.leadId` (or `String(input.leadId ?? "")`) — the local's reads.
    if (ts.isVariableDeclaration(value.parent) && value.parent.initializer === value && ts.isIdentifier(value.parent.name)) {
      const decl = value.parent;
      const name = decl.name as ts.Identifier;
      if (depth < 6) out.push(...usesOf(identRefs(bodyAround(decl), name.text).filter((r) => r.pos > decl.end), depth + 1));
      continue;
    }
    const c = climb(value);
    if (!c || c.keys.length > 1) continue;
    const callee = resolveCallee(fileOf(ref), c.call.expression);
    if (!callee) continue;
    if (callee.key === MAY_ACCESS) {
      const record = c.call.arguments[1];
      if (record && ts.isStringLiteral(record) && RECORD_MODEL[record.text]) out.push({ model: RECORD_MODEL[record.text], via: `mayAccess("${record.text}")` });
      continue;
    }
    if (depth < 6) out.push(...paramUses(callee, c.arg, c.keys[0] ?? null, depth + 1));
  }
  return out;
}

/**
 * Reads of `name.member`, by member — and of `name.data.member` and `const { member } = name`, through
 * `schema.safeParse(name)`, `(name ?? {}) as T` and plain aliases.
 */
function memberRefs(body: ts.Node, name: string): Map<string, ts.Node[]> {
  const aliases = new Set([name]);
  const out = new Map<string, ts.Node[]>();
  const add = (member: string, node: ts.Node) => {
    const list = out.get(member) ?? [];
    list.push(node);
    out.set(member, list);
  };
  const strip = (e: ts.Expression): ts.Expression => {
    while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    return e;
  };
  const isAlias = (e: ts.Expression): boolean => {
    e = strip(e);
    if (ts.isIdentifier(e)) return aliases.has(e.text);
    if (ts.isBinaryExpression(e) && isOp(e, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken)) return isAlias(e.left);
    if (ts.isPropertyAccessExpression(e) && e.name.text === "data") return isAlias(e.expression);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && /^(safe)?[pP]arse(Async)?$/.test(e.expression.name.text)) return e.arguments.some((a) => isAlias(a));
    return false;
  };
  const destructured: { pattern: ts.ObjectBindingPattern }[] = [];
  const visitDecls = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && isAlias(n.initializer)) {
      if (ts.isIdentifier(n.name)) aliases.add(n.name.text);
      else if (ts.isObjectBindingPattern(n.name)) destructured.push({ pattern: n.name });
    }
    ts.forEachChild(n, visitDecls);
  };
  visitDecls(body);
  for (const { pattern } of destructured) {
    for (const el of pattern.elements) {
      const key = ((el.propertyName ?? el.name) as ts.Identifier).text;
      if (key && ts.isIdentifier(el.name)) for (const r of identRefs(body, el.name.text)) add(key, r);
    }
  }
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && isAlias(n.expression) && n.name.text !== "data") add(n.name.text, n);
    else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "get" && isAlias(n.expression.expression)) {
      const a = n.arguments[0];
      if (a && ts.isStringLiteral(a)) add(a.text, n);
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out;
}

type RecordInput = { label: string; model: string; record: string; parent: string | null; via: string; refs: ts.Node[]; uses: Use[] };

const isStringType = (t: ts.TypeNode | undefined): boolean =>
  !!t && (t.kind === ts.SyntaxKind.StringKeyword || (ts.isUnionTypeNode(t) && t.types.some((x) => x.kind === ts.SyntaxKind.StringKeyword) && t.types.every((x) => x.kind === ts.SyntaxKind.StringKeyword || ts.isLiteralTypeNode(x) || x.kind === ts.SyntaxKind.UndefinedKeyword)));

/** The record ids an action takes: each parameter, or property of one, whose value names a record. */
function recordInputs(fn: Fn): RecordInput[] {
  const found: RecordInput[] = [];
  const consider = (label: string, member: string, refs: ts.Node[]) => {
    const uses = usesOf(refs, 0);
    const byName = NAME_MODELS[member.replace(/Ids$/, "Id")];
    const use = uses.find((u) => recordOf(u.model)) ?? (uses.length === 0 && byName ? { model: byName, via: "its name" } : null);
    if (!use) return;
    const r = recordOf(use.model)!;
    found.push({ label, model: use.model, record: r.record, parent: r.parent, via: use.via, refs, uses });
  };
  for (const p of fn.params) {
    if (ts.isIdentifier(p.name)) {
      const name = p.name.text;
      // An id by its name — or a plain string by what it is used as (`keepRef`, a URL segment).
      if (ID_NAME.test(name) || isStringType(p.type)) consider(name, name, identRefs(fn.body, name));
      if (!ID_NAME.test(name)) for (const [member, refs] of [...memberRefs(fn.body, name)].sort(([x], [y]) => x.localeCompare(y))) if (ID_NAME.test(member)) consider(`${name}.${member}`, member, refs);
    } else if (ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) {
        const member = ((el.propertyName ?? el.name) as ts.Identifier).text;
        if (member && ID_NAME.test(member) && ts.isIdentifier(el.name)) consider(`{${member}}`, member, identRefs(fn.body, el.name.text));
      }
    }
  }
  return found;
}

// ─── Verified without a helper: the super admin's alone, or the caller's own row ─────────────────

const SUPER_ADMIN = "src/lib/authz/super-admin.ts::actingAsSuperAdmin";
const SESSION = new Set(["src/lib/session.ts::requireUser", "src/lib/session.ts::currentUser", "src/lib/modules-access.ts::requireModuleUser", "src/lib/modules-access.ts::requireModuleAccess"]);

const strip = (e: ts.Expression): ts.Expression => {
  while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
};
const orTerms = (e: ts.Expression): ts.Expression[] => {
  e = strip(e);
  return ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken ? [...orTerms(e.left), ...orTerms(e.right)] : [e];
};
const refuses = (st: ts.Statement): boolean =>
  ts.isReturnStatement(st) || ts.isThrowStatement(st) || (ts.isBlock(st) && st.statements.length > 0 && refuses(st.statements[st.statements.length - 1]));

/**
 * `if (!(await actingAsSuperAdmin(user.id)) …) return …` as a statement of the action itself, before anything
 * but a plain copy (`const id = String(x ?? "")`) reads the record id.
 */
function superAdminOnly(fn: Fn, inputs: RecordInput[]): boolean {
  if (!ts.isBlock(fn.body)) return false;
  const idx = indexOf(fn.file);
  const refs = inputs.flatMap((i) => i.refs);
  for (const st of fn.body.statements) {
    if (ts.isIfStatement(st) && !st.elseStatement && refuses(st.thenStatement)) {
      const guard = orTerms(st.expression).some((t) => ts.isPrefixUnaryExpression(t) && t.operator === ts.SyntaxKind.ExclamationToken && (() => {
        const call = strip(t.operand);
        return ts.isCallExpression(call) && resolveCallee(idx, call.expression)?.key === SUPER_ADMIN;
      })());
      if (guard) return true;
    }
    const reads = refs.filter((r) => r.pos >= st.pos && r.end <= st.end);
    const copyOnly = ts.isVariableStatement(st) && reads.every((r) => {
      const v = transparent(r);
      return ts.isVariableDeclaration(v.parent) && v.parent.initializer === v;
    });
    if (reads.length && !copyOnly) return false;
  }
  return false;
}

/**
 * Whether a function hands back the signed-in user: `requireUser` and its kin, or a local helper returning what
 * one of them gave — itself (`calendarUser`), or as the `user` of an object (`const { user } = await gate()`).
 */
const sessionCache = new Map<string, "user" | "object" | null>();
function sessionShape(fn: Fn | null, depth = 0): "user" | "object" | null {
  if (!fn) return null;
  if (SESSION.has(fn.key)) return "user";
  if (sessionCache.has(fn.key)) return sessionCache.get(fn.key)!;
  sessionCache.set(fn.key, null);
  let shape: "user" | "object" | null = null;
  if (depth < 3) {
    const users = new Set([...callerVars(fn, depth + 1).keys()]);
    const visit = (n: ts.Node) => {
      if (shape) return;
      if (ts.isReturnStatement(n) && n.expression) {
        const e = strip(n.expression);
        const branches = ts.isConditionalExpression(e) ? [strip(e.whenTrue), strip(e.whenFalse)] : [e];
        if (branches.some((b) => ts.isIdentifier(b) && users.has(b.text))) shape = "user";
        else if (ts.isObjectLiteralExpression(e) && e.properties.some((p) => (ts.isShorthandPropertyAssignment(p) && p.name.text === "user" && users.has("user")) || (ts.isPropertyAssignment(p) && p.name.getText() === "user" && ts.isIdentifier(strip(p.initializer)) && users.has(strip(p.initializer).getText()))))
          shape = "object";
      }
      if (!ts.isFunctionLike(n) || n === fn.node) ts.forEachChild(n, visit);
    };
    visit(fn.node);
  }
  sessionCache.set(fn.key, shape);
  return shape;
}

/** The locals of a function holding the signed-in user (`const user = await requireUser()`), by name. */
function callerVars(fn: Fn, depth = 0): Map<string, true> {
  const idx = indexOf(fn.file);
  const out = new Map<string, true>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = strip(n.initializer);
      const shape = ts.isCallExpression(init) ? sessionShape(resolveCallee(idx, init.expression), depth) : null;
      if (shape === "user" && ts.isIdentifier(n.name)) out.set(n.name.text, true);
      if (shape === "object" && ts.isObjectBindingPattern(n.name))
        for (const el of n.name.elements) if (((el.propertyName ?? el.name) as ts.Identifier).text === "user" && ts.isIdentifier(el.name)) out.set(el.name.text, true);
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return out;
}

/** How a function writes its caller's id: `user.id` for each local holding the signed-in user, and copies of it. */
function callerIds(fn: Fn): Set<string> {
  const out = new Set([...callerVars(fn).keys()].map((v) => `${v}.id`));
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && out.has(strip(n.initializer).getText())) out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return out;
}

/** A read that only checks the id's shape (`typeof id`, `!id`) or names a path to revalidate. */
function harmlessRead(value: ts.Node): boolean {
  const p = skipWrappers(value).parent;
  if (ts.isTypeOfExpression(p) || (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken)) return true;
  if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === "isArray") return true;
  for (let a: ts.Node | undefined = value.parent; a && !ts.isStatement(a); a = a.parent) {
    if (ts.isCallExpression(a) && ts.isIdentifier(a.expression) && /^revalidate(Path|Tag)$/.test(a.expression.text)) return true;
  }
  return false;
}

/**
 * Every read of the record id is a key of a Prisma `where` that also pins the row to the caller —
 * `{ id, userId: user.id }` — or only checks its shape or names a path to revalidate. A copy of it is held
 * to the same; so is a function it is handed to with the caller's id beside it (`ownMeeting(user.id, id)`),
 * against that function's own parameter.
 */
function ownRecordOnly(fn: Fn, input: RecordInput): boolean {
  const mine = callerIds(fn);
  return pinnedReads(input.refs, mine, 0) || guardedOwnLoad(fn, input, mine);
}

/**
 * The row loaded by the id (`const log = await db.taskTimeLog.findUnique({ where: { id } })`), then refused unless
 * it is the caller's (`if (!log || log.userId !== user.id) return …`) — before anything else reads the id.
 */
function guardedOwnLoad(fn: Fn, input: RecordInput, mine: Set<string>): boolean {
  if (!ts.isBlock(fn.body) || !mine.size) return false;
  let row: string | null = null;
  for (const st of fn.body.statements) {
    const reads = input.refs.filter((r) => r.pos >= st.pos && r.end <= st.end).map((r) => transparent(r));
    if (row === null) {
      if (!reads.length) continue;
      const d = ts.isVariableStatement(st) && st.declarationList.declarations.length === 1 ? st.declarationList.declarations[0] : null;
      if (d && ts.isIdentifier(d.name) && reads.every((r) => harmlessRead(r) || prismaUse(r)?.arg === "where")) {
        row = d.name.text;
        continue;
      }
      if (reads.every((r) => harmlessRead(r))) continue;
      return false;
    }
    if (ts.isIfStatement(st) && !st.elseStatement && refuses(st.thenStatement)) {
      const owner = (side: ts.Expression) => ts.isPropertyAccessExpression(strip(side)) && (strip(side) as ts.PropertyAccessExpression).expression.getText() === row;
      const mismatch = orTerms(st.expression).some(
        (t) =>
          ts.isBinaryExpression(t) &&
          isOp(t, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken) &&
          ((owner(t.left) && mine.has(strip(t.right).getText())) || (owner(t.right) && mine.has(strip(t.left).getText()))),
      );
      if (mismatch) return true;
    }
    if (!reads.every((r) => harmlessRead(r))) return false;
  }
  return false;
}

function pinnedReads(refs: ts.Node[], mine: Set<string>, depth: number): boolean {
  if (!mine.size || !refs.length || depth > 6) return false;
  const isMine = (e: ts.Expression) => mine.has(strip(e).getText());
  return refs.every((ref) => {
    const value = transparent(ref);
    if (harmlessRead(value)) return true;
    // A copy: `const eventId = String(input.eventId ?? "")`.
    const decl = value.parent;
    if (ts.isVariableDeclaration(decl) && decl.initializer === value && ts.isIdentifier(decl.name)) {
      const name = decl.name.text;
      return pinnedReads(identRefs(bodyAround(decl), name).filter((r) => r.pos > decl.end), mine, depth + 1);
    }
    // Handed on with the caller's id beside it.
    const c = climb(value);
    if (c && c.keys.length === 0 && !prismaUse(value)) {
      const callee = resolveCallee(fileOf(value), c.call.expression);
      const own = c.call.arguments.findIndex((a, i) => i !== c.arg && isMine(a));
      const param = callee?.params[c.arg];
      const ownParam = callee?.params[own];
      if (!callee || own < 0 || !param || !ownParam || !ts.isIdentifier(param.name) || !ts.isIdentifier(ownParam.name)) return false;
      return pinnedReads(identRefs(callee.body, param.name.text), new Set([ownParam.name.text]), depth + 1);
    }
    const use = prismaUse(value);
    if (!use || use.arg !== "where") return false;
    // The object the id is a key of — through `{ in: ids }` — must also say whose row it is.
    let holder: ts.Node = skipWrappers(value).parent;
    if (ts.isShorthandPropertyAssignment(holder) || ts.isPropertyAssignment(holder)) holder = holder.parent;
    if (ts.isObjectLiteralExpression(holder) && holder.properties.every((p) => p.name && ts.isIdentifier(p.name) && PRISMA_OPERATORS.has(p.name.text))) {
      const up = skipWrappers(holder).parent;
      if (ts.isPropertyAssignment(up)) holder = up.parent;
    }
    return (
      ts.isObjectLiteralExpression(holder) &&
      holder.properties.some((p) => (ts.isPropertyAssignment(p) && isMine(p.initializer)) || (ts.isShorthandPropertyAssignment(p) && mine.has(p.name.text)))
    );
  });
}

// ─── The check ───────────────────────────────────────────────────────────────────────────────────

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);


const actionFiles: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.tsx?$/.test(name)) actionFiles.push(full);
  }
})(ACTIONS);

/**
 * The platform console, the CMS and the partner portal: they answer to their own staff and partner sign-ins
 * (requireStaff, cmsAction, requirePartner), not to a workspace's people and their record levels.
 */
const OTHER_SYSTEMS = /^src\/actions\/(platform|cms|partners)\//;
const actionKey = (fn: Fn) => `${rel(fn.file).replace(/^src\/actions\//, "")} ${fn.name}`;

section("The records");
{
  const missing = Object.keys(ROOT_MODELS).filter((m) => !SCHEMA.has(m));
  ok(`every record model is in prisma/schema.prisma (${Object.keys(ROOT_MODELS).length})`, missing.length === 0, missing.join(", "));
  const access = indexOf(path.join(SRC, "lib/authz/access.ts"));
  const fragments = [...access.fns.values()].flatMap((fn) => {
    const m = fn.exported ? /Promise<Prisma\.(\w+)WhereInput>/.exec(fn.node.type?.getText(access.sf) ?? "") : null;
    return m ? [m[1]] : [];
  });
  const unknownFragments = fragments.filter((m) => !ROOT_MODELS[m]);
  ok(`every record fragment in src/lib/authz/access.ts is for a model listed here (${fragments.length})`, fragments.length > 0 && unknownFragments.length === 0, unknownFragments.join(", "));
  const keysDecl = access.sf.statements.find((st) => ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === "ACCESS_RECORD_KEYS"));
  const recordKeys = keysDecl ? [...keysDecl.getText(access.sf).matchAll(/"(\w+)"/g)].map((m) => m[1]) : [];
  const unmapped = recordKeys.filter((k) => !RECORD_MODEL[k] || (k !== "vendors" && !Object.values(ROOT_MODELS).includes(k)));
  ok(`every record type in ACCESS_RECORD_KEYS has its model here (${recordKeys.length})`, recordKeys.length > 0 && unmapped.length === 0, unmapped.join(", "));
  const children = [...SCHEMA.keys()].filter((m) => !ROOT_MODELS[m] && recordOf(m)).length;
  ok(`${children} more models cannot exist without one of them (a ticket's comment, a document's line): their ids are record ids too`, children > 0);
}

section("The helpers");
const actions: Fn[] = [];
for (const f of actionFiles) {
  if (OTHER_SYSTEMS.test(rel(f))) continue;
  const idx = indexOf(f);
  if (!idx.useServer) continue;
  for (const fn of [...idx.fns.values()].sort((a, b) => a.line - b.line)) if (fn.exported) actions.push(fn);
}
/** A function where a table says it is — none when the file or the function is gone. */
const fnAt = (file: string, name: string): Fn | undefined => (existsSync(path.join(ROOT, file)) ? indexOf(path.join(ROOT, file)).fns.get(name) : undefined);
const listed = (table: Record<string, string[]>) => Object.entries(table).flatMap(([file, names]) => names.map((name) => ({ file, name, fn: fnAt(file, name) })));
const primitives = listed(PRIMITIVES);
const wrappers = listed(WRAPPERS);
const rules = listed(Object.fromEntries(Object.entries(OWN_RULES).map(([f, r]) => [f, Object.keys(r)])));
{
  const missing = primitives.filter((p) => !p.fn?.exported).map((p) => `${p.file} ${p.name}`);
  ok(`every primitive is an exported function where it is listed (${primitives.length})`, missing.length === 0, missing.join(", "));
  const gone = wrappers.filter((w) => !w.fn).map((w) => `${w.file} ${w.name}`);
  ok(`every named record helper is a function where it is listed (${wrappers.length})`, gone.length === 0, gone.join(", "));
  const noRule = rules.filter((r) => !r.fn).map((r) => `${r.file} ${r.name}`);
  ok(`every module's own rule is a function where it is listed (${rules.length})`, noRule.length === 0, noRule.join(", "));
  const stops = Object.keys(STOP).filter((k) => !fnAt(...(k.split("::") as [string, string])));
  ok(`every function the walk stops at exists (${Object.keys(STOP).length})`, stops.length === 0, stops.join(", "));
  const others = actionFiles.filter((f) => OTHER_SYSTEMS.test(rel(f)));
  const touching = others.filter((f) => [...indexOf(f).imports.values()].some((i) => i.file === path.join(SRC, "lib/db.ts")));
  ok(`the platform console, CMS and partner actions (${others.length} files, left out) never import the workspace database themselves`, touching.length === 0, touching.map(rel).join(", "));
}
discover([...actions, ...wrappers.flatMap((w) => (w.fn ? [w.fn] : []))]);
reaching = reachingSet(new Set([...primitiveKeys, ...wrapperKeys, ...ruleKeys]));
{
  const LINE = "src/lib/org-chart.ts::getDownlineUserIds";
  const toPrimitive = reachingSet(new Set([...primitiveKeys, LINE]));
  const loose = wrappers.filter((w) => w.fn && !toPrimitive.has(w.fn.key)).map((w) => `${w.file} ${w.name}`);
  ok("every named record helper reaches a primitive itself — or, for whose people, the reporting line (getDownlineUserIds)", loose.length === 0, loose.join(", "));
}

section("Actions that take a record id");
type Verdict = { fn: Fn; key: string; inputs: RecordInput[]; kind: "helper" | "super admin" | "own" | "none"; chain: string[] | null };
const verdicts: Verdict[] = [];
for (const fn of actions) {
  const inputs = recordInputs(fn);
  if (!inputs.length) continue;
  const chain = chainOf(fn, reaching, isHelper);
  const kind = chain ? "helper" : superAdminOnly(fn, inputs) ? "super admin" : inputs.every((i) => ownRecordOnly(fn, i)) ? "own" : "none";
  verdicts.push({ fn, key: actionKey(fn), inputs, kind, chain });
}
const at = (v: Verdict) => `${rel(v.fn.file)}:${v.fn.line} ${v.fn.name}`;
const takes = (v: Verdict) => v.inputs.map((i) => `${i.label} → ${i.model}${i.parent ? ` (${i.parent}'s)` : ""}`).join(", ");
const byKind = (k: Verdict["kind"]) => verdicts.filter((v) => v.kind === k);
const byKey = new Map(verdicts.map((v) => [v.key, v]));
const allActions = new Set(actions.map(actionKey));
const files = new Set(actions.map((a) => a.file)).size;

ok(`${verdicts.length} of the ${actions.length} exported actions in ${files} "use server" files take a record id`, verdicts.length > 0);
ok(`${byKind("helper").length} reach a record-scope helper`, true);
const sa = byKind("super admin");
ok(`${sa.length} are the super admin's alone — checked: refused first unless actingAsSuperAdmin${sa.length ? `: ${sa.map((v) => v.fn.name).join(", ")}` : ""}`, true);
const own = byKind("own");
ok(`${own.length} touch only the caller's own rows — checked: the id matched with the caller's id, or the row refused unless theirs${own.length ? `: ${own.map((v) => v.fn.name).join(", ")}` : ""}`, true);
const fresh = byKind("none").filter((v) => !(v.key in EXCEPTIONS) && !(v.key in KNOWN_GAPS));
ok(
  "every other action that takes a record id is in EXCEPTIONS or KNOWN_GAPS",
  fresh.length === 0,
  fresh.length ? `reaches no record-scope helper:\n${fresh.map((v) => `          ${at(v)}(${takes(v)})`).join("\n")}` : "",
);
const both = Object.keys(EXCEPTIONS).filter((k) => k in KNOWN_GAPS);
ok("no action is both an exception and a known gap", both.length === 0, both.join(", "));

/** An entry of either table, against what the action is now. */
function entry(table: "EXCEPTIONS" | "KNOWN_GAPS", key: string, reason: string) {
  const v = byKey.get(key);
  if (!allActions.has(key)) return ok(`${key} — ${reason}`, false, `no such action: take it out of ${table}`);
  if (!v) return ok(`${key} — ${reason}`, false, `it takes no record id now: take it out of ${table}`);
  if (v.kind !== "none") {
    const how = v.chain ? `it now reaches a helper (${v.chain.length ? v.chain.join(" > ") : "it is one"})` : `it is now ${v.kind === "own" ? "own rows only" : "the super admin's alone"}, as checked`;
    return ok(`${at(v)} — ${reason}`, false, table === "KNOWN_GAPS" ? `fixed — ${how}: remove it from KNOWN_GAPS` : `${how}: take it out of EXCEPTIONS`);
  }
  ok(`${at(v)} — ${reason}`, true);
}

section(`Exceptions (${Object.keys(EXCEPTIONS).length})`);
for (const key of Object.keys(EXCEPTIONS).sort()) entry("EXCEPTIONS", key, EXCEPTIONS[key]);

section(`Known gaps, still open (${Object.keys(KNOWN_GAPS).length})`);
for (const key of Object.keys(KNOWN_GAPS).sort()) entry("KNOWN_GAPS", key, KNOWN_GAPS[key]);

if (process.argv.includes("--list")) {
  section("Every action that takes a record id");
  for (const v of verdicts) {
    const how =
      v.kind === "helper" ? (v.chain!.length ? v.chain!.join(" > ") : "a helper itself") : v.kind === "none" ? (v.key in KNOWN_GAPS ? "KNOWN GAP" : v.key in EXCEPTIONS ? "exception" : "NOTHING") : v.kind === "own" ? "own rows only" : "super admin only";
    console.log(`  ${at(v)}(${takes(v)}) — ${how}`);
  }
}

console.log(
  `\n${passes} passed, ${failures} failed — ${verdicts.length} actions take a record id: ${byKind("helper").length} reach a helper, ${sa.length} super admin only, ` +
    `${own.length} own rows only, ${Object.keys(EXCEPTIONS).length} exceptions, ${Object.keys(KNOWN_GAPS).length} known gaps`,
);
console.error(`(${process.uptime().toFixed(1)}s)`);
process.exitCode = failures ? 1 : 0;
