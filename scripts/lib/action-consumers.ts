import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { withDependencies } from "../../src/lib/entitlements";
import { MODULE_REGISTRY } from "../../src/lib/modules";

/**
 * Whose page a file is, and who uses a server action — shared by `check:module-guards` and the classification that
 * decided which actions check the section as well as the plan (owner, 3 Nov 2026 — Phase 2 permission fixes, audit
 * L-6).
 *
 * Ownership is one notion: a page is a module's when its route is one of the module's links (or listed below), and a
 * component when its folder is the module's. A module's plan always brings the modules it requires with it, so for
 * the plan a page owns those too (`ownModules`). A role's section ticks bring nothing with them — the order form is
 * open to somebody whose role has Items unticked — so for the section a page owns only its own (`directModules`).
 *
 * A consumer is found by following named imports of the action, transitively, through whatever imports them
 * (components, other actions, colocated files) up to the files that render or call them: a page, layout or route
 * handler (src/app), or code in src/lib (which anything may call, so it is never a module's own). An export that only
 * uses a binding in a type position does not use it.
 */

export const ROOT = process.cwd();
export const SRC = path.join(ROOT, "src");

export function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
export const rel = (full: string, from: string = ROOT) => path.relative(from, full).split(path.sep).join("/");

// ─── Whose page a file is ──────────────────────────────────────────────────────────────────────

/** Each module's pages, longest first, so /items/brands is found before /items. */
export const hrefs = MODULE_REGISTRY.flatMap((m) => m.navItems.map((i) => [i.href, m.key] as const)).sort((a, b) => b[0].length - a[0].length);
/** Pages that are a module's own though its nav does not list them. */
export const EXTRA_ROUTES: [string, string][] = [
  ["/documents", "sales_documents"],
  ["/documents", "purchase_documents"],
  // Printed or downloaded from inside the module: an HR letter, a payslip, an employee's document.
  ["/letters", "hr"],
  ["/payslips", "payroll"],
  ["/api/hr", "hr"],
  // The Deskzo app's calling (src/lib/app): every route there asks for Calls first (appRoute({ calls: true })).
  ["/api/app/calls", "calls"],
];
/** Component folders that belong to one module. */
export const COMPONENT_FOLDERS: Record<string, string[]> = {
  accounting: ["accounting"],
  assets: ["it_assets"],
  calendar: ["calendar"],
  cards: ["cards"],
  signatures: ["signatures"],
  close: ["revenue_close"],
  credit: ["receivables"],
  documents: ["sales_documents", "purchase_documents"],
  forms: ["forms"],
  hr: ["hr"],
  notes: ["notes"],
  revenue: ["revenue_close"],
  support: ["helpdesk"],
  targets: ["targets"],
  tickets: ["helpdesk"],
  wins: ["wins"],
  workspace: ["workspace"],
};

/** The route a file under src/app serves, its dynamic segments as "x" — null for anything else. */
export function routeOf(file: string): string | null {
  const path_ = rel(file);
  const page = path_.match(/^src\/app\/\((?:dashboard|print|tv)\)(\/.*?)\/[^/]+\.tsx?$/) ?? path_.match(/^src\/app(\/api\/.*?)\/[^/]+\.tsx?$/);
  return page ? page[1]!.replace(/\/\[[^\]]+\]/g, "/x") : null;
}

