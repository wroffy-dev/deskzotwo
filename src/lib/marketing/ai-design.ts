import type { MarketingTopic } from "@prisma/client";
import { AiRefusal, aiService, aiTurn, aiUnavailable } from "@/lib/ai/gateway";
import type { ToolCall, ToolSpec, Turn } from "@/lib/copilot/types";
import { BLOCK_KINDS, designSchema, newBlockId, type BuilderBrand, type Design } from "@/lib/marketing/email-design";
import { MERGE_FIELDS } from "@/lib/marketing/merge";
import { TOPICS } from "@/lib/marketing/topics";

/**
 * Designing an email with Deskzo AI (owner, 1 Nov 2026: "ai for email templates, which will design the template based
 * on what user wants") — `designEmailWithAI`.
 *
 *   1. The model is told how an email is built here — the blocks of the email builder
 *      (src/lib/marketing/email-design.ts), the merge fields and their fallbacks — and given the person's words, the
 *      company's name and email, and, to change an email, its design. Nothing about any customer.
 *   2. It hands back a design through one tool call; the design is given block ids and checked as the builder's Save
 *      checks it. One with mistakes goes back once with them listed. At most three turns, all charged to the
 *      workspace's Deskzo AI credits (src/lib/ai/gateway.ts) as "Marketing: designing an email".
 *
 * It returns the design. It saves nothing: the builder opens it, undoable, for the person to change and save.
 */

export const MAX_DESCRIPTION = 2000;
const MAX_TURNS = 3;

export class DesignRefusal extends Error {}

export type Designed = {
  name: string;
  subjects: string[];
  preheader: string;
  topic: MarketingTopic;
  design: Design;
  notes: string[];
  // `credits` in thousandths, as the ledger keeps them (src/lib/ai/catalogue.ts `creditsText`).
  usage: { input: number; output: number; turns: number; credits: number };
};

const PROPOSE_EMAIL: ToolSpec = {
  name: "propose_email",
  description: "Hand back the designed email. Call it once, with the whole email.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "A short name for the template, up to 80 characters." },
      subjects: { type: "array", items: { type: "string" }, description: "Three subject lines to choose from, best first, each under 70 characters." },
      preheader: { type: "string", description: "The preview line shown after the subject, under 110 characters." },
      topic: { type: "string", enum: TOPICS.map((t) => t.key), description: "What the email is about, for customers' preferences." },
      settings: { type: "object", description: 'Optional: {"font": "arial"|"verdana"|"trebuchet"|"georgia", "brandColor": "#rrggbb"}. Leave brandColor out to use the company\'s.' },
      blocks: { type: "array", items: { type: "object" }, description: "The email's blocks, top to bottom, each as the instructions describe." },
      notes: { type: "array", items: { type: "string" }, description: "Up to 3 short notes for the person: placeholders to fill in, choices made." },
    },
    required: ["name", "subjects", "blocks"],
  },
};

const BLOCK_RULES = `Each block is an object with "type" and its own fields:
- logo: { type:"logo", align:"left"|"center"|"right", bar:true|false } — the company's logo, or its name. Always first.
- heading: { type:"heading", text, level:1|2, align } — level 1 for the email's title, 2 for sections.
- text: { type:"text", html, align, size:13|15|17 } — html uses only <p>, <strong>, <em>, <u>, <ul>/<ol>/<li>, <br> and <a href="https://…">. No styles.
- image: { type:"image", src:"", alt, width:10–100, align, link:"" } — leave src empty: the person chooses the picture. Use only when a picture is asked for or clearly helps.
- button: { type:"button", label, link, align, full:false } — link is https://…, or mailto:{{ownerEmail|COMPANY_EMAIL}}?subject=Words%20here to reply to the account manager.
- banner: { type:"banner", eyebrow, title, subtitle, align } — a big coloured headline: offers, announcements, greetings.
- details: { type:"details", title, rows:[{label, value}] } — label-and-value rows: a renewal's product, quantity, date and value; an event's date, time and place.
- checklist: { type:"checklist", title, items:[…] } — 2–5 ticked points.
- columns: { type:"columns", columns:[{title, text}] } — 2 or 3 short side-by-side points; text is plain words.
- social: { type:"social", align, links:[{label, url}] } — links as buttons; urls https:// or mailto:.
- signature: { type:"signature", closing:"Warm regards,", contacts:true } — signed by the account manager, or the team. Always last.
- divider: { type:"divider", thickness:1 } — between sections.
- spacer: { type:"spacer", height:8–60 }.
Do not use "html" blocks.`;

