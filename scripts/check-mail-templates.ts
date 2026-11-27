/**
 * check:mail-templates — the wording of Deskzo's own emails, editable in the console (owner, 1 Nov 2026):
 * the template engine (src/lib/console-shared/mail-template-engine.ts), every email's template
 * (src/lib/console-shared/mail-templates.ts), and the store that sends with the console's wording or
 * Deskzo's (src/lib/platform/mail/templates.ts). No database: the saved wordings are stood in for.
 *
 *   npm run check:mail-templates
 */
import { fieldsIn, fillTemplate, sampleValues, templateProblem } from "../src/lib/console-shared/mail-template-engine";
import { MAIL_TEMPLATES, MAIL_TEMPLATE_GROUPS } from "../src/lib/console-shared/mail-templates";
import { brandedHtml, defaultPlatformMail, renderPlatformMail, saveWording, setTestMailTemplates, templateMail, viaDeskzo } from "../src/lib/platform/mail/templates";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function main() {
  console.log("\n— The engine —\n");
  ok("fields are filled", fillTemplate("Hello {name}, welcome to {workspace}.", { name: "Asha", workspace: "Wroffy" }) === "Hello Asha, welcome to Wroffy.");
  ok("an unknown field is left as written", fillTemplate("Hi {nobody}", {}) === "Hi {nobody}");
  ok("an optional part with its field filled stays", fillTemplate("A[[ — {why}]].", { why: "reset" }) === "A — reset.");
  ok("…and goes, brackets and all, when it's empty", fillTemplate("A[[ — {why}]].", { why: "" }) === "A.");
  ok("an optional line on its own leaves no gap", fillTemplate("One\n\n[[Call {phone}.]]\n\nTwo", { phone: null }) === "One\n\nTwo");
  ok("fields in order, without repeats", JSON.stringify(fieldsIn("{a} {b} {a}")) === JSON.stringify(["a", "b"]));
  const fields = [
    { name: "name", about: "", sample: "Asha" },
    { name: "link", about: "", sample: "https://x" },
  ];
  ok("a good template passes", templateProblem({ subject: "Hi {name}", text: "Open {link}" }, fields, ["link"]) === null);
  ok("an unknown field is refused, naming the ones there are", /No such field: \{linkk\}.*\{name\}, \{link\}/.test(templateProblem({ subject: "Hi", text: "Open {linkk}" }, fields, []) ?? ""));
  ok("the link can't be taken out", /can't work without \{link\}/.test(templateProblem({ subject: "Hi", text: "Hello" }, fields, ["link"]) ?? ""));
  ok("…nor hidden in an optional part", /can't work without \{link\}/.test(templateProblem({ subject: "Hi", text: "[[Open {link}]]" }, fields, ["link"]) ?? ""));
  ok("an unclosed optional part is refused", /isn't closed/.test(templateProblem({ subject: "Hi", text: "[[Open {link}" }, fields, []) ?? ""));
  ok("an empty subject is refused", templateProblem({ subject: " ", text: "x" }, fields, []) === "Give it a subject.");
  ok("a subject is one line", templateProblem({ subject: "a\nb", text: "x" }, fields, []) === "The subject is one line.");

  console.log("\n— Every email's template —\n");
  ok("there are templates", MAIL_TEMPLATES.length > 0, MAIL_TEMPLATES.length);
  const keys = MAIL_TEMPLATES.map((t) => t.key);
  ok("keys are unique", new Set(keys).size === keys.length, keys.filter((k, i) => keys.indexOf(k) !== i).join(", "));
  for (const def of MAIL_TEMPLATES) {
    const problem = templateProblem(def, def.fields, def.required);
    const declared = new Set(def.fields.map((f) => f.name));
    const bad = [
      problem,
      MAIL_TEMPLATE_GROUPS.includes(def.group) ? null : `group ${def.group}`,
      def.required.every((r) => declared.has(r)) ? null : "a required field isn't declared",
      def.fields.every((f) => f.sample !== "" && f.about !== "") ? null : "a field has no sample or no words",
      def.label && def.when ? null : "no label or no when",
    ].filter(Boolean);
    ok(`${def.key} — ${def.label}`, bad.length === 0, bad.join("; "));
    const sample = defaultPlatformMail(def.key, sampleValues(def.fields));
    const leftover = fieldsIn(`${sample.subject}\n${sample.text}`);
    if (leftover.length) ok(`  ${def.key}: every field filled in its preview`, false, leftover.join(", "));
  }

  console.log("\n— The console's wording, or Deskzo's —\n");
  const def = MAIL_TEMPLATES.find((t) => t.required.length > 0 && t.fromWorkspace) ?? MAIL_TEMPLATES[0];
  if (!def) throw new Error("No templates to try the store with.");
  setTestMailTemplates({});
  const values = sampleValues(def.fields);
  const plain = await renderPlatformMail(def.key, values);
  ok("nothing saved: Deskzo's wording", plain.subject === defaultPlatformMail(def.key, values).subject && plain.text === defaultPlatformMail(def.key, values).text);
  const linkField = def.required[0];
  const edited = { subject: "Welcome aboard, {" + (def.fields[0]!.name) + "}", text: `Start here: {${linkField ?? def.fields[0]!.name}}` };
  const saved = await saveWording(def.key, edited, "check");
  ok("an owner's wording is saved", saved.ok, saved.ok ? "" : saved.error);
  const after = await renderPlatformMail(def.key, values);
  ok("…and sent from then on", after.text.startsWith("Start here: ") && after.subject.startsWith("Welcome aboard"), after.subject);
  if (linkField) {
    const broken = await saveWording(def.key, { subject: "Hi", text: "No link here" }, "check");
    ok("a wording without the link is refused", !broken.ok && /can't work without/.test(broken.ok ? "" : broken.error));
    setTestMailTemplates({ [def.key]: { subject: "Hi", text: "No link here", updatedAt: "", updatedBy: "x" } });
    const fallback = await renderPlatformMail(def.key, values);
    ok("a saved wording that no longer passes is passed over for Deskzo's", fallback.text === defaultPlatformMail(def.key, values).text);
  }
  setTestMailTemplates({});
  await saveWording(def.key, edited, "check");
  await saveWording(def.key, null, "check");
  ok("back to Deskzo's wording", (await renderPlatformMail(def.key, values)).text === defaultPlatformMail(def.key, values).text);

  console.log("\n— From and layout —\n");
  ok("\"Wroffy Technologies via Deskzo\"", viaDeskzo("Wroffy Technologies") === "Wroffy Technologies via Deskzo");
  ok("a name can't break the From header", viaDeskzo('Evil "Co" <x@y>\r\n') === "Evil Co x@y via Deskzo");
  if (def.fromWorkspace) {
    const mail = await templateMail(def.key, values, { workspace: "Wroffy Technologies" });
    ok("an email about a workspace goes from \"<Workspace> via Deskzo\"", mail.fromName === "Wroffy Technologies via Deskzo", mail.fromName);
  }
  const platformDef = MAIL_TEMPLATES.find((t) => !t.fromWorkspace);
  if (platformDef) {
    const mail = await templateMail(platformDef.key, sampleValues(platformDef.fields), { workspace: "Wroffy Technologies" });
    ok("a platform email keeps Deskzo's own name", mail.fromName === undefined);
  }
  const html = brandedHtml('Hi <b>"you"</b> & co\n\nOpen https://crm.wroffy.com/x?t=1&a=2');
  ok("the layout escapes the text", html.includes("Hi &lt;b&gt;&quot;you&quot;&lt;/b&gt; &amp; co") && !html.includes("<b>"));
  ok("…makes links clickable", html.includes('<a href="https://crm.wroffy.com/x?t=1&amp;a=2"'));
  ok("…and carries no images", !/<img/i.test(html));
  setTestMailTemplates(null);

  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
