/**
 * check:live-demo — "See Deskzo run your business" on deskzo.com (owner, 22 Nov 2026 — src/lib/platform/live-demo.ts).
 *
 *   1. A website as the demo keys it: a path or scheme dropped; nothing that isn't a public domain.
 *   2. Step 1: the site read, the model's answer kept to a real template, sane sample prices and GST rates.
 *   3. Step 2: prospects only as the headlines name them — one the model makes up, or one named twice, is dropped.
 *   4. Step 3: the email, and the products for the quote.
 *   5. A day's cache: the same website again asks nothing; no route, no demo.
 *   6. Sign-up carries the company and a real template only.
 *
 * A stand-in website, news feed and model: nothing leaves the machine.
 *
 *   npm run check:live-demo
 */
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";

// No control plane: the stand-in route and model, and no real pause switch, are what the demo meets here (emptied, not
// deleted — the clients reload .env, which would put a deleted one back).
process.env.CONTROL_DATABASE_URL = "";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const HOME = `<html><head><title>Zz Pumps | Industrial pumps</title><meta name="description" content="Zz Pumps makes centrifugal pumps for sugar mills and plants in Maharashtra."></head><body><a href="/about">About</a></body></html>`;
const ABOUT = `<html><body><p>Zz Pumps of Pune has made centrifugal and submersible pumps since 1998 for sugar, textile and food plants across Maharashtra.</p></body></html>`;
const day = (d: number) => new Date(Date.now() - d * 86_400_000).toUTCString();
const RSS = `<rss><channel>
<item><title>Sahyadri Sugar Works plans new boiler unit - Business Standard</title><link>https://news.example/a</link><pubDate>${day(1)}</pubDate><source url="x">Business Standard</source></item>
<item><title>Kolhapur Textile Mills to expand capacity - Mint</title><link>https://news.example/b</link><pubDate>${day(2)}</pubDate><source url="y">Mint</source></item>
<item><title>Modi inaugurates projects worth crores in Pune - NDTV</title><link>https://news.example/c</link><pubDate>${day(3)}</pubDate><source url="z">NDTV</source></item>
<item><title>Highest Paying Jobs in India this year - Simplilearn</title><link>https://news.example/d</link><pubDate>${day(4)}</pubDate><source url="w">Simplilearn</source></item>
</channel></rss>`;

