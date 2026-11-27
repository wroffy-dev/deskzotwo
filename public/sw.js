/*
 * The service worker of the workspace app on a phone's home screen, and of the site in a browser (src/lib/pwa.ts).
 *
 * Offline, the screen isn't blank (owner, 6 Nov 2026 — superseding "keep nothing"):
 *
 *   · The page's design — /_next/static, files named by their contents, holding nothing of the workspace — is kept once
 *     fetched, so a kept page still draws. The newest few hundred.
 *   · The last copy of the person's own work pages (KEPT_PAGES) is kept for them. Online the server always answers;
 *     a copy is shown only when it can't be reached, and the page says it is one (src/components/layout/offline-keeper.tsx).
 *
 * What holds that safe:
 *   · A copy is stored only when a signed-in page says so, naming its person; never while viewing as somebody, and
 *     never of a page the server redirected. Each person's copies are in their own store.
 *   · They go when anybody else signs in here, whenever sign-in comes up (signing out, or a session over), and after
 *     three days. Figures, money, payroll and reports are never among them.
 *   · Nothing but opening a page and the design files passes through here — data, files, actions and live updates are
 *     left to the browser, and nothing done offline is saved.
 *
 * Public in the proxy (src/proxy.ts), so it installs and updates for anybody signed in or not.
 */
const VERSION = "deskzo-app-2";
const DESIGN = "deskzo-design-1";
const PAGES_PREFIX = "deskzo-pages-";
const MANIFEST = "/api/pwa/manifest";
/** Must match src/lib/offline-pages.ts. */
const KEPT_PAGES = ["/today", "/tasks", "/calendar", "/visits"];
const KEPT_FOR_MS = 3 * 24 * 60 * 60 * 1000;
const DESIGN_FILES = 400;
const DESIGN_OF_A_PAGE = 80;
/** A page visited inside the app, with no copy this recent: fetched once to keep. */
const FRESH_MS = 30 * 60 * 1000;
const SAVED_AT = "x-deskzo-saved-at";
/** A dev server's files aren't named by their contents: keeping them would run yesterday's code. */
const LOCAL = /(^|\.)localhost$/.test(self.location.hostname);

/** Responses just opened, until their page says whether they may be kept. Lost if the worker sleeps: the next visit keeps it. */
const opened = new Map();
/** Which open window was given a kept copy, and how old it was. */
const servedCopy = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.add(new Request(MANIFEST, { cache: "reload" })))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== VERSION && (LOCAL || name !== DESIGN) && !name.startsWith(PAGES_PREFIX)).map((name) => caches.delete(name)));
      // The page's request starts while the worker wakes up, rather than after.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => undefined);
      await self.clients.claim();
    })(),
  );
});

const isKeptPath = (pathname) => KEPT_PAGES.includes(pathname);

async function pageStores() {
  return (await caches.keys()).filter((name) => name.startsWith(PAGES_PREFIX));
}

async function wipePages(exceptStore) {
  await Promise.all((await pageStores()).filter((name) => name !== exceptStore).map((name) => caches.delete(name)));
}

/** The kept copy of a page, or null — none, or past its three days (and then gone). */
async function keptCopy(pathname) {
  for (const name of await pageStores()) {
    const store = await caches.open(name);
    const hit = await store.match(pathname, { ignoreVary: true, ignoreSearch: true });
    if (!hit) continue;
    const savedAt = Number(hit.headers.get(SAVED_AT));
    if (!savedAt || Date.now() - savedAt > KEPT_FOR_MS) {
      await store.delete(pathname);
      continue;
    }
    return { response: hit, savedAt };
  }
  return null;
}

/** Which pages have a copy still good, for the offline screen's links. */
async function keptPaths() {
  const found = [];
  for (const pathname of KEPT_PAGES) if (await keptCopy(pathname)) found.push(pathname);
  return found;
}

async function store(userKey, pathname, response) {
  const name = PAGES_PREFIX + userKey;
  await wipePages(name);
  const headers = new Headers(response.headers);
  headers.set(SAVED_AT, String(Date.now()));
  const cache = await caches.open(name);
  const html = await response.text();
  await cache.put(pathname, new Response(html, { status: 200, headers }));
  await keepDesignOf(html);
}

