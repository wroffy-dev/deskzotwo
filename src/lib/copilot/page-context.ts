import { db } from "@/lib/db";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { mayAttachTo } from "@/lib/authz/attachments";
import { isModuleEnabled } from "@/actions/module";
import { formatCompanyId, formatLeadId, parseSeqQuery } from "@/lib/order-id";
import { workspaceTeammates } from "@/lib/ai/teammates-server";

/**
 * What Deskzo AI is told besides the question (owner, 20 Nov 2026 — "easily accessible", step 3):
 *
 *   · the page the person is on — and, for a lead's or a company's page they may see, which record it is, so "follow up
 *     on this lead" means that lead. Only the record's number, title and company; nothing they couldn't see there.
 *   · the teammates they can ask by name — "@Tara…" — and which tool is each one's, by the names the workspace gave them.
 */

const MAX_PATH = 200;

/** The page as the panel sent it: a path on this site, without its query — or null. */
export function cleanPage(page: unknown): string | null {
  if (typeof page !== "string") return null;
  const path = page.split(/[?#]/)[0]!.trim();
  return path.startsWith("/") && !path.startsWith("//") && path.length <= MAX_PATH && /^[\w\-./%]+$/.test(path) ? path : null;
}

/** "The person is looking at lead LEAD-000123 …" — or a plain line for any other page, or nothing. */
export async function pageLine(userId: string, page: string | null): Promise<string> {
  if (!page) return "";
  const lead = /^\/leads\/([^/]+)$/.exec(page);
  if (lead && lead[1] !== "new" && (await isModuleEnabled("leads"))) {
    const seq = parseSeqQuery(decodeURIComponent(lead[1]!));
    const row = await db.lead.findFirst({
      where: seq !== null ? { leadSeq: seq } : { id: lead[1]! },
      select: { id: true, leadSeq: true, title: true, company: { select: { companySeq: true, name: true } } },
    });
    if (row && (await mayAttachTo(userId, { companyId: null, leadId: row.id, ticketId: null }))) {
      const ref = formatLeadId(row.leadSeq);
      return `\n\nThe person is looking at lead ${ref} — “${row.title}”, at ${row.company.name} (${formatCompanyId(row.company.companySeq)}). When they say "this lead", "this deal" or "here", they mean it: use leadRef ${ref}.`;
    }
  }
  const company = /^\/companies\/([^/]+)$/.exec(page);
  if (company) {
    const seq = parseSeqQuery(decodeURIComponent(company[1]!));
    const row = await db.company.findFirst({
      where: seq !== null ? { companySeq: seq } : { id: company[1]! },
      select: { id: true, companySeq: true, name: true, ownerUserId: true, relationshipType: true },
    });
    if (row && (await canSeeCompany(userId, row))) {
      const ref = formatCompanyId(row.companySeq);
      return `\n\nThe person is looking at the company ${row.name} (${ref}). When they say "this customer", "this company" or "here", they mean it: use companyRef ${ref}.`;
    }
  }
  return `\n\nThe person is on the page ${page}.`;
}

/** The teammates they may ask by name, each with its tool — only those whose tools they were offered. */
export async function teammatesLine(offered: string[]): Promise<string> {
  const has = (name: string) => offered.includes(name);
  const t = await workspaceTeammates();
  const lines = [
    has("ved_research_plan") && `- ${t.ved.name} researches a lead or a company and plans how to work it (ved_research_plan).`,
    has("tara_nurture_lead") && `- ${t.tara.name} follows a lead up with short emails its owner checks and sends (tara_nurture_lead).`,
    has("arjun_who_to_chase") && `- ${t.arjun.name} says who to chase for payment today (arjun_who_to_chase) and drafts a chase email to a customer (arjun_draft_chase).`,
  ].filter(Boolean);
  if (!lines.length) return "";
  return [
    "",
    "",
    `Your AI teammates — the person may ask one by name ("@${t.tara.name} follow this lead up"):`,
    ...lines,
    "When one is asked by name, or the request is plainly theirs, use their tool, then say in a sentence what they did and where to see it. What they make waits for a person to check — never say an email was sent.",
  ].join("\n");
}
