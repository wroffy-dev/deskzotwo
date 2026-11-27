/**
 * The screens behind "Watch your AI team at work" on the website (owner, 23 Nov 2026: "i wanted a demo with real
 * workspaces screen on behind these agents working"): Deskzo's own pages — Today, a lead, Approvals, the customer
 * inbox, Automate, Collections, Read a bill, Banking, My HR and the HR desk — rendered from the local demo workspace
 * with its sidebar, and kept as public/platform-site/ai-team/screens.json — the website's /ai-team/screens.json, which
 * the block fetches when it comes into view (src/components/site/blocks/ai-team-demo-view.tsx). Run again after those
 * pages change:
 *
 *   npm run site:ai-team-screens
 *
 *   · As the local super admin, the real pages and the real menu; the header is the block's own, for the person each
 *     teammate works with.
 *   · Nobody real on the page: the super admin's name becomes Rohit Patil, and the owner's company Zenith.
 *   · A page among the website's, not an app: headings, landmarks and links become plain elements (no second h1 on the
 *     home page, no link to a workspace page a visitor can't open), and no ids or form targets.
 *
 * The local demo data only (DATABASE_URL); nothing is written anywhere but the JSON.
 */
import "dotenv/config";
import Module from "node:module";
import path from "node:path";
import fs from "node:fs";

