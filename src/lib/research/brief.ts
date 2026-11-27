import { db } from "@/lib/db";
import { aiTurn } from "@/lib/ai/gateway";
import type { ResearchFacts } from "@/lib/research/parse";
import { workspacePack } from "@/lib/country-pack";

/**
 * A company's research brief (owner, 18 Nov 2026: "build it with the brief as a separate button"): what Refresh found,
 * written up by Deskzo AI for somebody about to contact the company, as "Research: a company's brief" on the
 * workspace's credits. Asked for by a button, never written by itself.
 *
 * What goes to the model is public only — the company's name, website and city, the facts gathered from its website,
 * GST and the news, and what Domain Intel and Apollo found — never the workspace's dealings with it (orders, invoices,
 * notes, people's details). Every line names its source, and the model is told to leave out what the facts don't say:
 * a salesperson repeats this on a call.
 */

export type BriefInput = {
  name: string;
  website: string | null;
  city: string | null;
  facts: ResearchFacts;
  domain?: { emailProvider: string | null; emailSecurityProvider: string | null; platform: string | null; hostProvider: string | null; registeredOn: string | null } | null;
  apollo?: { description?: string | null; industry?: string | null; employees?: number | null; founded?: number | null; revenue?: string | null } | null;
};

/** Ved's brief instructions — India's, or without India and GST for a workspace elsewhere (the UAE). */
export const briefSystemFor = (india: boolean) => [
  `You write short research briefs about a company for a salesperson at ${india ? "an Indian" : "an"} IT reseller and system integrator`,
  "(Microsoft 365, Google Workspace, Adobe, Autodesk, security, hardware and services) who is about to contact it.",
  "Use ONLY the facts given. Never add anything you know or guess from elsewhere; if the facts don't say it, leave it out.",
  "Write in plain English, at most 220 words, as these sections, each a few bullet lines starting with \"- \":",
  "Who they are / Size and standing / What they run / In the news / Openings and questions to ask.",
  "Leave out a section the facts say nothing about. End every bullet with its source in brackets:",
  `${india ? "[Website], [GST]," : "[Website],"} [Domain], [Apollo] or [News]. Openings` + " are suggestions, so say \"may\" — and give the fact that",
  "prompts each one. No greeting, no closing line, no markdown other than the section names on their own lines.",
].join(" ");

export const BRIEF_SYSTEM = briefSystemFor(true);

/** The facts as the model reads them: labelled lines, nothing private. Pure, so a check can read exactly what is sent. */
export function briefPrompt(input: BriefInput): string {
  const lines: string[] = [`Company: ${input.name}`];
  if (input.website) lines.push(`Website: ${input.website}`);
  if (input.city) lines.push(`City on file: ${input.city}`);
  const w = input.facts.website;
  if (w) {
    if (w.title) lines.push(`[Website] Title: ${w.title}`);
    if (w.description) lines.push(`[Website] Description: ${w.description}`);
    if (w.about) lines.push(`[Website] About page: ${w.about}`);
    if (w.founded) lines.push(`[Website] Founded: ${w.founded}`);
    if (w.careersUrl) lines.push(`[Website] Has a careers page: ${w.careersUrl}`);
    const social = Object.keys(w.social ?? {});
    if (social.length) lines.push(`[Website] Social pages: ${social.join(", ")}`);
  }
  for (const g of input.facts.gst ?? []) {
    lines.push(`[GST] ${g.gstin}: ${[g.legalName && `legal name ${g.legalName}`, g.tradeName && `trade name ${g.tradeName}`, `status ${g.status}`, g.taxpayerType && `taxpayer type ${g.taxpayerType}`, g.state && `state ${g.state}`, g.panHolder && `PAN holder: ${g.panHolder}`].filter(Boolean).join("; ")}`);
  }
  const d = input.domain;
  if (d) {
    if (d.emailProvider) lines.push(`[Domain] Email runs on: ${d.emailProvider}`);
    if (d.emailSecurityProvider) lines.push(`[Domain] Email security: ${d.emailSecurityProvider}`);
    if (d.platform) lines.push(`[Domain] Website built on: ${d.platform}`);
    if (d.hostProvider) lines.push(`[Domain] Website hosted on: ${d.hostProvider}`);
    if (d.registeredOn) lines.push(`[Domain] Domain registered: ${d.registeredOn.slice(0, 10)}`);
  }
  const a = input.apollo;
  if (a) {
    if (a.description) lines.push(`[Apollo] Description: ${a.description.slice(0, 900)}`);
    if (a.industry) lines.push(`[Apollo] Industry: ${a.industry}`);
    if (a.employees) lines.push(`[Apollo] Employees: ${a.employees}`);
    if (a.founded) lines.push(`[Apollo] Founded: ${a.founded}`);
    if (a.revenue) lines.push(`[Apollo] Revenue: ${a.revenue}`);
  }
  for (const n of input.facts.news ?? []) lines.push(`[News] ${n.date ? n.date.slice(0, 10) : "undated"} — ${n.title}${n.source ? ` (${n.source})` : ""}`);
  return `${lines.join("\n")}\n\nWrite the brief.`;
}

/** Whether there is enough to write from: anything beyond the name. */
export function briefHasFacts(input: BriefInput): boolean {
  return briefPrompt(input).split("\n").filter((l) => l.startsWith("[")).length > 0;
}

/** Asks Deskzo AI for the brief and keeps it on the company's research. Throws AiRefusal with words for the person. */
export async function writeBrief(companyId: string, userId: string, input: BriefInput): Promise<{ brief: string; at: Date }> {
  const outcome = await aiTurn({ userId, feature: "research.brief", system: briefSystemFor(workspacePack().india), history: [{ role: "user", text: briefPrompt(input) }], tools: [] });
  const brief = outcome.text.trim().slice(0, 4000);
  const at = new Date();
  await db.companyResearch.upsert({
    where: { companyId },
    create: { companyId, brief, briefAt: at, briefById: userId },
    update: { brief, briefAt: at, briefById: userId },
    select: { companyId: true },
  });
  return { brief, at };
}
