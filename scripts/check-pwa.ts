/**
 * The workspace as an app on a phone's home screen (src/lib/pwa.ts): its manifest, its icons, the head tags
 * that make an iPhone install it, and the service worker (public/sw.js) — run in a stand-in browser to show
 * what it keeps offline and when it lets go of it (owner, 6 Nov 2026), and that it only steps in when the phone is offline. Then what makes it feel like the
 * phone app (owner, 31 Oct 2026): the Today screen it opens on, and the tabs along the bottom.
 *
 * The branding is a stand-in, swapped per case, so nothing in the database is read or written.
 *
 *   npm run check:pwa
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageResponse } from "next/og";
import type { Branding } from "../src/lib/branding";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
const section = (title: string) => console.log(`\n— ${title} —\n`);

// ── The workspace's branding, as the routes read it ─────────────────────────────────────────────

const BASE: Branding = {
  appName: "Acme Industries",
  shortName: null,
  tagline: null,
  logoDataUrl: null,
  faviconDataUrl: null,
  primaryColor: "#0f766e",
  defaultTheme: "system",
};
let branding: Branding = BASE;
const brandingStub = { getBranding: async () => branding };
/** Where the tab bar thinks the phone is. */
let pathnameNow = "/today";
const navigationStub = { usePathname: () => pathnameNow, useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {} }), useSearchParams: () => new URLSearchParams() };

const load = Module.createRequire(__filename);
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown; _resolveFilename(request: string, parent: unknown, isMain: boolean): string };
const brandingFile = load.resolve("../src/actions/branding");
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@/actions/branding") return brandingStub;
  if (request === "next/navigation") return navigationStub;
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved === brandingFile) return brandingStub;
  return realLoad.call(this, request, parent, isMain);
};

const pwa = load("../src/lib/pwa") as typeof import("../src/lib/pwa");
const manifestRoute = load("../src/app/api/pwa/manifest/route") as typeof import("../src/app/api/pwa/manifest/route");
const iconRoute = load("../src/app/api/pwa/icon/[name]/route") as typeof import("../src/app/api/pwa/icon/[name]/route");
const { InstallApp } = load("../src/components/layout/install-app") as typeof import("../src/components/layout/install-app");
const { AppTabBar } = load("../src/components/layout/app-tab-bar") as typeof import("../src/components/layout/app-tab-bar");
const { TodayView } = load("../src/components/today/today-view") as typeof import("../src/components/today/today-view");