// The public site's own folder: the proxy serves the bare domain from /platform-site, so this is /ai-team/screens.json there.
const OUT = path.join(__dirname, "..", "public", "platform-site", "ai-team", "screens.json");
const requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "site:ai-team-screens" });
let actor: { id: string; name: string; email: string; role: string } | null = null;
let currentPath = "/";
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return { headers: async () => requestHeaders, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      permanentRedirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => currentPath,
      useSearchParams: () => new URLSearchParams(),
      useParams: () => ({}),
    };
  }
  if (request === "@/lib/auth") {
    const session = async () => (actor ? { user: { ...actor, sid: null } } : null);
    return { auth: session, signIn: async () => {}, signOut: async () => {}, handlers: {} };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

/** A rendered page as one more element of the website's: no landmarks, headings, links, ids or form targets. */
function plain(html: string): string {
  return html
    .replace(/<(h[1-6]|main|header|nav|aside|section|form)\b/g, '<div data-tag="$1"')
    .replace(/<\/(h[1-6]|main|header|nav|aside|section|form)>/g, "</div>")
    .replace(/<a\b/g, '<span data-tag="a"')
    .replace(/<\/a>/g, "</span>")
    .replace(/\s(href|id|for|action|formaction|aria-labelledby|aria-controls|aria-describedby)="[^"]*"/g, "");
}

async function main() {
  const React = await import("react");
  const h = React.createElement;
  const { db } = await import("../src/lib/db");
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  actor = { ...admin, role: String(admin.role) };
  const { renderHtml } = await import("./lib/render-html");
  const { accessContextFor } = await import("../src/lib/modules-access");
  const { buildNavigation } = await import("../src/lib/navigation");
  const { Sidebar } = await import("../src/components/layout/sidebar");
  const { TeammateAvatar } = await import("../src/components/ai/teammate-avatar");
  const { formatLeadId } = await import("../src/lib/order-id");
  const navigation = buildNavigation((await accessContextFor(admin.id))!);
  // The lead Ved and Tara work on: the demo's most recently touched open one.
  const lead = await db.lead.findFirst({ where: { status: { notIn: ["WON", "LOST"] as never } }, orderBy: { updatedAt: "desc" }, select: { leadSeq: true } });
  if (!lead) throw new Error("The local demo workspace has no open lead.");
  const leadRef = formatLeadId(lead.leadSeq);

  // Nobody real: the super admin, and the owner's company as the demo data names it.
  const first = admin.name.split(/\s+/)[0]!;
  const swaps: [RegExp, string][] = [
    [new RegExp(admin.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "Rohit Patil"],
    [new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "Rohit"],
    [new RegExp(admin.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "rohit@zenith.example"],
    [/Wroffy Website/g, "Company website"],
    [/wroffy\.com/gi, "zenith.example"],
    [/Wroffy/g, "Zenith"],
  ];
  const swap = (s: string) => swaps.reduce((t, [re, to]) => t.replace(re, to), s);

  const header = h(
    "header",
    { className: "sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md md:px-6" },
    h("div", { className: "flex h-9 w-full max-w-md items-center gap-2 rounded-base border border-line bg-surface-sunken px-3 text-sm text-subtle" }, "Search leads, customers, invoices…"),
    h(
      "div",
      { className: "ml-auto flex items-center gap-3" },
      h("span", { className: "inline-flex h-8 items-center rounded-base bg-brand px-3 text-sm font-medium text-white" }, "+ New"),
      h("span", { className: "inline-flex h-8 items-center rounded-base border border-line px-3 text-sm text-text" }, "Ask Deskzo AI"),
      h(
        "span",
        { className: "flex items-center gap-2" },
        h("span", { "data-mk": "initials", className: "inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white" }, "RP"),
        h("span", { className: "hidden text-left leading-tight lg:block" }, h("span", { "data-mk": "who", className: "block text-[13px] font-medium text-text" }, "Rohit Patil"), h("span", { "data-mk": "role", className: "block text-[11px] text-subtle" }, "Sales")),
      ),
    ),
  );
  const screens: [string, string, string, Record<string, string>][] = [
    ["ved-today", "/today", "today/page", {}],
    ["ved-lead", `/leads/${leadRef}`, "leads/[id]/page", { id: leadRef }],
    ["tara-approvals", "/approvals", "approvals/page", {}],
    ["kabir-inbox", "/inbox", "inbox/page", {}],
    ["mira-automate", "/automate/workflows", "automate/workflows/page", {}],
    ["mira-workflow", "/automate/workflows/WF-0001", "automate/workflows/[ref]/page", { ref: "WF-0001" }],
    ["arjun-collections", "/collections", "collections/page", {}],
    ["arjun-bill", "/purchase/bills/read", "purchase/bills/read/page", {}],
    ["arjun-bank", "/accounting/banking", "accounting/banking/page", {}],
    ["priya-myhr", "/people/me", "people/me/page", {}],
    ["priya-hr", "/people/hr-desk", "people/hr-desk/page", {}],
  ];
  const out: { lead: string; screens: Record<string, string>; faces: Record<string, string> } = { lead: leadRef, screens: {}, faces: {} };
  for (const [name, route, file, params] of screens) {
    currentPath = route;
    const Page = (await import(`../src/app/(dashboard)/${file}`)).default as (p: unknown) => Promise<unknown>;
    const page = await Page({ params: Promise.resolve(params), searchParams: Promise.resolve({}) });
    const shell = h(
      "div",
      { className: "flex min-h-screen" },
      h(Sidebar as never, { navigation }),
      h("div", { className: "relative flex min-w-0 flex-1 flex-col overflow-x-clip" }, header, h("main", { className: "mx-auto w-full max-w-[1600px] flex-1 px-4 pt-6 md:px-6 md:py-8" }, page as never)),
    );
    out.screens[name] = plain(swap(await renderHtml(shell)));
    console.log(`  ${name.padEnd(18)} ${route} — ${(out.screens[name].length / 1024).toFixed(0)} KB`);
  }
  for (const k of ["deskzo", "ved", "tara", "kabir", "mira", "arjun", "priya"]) out.faces[k] = await renderHtml(h(TeammateAvatar as never, { teammate: k, size: "sm" }));
  const all = JSON.stringify(out);
  const left = [admin.name, admin.email, "wroffy"].filter((s) => all.toLowerCase().includes(s.toLowerCase()));
  if (left.length) throw new Error(`Still on the screens: ${left.join(", ")} — add a swap.`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, all);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)} — ${(all.length / 1024).toFixed(0)} KB, the lead ${leadRef}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