function systemPrompt(brand: BuilderBrand): string {
  const fields = MERGE_FIELDS.filter((f) => !["formName", "formLink", "eventDate", "eventVenue", "inviterName", "unsubscribeUrl", "postalAddress", "assetCount", "fulfilledDate"].includes(f.key))
    .map((f) => `{{${f.key}}} — ${f.label}: ${f.source}`)
    .join("\n");
  return `You design marketing and customer emails in Deskzo's email builder for ${brand.name}, an Indian business. You write the email's words and lay it out as blocks.

How an email is built:
${BLOCK_RULES}

The blocks available: ${BLOCK_KINDS.filter((k) => k.type !== "html").map((k) => k.label).join(", ")}.

Merge fields fill in each recipient's own details. Write them as {{field|fallback}} — the fallback is printed when a recipient has no value — so an email never reads "Hi ,". The fields:
${fields}
Use the subscription fields (productName, quantity, expiryDate, daysLeft, daysLeftPhrase, renewalValue, orderId) only for emails about a subscription or renewal. {{ourName}} is ${brand.name}'s own name and needs no fallback.

Rules:
- Start with a logo block and end with a signature block.
- Keep it short and scannable: a title, two or three short paragraphs or a details box, one clear button. Most emails need 5–9 blocks.
- Write warm, clear, professional Indian English — rupees as ₹, dates like 9 Aug 2027 — unless the person asks for Hindi, Hinglish or another language.
- Never invent facts you weren't given: prices, discounts, dates, names, phone numbers, web addresses. Put a placeholder in [square brackets] for the person to fill, such as [20% off] or https://[your link].
- The company's email for replies is ${brand.email ?? "unknown — use {{ownerEmail|[your email]}}"}.
- Subjects: specific and honest, no ALL CAPS, no spammy words like FREE!!!, at most one emoji.
- When asked to change an email, keep what wasn't asked about, and hand back the whole changed email.
- Call propose_email once with the whole email. Don't answer in prose.`;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

type Proposal = { name: string; subjects: string[]; preheader: string; topic: MarketingTopic; notes: string[]; raw: unknown };

function proposalOf(call: ToolCall | undefined): Proposal | null {
  if (!call || call.name !== PROPOSE_EMAIL.name || !call.input || typeof call.input !== "object") return null;
  const input = call.input as Record<string, unknown>;
  let blocks = input.blocks;
  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks);
    } catch {
      /* the check says why */
    }
  }
  const topic = TOPICS.some((t) => t.key === input.topic) ? (input.topic as MarketingTopic) : "OFFERS";
  const settings = input.settings && typeof input.settings === "object" ? (input.settings as Record<string, unknown>) : {};
  const raw = {
    version: 1,
    settings: {
      font: ["arial", "verdana", "trebuchet", "georgia"].includes(String(settings.font)) ? settings.font : "arial",
      ...(typeof settings.brandColor === "string" && /^#[0-9a-f]{6}$/i.test(settings.brandColor) ? { brandColor: settings.brandColor } : {}),
    },
    // Ids are Deskzo's to give; anything the model added is dropped, so a block is only its own fields.
    blocks: Array.isArray(blocks) ? blocks.filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type !== "html").map((b) => ({ ...(b as Record<string, unknown>), id: newBlockId() })) : blocks,
  };
  const subjects = Array.isArray(input.subjects) ? input.subjects.map((s) => text(s, 150).replace(/[\r\n]+/g, " ")).filter(Boolean).slice(0, 3) : [];
  return {
    name: text(input.name, 80) || "Email designed with AI",
    subjects,
    preheader: text(input.preheader, 200).replace(/[\r\n]+/g, " "),
    topic,
    notes: Array.isArray(input.notes) ? input.notes.map((n) => text(n, 200)).filter(Boolean).slice(0, 3) : [],
    raw,
  };
}