/** The design files a kept page names: one saved in the background, never drawn here, has fetched none of its own. */
async function keepDesignOf(html) {
  if (LOCAL) return;
  const files = [...new Set(html.match(/\/_next\/static\/[^"'\s\\)]+/g) ?? [])].slice(0, DESIGN_OF_A_PAGE);
  for (const file of files) await designFile(new Request(file)).catch(() => undefined);
}

/**
 * The installed app keeps every work page (owner, 8 Nov 2026 — "PWA still shows internet connection required"), not
 * only the ones opened: a phone's next start without internet may land on any of them. One after another, and none
 * kept in the last half hour; a page that isn't theirs (a module off, a redirect) just isn't kept.
 */
let keepingAll = false;
async function keepAll(userKey) {
  if (keepingAll) return;
  keepingAll = true;
  try {
    for (const pathname of KEPT_PAGES) {
      const have = await keptCopy(pathname);
      if (have && Date.now() - have.savedAt < FRESH_MS) continue;
      const response = await fetch(pathname, { credentials: "same-origin" }).catch(() => null);
      if (response && response.status === 200 && !response.redirected && new URL(response.url).pathname === pathname) await store(userKey, pathname, response);
    }
  } finally {
    keepingAll = false;
  }
}

/** A page says it's signed in and may be kept: store what was just opened, or fetch a copy for a page reached inside the app. */
async function keep(userKey, pathname) {
  if (!isKeptPath(pathname)) {
    await wipePages(PAGES_PREFIX + userKey);
    return;
  }
  const justOpened = opened.get(pathname);
  opened.delete(pathname);
  if (justOpened) return store(userKey, pathname, justOpened);
  const have = await keptCopy(pathname);
  if (have && Date.now() - have.savedAt < FRESH_MS) return;
  const response = await fetch(pathname, { credentials: "same-origin" }).catch(() => null);
  if (response && response.status === 200 && !response.redirected && new URL(response.url).pathname === pathname) await store(userKey, pathname, response);
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "deskzo-keep" && typeof data.userKey === "string" && /^[a-z0-9]{8,80}$/.test(data.userKey) && typeof data.pathname === "string") {
    event.waitUntil(keep(data.userKey, data.pathname).then(() => (data.all === true ? keepAll(data.userKey) : undefined)));
  }
  // Viewing as somebody, or anything else that mustn't be kept: nothing of what was just opened stays.
  if (data.type === "deskzo-dont-keep") opened.clear();
  if (data.type === "deskzo-wipe") event.waitUntil(wipePages(null));
  if (data.type === "deskzo-copy-age" && event.ports && event.ports[0]) {
    const savedAt = servedCopy.get(event.source && event.source.id);
    event.ports[0].postMessage({ savedAt: savedAt ?? null });
  }
});

async function designFile(request) {
  const cache = await caches.open(DESIGN);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    if (keys.length > DESIGN_FILES) await Promise.all(keys.slice(0, keys.length - DESIGN_FILES).map((key) => cache.delete(key)));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/static/")) {
    if (!LOCAL) event.respondWith(designFile(request));
    return;
  }
  // Opening a page only. Everything else — data, files, actions, live updates — is left to the browser.
  if (request.mode !== "navigate") return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        const response = preloaded || (await fetch(request));
        const landed = new URL(response.url || request.url).pathname;
        // Sign-in came up — signed out, or the session is over: nothing of theirs stays.
        if (landed === "/login" || url.pathname === "/login") await wipePages(null);
        else if (response.status === 200 && !response.redirected && !url.search && isKeptPath(url.pathname) && landed === url.pathname) opened.set(url.pathname, response.clone());
        return response;
      } catch {
        const copy = isKeptPath(url.pathname) ? await keptCopy(url.pathname) : null;
        if (copy) {
          if (event.resultingClientId) servedCopy.set(event.resultingClientId, copy.savedAt);
          return copy.response;
        }
        return offlinePage(await keptPaths());
      }
    })(),
  );
});

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const PAGE_NAMES = { "/today": "Today", "/tasks": "My tasks", "/calendar": "Calendar", "/visits": "Field visits" };

async function offlinePage(kept = []) {
  let name = "Deskzo";
  let color = "#4f46e5";
  try {
    const cached = await caches.match(MANIFEST);
    if (cached) {
      const manifest = await cached.json();
      if (typeof manifest.name === "string" && manifest.name) name = manifest.name;
      if (typeof manifest.theme_color === "string" && /^#[0-9a-fA-F]{6}$/.test(manifest.theme_color)) color = manifest.theme_color;
    }
  } catch {
    // The defaults above.
  }
  const links = kept.map((path) => `<a class="kept" href="${path}">${escapeHtml(PAGE_NAMES[path] ?? path)}</a>`).join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(name)} — offline</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; }
  @media (prefers-color-scheme: dark) { body { background: #0b1120; color: #e2e8f0; } p { color: #94a3b8; } }
  main { max-width: 22rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 8px; }
  p { margin: 0 0 20px; color: #475569; line-height: 1.5; }
  a { display: inline-block; padding: 10px 18px; border-radius: 8px; background: ${color}; color: #fff; text-decoration: none; font-weight: 600; }
  a.kept { margin: 0 4px 8px; background: transparent; color: inherit; border: 1px solid currentColor; font-weight: 500; }
  nav { margin-bottom: 16px; }
</style>
</head>
<body>
<main>
  <h1>You're offline</h1>
  <p>${kept.length ? "This page isn't saved on this device, but these are, as you last saw them:" : `${escapeHtml(name)} needs the internet. It opens again as soon as your phone is back online.`}</p>
  ${kept.length ? `<nav>${links}</nav>` : ""}
  <a href="">Try again</a>
</main>
</body>
</html>`;
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