/** The modules a file is a page or component of — its own, without what they require. */
export function directModules(file: string): string[] {
  const own: string[] = [];
  const route = routeOf(file);
  if (route) {
    own.push(...hrefs.filter(([h]) => route === h || route.startsWith(`${h}/`)).map(([, k]) => k).slice(0, 1));
    own.push(...EXTRA_ROUTES.filter(([h]) => route === h || route.startsWith(`${h}/`)).map(([, k]) => k));
  }
  const folder = rel(file).match(/^src\/components\/([^/]+)\//)?.[1];
  if (folder) own.push(...(COMPONENT_FOLDERS[folder] ?? []));
  return [...new Set(own)];
}

/** The modules a file belongs to, with everything they require — which are always in the plan with them. */
export function ownModules(file: string): string[] {
  return [...withDependencies(directModules(file))];
}

// ─── The import graph ──────────────────────────────────────────────────────────────────────────

const SPECIAL = /^(page|layout|template|default|error|global-error|not-found|loading|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.tsx?$/;

/** Where following stops: what renders or calls the action, rather than passing it on. */
export type TerminalKind = "page" | "route" | "layout" | "lib" | "other";
export function terminalKind(file: string): TerminalKind | null {
  const r = rel(file);
  if (r.startsWith("src/app/")) {
    const base = path.basename(r);
    if (!SPECIAL.test(base)) return null;
    if (/^route\./.test(base)) return "route";
    if (/^(layout|template)\./.test(base)) return "layout";
    return "page";
  }
  if (r.startsWith("src/lib/")) return "lib";
  if (r === "src/proxy.ts" || r.startsWith("src/instrumentation")) return "other";
  return null;
}

type Binding = { target: string; name: string };
type FileInfo = {
  /** Local binding → what it imports (name "*" is the whole module). */
  imports: Map<string, Binding>;
  /** Top-level unit (a declared name, or "<side>" for top-level statements) → local names and dynamic imports it uses. */
  units: Map<string, { refs: Set<string>; dynamic: Binding[] }>;
  /** Exported name → the local units it is. */
  exports: Map<string, string[]>;
  /** `export { a as b } from "x"` — exported name → binding. */
  reexports: Map<string, Binding>;
  /** `export * from "x"`. */
  starFrom: string[];
};

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (/\.tsx?$/.test(cand) && existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** The value-position identifiers and dynamic imports inside a node — types, property names and declared names skipped. */
function usesIn(node: ts.Node, file: string): { refs: Set<string>; dynamic: Binding[] } {
  const refs = new Set<string>();
  const dynamic: Binding[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const target = resolveSpec(file, n.arguments[0].text);
      if (target) {
        // `const { a, b } = await import("x")` uses a and b; anything else, the whole module.
        let p: ts.Node = n.parent;
        if (ts.isAwaitExpression(p)) p = p.parent;
        if (ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) {
            const name = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
            dynamic.push({ target, name: name ?? "*" });
          }
        } else dynamic.push({ target, name: "*" });
      }
    }
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const skip =
        (p && ts.isPropertyAccessExpression(p) && p.name === n) ||
        (p && ts.isPropertyAssignment(p) && p.name === n) ||
        (p && (ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name === n) ||
        (p && ts.isJsxAttribute(p) && p.name === n) ||
        (p && ts.isBindingElement(p) && p.propertyName === n) ||
        (p && ts.isQualifiedName(p));
      if (!skip) refs.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { refs, dynamic };
}

function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

function parse(file: string, text: string): FileInfo {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const info: FileInfo = { imports: new Map(), units: new Map(), exports: new Map(), reexports: new Map(), starFrom: [] };
  const exported = (node: ts.Node) => !!(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
  const isDefault = (node: ts.Node) => !!(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Default);
  const addUnit = (name: string, node: ts.Node) => {
    const u = usesIn(node, file);
    const prev = info.units.get(name);
    if (prev) {
      u.refs.forEach((r) => prev.refs.add(r));
      prev.dynamic.push(...u.dynamic);
    } else info.units.set(name, u);
  };
  const addExport = (name: string, unit: string) => info.exports.set(name, [...(info.exports.get(name) ?? []), unit]);
  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (stmt.importClause?.isTypeOnly || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const target = resolveSpec(file, stmt.moduleSpecifier.text);
      if (!target) continue;
      const clause = stmt.importClause;
      if (!clause) {
        info.imports.set(`<bare:${target}>`, { target, name: "*" });
        addUnit("<side>", ts.factory.createIdentifier(`<bare:${target}>`));
        info.units.get("<side>")!.refs.add(`<bare:${target}>`);
        continue;
      }
      if (clause.name) info.imports.set(clause.name.text, { target, name: "default" });
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) info.imports.set(nb.name.text, { target, name: "*" });
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) info.imports.set(el.name.text, { target, name: (el.propertyName ?? el.name).text });
    } else if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      const target = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? resolveSpec(file, stmt.moduleSpecifier.text) : null;
      if (stmt.moduleSpecifier && !target) continue;
      if (!stmt.exportClause && target) info.starFrom.push(target);
      else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.isTypeOnly) continue;
          const local = (el.propertyName ?? el.name).text;
          if (target) info.reexports.set(el.name.text, { target, name: local });
          else addExport(el.name.text, local);
        }
      } else if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause) && target) info.reexports.set(stmt.exportClause.name.text, { target, name: "*" });
    } else if (ts.isExportAssignment(stmt)) {
      addUnit("<default>", stmt.expression);
      addExport("default", "<default>");
    } else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      const name = stmt.name?.text ?? "<default>";
      addUnit(name, stmt);
      if (exported(stmt)) addExport(isDefault(stmt) ? "default" : name, name);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const names = bindingNames(decl.name);
        for (const n of names) {
          addUnit(n, decl);
          if (exported(stmt)) addExport(n, n);
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isModuleDeclaration(stmt)) {
      continue;
    } else {
      addUnit("<side>", stmt);
    }
  }
  return info;
}

