/**
 * check:ai-teammates — the AI teammates (owner, 19 Nov 2026 — src/lib/ai/teammates.ts), their names and photos decided
 * by Deskzo's console country by country since 23 Nov 2026 (src/lib/ai/teammate-looks.ts).
 *
 *   1. The seven, their defaults, and a name cleaned: no links, no markup, at most 30 characters.
 *   2. The built-in photos: every teammate but Deskzo AI has one, served from its own address, never inside a page.
 *   3. The console's: every country's name and photo over the defaults; a country's own over every country's, field by
 *      field; another country keeps every country's; taken away, back to what's under it. The rows are put back.
 *   4. On screen: the face is the photo with the AI mark; the workspace's page lists all seven, to read only; the
 *      console's page shows the built-in photos and where each comes from.
 *   5. The public website: the AI team section and the "at work" demo show the same photos, each with the AI mark —
 *      the demo's captured screens too, every drawn face in them turned into the photo as they load.
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";

process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ refresh() {}, push() {} }), notFound: () => { throw new Error("notFound"); } };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const tm = require("../src/lib/ai/teammates") as typeof import("../src/lib/ai/teammates");
  const looks = require("../src/lib/ai/teammate-looks") as typeof import("../src/lib/ai/teammate-looks");
  const server = require("../src/lib/ai/teammates-server") as typeof import("../src/lib/ai/teammates-server");
  const { controlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
  const { workspaceCountry } = require("../src/lib/country-pack") as typeof import("../src/lib/country-pack");
  const React = require("react") as typeof import("react");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { TeammateAvatar, TeammatesProvider } = require("../src/components/ai/teammate-avatar") as typeof import("../src/components/ai/teammate-avatar");
  const { AiTeammatesSettings } = require("../src/components/settings/ai-teammates") as typeof import("../src/components/settings/ai-teammates");
  const { ConsoleAiTeammates } = require("../src/components/console/settings/ai-teammates") as typeof import("../src/components/console/settings/ai-teammates");
  const { DEFAULT_TEAMMATE_PHOTOS } = require("../src/lib/ai/teammate-default-photos") as typeof import("../src/lib/ai/teammate-default-photos");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const render = (el: unknown) => renderToStaticMarkup(el as ReactElement);

  section("1. The seven");
  const all = tm.teammatesWith();
  ok("Deskzo AI, Ved, Tara, Kabir, Mira, Arjun and Priya", tm.TEAMMATE_KEYS.map((k) => all[k].name).join(", ") === "Deskzo AI, Ved, Tara, Kabir, Mira, Arjun, Priya");
  ok("a name is cleaned of links and markup", tm.cleanTeammateName("Asha <b>https://x.example</b>") === "Asha b");
  ok("  and kept to 30 characters", tm.cleanTeammateName("A".repeat(50)).length === 30);

  const db = controlDb();
  const before = await db.platformTeammateLook.findMany();
  const home = workspaceCountry();
  const other = home === "AE" ? "IN" : "AE";
  try {
    await db.platformTeammateLook.deleteMany({});
    looks.forgetLooks();

    section("2. The built-in photos");
    const team = await server.workspaceTeammates();
    ok("every teammate but Deskzo AI has a photo, by its address", tm.TEAMMATE_KEYS.every((k) => (k === "deskzo" ? team[k].photo === null : team[k].photo === `/api/teammates/${k}/photo?v=d1`)), tm.TEAMMATE_KEYS.map((k) => team[k].photo));
    const tara = await server.teammatePhoto("tara");
    ok("  the address serves the picture — a WebP", tara?.type === "image/webp" && tara.bytes.subarray(0, 4).toString("ascii") === "RIFF" && tara.bytes.length > 2000);
    ok("  Deskzo AI is its mark, and a teammate there isn't is nothing", (await server.teammatePhoto("deskzo")) === null && (await server.teammatePhoto("zz")) === null);
    ok("six built-in photos, each a real picture", Object.values(DEFAULT_TEAMMATE_PHOTOS).length === 6 && Object.values(DEFAULT_TEAMMATE_PHOTOS).every((p) => tm.isTeammatePhoto(p)));

    section("3. Set in the console, country by country");
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    await looks.saveLook(looks.EVERY_COUNTRY, "kabir", { name: "Asha" }, "zz-staff");
    await looks.saveLook(looks.EVERY_COUNTRY, "tara", { photo: PNG }, "zz-staff");
    await looks.saveLook(home, "kabir", { name: "Kabir Local" }, "zz-staff");
    const mine = await server.workspaceTeammates();
    ok("this workspace's country's own name wins over every country's", mine.kabir.name === "Kabir Local", mine.kabir.name);
    ok("  every country's photo over the built-in one, at a new address", /^\/api\/teammates\/tara\/photo\?v=a\d+$/.test(mine.tara.photo ?? ""), mine.tara.photo);
    const served = await server.teammatePhoto("tara");
    ok("  and that address serves the console's picture", served?.type === "image/png" && served.bytes[0] === 0x89);
    const elsewhere = await looks.looksFor(other);
    ok(`another country (${other}) keeps every country's name`, elsewhere.kabir.name === "Asha" && elsewhere.tara.photoFrom === "every");
    await looks.saveLook(home, "kabir", { name: null }, "zz-staff");
    ok("its own taken away: back to every country's", (await server.workspaceTeammates()).kabir.name === "Asha" && (await db.platformTeammateLook.count({ where: { country: home, key: "kabir" } })) === 0);
    await looks.saveLook(looks.EVERY_COUNTRY, "tara", { photo: null }, "zz-staff");
    ok("every country's photo taken away: the built-in one", (await server.workspaceTeammates()).tara.photo === "/api/teammates/tara/photo?v=d1");
    ok("a country that isn't a code reads as the default home", (await looks.looksFor("<script>")).kabir.name === "Asha");
  } finally {
    await db.platformTeammateLook.deleteMany({});
    for (const r of before) await db.platformTeammateLook.create({ data: r });
    looks.forgetLooks();
  }
  ok("the console's rows are as they were found", (await db.platformTeammateLook.count()) === before.length);

  section("4. On screen");
  const withPhoto = render(React.createElement(TeammatesProvider, { teammates: tm.teammatesWith({ kabir: { photo: "/api/teammates/kabir/photo?v=d1" } }) }, React.createElement(TeammateAvatar, { teammate: "kabir", size: "md" })));
  ok("with a photo, the face is the photo, still with the AI mark", withPhoto.includes('src="/api/teammates/kabir/photo?v=d1"') && withPhoto.includes(">AI<"));
  ok("a photo address from anywhere else is ignored", tm.teammatesWith({ kabir: { photo: "https://evil.example/x.png" } }).kabir.photo === null);
  // Since 23 Nov 2026: whether each is working here, why not, this month's work, and a switch each for an admin.
  const status = (key: (typeof tm.TEAMMATE_KEYS)[number]) => ({
    key,
    on: key !== "tara",
    state: key === "tara" ? ("off" as const) : key === "kabir" ? ("blocked" as const) : ("working" as const),
    reason: key === "kabir" ? "Customer inbox is switched off" : null,
    fix: key === "kabir" ? { label: "Modules", href: "/settings/modules" } : null,
    done: key === "ved" ? 38 : 0,
    credits: key === "ved" ? 240 : 0,
  });
  const team = { paused: false, aiOn: true, creditsLeft: 1240, creditsUsed: 760, teammates: tm.TEAMMATE_KEYS.map(status) };
  const pageProps = { team, teammates: tm.TEAMMATE_KEYS.map((k) => all[k]), waiting: 6 };
  const page = render(React.createElement(AiTeammatesSettings, { ...pageProps, canManage: true }));
  ok("the workspace's page lists all seven — nothing to rename or upload", ["Deskzo AI", "Ved", "Tara", "Kabir", "Mira", "Arjun", "Priya"].every((n) => page.includes(n)) && !/Rename|Upload|prompt/i.test(page));
  ok("each says whether they're working here", page.includes("Working") && page.includes("Switched off") && page.includes("Can&#x27;t work"));
  ok("one who can't work says why, and where to put it right", page.includes("Customer inbox is switched off") && page.includes('href="/settings/modules"'));
  ok("this month's work and its credits", page.includes("38 jobs done") && page.includes("240 credits") && page.includes("6 drafts are"));
  ok("an admin gets a switch each, the one switched off shown off", (page.match(/role="switch"/g) ?? []).length === 7 && (page.match(/aria-checked="false"/g) ?? []).length === 1);
  const readOnly = render(React.createElement(AiTeammatesSettings, { ...pageProps, canManage: false }));
  ok("anybody else sees who's working, and no switches", readOnly.includes("Working") && !readOnly.includes('role="switch"') && readOnly.includes("Only an admin"));
  const consolePage = render(
    React.createElement(ConsoleAiTeammates, {
      data: { countries: [{ code: "*", label: "Every country" }, { code: "IN", label: "India" }], rows: {}, defaultPhotos: DEFAULT_TEAMMATE_PHOTOS, canEdit: true },
    }),
  );
  ok("the console's page: the built-in photos, where each comes from, and a name and photo for each", consolePage.includes("data:image/webp;base64,") && consolePage.includes("built in") && consolePage.includes("Save name") && consolePage.includes("Upload photo"));

  section("5. On the website");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { AiTeamBlock } = require("../src/components/site/blocks/ai-team") as typeof import("../src/components/site/blocks/ai-team");
  const { AiTeamDemoView } = require("../src/components/site/blocks/ai-team-demo-view") as typeof import("../src/components/site/blocks/ai-team-demo-view");
  const { DEFAULT_SITE_SETTINGS } = require("../src/components/site/defaults") as typeof import("../src/components/site/defaults");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const site = render(React.createElement(AiTeamBlock, { props: { heading: "Your AI team" } as never, ctx: { settings: DEFAULT_SITE_SETTINGS, trialDays: 14 } as never }));
  const shown = (["ved", "tara", "kabir", "mira", "arjun", "priya"] as const).every((k) => site.includes(`src="${DEFAULT_TEAMMATE_PHOTOS[k]}"`));
  ok("the AI team section: each teammate's photo, with the AI mark — Deskzo AI its mark", shown && (site.match(/>AI</g) ?? []).length >= 7 && !site.includes('aria-label="Ved, AI researcher"><circle'), "");
  const demo = render(React.createElement(AiTeamDemoView, {}));
  ok("the at-work demo: the same photos", (["ved", "tara", "kabir", "mira", "arjun", "priya"] as const).filter((k) => demo.includes(DEFAULT_TEAMMATE_PHOTOS[k])).length >= 1 && demo.includes(">AI<"));
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { screensWithPhotos, withTeammatePhotos } = require("../src/components/site/blocks/ai-team-demo-photos") as typeof import("../src/components/site/blocks/ai-team-demo-photos");
  const fs = require("node:fs") as typeof import("node:fs");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const file = JSON.parse(fs.readFileSync("public/platform-site/ai-team/screens.json", "utf8")) as { lead: string; screens: Record<string, string>; faces: Record<string, string> };
  const drawnBefore = (Object.values(file.screens).join("") + Object.values(file.faces).join("")).match(/<svg viewBox="0 0 40 40"/g)?.length ?? 0;
  const swapped = screensWithPhotos(file);
  const after = Object.values(swapped.screens).join("") + Object.values(swapped.faces).join("");
  const left = after.match(/<svg viewBox="0 0 40 40"[^>]*aria-label="([^"]+)"/g) ?? [];
  ok("the demo's captured screens: every drawn teammate face becomes their photo — only Deskzo AI's mark is left", drawnBefore > 0 && left.every((s) => s.includes('aria-label="Deskzo AI,')) && after.split('<img src="data:image/webp').length - 1 >= drawnBefore - left.length, { drawnBefore, left: left.length });
  ok("  the steps' own faces too", (["ved", "tara", "kabir", "mira", "arjun", "priya"] as const).every((k) => swapped.faces[k]!.includes(DEFAULT_TEAMMATE_PHOTOS[k])) && swapped.faces.deskzo!.includes("<svg"));
  ok("  a face it doesn't know is left as it was", withTeammatePhotos('<svg viewBox="0 0 40 40" width="9" height="9" role="img" aria-label="Zed, AI x" class="overflow-hidden rounded-full"><g/></svg>').startsWith("<svg"));
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll ai-teammates checks passed.");
    process.exitCode = failures ? 1 : 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