async function main() {
  const demo = await import("../src/lib/platform/live-demo");
  const gather = await import("../src/lib/research/gather");
  const accounts = await import("../src/lib/ai/accounts");
  const providers = await import("../src/lib/copilot/providers");

  console.log("1. The website");
  await test("a path, a scheme or www is dropped", () => {
    assert.equal(demo.demoDomain("https://www.Zzpumps.in/about"), "zzpumps.in");
    assert.equal(demo.demoDomain("zzpumps.in"), "zzpumps.in");
  });
  await test("nothing that isn't a public domain", () => {
    assert.equal(demo.demoDomain(""), null);
    assert.equal(demo.demoDomain("not a site"), null);
    assert.equal(demo.demoDomain("printer.local"), null);
    assert.equal(demo.demoDomain(42), null);
  });

  console.log("1b. Reading the model's answer");
  await test("fenced, with words around it, or a trailing comma: the object is read", () => {
    assert.deepEqual(demo.jsonIn('Sure!\n\`\`\`json\n{"a": 1}\n\`\`\`'), { a: 1 });
    assert.deepEqual(demo.jsonIn('{"a": [1, 2,], }'), { a: [1, 2] });
    assert.equal(demo.jsonIn("No JSON here"), null);
  });

  const fetched: string[] = [];
  gather.researchFetch.get = async (url: string) => {
    fetched.push(url);
    if (url.startsWith("https://news.google.com/rss/search?q=")) return { url, status: 200, headers: new Headers(), body: RSS, bytes: Buffer.from(""), truncated: false };
    const body = url === "https://zzpumps.in/" ? HOME : url === "https://zzpumps.in/about" ? ABOUT : null;
    if (!body) throw new Error("no such page");
    return { url, status: 200, headers: new Headers({ "content-type": "text/html" }), body, bytes: Buffer.from(""), truncated: false };
  };
  const asked: string[] = [];
  // The first answer is unreadable: the demo asks once more rather than failing the visitor.
  let garbled = true;
  const answers = {
    business: { name: "Zz Pumps", line: "Industrial pumps for plants", city: "Pune", size: null, industry: "manufacturing", buyers: "sugar mills Maharashtra", products: [{ name: "Centrifugal pump 5HP", unit: "unit", samplePrice: 42000, taxRate: 18 }, { name: "Spares kit", unit: "set", samplePrice: 7, taxRate: 7 }] },
    prospects: {
      prospects: [
        { name: "Modi", isCompany: true, why: "inaugurates projects", headline: 2 },
        { name: "Highest Paying Jobs", isCompany: true, why: "jobs", headline: 3 },
        { name: "Sahyadri Sugar Works", isCompany: true, why: "new boiler unit", headline: 0 },
        { name: "Made Up Industries", isCompany: true, why: "invented", headline: 1 },
        { name: "Sahyadri Sugar Works", isCompany: true, why: "again", headline: 0 },
        { name: "Kolhapur Textile Mills", isCompany: true, why: "expanding capacity", headline: 1 },
      ],
    },
    email: { subject: "Pumps for your new boiler unit", body: "Hi,\nCongratulations on the new boiler unit.\n[Your name]" },
  };
  providers.setTestProvider({
    async runTurn(req) {
      const text = req.history[0]!.text;
      asked.push(req.system);
      if (garbled) {
        garbled = false;
        return { text: "I'm not sure what you mean.", toolCalls: [], native: null, usage: { input: 1, output: 1 }, stop: "done", model: "zz" };
      }
      const reply = /Headlines:/.test(text) ? answers.prospects : /subject/.test(text) && /From:/.test(text) ? answers.email : answers.business;
      return { text: `Here you go: ${JSON.stringify(reply)}`, toolCalls: [], native: null, usage: { input: 1, output: 1 }, stop: "done", model: "zz" };
    },
  } as never);
  const route = { feature: "research.brief" as const, model: { key: "zz", label: "Zz", providerModel: "zz", inputRate: 1, outputRate: 1, inputCost: null, outputCost: null }, account: { id: "a", name: "Zz", kind: "ANTHROPIC" as const, residency: "Zzland", noTraining: true }, connection: () => ({}) as never };
  accounts.setTestRoute((f) => (f === "research.brief" ? route : null));
  demo.resetDemoCache();

  console.log("2. Their business");
  const b = await demo.demoBusiness("zzpumps.in");
  await test("an unreadable first answer is asked again, not shown as a failure", () => {
    assert.equal(garbled, false);
    assert.equal(b.name, "Zz Pumps");
  });
  await test("read from their own pages, set up for a real template", () => {
    assert.ok(fetched.includes("https://zzpumps.in/"));
    assert.equal(b.name, "Zz Pumps");
    assert.equal(b.industryKey, "manufacturing");
    assert.ok(b.stages.length >= 3);
  });
  await test("a price or GST rate that can't be one becomes a sample", () => {
    assert.equal(b.products[0]!.samplePrice, 42000);
    assert.equal(b.products[1]!.samplePrice, 10000);
    assert.equal(b.products[1]!.taxRate, 18);
  });

  console.log("3. Prospects from the news");
  const p = await demo.demoProspects("zzpumps.in");
  await test("a person, a topic or a list the model calls a company isn't shown", () => {
    assert.ok(!p.some((x) => x.name === "Modi" || x.name === "Highest Paying Jobs"));
  });
  await test("the code's own check: a company named in its headline, doing something a seller can act on", () => {
    assert.ok(demo.prospectAllowed("Sahyadri Sugar Works", "Sahyadri Sugar Works plans new boiler unit"));
    assert.ok(demo.prospectAllowed("Maruti Suzuki India", "Maruti Suzuki India to set up new plant in Haryana"));
    assert.ok(demo.prospectAllowed("Zepto", "Zepto raises $350 million to expand dark stores"));
    assert.ok(!demo.prospectAllowed("Modi", "Modi inaugurates projects worth crores in Pune"));
    assert.ok(!demo.prospectAllowed("Highest Paying Jobs", "Highest Paying Jobs in India this year"));
    assert.ok(!demo.prospectAllowed("Global corporate restructuring", "Global corporate restructuring: what it means for India"));
    assert.ok(!demo.prospectAllowed("Infosys", "Infosys shares fall 2% on weak guidance"));
    assert.ok(!demo.prospectAllowed("Acme Ltd", "Another firm opens new office"));
  });
  await test("only companies the headlines name, once each, with the headline's link", () => {
    assert.deepEqual(p.map((x) => x.name), ["Sahyadri Sugar Works", "Kolhapur Textile Mills"]);
    assert.equal(p[0]!.url, "https://news.example/a");
    assert.equal(p[0]!.source, "Business Standard");
  });

  console.log("4. The team");
  const t = await demo.demoTeam("zzpumps.in");
  await test("Tara's email to the first prospect, and the products for the quote", () => {
    assert.equal(t.email.to, "Sahyadri Sugar Works");
    assert.equal(t.email.subject, "Pumps for your new boiler unit");
    assert.ok(t.email.body.endsWith("[Your name]"));
    assert.equal(t.products.length, 2);
  });

  console.log("5. Cache and switches");
  await test("the same website again asks the model nothing", async () => {
    const before = asked.length;
    await demo.demoBusiness("zzpumps.in");
    await demo.demoProspects("zzpumps.in");
    await demo.demoTeam("zzpumps.in");
    assert.equal(asked.length, before);
  });
  await test("a step before the first is refused", async () => {
    await assert.rejects(demo.demoProspects("never-read.in"), /Start again/);
  });
  await test("no model set up: the demo says so", async () => {
    accounts.setTestRoute(() => null);
    demo.resetDemoCache();
    await assert.rejects(demo.demoBusiness("zzpumps.in"), /isn't switched on/);
  });
  accounts.setTestRoute(null);
  providers.setTestProvider(null);

  console.log("6. Wiring");
  await test("the actions answer only on deskzo.com, with a trap field and per-caller limits", () => {
    const a = fs.readFileSync("src/actions/platform/live-demo.ts", "utf8");
    assert.ok(a.includes(`classifyHost(host).kind !== "root"`) && a.includes("confirm_url") && a.includes("platform|demo-caller:"));
  });
  await test("sign-up takes the company and only a real template", () => {
    const s = fs.readFileSync("src/components/site/blocks/signup-form.tsx", "utf8");
    assert.ok(s.includes("templateOf(String(query.industry") && s.includes("start={prefillFrom(ctx.searchParams)}"));
  });

  console.log(`\nAll ${passed} live demo checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