/** Whether designing can run for this person now, in words — null when it can. */
export function designUnavailable(userId: string): Promise<string | null> {
  return aiUnavailable(userId, "marketing.design");
}

/** Where a description is sent, in words shown before anybody types one. */
export async function designProvider(): Promise<string> {
  const service = await aiService("marketing.design");
  if (!service) return "Deskzo AI";
  return `Deskzo AI (${service.model}, processed in ${service.residency}${service.noTraining ? ", never used for training" : ""})`;
}

export async function designEmailWithAI(input: { userId: string; description: string; brand: BuilderBrand; current?: Design | null }): Promise<Designed> {
  const description = input.description.trim();
  if (description.length < 8) throw new DesignRefusal("Say a little more about the email — who it's for and what it should tell them.");
  if (description.length > MAX_DESCRIPTION) throw new DesignRefusal(`Keep the description under ${MAX_DESCRIPTION.toLocaleString("en-IN")} characters.`);

  // To change an email: its design without ids — what the model needs, nothing it could echo back wrongly.
  const current = input.current?.blocks.length ? JSON.stringify({ settings: input.current.settings, blocks: input.current.blocks }, (key, value) => (key === "id" ? undefined : value)) : null;
  const ask = current ? `Here is the email as it is now:\n${current}\n\nChange it like this: ${description}` : `Design this email: ${description}`;
  const history: Turn[] = [{ role: "user", text: ask }];
  const system = systemPrompt(input.brand);
  const usage = { input: 0, output: 0, turns: 0, credits: 0 };
  let best: { proposal: Proposal; design: Design } | null = null;
  let repaired = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let outcome;
    try {
      outcome = await aiTurn({ userId: input.userId, feature: "marketing.design", system, history, tools: [PROPOSE_EMAIL] });
    } catch (err) {
      if (err instanceof AiRefusal) throw new DesignRefusal(err.message);
      throw err;
    }
    usage.input += outcome.usage.input;
    usage.output += outcome.usage.output;
    usage.turns += 1;
    usage.credits += outcome.charge.credits;
    if (outcome.stop === "refused") throw new DesignRefusal("The AI declined to write that. Try describing it differently.");

    const call = outcome.toolCalls.find((c) => c.name === PROPOSE_EMAIL.name);
    history.push({ role: "assistant", text: outcome.text, toolCalls: outcome.toolCalls, ...(outcome.native ? { native: { provider: outcome.family, model: outcome.model, content: outcome.native, masked: outcome.masked } } : {}) });
    const proposal = proposalOf(call);
    if (!proposal) {
      if (outcome.toolCalls.length) history.push({ role: "tool", results: outcome.toolCalls.map((c) => ({ id: c.id, name: c.name, output: "Only propose_email is available.", isError: true })) });
      else history.push({ role: "user", text: "Call propose_email with the whole email now." });
      continue;
    }
    const parsed = designSchema.safeParse(proposal.raw);
    if (parsed.success && parsed.data.blocks.length > 0) {
      best = { proposal, design: parsed.data };
      break;
    }
    if (repaired) break;
    repaired = true;
    const problems = parsed.success ? ["The email has no blocks."] : parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".") || "email"}: ${i.message}`);
    const fix = `The email has these problems. Fix them and call propose_email again with the whole email:\n- ${problems.join("\n- ")}`;
    history.push({ role: "tool", results: outcome.toolCalls.map((c) => ({ id: c.id, name: c.name, isError: true, output: c.id === call!.id ? fix : "Ignored: one call with the whole email is enough." })) });
  }

  if (!best) throw new DesignRefusal("The AI didn't come back with an email the builder can open. Try describing it differently, or more simply.");
  const { proposal, design } = best;
  return { name: proposal.name, subjects: proposal.subjects, preheader: proposal.preheader, topic: proposal.topic, design, notes: proposal.notes, usage };
}
