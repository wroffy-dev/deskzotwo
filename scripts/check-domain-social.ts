/**
 * check:domain-social — the company's social pages from the free website lookup (owner, 15 Nov 2026: "add social links
 * to the free lookup"; src/lib/domain-intel/signatures.ts `socialLinksFrom`, src/actions/domain.ts).
 *
 *   1. The parser: each network's company page from a homepage's links — not share buttons, posts or personal profiles.
 *   2. A refresh keeps them on the profile and fills the company's LinkedIn when it has none — never over one typed,
 *      and only for somebody who may edit the company.
 *   3. The panel's briefing hands them out, and none to somebody the website is masked from.
 *
 * The lookup itself is stubbed (no internet needed). Own fixture tagged ZZSOC, removed in a finally.
 *
 *   npm run check:domain-social
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { socialLinksFrom as parseSocial } from "../src/lib/domain-intel/signatures";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let mayEdit = true;
let websiteMasked = false;
let homepageLinks: Record<string, string> = {};

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor, requireModuleAccess: async () => actor };
  }
  if (request === "@/lib/authz/access" || request.endsWith("lib/authz/access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, mayAccess: async (_u: string, _r: string, action: string) => (action === "edit" ? mayEdit : true) };
  }
  if (request === "@/lib/authz/company-scope" || request.endsWith("lib/authz/company-scope")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, canSeeCompany: async () => true };
  }
  if (request === "@/lib/companies/masking" || request.endsWith("lib/companies/masking")) {
    const real = originalLoad.call(this, request, parent, isMain) as { companyMasker: (u: string, c: string) => Promise<{ visibility: (f: string) => string }> };
    return {
      ...real,
      companyMasker: async (u: string, c: string) => {
        const m = await real.companyMasker(u, c);
        return new Proxy(m, { get: (t, k) => (k === "visibility" ? (f: string) => (f === "website" && websiteMasked ? "masked" : t.visibility(f)) : (t as Record<string | symbol, unknown>)[k]) });
      },
    };
  }
  if (request === "@/lib/domain-intel/lookup" || request.endsWith("domain-intel/lookup")) {
    return {
      inspectDomain: async () => {

        const html = Object.values(homepageLinks).map((h) => `<a href="${h}">x</a>`).join("");
        return {
          finalUrl: "https://zzsoc-acme.example/", httpStatus: 200, siteTitle: "ZZSOC Acme", siteDescription: "Acme makes things.",
          platform: null, platformEvidence: null, hostProvider: null, hostEvidence: null, ipAddress: null, mxHosts: [], emailProvider: null,
          emailSecurityProvider: null, nsHosts: [], dnsProvider: null, registrar: null, registeredOn: null, expiresOn: null, spfRecord: null,
          dmarcRecord: null, dmarcPolicy: null, dkimFound: false, screenshotUrl: null, cnames: [], socialLinks: parseSocial(html),
        };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const TAG = "ZZSOC";
/** The same links, whatever order the database keeps the keys in. */
const sameLinks = (a: unknown, b: Record<string, string>) => !!a && typeof a === "object" && Object.keys(b).length === Object.keys(a).length && Object.entries(b).every(([k, v]) => (a as Record<string, unknown>)[k] === v);

