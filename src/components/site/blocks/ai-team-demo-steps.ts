import type { TeammateKey } from "@/lib/ai/teammates";

/**
 * "Watch your AI team at work" (owner, 23 Nov 2026 — "a demo with real workspaces screen on behind these agents
 * working"): what each teammate does, step by step, on Deskzo's own screens (the site's /ai-team/screens.json, from
 * `npm run site:ai-team-screens`). A step names its screen, may change it — a card Ved writes, the draft Tara leaves in
 * Approvals, a chat Kabir answers — and names the spot to ring. Nothing is asked of a model or of the server: it is a
 * replay, and the page says so (ai-team-demo-view.tsx).
 *
 * The screens are rendered pages, so a spot is found by its words (`findText`) and by the marks the generator leaves:
 * `data-tag="h1"`, `"a"`, `"section"`, `"main"` where a heading, link or landmark was, and `data-mk` on the header's
 * person. A screen whose words change and lose a spot still shows; its ring just has nothing to ring.
 *
 * The company, people and amounts are samples; what each teammate does, and where a person decides, follows
 * src/lib/ai/teammates.ts.
 */

export type DemoCtx = { faces: Record<string, string>; anim: boolean; lead: string };
export type DemoStep = {
  screen: string;
  /** The address shown in the window's bar. */
  url: (ctx: { lead: string }) => string;
  say: string;
  /** Who is signed in, when not the teammate's usual person. */
  who?: [string, string];
  act?: (root: HTMLElement, ctx: DemoCtx) => void;
  target: (root: HTMLElement) => Element | null;
};
export type DemoAgent = { key: TeammateKey; who: [string, string]; steps: DemoStep[] };

// ---------- over a rendered screen ----------
function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}
/** The deepest element under `root` (matching `sel`) whose words include `text`. */
export function findText(root: ParentNode, text: string, sel = "*"): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const node of Array.from(root.querySelectorAll<HTMLElement>(sel))) {
    if ((node.textContent ?? "").includes(text) && (!best || best.contains(node))) best = node;
  }
  return best;
}
const card = (node: Element | null) => (node?.closest(".rounded-xl") as HTMLElement | null) ?? null;
const face = (ctx: DemoCtx, key: string) => `<span class="inline-flex shrink-0" style="width:28px;height:28px">${ctx.faces[key] ?? ""}</span>`;
function fresh<T extends Element | null>(node: T, ctx: DemoCtx): T {
  if (ctx.anim && node) node.classList.add("animate-fade-rise");
  return node;
}
const BTN = "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-base font-medium h-8 px-3 text-[13px] ";
const PRIMARY = `${BTN}bg-brand text-white shadow-sm`;
const SECONDARY = `${BTN}bg-surface text-text border border-line-strong shadow-sm`;
function pill(text: string, tone: "warn" | "good" | "info" = "info"): string {
  const c = tone === "warn" ? "bg-warning-bg text-warning" : tone === "good" ? "bg-success-bg text-success" : "bg-info-bg text-info";
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${c}">${text}</span>`;
}
function bubble(from: "ai" | "visitor" | "person", text: string, who: string, mk = ""): string {
  const mine = from === "ai";
  return `<div class="flex ${mine ? "justify-end" : "justify-start"}"${mk ? ` data-mk="${mk}"` : ""}><div class="max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm ${
    mine ? "bg-brand text-white" : "bg-surface-sunken text-text"
  }"><span class="block text-[11px] ${mine ? "opacity-80" : "text-muted"}">${who}</span>${text}</div></div>`;
}
const chip = (root: HTMLElement, text: string) => {
  const t = findText(root, text);
  return (t?.closest('[data-tag="a"], span.rounded-full, div.rounded-full') as HTMLElement | null) ?? t;
};

/** The person signed in, in the screens' header. */
export function setWho(root: HTMLElement, who: [string, string]) {
  const name = root.querySelector('[data-mk="who"]');
  const role = root.querySelector('[data-mk="role"]');
  const initials = root.querySelector('[data-mk="initials"]');
  if (name) name.textContent = who[0];
  if (role) role.textContent = who[1];
  if (initials) initials.textContent = who[0].split(/\s+/).map((p) => p[0]).join("");
  // Today's greeting is the hour the screens were made at ("Working late, …"): the demo's day starts in the morning.
  for (const h of Array.from(root.querySelectorAll('[data-tag^="h"]'))) {
    if (/^(Working late|Good (morning|afternoon|evening)),/.test(h.textContent ?? "")) h.textContent = `Good morning, ${who[0].split(/\s+/)[0]}`;
  }
}

