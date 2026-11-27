import { familyOf } from "@/lib/ai/catalogue";
import { routeFor, withoutSecrets } from "@/lib/ai/accounts";
import { aiPaused } from "@/lib/ai/settings";
import { adapterFor } from "@/lib/copilot/providers";
import type { Connection } from "@/lib/copilot/types";
import { toDomain } from "@/lib/domain-intel/signatures";
import { INDUSTRY_TEMPLATES, templateOf } from "@/lib/industry-templates/catalogue";
import { researchFetch, websiteResearch } from "@/lib/research/gather";
import { newsFromRss } from "@/lib/research/parse";

/**
 * "See Deskzo run your business" on deskzo.com (owner, 22 Nov 2026 — "I like the explee.com … sense of live demo and in
 * last ask for money"): a visitor types their website and watches Ved read it, Deskzo set up for their trade, three
 * companies they could sell to found in the news, and Tara and Arjun at work — then is asked to start.
 *
 * Three steps, each its own call so the page shows each as it really finishes: the business, the prospects, the team.
 * Nothing is kept but a day's cache by website, in this process — so the same site twice costs nothing, and nothing a
 * visitor typed outlives the day. No workspace is touched and none is charged: the model is the console's research
 * route (Ved's), called as the console's own "Test account" calls it.
 *
 * What it never does: invent a company. A prospect must be named in a real headline it was found in, and is dropped
 * otherwise; prices on the quote are marked as samples.
 */

export type DemoProduct = { name: string; unit: string; samplePrice: number; taxRate: number };

export type DemoBusiness = {
  domain: string;
  name: string;
  /** What they do, in a line. */
  line: string;
  city: string | null;
  size: string | null;
  industryKey: string;
  industryName: string;
  stages: string[];
  modules: string[];
  /** Who buys from them, as a search for news would put it. */
  buyers: string;
  products: DemoProduct[];
};

export type DemoProspect = { name: string; why: string; url: string; source: string };

export type DemoTeam = { email: { to: string; subject: string; body: string }; products: DemoProduct[] };

export class DemoRefused extends Error {}

const DAY_MS = 24 * 60 * 60_000;
const CACHE_MAX = 500;
type Entry = { at: number; business?: DemoBusiness; prospects?: DemoProspect[]; team?: DemoTeam };
const cache = new Map<string, Entry>();

function entryFor(domain: string, now = Date.now()): Entry | null {
  const e = cache.get(domain);
  if (!e) return null;
  if (now - e.at > DAY_MS) {
    cache.delete(domain);
    return null;
  }
  return e;
}

function keep(domain: string, patch: Partial<Entry>, now = Date.now()) {
  const was = entryFor(domain, now);
  if (!was && cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(domain, { at: was?.at ?? now, ...was, ...patch });
}

/** A website as the demo keys it — "Acme.in/about" is acme.in. Null when it can't be one. */
export function demoDomain(input: unknown): string | null {
  const d = toDomain(typeof input === "string" ? input.trim().slice(0, 200) : "");
  return d && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !/\.(local|localhost|internal|test)$/.test(d) ? d : null;
}

/**
 * An answer's JSON: the object in it, whether fenced (```json … ```) or with words around it; a trailing comma
 * forgiven. Null when there is none. Pure.
 */
export function jsonIn(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  const from = unfenced.indexOf("{");
  const to = unfenced.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  const body = unfenced.slice(from, to + 1);
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* the next, forgiven */
    }
  }
  return null;
}

/**
 * One question to the model, answered as JSON — the console's research route, no workspace, no credits. Asked twice
 * at most: a call that fails, or an answer with no JSON in it, is tried once more (owner, 22 Nov 2026 — "Ved couldn't
 * finish that" on www.trevento.com). The log says which went wrong, with the start of an unreadable answer, so the
 * server's log shows why without a visitor ever seeing it.
 */
async function askJson<T>(system: string, prompt: string, maxTokens = 1500): Promise<T> {
  if (await aiPaused()) throw new DemoRefused("Deskzo's AI is paused just now — try again in a little while.");
  const route = await routeFor("research.brief");
  if (!route) throw new DemoRefused("The live demo isn't switched on yet.");
  let connection: Connection | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text = "";
    try {
      connection = route.connection();
      const outcome = await adapterFor(familyOf(route.account.kind)).runTurn({
        connection,
        model: route.model.providerModel,
        system: `${system} Reply with one JSON object and nothing else — no words before or after it.`,
        history: [{ role: "user", text: prompt }],
        tools: [],
        onText: () => {},
        maxTokens,
        signal: AbortSignal.timeout(60_000),
      });
      text = outcome.text.trim();
      const parsed = jsonIn(text);
      if (parsed && typeof parsed === "object") return parsed as T;
      console.warn(`[live-demo] attempt ${attempt} on ${route.model.key}: no JSON in the answer (stop: ${outcome.stop}) — "${text.slice(0, 200).replace(/\s+/g, " ")}"`);
    } catch (err) {
      console.warn(`[live-demo] attempt ${attempt} on ${route.model.key}: the call failed — ${withoutSecrets(err instanceof Error ? err.message : String(err), connection).slice(0, 300)}`);
    }
  }
  throw new DemoRefused("Ved couldn't finish that just now — try again in a moment.");
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** A price the model offered, kept only when it is a sane sample. */
function price(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 100 && n <= 50_000_000 ? n : 10_000;
}

