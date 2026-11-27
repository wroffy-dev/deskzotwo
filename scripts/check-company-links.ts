/**
 * check:company-links — a company's name is a link only for somebody who may open it (owner, 25 Nov 2026: "if company
 * view permission is not there than hyperlink should not be there for that person").
 *
 * The component (src/components/companies/company-link.tsx) drawn both ways; that no screen links to a company past
 * it; and, on people made here and removed, which companies are out of somebody's reach.
 *
 *   npm run check:company-links
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { CompanyLink, CompanyLinksProvider, leadsToCompanies, plainClasses } from "../src/components/companies/company-link";
import { companiesOutOfReach } from "../src/lib/companies/out-of-reach";
import { decideModuleAccess } from "../src/lib/navigation";
import { getModuleDefinition } from "../src/lib/modules";

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function main() {
  console.log("\n— The link —\n");
  const draw = (open: boolean | null, props: Partial<Parameters<typeof CompanyLink>[0]> = {}) => {
    const link = h(CompanyLink, { href: "/companies/COM-000001", className: "font-medium text-brand hover:underline", ...props }, "Acme");
    return renderToStaticMarkup(open === null ? link : h(CompanyLinksProvider, { open, children: link }));
  };
  ok("a link for somebody who opens companies", draw(true).startsWith("<a ") && draw(true).includes('href="/companies/COM-000001"'));
  ok("the name alone for somebody who doesn't", draw(false) === '<span class="font-medium">Acme</span>', draw(false));
  ok("  a tab of it, too", !draw(false, { href: "/companies/COM-000001?tab=products" }).includes("<a"));
  ok("  a button that would open it isn't drawn", draw(false, { hideWhenShut: true }) === "");
  ok("  an address that isn't a company's stays a link", draw(false, { href: "/leads/LEAD-000001" }).startsWith("<a "));
  ok("one company out of reach, for somebody who opens others", draw(true, { shut: true }) === '<span class="font-medium">Acme</span>');
  ok("outside the app's layout it is a link, as before", draw(null).startsWith("<a "));
  ok("what leads to companies", leadsToCompanies("/companies") && leadsToCompanies("/companies/x#y") && !leadsToCompanies("/companies-old") && !leadsToCompanies("/customers"));
  ok("nothing left that looks like a link", plainClasses("hover:underline") === undefined && plainClasses("text-brand underline underline-offset-2 text-xs") === "text-xs");

  console.log("\n— Every screen —\n");
  // The merge, which only opens with the module itself.
  const OWN = new Set(["src/components/companies/merge-wizard.tsx", "src/components/companies/company-link.tsx"]);
  const files = execSync("git ls-files -co --exclude-standard src/components src/app", { encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\n")
    .filter((f) => f.endsWith(".tsx") && !OWN.has(f));
  const past: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Each <Link …> or <a …>, to the end of its href.
    for (const m of text.matchAll(/<(?:Link|a)\s[^<>]*?href=\{([^}]*(?:\}[^}]*)?)\}/g)) {
      if (/companyPath\(|`\/companies\/\$\{/.test(m[1]!)) past.push(`${file}:${text.slice(0, m.index).split("\n").length}`);
    }
  }
  ok(`no screen links to a company but through CompanyLink (${files.length} read)`, past.length === 0, past.length ? past : "");
  const layout = readFileSync("src/app/(dashboard)/layout.tsx", "utf8");
  ok("the app's layout says whether this person opens them", layout.includes('<CompanyLinksProvider open={openModules.includes("companies")}>'));

  console.log("\n— Who may —\n");
  const def = getModuleDefinition("companies")!;
  const on = { entitled: true, switchedOn: true };
  ok("the section held: companies open", decideModuleAccess(def, on, new Set(["section.companies"])) === "available");
  ok("the section not held: they don't", decideModuleAccess(def, on, new Set(["tickets.view", "tickets.create", "companies.viewAll"])) === "no-permission");

  const ROLE = "ZZPROBE_CLINK";
  const clean = async () => {
    await db.company.deleteMany({ where: { name: { startsWith: "Zzprobe clink" } } });
    await db.user.deleteMany({ where: { role: ROLE } });
    await db.role.deleteMany({ where: { key: ROLE } });
  };
  await clean();
  try {
    await db.role.create({ data: { key: ROLE, name: "Zzprobe clink" } });
    await db.rolePermission.create({ data: { role: ROLE, permission: "companies.viewAll", allowed: false } });
    const owner = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
    const me = await db.user.create({ data: { name: "Zzprobe clink", email: "clink@zzprobe-clink.invalid", role: ROLE, passwordHash: "x".repeat(60) }, select: { id: true } });
    const make = (name: string, ownerUserId: string) =>
      db.company.create({
        data: { name: `Zzprobe clink ${name}`, normalizedName: `zzprobe clink ${name}`, relationshipType: "CLIENT", ownerUserId, createdById: owner.id },
        select: { id: true },
      });
    const mine = await make("mine", me.id);
    const theirs = await make("theirs", owner.id);
    const shut = await companiesOutOfReach(me.id, [mine.id, theirs.id, theirs.id]);
    ok("somebody else's company is out of reach, their own isn't", shut.length === 1 && shut[0] === theirs.id);
    ok("none is out of the super admin's", (await companiesOutOfReach(owner.id, [mine.id, theirs.id])).length === 0);
    ok("no companies, none out of reach", (await companiesOutOfReach(me.id, [])).length === 0);
  } finally {
    await clean();
  }

  await db.$disconnect();
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