// ---------- the cards the teammates leave ----------
function vedPlan(root: HTMLElement, ctx: DemoCtx) {
  const products = card(findText(root, "Products required"));
  if (!products) return;
  const c = el(
    `<div class="rounded-xl border border-line bg-surface shadow-sm" data-mk="ved-plan">` +
      `<div class="flex items-center gap-2 border-b border-line px-5 py-3.5 text-sm font-medium text-text">${face(ctx, "ved")} Research &amp; plan <span class="ml-auto text-xs font-normal text-muted">by Ved · just now</span></div>` +
      `<div class="grid gap-6 px-5 py-4 text-sm md:grid-cols-2"><div><p class="text-xs font-semibold uppercase tracking-wide text-muted">What to know</p><ul class="mt-2 list-disc space-y-1.5 pl-4 text-text">` +
      "<li>Corporate travel company, about 180 people, offices in Kolkata, Delhi and Pune</li><li>Opening a new Pune branch in January (news, 12 November)</li><li>Hiring an IT administrator: they're building a team</li><li>Customers like this bought laptops and Microsoft 365; first orders averaged ₹6.8 lakh</li></ul></div>" +
      `<div><p class="text-xs font-semibold uppercase tracking-wide text-muted">The plan</p><ol class="mt-2 list-decimal space-y-1.5 pl-4 text-text">` +
      "<li>Call Deepa Nair on Tuesday morning and ask when the Pune branch opens</li><li>Offer 40 laptops with a three-year warranty, and Microsoft 365 for the new branch</li><li>After the call, Tara drafts the follow-up</li></ol></div></div></div>",
  );
  products.parentNode?.insertBefore(fresh(c, ctx), products);
}
function taraDraft(root: HTMLElement, ctx: DemoCtx) {
  const plan = root.querySelector('[data-mk="ved-plan"]');
  if (!plan) return;
  const c = el(
    `<div class="rounded-xl border border-line bg-surface shadow-sm" data-mk="tara-draft">` +
      `<div class="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3.5 text-sm font-medium text-text">${face(ctx, "tara")} Follow-up email ${pill("Waiting for Rohit", "warn")}<span class="ml-auto text-xs font-normal text-muted">by Tara · just now</span></div>` +
      `<div class="space-y-2 px-5 py-4 text-sm"><p class="text-xs text-muted">To Deepa Nair &lt;deepa@vertextravels.example&gt;</p><p class="font-medium text-text">Laptops for your Pune branch</p>` +
      `<p class="whitespace-pre-line text-text">Hi Deepa,\n\nThanks for your enquiry yesterday. For the Pune branch opening in January, we can have 40 laptops set up with Microsoft 365, ready a week before you move in.\n\nWould Tuesday morning suit you for a short call?\n\nRohit</p></div></div>`,
  );
  plan.parentNode?.insertBefore(fresh(c, ctx), plan.nextSibling);
}

const lead = ({ lead: ref }: { lead: string }) => `/leads/${ref}`;
const at = (path: string) => () => path;

// ---------- Deskzo AI's panel, as src/components/copilot/copilot-panel.tsx draws it ----------
function aiPanel(root: HTMLElement, ctx: DemoCtx) {
  if (root.querySelector('[data-mk="ai-panel"]')) return;
  root.appendChild(fresh(el(`<div class="absolute inset-0 z-20 bg-text/20"></div>`), ctx));
  const p = el(
    `<div class="absolute right-0 top-0 z-30 flex h-[900px] w-[460px] flex-col border-l border-line bg-surface shadow-xl" data-mk="ai-panel">` +
      `<div class="flex items-center gap-2 border-b border-line px-4 py-3">${face(ctx, "deskzo")}<span class="text-sm font-semibold text-text">Deskzo AI</span><span class="truncate text-[11px] text-subtle">Your AI team</span></div>` +
      `<div class="flex-1 space-y-3 overflow-hidden px-4 py-4" data-mk="ai-chat"></div>` +
      `<div class="border-t border-line px-4 py-3"><div class="min-h-[2.5rem] rounded-base border border-line-strong bg-surface px-3 py-2 text-[13px] text-subtle">Ask anything — or ask a teammate by name…</div></div></div>`,
  );
  root.appendChild(fresh(p, ctx));
}
/** The three owing the most, as Today's "Payments to chase" lists them — so the answer and the screen agree. */
function owing(root: HTMLElement): { name: string; amount: string; late: string }[] {
  const box = card(findText(root, "Payments to chase"));
  const rows = Array.from(box?.querySelectorAll("li") ?? []).slice(0, 3);
  const found = rows
    .map((li) => {
      const detail = li.querySelector(".text-xs")?.textContent ?? "";
      return { name: li.querySelector(".text-sm")?.textContent?.trim() ?? "", amount: detail.match(/₹[\d.,]+\s?[LKCr]*/)?.[0] ?? "", late: detail.match(/oldest (\d+) days? late/)?.[1] ?? "" };
    })
    .filter((r) => r.name && r.amount);
  return found.length
    ? found
    : [
        { name: "Northstar Hospitals LLP", amount: "₹36L", late: "13" },
        { name: "Everest Realty Limited", amount: "₹27.2L", late: "13" },
        { name: "Orion Education Limited", amount: "₹26.2L", late: "13" },
      ];
}