export type Node = `${string}#${string}`;
const node = (file: string, name: string): Node => `${file}#${name}`;

export type ConsumerOf = {
  /** The file that renders or calls it. */
  file: string;
  kind: TerminalKind;
  /** How it got there, from the action up: "src/components/x.tsx#Widget", … */
  chain: string[];
  /** What it imports that leads to the action, each as "file#export" — the action itself when it calls it. */
  uses: string[];
};

export class ActionGraph {
  readonly files: string[];
  readonly texts = new Map<string, string>();
  private infos = new Map<string, FileInfo>();
  /** (target, name) → the nodes that use it. */
  private users = new Map<Node, Set<Node>>();
  /** target → files that `export *` from it. */
  private starUsers = new Map<string, Set<string>>();

  constructor() {
    this.files = walk(SRC);
    for (const f of this.files) {
      const text = readFileSync(f, "utf8");
      this.texts.set(f, text);
      this.infos.set(f, parse(f, text));
    }
    for (const [f, info] of this.infos) {
      // What each export uses, through the file's own top-level units.
      const exportNames = [...info.exports.keys()];
      const sideUses = this.closure(info, ["<side>"]);
      for (const name of exportNames) {
        const uses = this.closure(info, [...info.exports.get(name)!, "<side>"]);
        for (const b of uses) this.addUse(b, node(f, name));
      }
      // Side effects run for whoever imports the file at all.
      if (exportNames.length === 0) for (const b of sideUses) this.addUse(b, node(f, "<side>"));
      for (const [name, b] of info.reexports) this.addUse(b, node(f, name));
      for (const t of info.starFrom) {
        if (!this.starUsers.has(t)) this.starUsers.set(t, new Set());
        this.starUsers.get(t)!.add(f);
      }
    }
  }

  private addUse(b: Binding, user: Node) {
    const key = node(b.target, b.name);
    if (!this.users.has(key)) this.users.set(key, new Set());
    this.users.get(key)!.add(user);
  }

  /** The imported bindings (and same-file exports) a set of units reaches. */
  private closure(info: FileInfo, start: string[]): Binding[] {
    const seen = new Set<string>();
    const out: Binding[] = [];
    const stack = [...start];
    while (stack.length) {
      const u = stack.pop()!;
      if (seen.has(u)) continue;
      seen.add(u);
      const unit = info.units.get(u);
      if (!unit) continue;
      out.push(...unit.dynamic);
      for (const r of unit.refs) {
        const imp = info.imports.get(r);
        if (imp) out.push(imp);
        else if (info.units.has(r) && !seen.has(r)) stack.push(r);
      }
    }
    return out;
  }

  /** Same-file exports a unit reaches — so an export calling another export of its file is that one's user. */
  private sameFileUsers(file: string, name: string): Node[] {
    const info = this.infos.get(file)!;
    const locals = new Set(info.exports.get(name) ?? []);
    const out: Node[] = [];
    for (const [other, units] of info.exports) {
      if (other === name) continue;
      const seen = new Set<string>();
      const stack = [...units];
      let hit = false;
      while (stack.length && !hit) {
        const u = stack.pop()!;
        if (seen.has(u)) continue;
        seen.add(u);
        for (const r of info.units.get(u)?.refs ?? []) {
          if (locals.has(r)) hit = true;
          else if (info.units.has(r)) stack.push(r);
        }
      }
      if (hit) out.push(node(file, other));
    }
    return out;
  }

