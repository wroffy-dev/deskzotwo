/**
 * check:mail-address-gate — every mail looks at its addresses before it leaves (owner, 30 Oct 2026;
 * src/lib/mail-address-gate.ts): not an address, or a domain that doesn't exist or takes no mail, is refused; a DNS
 * that doesn't answer is not a verdict, and the mail goes. Through the workspace's providers and Deskzo's own mailer.
 * The resolver is stood in for, so nothing here waits on real DNS; no database.
 */
// No control plane: the mailer's log and accounts stay out of it, and mail goes by the server route below.
process.env.CONTROL_DATABASE_URL = "";
import { resolver } from "../src/lib/dns";
import { addressVerdict, firstUndeliverable } from "../src/lib/mail-address-gate";
import { providerByKey } from "../src/lib/marketing/providers";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

// The stand-in DNS: a domain's MX / A / AAAA, or the error c-ares would give.
type Answer = string[] | "ENOTFOUND" | "ENODATA" | "ETIMEOUT" | "ECONNREFUSED";
const zone: Record<string, { mx: Answer; a: Answer; aaaa: Answer }> = {
  "zzmail.example": { mx: ["mx.zzmail.example"], a: ["192.0.2.1"], aaaa: "ENODATA" },
  "zzweb-only.example": { mx: "ENODATA", a: ["192.0.2.2"], aaaa: "ENODATA" },
  "zzno-mail.example": { mx: "ENODATA", a: "ENODATA", aaaa: "ENODATA" },
  "zzgone.example": { mx: "ENOTFOUND", a: "ENOTFOUND", aaaa: "ENOTFOUND" },
  "zzslow.example": { mx: "ETIMEOUT", a: "ETIMEOUT", aaaa: "ETIMEOUT" },
  "zzoffline.example": { mx: "ECONNREFUSED", a: "ECONNREFUSED", aaaa: "ECONNREFUSED" },
};
let asked = 0;
const answer = (domain: string, kind: "mx" | "a" | "aaaa") => {
  asked += 1;
  const found = zone[domain]?.[kind] ?? "ENOTFOUND";
  if (typeof found === "string") return Promise.reject(Object.assign(new Error(found), { code: found }));
  return Promise.resolve(found);
};
Object.assign(resolver, {
  resolveMx: (d: string) => answer(d, "mx").then((hosts) => (hosts as string[]).map((exchange, priority) => ({ exchange, priority }))),
  resolve4: (d: string) => answer(d, "a"),
  resolve6: (d: string) => answer(d, "aaaa"),
});

async function main() {
  section("One address");
  ok("a working domain: goes", (await addressVerdict("Asha@ZzMail.example")).ok);
  ok("no MX but a web address: goes (RFC 5321 falls back to it)", (await addressVerdict("a@zzweb-only.example")).ok);
  const noMail = await addressVerdict("a@zzno-mail.example");
  ok("a domain with no mail server and no address: refused, saying which", !noMail.ok && /zzno-mail\.example doesn't exist or takes no mail/.test(noMail.detail), noMail);
  ok("a domain that doesn't exist: refused", !(await addressVerdict("a@zzgone.example")).ok);
  for (const bad of ["asha", "asha@", "asha @zzmail.example", "asha@zzmail", ""]) {
    const v = await addressVerdict(bad);
    ok(`not an address — "${bad}": refused`, !v.ok && /isn't an email address/.test(v.detail), v);
  }
  section("DNS that doesn't answer is not a verdict");
  ok("a timeout: goes", (await addressVerdict("a@zzslow.example")).ok);
  ok("a resolver down: goes", (await addressVerdict("a@zzoffline.example")).ok);
  const before = asked;
  await addressVerdict("b@zzslow.example");
  ok("  and isn't kept — asked again next time", asked > before);
  const kept = asked;
  await addressVerdict("c@zzgone.example");
  await addressVerdict("d@zzmail.example");
  ok("a definite answer is kept: no second lookup", asked === kept);

  section("Every recipient");
  ok("all good: goes", (await firstUndeliverable(["a@zzmail.example", null, "", "b@zzweb-only.example"])).ok);
  const second = await firstUndeliverable(["a@zzmail.example", "b@zzgone.example"]);
  ok("one bad among them: refused, naming it", !second.ok && second.address === "b@zzgone.example", second);

  section("The workspace's providers");
  const smtp = providerByKey.smtp!;
  const refused = await smtp.send({ to: "a@zzgone.example", subject: "Renewal", html: "<p>x</p>" }, { id: "x", fromEmail: "renewals@zzmail.example", fromName: null, replyTo: null, credentials: {} } as never);
  ok("SMTP: refused before the server, for good", !refused.ok && !refused.retryable && /^Not sent: zzgone\.example/.test(refused.error), refused);
  const cc = await smtp.send({ to: "a@zzmail.example", cc: ["boss@zzno-mail.example"], subject: "Invoice", html: "<p>x</p>" }, { id: "x", fromEmail: "a@zzmail.example", fromName: null, replyTo: null, credentials: {} } as never);
  ok("  a bad copy address refuses it too", !cc.ok && /zzno-mail\.example/.test(cc.error), cc);
  const passed = await smtp.send({ to: "a@zzmail.example", subject: "Invoice", html: "<p>x</p>" }, { id: "x", fromEmail: "a@zzmail.example", fromName: null, replyTo: null, credentials: {} } as never);
  ok("  a good one reaches the provider (which says what it lacks)", !passed.ok && !/^Not sent:/.test(passed.error), passed);
  for (const key of ["resend", "ses", "elastic", "m365"]) {
    const r = await providerByKey[key]!.send({ to: "x@zzgone.example", subject: "s", html: "h" }, { id: "x", fromEmail: null, fromName: null, replyTo: null, credentials: {} } as never);
    ok(`${key}: refused the same way`, !r.ok && /^Not sent:/.test(r.error), r);
  }
  const mock = await providerByKey.mock!.send({ to: "x@zzgone.example", subject: "s", html: "h" }, { id: "x", fromEmail: null, fromName: null, replyTo: null, credentials: {} } as never);
  ok("the mock only records: left alone, for the check suites", mock.ok);

  section("Deskzo's own mailer");
  // The server route, with its transport stood in for: whatever reaches it is counted.
  process.env.PLATFORM_SMTP_URL = "smtp://zzmail.example";
  process.env.PLATFORM_MAIL_FROM = "Deskzo <noreply@zzmail.example>";
  const store = await import("../src/lib/platform/mail/store");
  const mailer = await import("../src/lib/platform/mailer");
  let reached = 0;
  store.setTestMailTransport(() => ({ sendMail: async () => ((reached += 1), { messageId: "<zz@zz>" }) }) as never);
  let thrown: unknown = null;
  try {
    await mailer.deliverMail({ type: "ACCOUNT", to: "new.signup@zzgone.example", subject: "Your code", text: "123456" } as never);
  } catch (err) {
    thrown = err;
  }
  const t = thrown as { message?: string; responseCode?: number } | null;
  ok("a signup's typo'd domain: refused as a 550, the server never asked", reached === 0 && t?.responseCode === 550 && /^Not sent: zzgone\.example/.test(t.message ?? ""), t?.message);
  const { permanentRefusal } = await import("../src/lib/platform/mail/queue");
  ok("  which the queue reads as permanent — dead at once, not tried for a day", permanentRefusal(thrown));
  await mailer.deliverMail({ type: "ACCOUNT", to: "new.signup@zzmail.example", subject: "Your code", text: "123456" } as never).catch(() => null);
  ok("a good address goes through", reached === 1);
  store.setTestMailTransport(null);

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll mail address gate checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