export const AI_TEAM_DEMO: DemoAgent[] = [
  {
    key: "deskzo",
    who: ["Rohit Patil", "Sales"],
    steps: [
      {
        screen: "ved-today",
        url: at("/today"),
        target: (r) => findText(r, "Ask Deskzo AI"),
        say: "Anyone can ask Deskzo AI about their records and their work, from any page.",
      },
      {
        screen: "ved-today",
        url: at("/today"),
        act: (r, ctx) => {
          aiPanel(r, ctx);
          r.querySelector('[data-mk="ai-chat"]')?.appendChild(
            fresh(el(`<div class="ml-8 whitespace-pre-wrap rounded-base bg-brand px-3 py-2 text-[13px] text-brand-contrast" data-mk="ask">Who owes us the most, and what should I do about it today?</div>`), ctx),
          );
        },
        target: (r) => r.querySelector('[data-mk="ask"]'),
        say: "Rohit asks in plain words.",
      },
      {
        screen: "ved-today",
        url: at("/today"),
        act: (r, ctx) => {
          const chat = r.querySelector('[data-mk="ai-chat"]');
          if (!chat) return;
          const top = owing(r);
          chat.appendChild(fresh(el(`<p class="text-[11px] text-subtle">✓ Looked up the unpaid invoices you can see</p>`), ctx));
          chat.appendChild(
            fresh(
              el(
                `<div class="mr-4 space-y-2" data-mk="answer"><p class="text-[13px] text-text">These three owe the most, and nobody has followed up with any of them yet:</p>` +
                  `<div class="overflow-hidden rounded-base border border-line"><div class="border-b border-line bg-surface-sunken px-3 py-2 text-xs font-medium text-text">Owed the most, overdue</div><table class="w-full text-[13px]"><tbody>` +
                  top.map((t) => `<tr class="border-t border-line first:border-t-0"><td class="px-3 py-2 text-text">${t.name}</td><td class="px-3 py-2 text-right tabular-nums text-text">${t.amount}</td></tr>`).join("") +
                  `</tbody></table></div><p class="text-[13px] text-text">Start with ${top[0]!.name}${top[0]!.late ? `: the oldest of its invoices is ${top[0]!.late} days late` : ""}. Shall I ask Arjun to draft the chase emails?</p></div>`,
              ),
              ctx,
            ),
          );
        },
        target: (r) => r.querySelector('[data-mk="answer"]'),
        say: "It answers from the records Rohit is allowed to see, with the figures, and says what to do first.",
      },
      {
        screen: "ved-today",
        url: at("/today"),
        act: (r, ctx) => {
          const chat = r.querySelector('[data-mk="ai-chat"]');
          if (!chat) return;
          chat.appendChild(fresh(el(`<div class="ml-8 rounded-base bg-brand px-3 py-2 text-[13px] text-brand-contrast">Yes, ask Arjun.</div>`), ctx));
          chat.appendChild(fresh(el(`<p class="text-center text-[11px] text-subtle">Arjun joined</p>`), ctx));
          chat.appendChild(
            fresh(
              el(
                `<div class="mr-4 flex items-start gap-2" data-mk="handoff">${face(ctx, "arjun")}<div class="min-w-0 flex-1 rounded-base bg-surface-sunken px-3 py-2 text-[13px] text-text"><span class="font-semibold">Arjun</span> Three chase emails drafted. They're waiting in your Approvals for you to read and send.</div></div>`,
              ),
              ctx,
            ),
          );
        },
        target: (r) => r.querySelector('[data-mk="handoff"]'),
        say: "And it brings in the right teammate: Arjun drafts the emails, and a person sends them.",
      },
    ],
  },
  {
    key: "ved",
    who: ["Rohit Patil", "Sales"],
    steps: [
      {
        screen: "ved-today",
        url: at("/today"),
        target: (r) => card(findText(r, "Your AI team today")),
        say: "7:30 in the morning. Before Rohit logs in, Ved goes through every open lead.",
      },
      {
        screen: "ved-today",
        url: at("/today"),
        act: (r, ctx) => {
          const list = card(findText(r, "Your AI team today"))?.querySelector(".space-y-2\\.5");
          if (!list) return;
          const item = el(
            `<div class="flex items-start gap-2.5" data-mk="picks">${face(ctx, "ved")}<div class="min-w-0 flex-1 rounded-xl bg-surface-sunken px-3 py-2 text-sm text-text"><span class="font-semibold">Ved</span> 3 leads to work first today` +
              `<ol class="mt-1.5 list-decimal space-y-1 pl-4 text-[13px]"><li><b>Vertex Travels</b>: website enquiry last night, laptops for a new branch</li><li><b>Orion Education</b>: opened your proposal three times yesterday</li><li><b>Pinnacle Pharma</b>: 120 licences renew in 21 days</li></ol></div></div>`,
          );
          list.insertBefore(fresh(item, ctx), list.firstChild);
        },
        target: (r) => r.querySelector('[data-mk="picks"]'),
        say: "Three picks for today, each with a reason. Rohit opens the first one.",
      },
      { screen: "ved-lead", url: lead, target: (r) => chip(r, "Research & plan"), say: "On the lead, Ved starts the research." },
      {
        screen: "ved-lead",
        url: lead,
        act: (r, ctx) => {
          const p = findText(r, "Nothing looked up yet", "p");
          if (p) fresh(p, ctx).textContent = "Looked up just now: vertextravels.example, a travel company with offices in Kolkata, Delhi and Pune. GST registration active since 2014.";
        },
        target: (r) => card(findText(r, "Domain & web")),
        say: "Ved reads the company's website and this month's news, and checks its GST registration.",
      },
      { screen: "ved-lead", url: lead, act: vedPlan, target: (r) => r.querySelector('[data-mk="ved-plan"]'), say: "What to know and a plan for the first call, at the top of the lead." },
      { screen: "ved-lead", url: lead, target: (r) => findText(r, "Deal owner"), say: "Rohit reads it and decides what to do. Ved only reads public pages and never contacts anyone." },
    ],
  },
  {
    key: "tara",
    who: ["Rohit Patil", "Sales"],
    steps: [
      {
        screen: "ved-lead",
        url: lead,
        act: (r, ctx) => {
          vedPlan(r, { ...ctx, anim: false });
          const t = findText(r, "Ved's plan first");
          if (t) t.textContent = "Drafting…";
        },
        target: (r) => chip(r, "Drafting…"),
        say: "With Ved's plan in, Tara drafts the follow-up.",
      },
      {
        screen: "ved-lead",
        url: lead,
        act: (r, ctx) => {
          const t = findText(r, "Drafting…");
          if (t) t.textContent = "Draft ready";
          taraDraft(r, ctx);
        },
        target: (r) => r.querySelector('[data-mk="tara-draft"]'),
        say: "Written in your house style: short, warm, and signed by the lead's owner.",
      },
      {
        screen: "tara-approvals",
        url: at("/approvals"),
        act: (r, ctx) => {
          const empty = findText(r, "Nothing is waiting for you to decide.");
          if (!empty) return;
          const row = el(
            `<div class="rounded-xl border border-line bg-surface shadow-sm" data-mk="approval"><div class="flex flex-wrap items-center gap-3 p-4">${face(ctx, "tara")}` +
              `<div class="min-w-0 flex-1"><p class="text-sm font-medium text-text">Tara's follow-up to Deepa Nair, Vertex Travels</p><p class="text-xs text-muted">“Laptops for your Pune branch” · drafted 2 minutes ago</p></div>` +
              `<span class="${SECONDARY}">Edit</span><span class="${SECONDARY}">Discard</span><span class="${PRIMARY}" data-mk="approve">Approve and send</span></div></div>`,
          );
          empty.parentNode?.replaceChild(fresh(row, ctx), empty);
        },
        target: (r) => r.querySelector('[data-mk="approval"]'),
        say: "The draft waits in Rohit's Approvals.",
      },
      { screen: "tara-approvals", url: at("/approvals"), target: (r) => r.querySelector('[data-mk="approve"]'), say: "Tara never sends an email. Rohit approves, edits or discards it, and Tara learns from the changes." },
    ],
  },
  {
    key: "kabir",
    who: ["Neha Joshi", "Support"],
    steps: [
      {
        screen: "kabir-inbox",
        url: at("/inbox"),
        act: (r, ctx) => {
          const li = findText(r, "No conversations here.", "li");
          li?.parentNode?.replaceChild(
            fresh(
              el(
                `<li class="border-b border-line bg-surface-sunken px-4 py-3" data-mk="conv"><div class="flex items-center gap-2"><span class="h-2 w-2 rounded-full bg-success"></span><span class="text-sm font-medium text-text">Visitor from Pune</span><span class="ml-auto text-xs text-muted">8:40 pm</span></div><p class="mt-1 truncate text-xs text-muted">Website chat · Do you sell Microsoft 365 for a 15 person office?</p></li>`,
              ),
              ctx,
            ),
            li,
          );
          const pane = findText(r, "Choose a conversation.", '[data-tag="section"]');
          if (!pane) return;
          pane.className = "flex min-w-0 flex-1 flex-col";
          pane.innerHTML =
            `<div class="flex items-center gap-3 border-b border-line px-5 py-3"><div class="min-w-0 flex-1"><p class="text-sm font-medium text-text">Visitor from Pune</p><p class="text-xs text-muted">Website chat · zenith.example/pricing</p></div><span data-mk="answering">${pill("Kabir is answering", "good")}</span></div>` +
            `<div class="flex-1 space-y-3 p-5" data-mk="thread">${bubble("visitor", "Hi, do you sell Microsoft 365 for a 15 person office? What's the price?", "Visitor")}</div>`;
        },
        target: (r) => r.querySelector('[data-mk="conv"]'),
        say: "8:40 in the evening. A visitor opens the chat on your website.",
      },
      {
        screen: "kabir-inbox",
        url: at("/inbox"),
        act: (r, ctx) => {
          r.querySelector('[data-mk="thread"]')?.appendChild(
            fresh(el(bubble("ai", "Yes. Most offices of 15 take Microsoft 365 Business Standard: ₹960 a person a month plus GST, billed yearly. Each person gets Outlook, Teams and 1 TB of storage. Shall I have someone send you a quote?", "Kabir (AI)", "k1")), ctx),
          );
        },
        target: (r) => r.querySelector('[data-mk="k1"]'),
        say: "Kabir answers from your own guides and price list, and says it's an AI.",
      },
      {
        screen: "kabir-inbox",
        url: at("/inbox"),
        act: (r, ctx) => {
          const t = r.querySelector('[data-mk="thread"]');
          t?.appendChild(fresh(el(bubble("visitor", "Yes please. Can you also move our old Gmail?", "Visitor")), ctx));
          t?.appendChild(fresh(el(bubble("ai", "We can: mail, contacts and calendars move over a weekend. I've asked Neha from our team to join. Neha is online until 9.", "Kabir (AI)", "k2")), ctx));
        },
        target: (r) => r.querySelector('[data-mk="k2"]'),
        say: "A sale goes to a person: Kabir hands the chat to Neha.",
      },
      {
        screen: "kabir-inbox",
        url: at("/inbox"),
        act: (r, ctx) => {
          const t = r.querySelector('[data-mk="thread"]');
          t?.appendChild(fresh(el(`<p class="text-center text-xs text-muted" data-mk="k3">Neha joined · Lead made: “15 people, Microsoft 365 and a Gmail move”, owner Neha</p>`), ctx));
          t?.appendChild(fresh(el(bubble("person", "Hi, I'm Neha. I'll send the quote tonight. What's the best email for it?", "Neha")), ctx));
          const a = r.querySelector('[data-mk="answering"]');
          if (a) a.innerHTML = pill("Neha");
        },
        target: (r) => r.querySelector('[data-mk="k3"]'),
        say: "Neha takes over, and a lead is made, so nothing waits for the morning.",
      },
    ],
  },
  {
    key: "mira",
    who: ["Rohit Patil", "Admin"],
    steps: [
      { screen: "mira-automate", url: at("/automate/workflows"), target: (r) => findText(r, "Describe it to Mira", "button") ?? findText(r, "Describe it to Mira"), say: "The owner describes a rule the way they'd say it to a colleague." },
      {
        screen: "mira-automate",
        url: at("/automate/workflows"),
        act: (r, ctx) => {
          r.appendChild(
            fresh(
              el(
                `<div><div class="absolute inset-0 bg-text/30"></div><div class="absolute left-1/2 top-[150px] w-[620px] -translate-x-1/2 rounded-xl border border-line bg-surface p-5 shadow-lg">` +
                  `<div class="flex items-center gap-2 text-sm font-semibold text-text">${face(ctx, "mira")} Describe it to Mira</div>` +
                  `<div class="mt-3 rounded-base border border-line-strong bg-surface px-3 py-2.5 text-sm text-text" data-mk="said">When a deal over ₹1 lakh is won, give accounts a task to raise the invoice the next day, and tell my sales head.</div>` +
                  `<div class="mt-3 flex justify-end gap-2"><span class="${SECONDARY}">Cancel</span><span class="${PRIMARY}">Build it</span></div></div></div>`,
              ),
              ctx,
            ),
          );
        },
        target: (r) => r.querySelector('[data-mk="said"]'),
        say: "“When a deal over ₹1 lakh is won, give accounts a task to raise the invoice the next day, and tell my sales head.”",
      },
      {
        screen: "mira-workflow",
        url: at("/automate/workflows/WF-0002"),
        act: (r, ctx) => {
          for (const input of Array.from(r.querySelectorAll<HTMLInputElement>('[data-tag="main"] input'))) {
            if (input.getAttribute("value") === "New workflow") input.setAttribute("value", "Invoice task for big wins");
            if (input.getAttribute("placeholder") === "What it is for, in a line") input.setAttribute("value", "Made by Mira from what you said");
          }
          const crumb = findText(r, "WF-0001");
          if (crumb) crumb.innerHTML = crumb.innerHTML.replace("WF-0001", "WF-0002");
          const trigger = findText(r, "When somebody presses Run", "div, p, span");
          if (trigger) trigger.textContent = "When a lead moves to Won";
          for (const o of Array.from(r.querySelectorAll("option"))) if (o.hasAttribute("selected") && o.textContent === "When somebody presses Run") o.textContent = "When a lead moves to Won";
          const title = findText(r, "Notify a person");
          const step = card(title) ?? (title?.closest("div[class*='rounded']") as HTMLElement | null);
          if (!step) return;
          const make = (name: string, sub: string) => {
            const c = step.cloneNode(true) as HTMLElement;
            const t = findText(c, "Notify a person");
            if (t) t.textContent = name;
            const s = findText(c, "Hello from a workflow");
            if (s) s.textContent = sub;
            return fresh(c, ctx);
          };
          const group = el(`<div class="space-y-3" data-mk="steps"></div>`);
          group.appendChild(make("Only if", "Its value is more than ₹1,00,000"));
          group.appendChild(make("Make a task", "For Accounts: “Raise the invoice for {lead}”, due the next working day"));
          group.appendChild(make("Notify a person", "Anil, sales head: “{owner} won {lead}, {value}”"));
          step.parentNode?.replaceChild(group, step);
        },
        target: (r) => r.querySelector('[data-mk="steps"]'),
        say: "Mira builds it: when, if, then, matched to your own departments and people.",
      },
      { screen: "mira-workflow", url: at("/automate/workflows/WF-0002"), target: (r) => findText(r, "Publish", "button") ?? findText(r, "Publish"), say: "It's saved as a draft. Nothing runs until a person checks it and publishes." },
    ],
  },
  {
    key: "arjun",
    who: ["Kunal Shah", "Accounts"],
    steps: [
      { screen: "arjun-collections", url: at("/collections"), target: (r) => card(findText(r, "Who to chase today")), say: "Each morning Arjun ranks who to chase, straight from your books. The list needs no AI." },
      {
        screen: "arjun-collections",
        url: at("/collections"),
        act: (r, ctx) => {
          const first = card(findText(r, "Who to chase today"))?.querySelector("li");
          const name = first?.querySelector('[data-tag="a"]')?.textContent || "the first customer";
          first?.appendChild(
            fresh(
              el(
                `<div class="mt-3 ml-8 rounded-xl border border-line bg-surface-sunken p-4 text-sm" data-mk="chase"><div class="flex flex-wrap items-center gap-2">${face(ctx, "arjun")}` +
                  `<span class="font-medium text-text">Chase email to ${name}, drafted</span>${pill("Waiting for Kunal to send", "warn")}</div>` +
                  `<p class="mt-2 text-xs text-muted">To their accounts team · “Two invoices overdue”</p>` +
                  `<p class="mt-1.5 text-text">Dear Accounts team, two of our invoices to you are now overdue; the older one is 13 days late. Could you confirm a date for the payment? The statement is attached. Regards, Kunal</p></div>`,
              ),
              ctx,
            ),
          );
        },
        target: (r) => r.querySelector('[data-mk="chase"]'),
        say: "Asked, Arjun drafts the chase email. Kunal reads it and sends it.",
      },
      {
        screen: "arjun-bill",
        url: at("/purchase/bills/read"),
        act: (r, ctx) => {
          const drop = findText(r, "Drop the vendor's bill here");
          const zone = (drop?.closest("[class*='border-dashed']") as HTMLElement | null) ?? (drop?.parentElement ?? null);
          if (!zone) return;
          zone.innerHTML =
            `<div class="flex flex-col items-center justify-center gap-3 p-10 text-center" data-mk="pdf"><div class="flex h-28 w-24 flex-col justify-between rounded-base border border-line-strong bg-surface p-2 shadow-sm"><span class="text-[10px] font-semibold text-danger">PDF</span><span class="block h-1 rounded bg-surface-sunken"></span><span class="block h-1 rounded bg-surface-sunken"></span><span class="block h-1 rounded bg-surface-sunken"></span></div>` +
            `<p class="text-sm font-medium text-text">NSD-88412.pdf</p><p class="text-xs text-muted">Northstar Distributors · 1 page · uploaded just now</p></div>`;
          fresh(zone.firstElementChild, ctx);
        },
        target: (r) => r.querySelector('[data-mk="pdf"]'),
        say: "A vendor's bill arrives as a PDF and is dropped in.",
      },
      {
        screen: "arjun-bill",
        url: at("/purchase/bills/read"),
        act: (r, ctx) => {
          const panel = card(findText(r, "Arjun reads it for you"));
          if (!panel) return;
          const row = (a: string, b: string, c: string, strong = false) =>
            `<tr class="border-t border-line${strong ? " font-semibold text-text" : ""}"><td class="py-2 pr-3">${a}</td><td class="py-2 pr-3 text-muted">${b}</td><td class="py-2 text-right tabular-nums">${c}</td></tr>`;
          panel.appendChild(
            fresh(
              el(
                `<div class="border-t border-line p-5 text-sm" data-mk="draft-bill">` +
                  `<dl class="grid grid-cols-2 gap-x-4 gap-y-2"><div><dt class="text-xs text-muted">Vendor</dt><dd class="font-medium text-text">Northstar Distributors</dd></div><div><dt class="text-xs text-muted">GSTIN</dt><dd class="text-text">27AAACN0000A1Z5 (sample)</dd></div>` +
                  `<div><dt class="text-xs text-muted">Bill number</dt><dd class="text-text">NSD/25-26/88412</dd></div><div><dt class="text-xs text-muted">Bill date</dt><dd class="text-text">18 Nov 2026</dd></div></dl>` +
                  `<table class="mt-4 w-full text-sm"><tbody>${row("Laptop, 14-inch, i5, 16 GB", "10 × ₹52,000", "₹5,20,000.00")}${row("Laptop bag", "10 × ₹650", "₹6,500.00")}${row("CGST 9% + SGST 9%", "on ₹5,26,500", "₹94,770.00")}${row("Total", "", "₹6,21,270.00", true)}</tbody></table>` +
                  `<div class="mt-4 flex flex-wrap items-center gap-2">${pill("GST checked", "good")}${pill("Totals add up", "good")}<span class="ml-auto ${PRIMARY}" data-mk="save">Save draft bill</span></div></div>`,
              ),
              ctx,
            ),
          );
        },
        target: (r) => r.querySelector('[data-mk="draft-bill"]'),
        say: "Arjun reads it into a draft bill, and checks the GST and the totals.",
      },
      { screen: "arjun-bill", url: at("/purchase/bills/read"), target: (r) => r.querySelector('[data-mk="save"]'), say: "Nothing reaches the books until Kunal checks the draft and saves it." },
      {
        screen: "arjun-bank",
        url: at("/accounting/banking"),
        act: (r, ctx) => {
          const head = findText(r, "Reconciling", "span");
          const box = card(head);
          if (!head || !box) return;
          const line = (who: string, amt: string, match: string, tone: "good" | "warn", mk = "") =>
            `<li class="flex flex-wrap items-center gap-3 px-5 py-3"${mk ? ` data-mk="${mk}"` : ""}><div class="min-w-0 flex-1"><p class="text-sm text-text">${who}</p><p class="text-xs text-muted">23 Nov 2026 · bank statement</p></div><span class="tabular-nums text-sm text-text">${amt}</span>${pill(match, tone)}</li>`;
          const list = el(
            `<div data-mk="bank"><p class="flex items-center gap-2 px-5 pt-3 text-xs text-muted">${face(ctx, "arjun")} Yesterday's statement, matched by Arjun</p><ol class="divide-y divide-line">` +
              line("NEFT · NORTHSTAR MOTORS LLP", "₹4,15,360.00", "Northstar Motors LLP · INV-2311", "good") +
              line("IMPS · BLUESTONE TRAVELS", "₹6,266.00", "Bluestone Travels Limited · INV-2327", "good") +
              line("UPI · GREENFIELD PHARMA", "₹18,833.00", "Greenfield Pharma Pvt Ltd · INV-2340", "good") +
              line("NEFT · R K TRADERS", "₹12,400.00", "Not sure: no invoice for this amount. For Kunal", "warn", "unsure") +
              "</ol></div>",
          );
          box.insertBefore(fresh(list, ctx), head.parentNode?.nextSibling ?? null);
        },
        target: (r) => r.querySelector('[data-mk="bank"]'),
        say: "Yesterday's bank lines: Arjun works out whose money each one is.",
      },
      { screen: "arjun-bank", url: at("/accounting/banking"), target: (r) => r.querySelector('[data-mk="unsure"]'), say: "Anything Arjun isn't sure of is left for a person, and nothing is recorded twice." },
    ],
  },
  {
    key: "priya",
    who: ["Anjali Mehta", "Sales"],
    steps: [
      {
        screen: "priya-myhr",
        url: at("/people/me"),
        act: (r, ctx) => {
          const h1 = findText(r, "My HR", '[data-tag="h1"]');
          const top = h1?.parentElement?.parentElement;
          if (!top?.parentNode) return;
          const c = el(
            `<div class="mb-6 rounded-xl border border-line bg-surface shadow-sm" data-mk="ask"><div class="flex items-center gap-2 border-b border-line px-5 py-3.5 text-sm font-medium text-text">${face(ctx, "priya")}` +
              ` Ask HR <span class="ml-auto text-xs font-normal text-muted">Priya answers from your own records · AI</span></div><div class="space-y-3 px-5 py-4" data-mk="hr-chat">${bubble("person", "How many leaves do I have left?", "Anjali")}</div></div>`,
          );
          top.parentNode.insertBefore(fresh(c, ctx), top.nextSibling);
        },
        target: (r) => r.querySelector('[data-mk="ask"]'),
        say: "Anjali asks the HR desk from My HR.",
      },
      {
        screen: "priya-myhr",
        url: at("/people/me"),
        act: (r, ctx) => {
          r.querySelector('[data-mk="hr-chat"]')?.appendChild(fresh(el(bubble("ai", "You have 12 casual, 8 sick and 12 earned leaves left this year.", "Priya (AI)")), ctx));
        },
        target: (r) => card(findText(r, "Leave balance")),
        say: "Priya answers from Anjali's own leave balance.",
      },
      {
        screen: "priya-myhr",
        url: at("/people/me"),
        act: (r, ctx) => {
          const chat = r.querySelector('[data-mk="hr-chat"]');
          chat?.appendChild(fresh(el(bubble("person", "When's the next holiday?", "Anjali")), ctx));
          chat?.appendChild(fresh(el(bubble("ai", "Christmas, Friday 25 December, from the company's holiday calendar.", "Priya (AI)")), ctx));
        },
        target: (r) => card(findText(r, "Next holiday")) ?? card(findText(r, "Christmas")),
        say: "And from the company's holiday calendar.",
      },
      {
        screen: "priya-myhr",
        url: at("/people/me"),
        act: (r, ctx) => {
          const chat = r.querySelector('[data-mk="hr-chat"]');
          chat?.appendChild(fresh(el(bubble("person", "Why was my November salary lower?", "Anjali")), ctx));
          chat?.appendChild(fresh(el(bubble("ai", "I can't see pay: salaries never go to the AI. I've passed your question to HR, and you'll be told when they answer.", "Priya (AI)", "pay")), ctx));
        },
        target: (r) => r.querySelector('[data-mk="pay"]'),
        say: "Anything about money goes to HR. Salaries never go to the AI.",
      },
      {
        screen: "priya-hr",
        url: at("/people/hr-desk"),
        who: ["Meena Iyer", "HR"],
        act: (r, ctx) => {
          const off = findText(r, "switched off", "p");
          if (off) off.textContent = "Questions Priya couldn't answer, or where somebody asked for a person. Your answer appears under their question on My HR, and they're told.";
          const empty = findText(r, "Nothing waiting");
          const box = card(empty) ?? empty;
          if (!box) return;
          box.innerHTML =
            `<div class="flex flex-wrap items-center gap-3 p-4" data-mk="hr-q"><span class="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-sunken text-xs font-semibold text-text">AM</span>` +
            `<div class="min-w-0 flex-1"><p class="text-sm font-medium text-text">Why was my November salary lower?</p><p class="text-xs text-muted">Anjali Mehta, Sales · passed on by Priya at 10:12 am</p></div><span class="${PRIMARY}">Answer</span></div>`;
          fresh(box.firstElementChild, ctx);
        },
        target: (r) => r.querySelector('[data-mk="hr-q"]'),
        say: "Meena in HR answers it on the HR desk, and Anjali is told.",
      },
    ],
  },
];
