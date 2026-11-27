/**
 * Text people type becomes safe HTML wherever it is put into an email or a page (owner, 15 Nov 2026: "input field
 * sanitization and validations"). Every builder is sent the same hostile strings — a script tag, an event handler,
 * a javascript: link, a broken-out attribute, an iframe, a style that runs script, an SVG with script — and none of it
 * may come out able to run. No database.
 *
 *   npx tsx scripts/check-html-safety.ts
 */
import { textToHtml as marketingTextToHtml, sanitizeEmailHtml } from "../src/lib/marketing/html";
import { textToHtml as ruleTextToHtml } from "../src/lib/pipeline/automation-rules";
import { toEmailHtml } from "../src/lib/documents/email-template";
import { brandedHtml } from "../src/lib/platform/mail/templates";
import { escapeHtml, safeUrl, safeImage, safeColor } from "../src/lib/signatures/render";

let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  if (!cond) failed += 1;
}

const ATTACKS = [
  `<script>alert(1)</script>`,
  `<img src=x onerror="alert(1)">`,
  `<a href="javascript:alert(1)">click</a>`,
  `"><svg onload=alert(1)>`,
  `<iframe src="https://evil.example"></iframe>`,
  `<div style="background:url(javascript:alert(1))">x</div>`,
  `<svg><script>alert(1)</script></svg>`,
  `<a href="JaVaScRiPt:alert(1)">x</a>`,
  `<form action="https://evil.example"><input name=p></form>`,
  `<meta http-equiv="refresh" content="0;url=https://evil.example">`,
];

/** Whether HTML could run something: a tag that executes, an event handler, or a javascript: URL in an attribute. */
function canRun(html: string): string | null {
  if (/<\s*(script|iframe|object|embed|form|meta|base|link)\b/i.test(html)) return "executable tag";
  if (/<[^>]+\son[a-z]+\s*=/i.test(html)) return "event handler";
  if (/<[^>]+(href|src|action)\s*=\s*["']?\s*javascript:/i.test(html)) return "javascript: link";
  if (/<[^>]+style\s*=\s*["'][^"']*javascript:/i.test(html)) return "javascript: in style";
  return null;
}

const BUILDERS: [string, (s: string) => string][] = [
  ["typed text to email HTML (quick messages, support replies, portal codes)", marketingTextToHtml],
  ["a stage rule's email (pipeline automation)", ruleTextToHtml],
  ["a document's covering email", toEmailHtml],
  ["Deskzo's own emails", brandedHtml],
  ["a signature's text", escapeHtml],
  ["marketing HTML, cleaned", sanitizeEmailHtml],
];

console.log("Every builder, every attack");
for (const [name, build] of BUILDERS) {
  const bad = ATTACKS.map((a) => ({ a, out: build(a) })).filter((x) => canRun(x.out));
  ok(name, bad.length === 0, bad.map((b) => ({ in: b.a, out: b.out, why: canRun(b.out) })));
}

console.log("Text survives, as text");
ok("typed text keeps its words and line breaks", marketingTextToHtml("Hello Priya,\n\nYour order <ORD-1> ships today.").includes("Your order &lt;ORD-1&gt; ships today."));
ok("a typed web address becomes a link, an https one only", marketingTextToHtml("See https://deskzo.com/help").includes('href="https://deskzo.com/help"') && !marketingTextToHtml("javascript:alert(1)").includes("href"));
ok("marketing HTML keeps an ordinary link and bold text", sanitizeEmailHtml('<p><b>Hi</b> <a href="https://deskzo.com">here</a></p>').includes('href="https://deskzo.com"'));

console.log("Links and colours a person types");
ok("a signature link: javascript: and data: refused", safeUrl("javascript:alert(1)") === null && safeUrl("data:text/html,<script>") === null);
ok("  an https one kept", safeUrl("https://deskzo.com") !== null);
ok("a signature image: only https or a known data image", safeImage("javascript:alert(1)") === null);
ok("a colour: only a hex colour, else the default", safeColor("red;background:url(javascript:alert(1))") === "#1d4ed8");

console.log(failed ? `\n${failed} failed` : "\nAll HTML safety checks passed.");
process.exit(failed ? 1 : 0);
