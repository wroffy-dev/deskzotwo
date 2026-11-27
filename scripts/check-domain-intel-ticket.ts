/**
 * check:domain-intel-ticket — "Domain intel" on a ticket (owner, 2 Nov 2026 — src/lib/domain-intel/live-check.ts,
 * src/actions/domain-check.ts).
 *
 *   1. What counts as a domain: a URL, an address, a bare name — not a path, an IP or nonsense.
 *   2. The domains a ticket points at: the customer's website, the contact's, any written in it — not gmail.com.
 *   3. The problems the findings add up to, worst first: an expired domain, no MX, two SPF records, a dead site, an
 *      expiring certificate…
 *   4. A real lookup (google.com): name servers, MX, SPF, the certificate, the website — and nothing wrong said of it.
 *      A name pointing inside our network is never fetched or connected to.
 *   5. Only for whoever may open the ticket; twenty lookups a person in ten minutes.
 *
 * Needs the internet for part 4. Reads the dev workspace; changes nothing.
 *
 *   npm run check:domain-intel-ticket
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let mayView = true;
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
  if (request === "@/actions/permission" || request.endsWith("actions/permission")) return { hasEffectivePermission: async () => true };
  if (request === "@/lib/authz/access" || request.endsWith("lib/authz/access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, mayAccess: async () => mayView };
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
const DAY = 86_400_000;

async function main() {
  const { cleanDomain, domainsFrom, problemsIn, liveDomainReport } = await import("../src/lib/domain-intel/live-check");
  const { checkTicketDomain, ticketDomains } = await import("../src/actions/domain-check");

  section("1. What counts as a domain");
  const cases: [string, string | null][] = [
    ["https://www.Goignis.com/contact", "goignis.com"],
    ["rohit@goignis.com", "goignis.com"],
    ["wroffy.co.in", "wroffy.co.in"],
    ["  acme.com  ", "acme.com"],
    ["127.0.0.1", null],
    ["not a domain", null],
    ["localhost", null],
    ["-bad-.com", null],
  ];
  const wrong = cases.filter(([i, want]) => cleanDomain(i) !== want).map(([i, want]) => `${i} → ${cleanDomain(i)} (want ${want})`);
  ok("URLs, addresses and names read; an IP, a bare host and nonsense refused", wrong.length === 0, wrong);

  section("2. The domains a ticket points at");
  const offered = domainsFrom({ website: "https://www.wroffy.com", emails: ["someone@gmail.com", "it@acme.co.in"], text: ["Autocad licence activation done. Company GOIGNIS TECHNOLOGIES LLP, rohit@goignis.com", "see wroffy.com too"] });
  ok("the website first, then the contact's, then what's written — gmail.com left out, no repeats", offered.join() === "wroffy.com,acme.co.in,goignis.com", offered);

  section("3. What looks wrong");
  const healthy = {
    domain: "x.com", checkedAt: new Date(), registrar: "R", registeredOn: null, expiresOn: new Date(Date.now() + 200 * DAY), nsHosts: ["ns1"], mxHosts: ["mx"], mxRecords: [{ priority: 10, exchange: "mx" }],
    txtRecords: ["v=spf1 -all"], spfRecord: "v=spf1 -all", dmarcRecord: "v=DMARC1; p=reject", dmarcPolicy: "reject", dkimFound: true, httpStatus: 200, finalUrl: "https://x.com/", aRecords: ["1.1.1.1"], cnames: [],
    cert: { issuer: "LE", subject: "x.com", validTo: new Date(Date.now() + 60 * DAY), names: ["x.com"], error: null },
  } as unknown as Parameters<typeof problemsIn>[0];
  ok("a healthy domain: nothing", problemsIn(healthy).length === 0, problemsIn(healthy));
  const sick = problemsIn({ ...healthy, expiresOn: new Date(Date.now() - 3 * DAY), mxHosts: [], mxRecords: [], txtRecords: ["v=spf1 a", "v=spf1 mx"], httpStatus: null, cert: { ...(healthy as { cert: object }).cert, validTo: new Date(Date.now() + 5 * DAY) } } as never);
  const texts = sick.map((p) => p.text);
  ok("an expired domain, no MX, two SPF records, a dead site, a certificate about to expire — all said", ["expired 3 days ago", "No MX", "2 SPF records", "doesn't answer", "certificate expires in"].every((s) => texts.some((t) => t.includes(s))), texts);
  ok("  the bad before the warnings", sick.findIndex((p) => p.level === "warn") === -1 || sick.slice(0, sick.findIndex((p) => p.level === "warn")).every((p) => p.level === "bad") && sick.slice(sick.findIndex((p) => p.level === "warn")).every((p) => p.level === "warn"));
  ok("a domain expiring in 20 days warned", problemsIn({ ...healthy, expiresOn: new Date(Date.now() + 20 * DAY) } as never).some((p) => p.level === "warn" && p.text.includes("expires in")));

  section("4. A real lookup");
  const g = await liveDomainReport("google.com");
  ok("name servers, MX and SPF read", g.nsHosts.length > 0 && g.mxRecords.length > 0 && !!g.spfRecord, { ns: g.nsHosts.slice(0, 2), mx: g.mxRecords[0], spf: g.spfRecord?.slice(0, 30) });
  ok("the website answers, its certificate read", !!g.httpStatus && !!g.cert?.validTo && g.cert.validTo > new Date(), { status: g.httpStatus, cert: g.cert?.issuer, to: g.cert?.validTo });
  ok("the registrar from RDAP, and an expiry ahead", !!g.registrar && !!g.expiresOn && new Date(g.expiresOn) > new Date(), { registrar: g.registrar, expires: g.expiresOn });
  ok("nothing bad said of it", g.problems.every((p) => p.level !== "bad"), g.problems);
  // localtest.me and its subdomains resolve to 127.0.0.1: public DNS, a private address.
  const inside = await liveDomainReport("localtest.me");
  ok("a name pointing inside our network: not fetched, not connected to", inside.httpStatus === null && inside.cert === null, { status: inside.httpStatus, cert: inside.cert });

  section("5. Who, and how often");
  const user = await db.user.findFirst({ where: { active: true }, select: { id: true, role: true, name: true, email: true } });
  const ticket = await db.ticket.findFirst({ select: { id: true } });
  if (!user || !ticket) throw new Error("No user or ticket in the dev workspace.");
  actor = { ...user, id: `zz-${Date.now()}` };
  mayView = false;
  ok("refused to somebody who can't open the ticket", !(await checkTicketDomain({ ticketId: ticket.id, domain: "google.com" })).ok && (await ticketDomains(ticket.id)).length === 0);
  mayView = true;
  const bad = await checkTicketDomain({ ticketId: ticket.id, domain: "http://10.0.0.1/admin" });
  ok("an address that isn't a domain refused", !bad.ok, bad.ok ? "checked" : bad.error);
  const last = await checkTicketDomain({ ticketId: ticket.id, domain: "example.com" });
  ok("a domain checked for whoever may open the ticket", last.ok, last.ok ? last.data.domain : last.error);
  // A refused name doesn't count; nineteen real ones fill the window.
  for (let i = 0; i < 19; i++) await checkTicketDomain({ ticketId: ticket.id, domain: "localtest.me" });
  const over = await checkTicketDomain({ ticketId: ticket.id, domain: "example.com" });
  ok("the twenty-first in ten minutes waits", !over.ok && over.error.includes("ten minutes"), over.ok ? "checked" : over.error);

  console.log(failures === 0 ? `\nAll ${passes} domain intel checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