  /** The nodes that use one directly. */
  private directUsers(n: Node): Node[] {
    const [file, name] = n.split("#") as [string, string];
    const out = new Set<Node>([...(this.users.get(n) ?? []), ...(this.users.get(node(file, "*")) ?? [])]);
    for (const f of this.starUsers.get(file) ?? []) out.add(node(f, name));
    if (this.infos.has(file)) for (const u of this.sameFileUsers(file, name)) out.add(u);
    return [...out];
  }

  /** A file's own names for another file's export — its import, a namespace import, or `const { name } = await import(…)`. */
  bindingsFor(file: string, target: string, name: string): string[] {
    const info = this.infos.get(file);
    if (!info) return [];
    const out = [...info.imports].filter(([, b]) => b.target === target && (b.name === name || b.name === "*")).map(([local]) => local);
    for (const u of info.units.values()) if (u.dynamic.some((d) => d.target === target && (d.name === name || d.name === "*"))) out.push(name);
    return [...new Set(out)];
  }

  /**
   * Everything that renders or calls this export, followed transitively. Also the dead ends — files nothing imports,
   * whose use of it runs nowhere.
   */
  consumersOf(file: string, name: string): { consumers: ConsumerOf[]; deadEnds: string[] } {
    const start = node(file, name);
    const prev = new Map<Node, Node | null>([[start, null]]);
    const queue: Node[] = [start];
    const consumers = new Map<string, ConsumerOf>();
    const deadEnds = new Set<string>();
    const chainOf = (n: Node) => {
      const chain: string[] = [];
      for (let c: Node | null = n; c; c = prev.get(c) ?? null) chain.push(`${rel(c.split("#")[0]!)}#${c.split("#")[1]}`);
      return chain.reverse();
    };
    while (queue.length) {
      const cur = queue.shift()!;
      const users = this.directUsers(cur);
      const curFile = cur.split("#")[0]!;
      if (cur !== start && users.length === 0 && !terminalKind(curFile)) deadEnds.add(rel(curFile));
      for (const u of users) {
        const uFile = u.split("#")[0]!;
        const kind = terminalKind(uFile);
        if (kind) {
          // Every way in counts: a page may both call the action and render a component that does.
          if (!consumers.has(uFile)) consumers.set(uFile, { file: uFile, kind, chain: [...chainOf(cur), `${rel(uFile)}#${u.split("#")[1]}`], uses: [] });
          const used = `${rel(cur.split("#")[0]!)}#${cur.split("#")[1]}`;
          if (!consumers.get(uFile)!.uses.includes(used)) consumers.get(uFile)!.uses.push(used);
          continue;
        }
        if (prev.has(u)) continue;
        prev.set(u, cur);
        queue.push(u);
      }
    }
    return { consumers: [...consumers.values()], deadEnds: [...deadEnds] };
  }
}

// ─── Whether a page asks after the module first ────────────────────────────────────────────────