/** A PNG of a plain square, drawn the way the icons are — a picture to put on one. */
async function pngOf(width: number, height: number): Promise<string> {
  const bytes = Buffer.from(await new ImageResponse(createElement("div", { style: { width: "100%", height: "100%", background: "#e11d48" } }), { width, height }).arrayBuffer());
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
const svgOf = (body: string) => `data:image/svg+xml;base64,${Buffer.from(body).toString("base64")}`;
const SQUARE_SVG = svgOf('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#1d4ed8"/></svg>');

async function icon(name: string) {
  const response = await iconRoute.GET(new Request(`https://acme.deskzo.com/api/pwa/icon/${name}`), { params: Promise.resolve({ name }) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { response, bytes, size: pwa.pngSize(bytes) };
}

async function main() {
  section("The manifest");
  {
    branding = { ...BASE, shortName: "Acme" };
    const response = await manifestRoute.GET();
    const manifest = (await response.json()) as Record<string, unknown> & { icons: { src: string; sizes: string; purpose: string }[] };
    ok("answered as a web app manifest", response.status === 200 && (response.headers.get("content-type") ?? "").startsWith("application/manifest+json"));
    ok("kept privately, never by a shared cache", response.headers.get("cache-control") === "private, max-age=3600");
    ok("the workspace's name, and its short name under the icon", manifest.name === "Acme Industries" && manifest.short_name === "Acme");
    ok("opens on Today, full screen, over the whole address", manifest.start_url === "/today" && manifest.scope === "/" && manifest.display === "standalone" && manifest.id === "/");
    ok("in the brand colour", manifest.theme_color === "#0f766e");
    ok(
      "icons at 192 and 512, and a maskable one",
      manifest.icons.length === 3 &&
        manifest.icons.some((i) => i.sizes === "192x192" && i.purpose === "any") &&
        manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "any") &&
        manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"),
    );
    ok("every icon it names is one the icon route draws", manifest.icons.every((i) => i.src.startsWith("/api/pwa/icon/") && pwa.isPwaIcon(i.src.slice("/api/pwa/icon/".length))));
    branding = { ...BASE, primaryColor: "red" };
    ok("a colour that isn't a hex colour falls back to the default", pwa.pwaManifest(branding).theme_color === "#4f46e5");
    ok("no short name: the app's name under the icon", pwa.homeScreenName({ ...BASE }) === "Acme Industries");
    ok("a very long name is cut for the home screen", pwa.homeScreenName({ ...BASE, appName: "A".repeat(80) }).length === 30);
  }

  section("The icons");
  {
    branding = BASE;
    for (const [name, spec] of Object.entries(pwa.PWA_ICONS)) {
      const { response, size } = await icon(name);
      ok(`${name}: a ${spec.size}×${spec.size} PNG`, response.status === 200 && response.headers.get("content-type") === "image/png" && size?.width === spec.size && size?.height === spec.size, size ? `${size.width}×${size.height}` : "not a PNG");
    }
    const unknown = await icon("1024");
    ok("an icon it doesn't draw is not found", unknown.response.status === 404);

    // Deskzo's icon on every workspace's app (owner, 23 Oct 2026): the company's favicon and logo don't change it.
    const deskzo192 = (await icon("192")).bytes;
    branding = { ...BASE, primaryColor: "#e11d48", faviconDataUrl: SQUARE_SVG, logoDataUrl: await pngOf(200, 200) };
    ok("a company's own favicon, logo and colour leave Deskzo's icon as it is", (await icon("192")).bytes.equals(deskzo192));
    ok("…on the iPhone's and the maskable one too", (await icon("180")).size?.width === 180 && (await icon("maskable")).size?.width === 512);
    const route = readFileSync(path.join(__dirname, "../src/app/api/pwa/icon/[name]/route.tsx"), "utf8");
    ok("drawn from Deskzo's icon, never the branding", /deskzoIconDataUrl/.test(route) && !/getBranding/.test(route));
    branding = BASE;

    ok("a PNG's size is read from its header", JSON.stringify(pwa.pngSize(Buffer.from((await pngOf(120, 64)).split(",")[1], "base64"))) === JSON.stringify({ width: 120, height: 64 }));
    ok("…and anything else has none", pwa.pngSize(Buffer.from("GIF89a-not-a-png-at-all")) === null);
  }

  section("What the pages add to their head");
  {
    branding = { ...BASE, shortName: "Acme", faviconDataUrl: SQUARE_SVG };
    const meta = await pwa.appMetadata();
    const apple = (meta.icons as { apple: { url: string; sizes: string }[] }).apple;
    const tab = (meta.icons as { icon: { url: string; type?: string }[] }).icon;
    ok("links the manifest", meta.manifest === "/api/pwa/manifest");
    ok("an iPhone opens it full screen, named as on the home screen", (meta.appleWebApp as { capable: boolean; title: string }).capable === true && (meta.appleWebApp as { title: string }).title === "Acme");
    ok("the iPhone's own icon at 180", apple.length === 1 && apple[0].url === "/api/pwa/icon/180" && apple[0].sizes === "180x180");
    ok(
      "Deskzo's icon in the tab, as an .ico and an SVG (a layout's icons replace the root's)",
      tab.length === 2 && tab[0].url === "/favicon.ico" && tab[1].type === "image/svg+xml" && tab[1].url.startsWith("data:image/svg+xml;base64,"),
    );
    ok("…not the company's favicon", tab.every((i) => i.url !== SQUARE_SVG));
    ok("the tag older iPhones read", (meta.other as Record<string, string>)["apple-mobile-web-app-capable"] === "yes");
    branding = BASE;
    ok("the same icons with no favicon", JSON.stringify((await pwa.appMetadata()).icons) === JSON.stringify(meta.icons));
    const root = readFileSync(path.join(__dirname, "../src/app/layout.tsx"), "utf8");
    ok("every other page's tab shows Deskzo's icon too", /icons: deskzoFavicons\(\)/.test(root) && !/faviconDataUrl/.test(root));

    const layout = readFileSync(path.join(__dirname, "../src/app/(dashboard)/layout.tsx"), "utf8");
    const login = readFileSync(path.join(__dirname, "../src/app/(auth)/login/page.tsx"), "utf8");
    ok("the signed-in pages carry it, and register the worker", /export const generateMetadata = appMetadata;/.test(layout) && /<InstallApp /.test(layout));
    ok("the sign-in page carries it", /export const generateMetadata = appMetadata;/.test(login));
    const publicLayout = readFileSync(path.join(__dirname, "../src/app/(public)/layout.tsx"), "utf8");
    ok("a customer's public pages don't (a form or portal is not this app)", !/appMetadata|InstallApp/.test(publicLayout));
    ok("the install hint draws nothing on the server (it is a fact about the phone)", renderToStaticMarkup(createElement(InstallApp, { appName: "Acme", hint: true })) === "");
  }

  section("The proxy");
  {
    const proxy = readFileSync(path.join(__dirname, "../src/proxy.ts"), "utf8");
    const prefixes = /const PUBLIC_PREFIXES = \[([^\]]*)\]/.exec(proxy)?.[1] ?? "";
    ok("/sw.js reached with nobody signed in", /"\/sw\.js"/.test(prefixes));
    ok("the manifest and icons are under /api, which needs no session", pwa.PWA_MANIFEST_PATH.startsWith("/api/") && /if \(api\) return NextResponse\.next\(\);/.test(proxy));
  }

  section("The service worker, in a stand-in browser");
  {
    const ORIGIN = "https://acme.deskzo.com";
    const source = readFileSync(path.join(__dirname, "../public/sw.js"), "utf8");
    const { KEPT_PAGES } = await import("../src/lib/offline-pages");
    ok("the pages it keeps are the app's list, and no money or figures among them", source.includes(`const KEPT_PAGES = ${JSON.stringify(KEPT_PAGES).replaceAll(",", ", ")};`) && !KEPT_PAGES.some((p) => /dashboard|accounting|payroll|reports|payments/.test(p)), KEPT_PAGES);

    class At extends Request {
      constructor(input: string | Request, init?: RequestInit) {
        super(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
      }
    }
    const stores = new Map<string, Map<string, Response>>([["an-older-version", new Map()]]);
    const urlOf = (r: string | Request) => (typeof r === "string" ? new URL(r, ORIGIN).href : r.url);
    const caches = {
      open: async (name: string) => {
        const store = stores.get(name) ?? new Map<string, Response>();
        stores.set(name, store);
        return {
          add: async (request: Request) => void store.set(request.url, await fetchStub(request)),
          put: async (request: string | Request, response: Response) => void store.set(urlOf(request), response),
          match: async (request: string | Request) => store.get(urlOf(request))?.clone(),
          delete: async (request: string | Request) => store.delete(urlOf(request)),
          keys: async () => [...store.keys()],
        };
      },
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match: async (request: string | Request) => {
        for (const store of stores.values()) {
          const hit = store.get(urlOf(request));
          if (hit) return hit.clone();
        }
        return undefined;
      },
    };
    let online = true;
    let pageHtml = "the page, from the server";
    let redirectToLogin = false;
    const fetched: string[] = [];
    async function fetchStub(input: string | { url: string }): Promise<Response> {
      const url = urlOf(input as string | Request);
      fetched.push(url);
      if (!online) throw new TypeError("Failed to fetch");
      if (url.endsWith("/api/pwa/manifest")) return Response.json({ name: 'Acme <b>"&', theme_color: "#0f766e" });
      if (url.includes("/_next/static/")) return new Response("the design", { status: 200 });
      if (redirectToLogin) {
        const moved = new Response("sign in", { status: 200 });
        Object.defineProperty(moved, "redirected", { value: true });
        return moved;
      }
      const answer = new Response(pageHtml, { status: 200 });
      Object.defineProperty(answer, "url", { value: url });
      return answer;
    }
    const listeners: Record<string, (event: unknown) => void> = {};
    let preloadOn = false;
    const self = {
      addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn),
      skipWaiting: () => undefined,
      registration: { navigationPreload: { enable: async () => void (preloadOn = true) } },
      clients: { claim: async () => undefined },
      location: { origin: ORIGIN, hostname: new URL(ORIGIN).hostname },
    };
    vm.runInNewContext(source, { self, caches, fetch: fetchStub, Request: At, Response, Headers, URL, console });

    const waits: Promise<unknown>[] = [];
    listeners.install({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    ok("installing keeps the manifest", !!(await caches.match("/api/pwa/manifest")));
    listeners.activate({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    ok("activating drops older versions' stores", !stores.has("an-older-version") && stores.has("deskzo-app-2"));
    ok("…and asks for the page while the worker wakes", preloadOn);

    async function open(request: { mode: string; method: string; url: string }) {
      let answer: Promise<Response> | null = null;
      listeners.fetch({ request, preloadResponse: Promise.resolve(undefined), respondWith: (p: Promise<Response>) => (answer = p) });
      return answer ? await (answer as Promise<Response>) : null;
    }
    const page = { mode: "navigate", method: "GET", url: `${ORIGIN}/dashboard` };
    const pageStores = () => [...stores.keys()].filter((n) => n.startsWith("deskzo-pages-"));
    const copies = () => pageStores().reduce((t, n) => t + stores.get(n)!.size, 0);
    const live = await open(page);
    ok("online, a page is the server's", live?.status === 200 && (await live.text()) === "the page, from the server");
    ok("…and a page not on the list is never kept", copies() === 0);
    ok("data, files and actions are left to the browser", (await open({ mode: "cors", method: "GET", url: `${ORIGIN}/api/app/today` })) === null && (await open({ mode: "navigate", method: "POST", url: `${ORIGIN}/login` })) === null);

    const say = async (data: unknown, source?: { id: string }, ports?: unknown[]) => {
      const pending: Promise<unknown>[] = [];
      listeners.message({ data, source, ports, waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await Promise.all(pending);
    };
    const today = { mode: "navigate", method: "GET", url: `${ORIGIN}/today` };
    await open(today);
    ok("a work page isn't kept until its page says who for", copies() === 0);
    await say({ type: "deskzo-dont-keep" });
    await say({ type: "deskzo-keep", userKey: "rita1234", pathname: "/dashboard" });
    ok("told not to (viewing as somebody), it's let go; a page off the list stays unkept", copies() === 0);
    await open(today);
    await say({ type: "deskzo-keep", userKey: "rita1234", pathname: "/today" });
    ok("told who for, the last copy is kept, in that person's own store", copies() === 1 && stores.has("deskzo-pages-rita1234"), pageStores());
    await say({ type: "deskzo-keep", userKey: "not a key!", pathname: "/today" });
    ok("…and a key that isn't one is ignored", pageStores().length === 1);

    await open({ mode: "no-cors", method: "GET", url: `${ORIGIN}/_next/static/chunks/app.js` });
    ok("the page's design is kept", stores.get("deskzo-design-1")?.size === 1);

    online = false;
    const client = { id: "window-1" };
    let shown: Response | null = null;
    listeners.fetch({ request: today, preloadResponse: Promise.resolve(undefined), resultingClientId: client.id, respondWith: (p: Promise<Response>) => void p.then((r) => (shown = r)) });
    await new Promise((done) => setTimeout(done, 20));
    ok("offline, the kept copy instead of a blank screen", (shown as Response | null)?.status === 200 && (await (shown as unknown as Response).text()) === "the page, from the server");
    let told: { savedAt: number | null } | null = null;
    await say({ type: "deskzo-copy-age" }, client, [{ postMessage: (m: { savedAt: number | null }) => (told = m) }]);
    ok("…and the page can ask when it was saved, to say so", typeof (told as { savedAt: number | null } | null)?.savedAt === "number");
    const design = await open({ mode: "no-cors", method: "GET", url: `${ORIGIN}/_next/static/chunks/app.js` });
    ok("…its design too", design?.status === 200 && (await design.text()) === "the design");
    const other = await open(page);
    const otherHtml = other ? await other.text() : "";
    ok("a page not kept offers the ones that are", other?.status === 503 && otherHtml.includes('href="/today"') && otherHtml.includes("Today"));
    online = true;
    const store = stores.get("deskzo-pages-rita1234")!;
    const copyKey = [...store.keys()][0]!;
    const oldHeaders = new Headers(store.get(copyKey)!.headers);
    const kept = await store.get(copyKey)!.clone().text();
    oldHeaders.set("x-deskzo-saved-at", String(Date.now() - 4 * 24 * 60 * 60 * 1000));
    store.set(copyKey, new Response(kept, { status: 200, headers: oldHeaders }));
    online = false;
    const stale = await open(today);
    ok("past three days a copy is gone", stale?.status === 503 && store.size === 0);
    online = true;
    await open(today);
    await say({ type: "deskzo-keep", userKey: "rita1234", pathname: "/today" });
    await open(today);
    await say({ type: "deskzo-keep", userKey: "vikram99", pathname: "/today" });
    ok("somebody else signing in here: the last person's copies go", pageStores().join() === "deskzo-pages-vikram99", pageStores());
    await open({ mode: "navigate", method: "GET", url: `${ORIGIN}/login` });
    ok("sign-in coming up — signed out, or the session over: every copy goes", pageStores().length === 0);

    // Installed on the home screen, every work page is kept, not only those opened (owner, 8 Nov 2026).
    await say({ type: "deskzo-keep", userKey: "rita1234", pathname: "/dashboard" });
    ok("in a browser, a page off the list keeps nothing", copies() === 0);
    await say({ type: "deskzo-keep", userKey: "rita1234", pathname: "/dashboard", all: true });
    ok("in the installed app, every work page is kept from any page", copies() === KEPT_PAGES.length, copies());
    const askedFor = fetched.length;
    await say({ type: "deskzo-keep", userKey: "rita1234", pathname: "/dashboard", all: true });
    ok("…and not asked for again within the half hour", fetched.length === askedFor);
    pageHtml = '<script src="/_next/static/chunks/only-this-page.js"></script><link href="/_next/static/css/only-this-page.css">';
    await open({ mode: "navigate", method: "GET", url: `${ORIGIN}/login` });
    await say({ type: "deskzo-keep", userKey: "rita1234", pathname: "/tasks", all: true });
    const design2 = [...(stores.get("deskzo-design-1")?.keys() ?? [])];
    ok("a page kept in the background keeps the design files it names", design2.some((u) => u.endsWith("/only-this-page.js")) && design2.some((u) => u.endsWith("/only-this-page.css")), design2);
    await open({ mode: "navigate", method: "GET", url: `${ORIGIN}/login` });
    pageHtml = "the page, from the server";
    redirectToLogin = true;
    await say({ type: "deskzo-keep", userKey: "rita1234", pathname: "/dashboard", all: true });
    ok("a page that redirects instead (signed out, a module off) isn't kept", copies() === 0);
    redirectToLogin = false;

    online = false;
    const offline = await open(page);
    const html = offline ? await offline.text() : "";
    ok("offline, the offline screen instead of the browser's error", offline?.status === 503 && /You're offline/.test(html));
    ok("…named for the workspace, its name escaped", html.includes("Acme &lt;b&gt;&quot;&amp;") && !html.includes("<b>"));
    ok("…never kept", offline?.headers.get("cache-control") === "no-store");
  }

  section("The phone app's last copies");
  {
    const rules = await import("../mobile/src/lib/offline-rules");
    ok("its own work is kept", ["/api/app/me", "/api/app/today", "/api/app/tasks?view=mine", "/api/app/meetings", "/api/app/visits?page=1"].every(rules.keepsPath));
    ok("…not a later page or a search", !rules.keepsPath("/api/app/tasks?page=2") && !rules.keepsPath("/api/app/visits?search=acme"));
    ok("…nor anything else", !["/api/app/leads", "/api/app/expenses", "/api/app/approvals", "/api/app/chat", "/api/app/companies", "/api/app/todayish"].some(rules.keepsPath));
    const now = Date.UTC(2026, 10, 6);
    const copy = rules.encodeCopy([{ id: "t1" }], { page: 1 }, now);
    ok("a copy reads back, with when it was saved", JSON.stringify(rules.decodeCopy(copy, now + 1000)) === JSON.stringify({ savedAt: now, data: [{ id: "t1" }], page: { page: 1 } }));
    ok("…not past three days", rules.decodeCopy(copy, now + rules.KEPT_FOR_MS + 1) === null);
    ok("…nor a damaged one", rules.decodeCopy("{not json", now) === null && rules.decodeCopy('{"data":1}', now) === null);
  }

  section("The phone app: what waits to be sent");
  {
    const box = await import("../mobile/src/lib/outbox-rules");
    ok("a new task, a task's status and a call's notes may wait", box.mayWait("POST", "/api/app/tasks") && box.mayWait("PATCH", "/api/app/tasks/t1") && box.mayWait("PATCH", "/api/app/calls/c1"));
    ok("…a visit's check-in may not: it's proof of where and when", !box.mayWait("POST", "/api/app/visits/v1/check-in") && !box.mayWait("PATCH", "/api/app/visits/v1"));
    ok("…nor anything else", !box.mayWait("POST", "/api/app/expenses") && !box.mayWait("POST", "/api/app/tasks/t1/comments") && !box.mayWait("POST", "/api/app/calls/c1"));
    ok("sent", box.afterTry("sent") === "sent");
    ok("no connection or the server's own trouble: later", [0, 500, 503, 429].every((status) => box.afterTry({ status }) === "later"));
    ok("refused: shown, never retried", [400, 401, 403, 404, 422].every((status) => box.afterTry({ status }) === "refused"));
    const item = (id: string, method: "POST" | "PATCH", path: string, body: unknown) => ({ id, method, path, body, label: id, queuedAt: 0 });
    let held = box.added(box.EMPTY, item("a", "POST", "/api/app/tasks", { title: "One" }));
    held = box.added(held, item("b", "PATCH", "/api/app/tasks/t1", { status: "DONE" }));
    held = box.added(held, item("c", "POST", "/api/app/tasks", { title: "Two" }));
    ok("in the order it was done", held.pending.map((p: { id: string }) => p.id).join() === "a,b,c");
    ok("a task's status shows while it waits", box.waitingStatus(held, "t1") === "DONE" && box.waitingStatus(held, "t2") === null);
    held = box.added(held, item("d", "PATCH", "/api/app/tasks/t1", { status: "TODO" }));
    ok("done then reopened: only the last goes", held.pending.map((p: { id: string }) => p.id).join() === "a,c,d" && box.waitingStatus(held, "t1") === "TODO");
    held = box.added(held, item("e", "POST", "/api/app/tasks", { title: "Same" }));
    held = box.added(held, item("f", "POST", "/api/app/tasks", { title: "Same" }));
    ok("two new tasks stay two", held.pending.filter((p: { method: string }) => p.method === "POST").length === 4);
    ok("reads back from its file", JSON.stringify(box.parseHeld(JSON.stringify(held))) === JSON.stringify(held));
    ok("…a damaged file is nothing", box.parseHeld("{not json").pending.length === 0 && box.parseHeld('{"pending":1}').pending.length === 0);
    let many = box.EMPTY;
    for (let i = 0; i < box.MAX_PENDING + 5; i++) many = box.added(many, item(String(i), "POST", "/api/app/tasks", {}));
    ok("held up to a limit, the latest kept", many.pending.length === box.MAX_PENDING && many.pending.at(-1)?.id === String(box.MAX_PENDING + 4));
  }

  section("A new task sent twice is made once");
  {
    const once = await import("../src/lib/app/once");
    const { db } = await import("../src/lib/db");
    const who = "ZZPROBE_ONCE";
    await db.appOnceKey.deleteMany({ where: { key: { startsWith: who } } });
    const first = await once.claimOnce(who, "key-12345678");
    ok("the first goes ahead", !first.done && first.key === `${who}:key-12345678`);
    let inProgress = 0;
    await once.claimOnce(who, "key-12345678").catch((e: { status?: number }) => { inProgress = e.status ?? -1; });
    ok("a second while the first is going: try again shortly", inProgress === 503);
    await once.finishOnce(first.done ? null : first.key, "task-1");
    const again = await once.claimOnce(who, "key-12345678");
    ok("sent again, the same task", again.done && again.recordId === "task-1");
    const other = await once.claimOnce(`${who}2`, "key-12345678");
    ok("the same key from somebody else is theirs", !other.done);
    const none = await once.claimOnce(who, null);
    ok("no key: it simply goes ahead", !none.done && none.key === null);
    const bad = await once.claimOnce(who, "x");
    ok("…nor a key too short to mean anything", !bad.done && bad.key === null);
    const refused = await once.claimOnce(who, "key-refused1");
    await once.releaseOnce(refused.done ? null : refused.key);
    ok("refused, another try may make it", !(await once.claimOnce(who, "key-refused1")).done);
    await db.appOnceKey.update({ where: { key: `${who}:key-refused1` }, data: { createdAt: new Date(Date.now() - 120_000) } });
    ok("a try that died long ago doesn't block it", !(await once.claimOnce(who, "key-refused1")).done);
    await db.appOnceKey.deleteMany({ where: { key: { startsWith: who } } });
  }

  section("Like the phone app: Today and the tabs along the bottom");
  {
    const sample = {
      date: "2026-10-31",
      attendance: { status: "PRESENT", check_in_at: "2026-10-31T04:05:00.000Z", check_out_at: null, worked_minutes: null },
      location: null,
      tasks: { due_today: [{ id: "t1", title: "Send the Acme quote", due: "2026-10-31", status: "TODO", priority: null, company: "Acme Ltd", can_work: true }], open: 7, overdue: 2 },
      approvals_waiting: 3,
      approvals_by_kind: { leave: 1, order: 2 },
      approvals_more: false,
      leave: { balances: [{ type_id: "cl", code: "CL", name: "Casual leave", available: 4, pending: 0 }], upcoming: [{ id: "l1", type: "Casual leave", from: "2026-11-05", to: "2026-11-06", days: 2, status: "PENDING" }] },
    } as unknown as import("../src/components/today/today-view").TodayData;
    const today = renderToStaticMarkup(createElement(TodayView, { today: sample, greeting: "Good morning, Rita", zone: "Asia/Kolkata", approvals: true, newLead: true }));
    ok("Today: the greeting and the day", today.includes("Good morning, Rita") && today.includes("Saturday, 31 October"), today.slice(0, 160));
    ok("…clocked in at 9:35 am, India's time", today.includes("In at 9:35") && today.includes("still in"));
    ok("…approvals waiting, each kind linked to where it's decided", today.includes("3 waiting for you") && today.includes("1 leave request") && today.includes("2 orders to approve") && today.includes('href="/people/leave"') && today.includes('href="/orders?status=PENDING_APPROVAL"'));
    ok("…tasks: open, overdue, what's due today", today.includes("7 open") && today.includes("2 overdue") && today.includes("Send the Acme quote") && today.includes('href="/tasks?task=t1"'));
    ok("…leave left, and Apply for leave", today.includes("Casual leave") && today.includes("Apply for leave") && today.includes("waiting for approval"));
    ok("…and a new lead a tap away", today.includes('href="/leads/new"'));
    const bare = renderToStaticMarkup(
      createElement(TodayView, { today: { ...sample, attendance: null, tasks: null, leave: null }, greeting: "Good evening, Sam", zone: "Asia/Kolkata", approvals: false, newLead: false }),
    );
    ok("a card only where its module is open", !bare.includes("Attendance") && !bare.includes("My tasks") && !bare.includes("Leave") && !bare.includes("Approvals") && !bare.includes("New lead"));

    pathnameNow = "/leads/LD-000012";
    const bar = renderToStaticMarkup(createElement(AppTabBar, { sales: true, chat: true, calls: true, chatUnread: 4 }));
    ok("the tabs: Today, Sales, Chat, Calls, More", ["Today", "Sales", "Chat", "Calls", "More"].every((t) => bar.includes(`>${t}<`)), bar.slice(0, 200));
    ok("…on a phone only, above the home bar", bar.includes("md:hidden") && bar.includes("safe-area-inset-bottom"));
    const link = (href: string) => bar.split("<a ").find((a) => a.includes(`href="${href}"`)) ?? "";
    ok("…the tab you're in is marked", link("/leads").includes('aria-current="page"') && !link("/today").includes("aria-current"));
    ok("…unread chats on the Chat tab", bar.includes(">4<"));
    const few = renderToStaticMarkup(createElement(AppTabBar, { sales: false, chat: false, calls: false, chatUnread: 0 }));
    ok("…a tab whose module isn't open isn't there; Today and More always are", !few.includes(">Sales<") && !few.includes(">Chat<") && !few.includes(">Calls<") && few.includes(">Today<") && few.includes(">More<"));
    const sidebar = readFileSync(path.join(__dirname, "../src/components/layout/sidebar.tsx"), "utf8");
    const layout = readFileSync(path.join(__dirname, "../src/app/(dashboard)/layout.tsx"), "utf8");
    ok("More opens the menu", sidebar.includes("OPEN_MENU_EVENT") && sidebar.includes("setMobileOpen(true)"));
    ok("the signed-in pages draw the bar, the page clear of it, reaching the screen's edges", layout.includes("<AppTabBar") && layout.includes("safe-area-inset-bottom") && layout.includes('viewportFit: "cover"'));
  }

  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
