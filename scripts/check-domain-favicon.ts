/**
 * check:domain-favicon — the company's own icon from its website (owner, 15 Nov 2026 — src/lib/domain-intel/favicon.ts).
 *
 *   · where the homepage says its icon is: apple-touch first, sized next, plain last, relative addresses resolved,
 *     data: skipped, /favicon.ico always the last try;
 *   · what the bytes are by their first few, whatever the server claims; an SVG carrying script is no icon;
 *   · fetching: the first real, small image wins; a missing one, a page, or one over 32 KB is passed over;
 *   · a company with no lookup has no icon.
 *
 *   npm run check:domain-favicon
 */
import "dotenv/config";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(40, 2)]);

async function main() {
  const f = await import("../src/lib/domain-intel/favicon");
  const html = `<html><head>
    <link rel="icon" href="/img/fav-16.png">
    <link rel="apple-touch-icon" href="https://cdn.acme.example/touch.png">
    <link rel="icon" sizes="32x32" href="icons/fav-32.png">
    <link rel="icon" href="data:image/png;base64,AAAA">
    <link rel="stylesheet" href="/site.css">
  </head></html>`;
  const urls = f.iconUrlsFrom(html, "https://www.acme.example/home/");
  ok(
    "the homepage's icons: apple-touch, then sized, then plain, then /favicon.ico; data: and stylesheets left out",
    JSON.stringify(urls) === JSON.stringify(["https://cdn.acme.example/touch.png", "https://www.acme.example/home/icons/fav-32.png", "https://www.acme.example/img/fav-16.png", "https://www.acme.example/favicon.ico"]),
    urls,
  );
  ok("a page with no icon tag still tries /favicon.ico", JSON.stringify(f.iconUrlsFrom("<html></html>", "https://acme.example/")) === '["https://acme.example/favicon.ico"]');

  ok("bytes say PNG and ICO, whatever the header says", f.imageTypeOf(PNG, "text/html") === "image/png" && f.imageTypeOf(ICO, null) === "image/x-icon");
  ok("an SVG is an icon", f.imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'), "image/svg+xml") === "image/svg+xml");
  ok("  one carrying script is not", f.imageTypeOf(Buffer.from('<svg onload="alert(1)"><script>x()</script></svg>'), "image/svg+xml") === null);
  ok("an HTML page served as the icon is not", f.imageTypeOf(Buffer.from("<!doctype html><html><body>Not found</body></html>"), "text/html") === null);

  const answers: Record<string, { status: number; bytes: Buffer; truncated?: boolean }> = {
    "https://a.example/missing.png": { status: 404, bytes: Buffer.from("not found, not found, not found") },
    "https://a.example/page.png": { status: 200, bytes: Buffer.from("<!doctype html><html>a page, not an icon</html>") },
    "https://a.example/huge.png": { status: 200, bytes: PNG, truncated: true },
    "https://a.example/real.ico": { status: 200, bytes: ICO },
  };
  const asked: string[] = [];
  const fake = (async (url: string) => {
    asked.push(url);
    const a = answers[url];
    if (!a) throw new Error("unreachable");
    return { url, status: a.status, headers: new Headers(), body: a.bytes.toString("utf8"), bytes: a.bytes, truncated: !!a.truncated };
  }) as never;
  const got = await f.fetchFavicon(["https://a.example/missing.png", "https://a.example/page.png", "https://a.example/huge.png", "https://a.example/real.ico", "https://a.example/never.png"], fake);
  ok("a missing one, a page and one too big are passed over; the first real icon is kept as a data URL", got === `data:image/x-icon;base64,${ICO.toString("base64")}`, got?.slice(0, 40));
  ok("  and nothing after it is fetched", !asked.includes("https://a.example/never.png"));
  ok("none that works: no icon", (await f.fetchFavicon(["https://a.example/missing.png"], fake)) === null);

  ok("a company with no lookup has no icon", (await f.faviconOf("zz-no-such-company")) === null);
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