/** A module gate: `isModuleEnabled`, `moduleAccess`, `requireModuleAccess` or `moduleAccessFor` — `decideModuleAccess`, as the menus. */
const gateCall = (k: string) => new RegExp(`\\b(?:isModuleEnabled|moduleAccess|requireModuleAccess)\\(\\s*(?:\\[[^\\]]*)?"${k}"|\\bmoduleAccessFor\\([^,()]+,\\s*"${k}"`, "g");
/** What a page does when the module isn't open to the person — within a few lines of asking. */
const REFUSAL = /notFound\(\)|<ModuleDisabledNotice|redirect\(|return null|throw |forbidden\(\)|unauthorized\(\)|return (?:new )?Response|NextResponse|appFailure\(|status: 40\d/g;

/**
 * Where, in a page, layout or route handler, the module has been asked after and refused: the end of each refusal
 * that follows a gate for one of these modules. Only the file itself counts — Next renders a page and its layouts in
 * parallel, so a layout's gate does not stop the page's own calls.
 */
function refusalsIn(text: string, modules: readonly string[]): number[] {
  const out: number[] = [];
  for (const k of modules) {
    for (const m of text.matchAll(gateCall(k))) {
      const window = text.slice(m.index!, m.index! + 1500).split("\n").slice(0, 15).join("\n");
      const r = [...window.matchAll(REFUSAL)][0];
      if (r) out.push(m.index! + r.index! + r[0].length);
      else if (text.includes(`<ModuleDisabledNotice moduleKey="${k}"`)) out.push(text.indexOf(`<ModuleDisabledNotice moduleKey="${k}"`, m.index!) + 1);
    }
    // The Deskzo app's calling routes ask for Calls in appRoute itself, before the handler runs.
    if (k === "calls") for (const m of text.matchAll(/appRoute\(\{\s*calls: true\s*\}/g)) out.push(m.index! + m[0].length);
  }
  return out.filter((n) => n > 0);
}

/**
 * Whether a page only reaches what it uses from an action after asking after the module: every use of the binding it
 * imports is in a top-level function that has asked and refused before it, or in a local function or component that
 * is itself only reached that way. A use before the gate — in a `Promise.all` beside it, or in `generateMetadata`,
 * which runs beside the page — would turn the page's "not open to you" into an error.
 */
export function usedAfterGate(graph: ActionGraph, file: string, binding: string, modules: readonly string[]): boolean {
  const text = graph.texts.get(file)!;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const top = source.statements.filter((s) => !ts.isImportDeclaration(s));
  const nameOf = (s: ts.Statement): string | null => {
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) return s.name.text;
    if (ts.isVariableStatement(s) && s.declarationList.declarations.length === 1 && ts.isIdentifier(s.declarationList.declarations[0]!.name)) return s.declarationList.declarations[0]!.name.text;
    return null;
  };
  const exported = (s: ts.Node) => ts.isExportAssignment(s) || ts.isExportDeclaration(s) || !!(ts.getCombinedModifierFlags(s as ts.Declaration) & ts.ModifierFlags.Export);
  const refusals = refusalsIn(text, modules);
  const memo = new Map<string, boolean>();
  const safe = (name: string): boolean => {
    if (memo.has(name)) return memo.get(name)!;
    memo.set(name, false);
    let ok = true;
    let used = false;
    for (const stmt of top) {
      const own = nameOf(stmt);
      const visit = (n: ts.Node): void => {
        if (!ok) return;
        if (ts.isIdentifier(n) && n.text === name && n !== (stmt as { name?: ts.Node }).name) {
          const p = n.parent;
          const declName = p && (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && (p as { name?: ts.Node }).name === n;
          const prop = p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n));
          if (!declName && !prop && !ts.isTypeNode(p)) {
            used = true;
            const start = stmt.getStart(source);
            const asked = refusals.some((r) => r > start && r < n.getStart(source) && r <= stmt.end);
            if (!asked) ok = !exported(stmt) && !!own && own !== name && safe(own);
          }
        }
        ts.forEachChild(n, visit);
      };
      if (ts.isExportDeclaration(stmt)) {
        // `export { X }` hands the binding on: whoever imports it uses it.
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause) && stmt.exportClause.elements.some((e) => (e.propertyName ?? e.name).text === name)) ok = false;
        continue;
      }
      visit(stmt);
      if (!ok) break;
    }
    memo.set(name, ok && used);
    return ok && used;
  };
  return safe(binding);
}

/**
 * Whether one consumer is the module's own: a page, layout or route of these modules alone (each of them one of the
 * action's, so whoever may open it may call it), which asks after them before it uses the action.
 */
export function ownedBy(graph: ActionGraph, consumer: ConsumerOf, modules: readonly string[]): { owned: boolean; why: string } {
  if (consumer.kind === "lib") return { owned: false, why: "src/lib code" };
  if (consumer.kind === "other") return { owned: false, why: "outside the app's pages" };
  const direct = directModules(consumer.file);
  if (direct.length === 0) return { owned: false, why: "a page no module owns" };
  if (direct.some((k) => !modules.includes(k))) return { owned: false, why: `a page of ${direct.join("|")}` };
  if (refusalsIn(graph.texts.get(consumer.file)!, modules).length === 0) return { owned: false, why: `a page of ${direct.join("|")} that doesn't ask after the module` };
  // Each export of the next file up that the page imports, by the page's own name for it.
  for (const use of consumer.uses) {
    const [usedFile, usedName] = use.split("#") as [string, string];
    const bindings = graph.bindingsFor(consumer.file, path.join(ROOT, usedFile), usedName);
    if (bindings.length === 0 || !bindings.every((b) => usedAfterGate(graph, consumer.file, b, modules))) {
      return { owned: false, why: `a page of ${direct.join("|")} that uses ${use.split("/").pop()} before asking after the module` };
    }
  }
  return { owned: true, why: "asks after the module first" };
}