function rate(v: unknown): number {
  const n = Number(v);
  return [0, 5, 12, 18, 28, 40].includes(n) ? n : 18;
}

/** Step 1: their website read, and Deskzo set up for their trade. */
export async function demoBusiness(domain: string): Promise<DemoBusiness> {
  const cached = entryFor(domain)?.business;
  if (cached) return cached;
  // Before reading anybody's website: whether there is a model to read it with.
  if (await aiPaused()) throw new DemoRefused("Deskzo's AI is paused just now — try again in a little while.");
  if (!(await routeFor("research.brief"))) throw new DemoRefused("The live demo isn't switched on yet.");
  const site = await websiteResearch(domain);
  if (!site.facts) throw new DemoRefused(site.error ?? `${domain} didn't answer — check the address.`);
  const f = site.facts;
  const facts = [
    `Website: ${domain}`,
    f.title && `Title: ${f.title}`,
    f.description && `Description: ${f.description}`,
    f.about && `About: ${clip(f.about, 1500)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const templates = INDUSTRY_TEMPLATES.map((t) => `${t.key} — ${t.name}`).join("\n");
  const r = await askJson<Record<string, unknown>>(
    "You read an Indian business's website for a CRM's setup. Use only the facts given; where they don't say, leave it null.",
    `${facts}\n\nThe CRM's industry templates:\n${templates}\n\nReturn {"name": the business's short name, "line": what it does in under 12 words, "city": its city or null, "size": "about N people" only if the facts say, else null, "industry": one template key from the list, the nearest, "buyers": who buys from it, as 3–6 words a news search could use (e.g. "manufacturing plants Maharashtra"), "products": up to 2 things it sells, each {"name", "unit" (e.g. "unit", "licence", "month"), "samplePrice": a typical price in rupees, "taxRate": the usual GST rate 0, 5, 12, 18 or 28}}.`,
  );
  const template = templateOf(r.industry) ?? templateOf("it_services")!;
  const products = (Array.isArray(r.products) ? r.products : [])
    .slice(0, 2)
    .map((p: Record<string, unknown>) => ({ name: clip(p?.name, 60), unit: clip(p?.unit, 20) || "unit", samplePrice: price(p?.samplePrice), taxRate: rate(p?.taxRate) }))
    .filter((p) => p.name);
  const business: DemoBusiness = {
    domain,
    name: clip(r.name, 60) || domain,
    line: clip(r.line, 100) || clip(f.description, 100) || "",
    city: clip(r.city, 40) || null,
    size: clip(r.size, 30) || null,
    industryKey: template.key,
    industryName: template.name,
    stages: template.stages.map((s) => s.label).slice(0, 6),
    modules: template.modules,
    buyers: clip(r.buyers, 60) || "businesses in India",
    products: products.length ? products : [{ name: "Your main product", unit: "unit", samplePrice: 10_000, taxRate: 18 }],
  };
  keep(domain, { business });
  return business;
}

/**
 * Whether a name the model offered can be shown as a prospect (owner, 22 Nov 2026 — "tighten it": a run showed "Modi",
 * "Highest Paying Jobs in India" and "Global corporate restructuring" as companies). It must be named in its headline
 * as written, look like an organisation's name rather than a topic or a person (capitalised, 1–6 words, none of the
 * words a topic or a list is made of), and the headline must say the company is doing something a seller cares about —
 * hiring, expanding, opening, investing, raising money, winning an order. The model is asked the same; this is
 * the code's own check, so a wrong answer still isn't shown. Pure.
 */
const NOT_A_COMPANY = new Set([
  "govt", "government", "ministry", "minister", "pm", "modi", "cm", "centre", "rbi", "sebi", "budget", "economy", "economic",
  "market", "markets", "stock", "stocks", "shares", "sensex", "nifty", "ipo", "sector", "industry", "jobs", "job", "salary", "salaries",
  "top", "best", "highest", "lowest", "biggest", "largest", "how", "why", "what", "who", "when", "report", "survey", "news",
  "week", "today", "year", "quarter", "q1", "q2", "q3", "q4", "corporate", "restructuring", "layoffs", "trends", "explained", "here", "list",
]);
const GROWTH = /\b(hir(e|es|ing)|recruit|expan(d|ds|sion|ding)|new( [\w-]+)? (plant|office|unit|facility|campus|factory|centre|center|branch|store|line|warehouse)|plans?|open(s|ed|ing)?|launch(es|ed)?|set(s|ting)? up|invest(s|ed|ment|ing)?|rais(e|es|ed)|fund(ing|ed|s)|acqui(re|res|red|sition)|order|contract|wins?|bags?|capacity|plant|facility|headcount|IPO)\b/i;

export function prospectAllowed(name: string, headline: string): boolean {
  const n = name.trim();
  if (n.length < 2 || n.length > 60) return false;
  if (!headline.toLowerCase().includes(n.toLowerCase())) return false;
  const words = n.split(/\s+/);
  if (words.length > 6) return false;
  if (!/^[A-Z0-9]/.test(n)) return false;
  if (words.some((w) => NOT_A_COMPANY.has(w.toLowerCase().replace(/[^a-z0-9']/g, "")))) return false;
  // What the headline says the company does: growth a seller can act on, after its name.
  const after = headline.slice(headline.toLowerCase().indexOf(n.toLowerCase()) + n.length);
  return GROWTH.test(after) || GROWTH.test(headline);
}

/** Step 2: three companies in this month's Indian news that could buy from them — each named in its own headline. */
export async function demoProspects(domain: string): Promise<DemoProspect[]> {
  const e = entryFor(domain);
  if (!e?.business) throw new DemoRefused("Start again from your website.");
  if (e.prospects) return e.prospects;
  const b = e.business;
  const q = encodeURIComponent(`${b.buyers} expansion OR "new plant" OR "new office" OR investment`);
  let items: { title: string; url: string; source: string }[] = [];
  try {
    const res = await researchFetch.get(`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`, {
      timeoutMs: 8_000,
      maxBytes: 600_000,
      maxRedirects: 4,
      headers: { "user-agent": "Mozilla/5.0 (compatible; DeskzoOne/1.0; +https://deskzo.com)", accept: "application/rss+xml,application/xml" },
    });
    if (res.status === 200) items = newsFromRss(res.body, { days: 60, max: 25 }).map((n) => ({ title: n.title, url: n.url, source: n.source ?? "" }));
  } catch {
    items = [];
  }
  let prospects: DemoProspect[] = [];
  if (items.length) {
    const r = await askJson<{ prospects?: { name?: string; isCompany?: boolean; why?: string; headline?: number }[] }>(
      "You pick prospects for an Indian business from news headlines. A prospect is a company or organisation named in the headline that the headline says is growing — hiring, expanding, opening, investing, raising money or winning work. Never a person, a place, a government body, a market index, a topic or a list; never a supplier, competitor or the business itself. Fewer is better than a weak one — return none if none fits.",
      `The business: ${b.name} — ${b.line}. It sells ${b.products.map((p) => p.name).join(", ")} to ${b.buyers}.\n\nHeadlines:\n${items.map((n, i) => `${i}. ${n.title}`).join("\n")}\n\nReturn {"prospects": up to 3, each {"name": the company exactly as the headline names it, "isCompany": true only if it is a company or organisation, "why": what it is doing that means it may buy now, under 10 words, "headline": its number}}.`,
      600,
    );
    const seen = new Set<string>();
    for (const p of r.prospects ?? []) {
      const item = items[Number(p.headline)];
      const name = clip(p.name, 60);
      // Never one the headline doesn't name, one the model doesn't call a company, or one the code's own check refuses.
      if (!item || !name || p.isCompany !== true || !prospectAllowed(name, item.title) || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      prospects.push({ name, why: clip(p.why, 80), url: item.url, source: item.source });
      if (prospects.length === 3) break;
    }
  }
  prospects = prospects.slice(0, 3);
  keep(domain, { prospects });
  return prospects;
}

/** Step 3: Tara's first email to the first prospect, and the products for Arjun's quote. */
export async function demoTeam(domain: string): Promise<DemoTeam> {
  const e = entryFor(domain);
  if (!e?.business) throw new DemoRefused("Start again from your website.");
  if (e.team) return e.team;
  const b = e.business;
  const to = e.prospects?.[0];
  const r = await askJson<{ subject?: string; body?: string }>(
    "You write a short, polite first sales email for an Indian business. Plain words, no hype, no prices, no promises.",
    `From: ${b.name} — ${b.line}.\nTo: ${to ? `${to.name} (${to.why})` : `a company among ${b.buyers}`}.\nReturn {"subject": under 60 characters, "body": under 70 words, starting "Hi," and ending with "[Your name]" on its own line}.`,
    400,
  );
  const team: DemoTeam = {
    email: { to: to?.name ?? "A company you'd like to sell to", subject: clip(r.subject, 80) || `${b.name} for ${to?.name ?? "your team"}`, body: String(r.body ?? "").slice(0, 700).trim() },
    products: b.products,
  };
  keep(domain, { team });
  return team;
}

/** For the check suite. */
export function resetDemoCache() {
  cache.clear();
}