async function cleanup() {
  await db.domainProfile.deleteMany({ where: { company: { name: { startsWith: TAG } } } });
  await db.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function main() {
  const { socialLinksFrom } = await import("../src/lib/domain-intel/signatures");

  section("1. The parser");
  const html = `<a href="https://www.linkedin.com/shareArticle?mini=true">share</a>
    <a href="https://in.linkedin.com/company/acme-tech/">li</a><a href="https://twitter.com/intent/tweet?x">t</a>
    <a href="https://twitter.com/AcmeTech">tw</a><a href='https://www.facebook.com/sharer/sharer.php?u=1'>s</a>
    <a href="https://www.facebook.com/acmetech/?ref=footer">fb</a><a href="https://www.instagram.com/p/abc123/">post</a>
    <a href="https://instagram.com/acme.tech">ig</a><a href="https://www.youtube.com/watch?v=1">v</a>
    <a href="https://www.youtube.com/@acmetech/videos">yt</a><a href="javascript:alert(1)">x</a>
    <a href="https://www.linkedin.com/in/someone">person</a>`;
  const found = socialLinksFrom(html);
  ok("each network's company page, without its query or trailing slash", found.linkedin === "https://in.linkedin.com/company/acme-tech" && found.facebook === "https://www.facebook.com/acmetech" && found.youtube === "https://www.youtube.com/@acmetech" && found.instagram === "https://instagram.com/acme.tech", found);
  ok("  X and Twitter both kept as x.com", found.x === "https://x.com/AcmeTech", found.x);
  ok("  share buttons, posts, videos, personal profiles and script links left out", !Object.values(found).some((u) => /share|intent|\/p\/|watch|\/in\/|javascript/.test(u ?? "")));
  ok("  a page with no social links finds nothing", Object.keys(socialLinksFrom(`<a href="https://example.com">x</a>`)).length === 0);

  await cleanup();
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true, role: true, name: true, email: true } });
  actor = admin;
  const domain = await import("../src/actions/domain");
  try {
    const empty = await db.company.create({ data: { name: `${TAG} Acme`, normalizedName: `${TAG.toLowerCase()} acme`, website: "https://zzsoc-acme.example", relationshipType: "CLIENT", createdById: admin.id }, select: { id: true } });
    const typed = await db.company.create({ data: { name: `${TAG} Typed`, normalizedName: `${TAG.toLowerCase()} typed`, website: "https://zzsoc-typed.example", linkedinUrl: "https://www.linkedin.com/company/typed-by-hand", relationshipType: "CLIENT", createdById: admin.id }, select: { id: true } });

    section("2. A refresh");
    homepageLinks = { li: "https://www.linkedin.com/company/zzsoc-acme/", x: "https://x.com/zzsocacme", yt: "https://www.youtube.com/@zzsocacme" };
    const done = await domain.refreshDomainProfile(empty.id);
    const profile = await db.domainProfile.findUnique({ where: { companyId: empty.id }, select: { socialLinks: true } });
    ok("the refresh succeeds and keeps the links on the profile", done.ok && sameLinks(profile?.socialLinks, { linkedin: "https://www.linkedin.com/company/zzsoc-acme", x: "https://x.com/zzsocacme", youtube: "https://www.youtube.com/@zzsocacme" }), { done, links: profile?.socialLinks });
    ok("  an empty LinkedIn on the company is filled from the website", (await db.company.findUniqueOrThrow({ where: { id: empty.id }, select: { linkedinUrl: true } })).linkedinUrl === "https://www.linkedin.com/company/zzsoc-acme");
    const audit = await db.auditLog.findFirst({ where: { entityType: "DomainProfile", entityId: empty.id }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("  and the audit says so", /LinkedIn page filled in/.test(audit?.entityLabel ?? ""), audit?.entityLabel);

    await domain.refreshDomainProfile(typed.id);
    ok("a LinkedIn somebody typed is never replaced", (await db.company.findUniqueOrThrow({ where: { id: typed.id }, select: { linkedinUrl: true } })).linkedinUrl === "https://www.linkedin.com/company/typed-by-hand");

    await db.company.update({ where: { id: empty.id }, data: { linkedinUrl: null } });
    mayEdit = false;
    await domain.refreshDomainProfile(empty.id);
    ok("someone who can't edit the company fills nothing in", (await db.company.findUniqueOrThrow({ where: { id: empty.id }, select: { linkedinUrl: true } })).linkedinUrl === null);
    mayEdit = true;

    homepageLinks = {};
    await domain.refreshDomainProfile(empty.id);
    ok("links gone from the homepage are gone from the profile", JSON.stringify((await db.domainProfile.findUnique({ where: { companyId: empty.id }, select: { socialLinks: true } }))?.socialLinks) === "{}");

    section("3. The panel");
    homepageLinks = { li: "https://www.linkedin.com/company/zzsoc-acme/", fb: "https://www.facebook.com/zzsocacme" };
    await domain.refreshDomainProfile(empty.id);
    const briefing = await domain.getDomainBriefing(empty.id);
    ok("the briefing hands the links to the panel", briefing?.socialLinks?.facebook === "https://www.facebook.com/zzsocacme" && briefing.socialLinks.linkedin === "https://www.linkedin.com/company/zzsoc-acme", briefing?.socialLinks);
    websiteMasked = true;
    const masked = await domain.getDomainBriefing(empty.id);
    ok("  none to somebody the website is masked from", !!masked && Object.keys(masked.socialLinks ?? {}).length === 0, masked?.socialLinks);
    websiteMasked = false;
  } finally {
    await cleanup();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  await db.$disconnect();
  if (failures) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
