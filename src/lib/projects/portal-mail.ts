import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { getOrganisation } from "@/lib/organisation";
import { deliverNow, emailRouteFor } from "@/lib/marketing/pipeline";
import { textToHtml } from "@/lib/pipeline/automation-rules";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { shownToken } from "@/lib/portal/link-token";
import { projectStageEmailsOn } from "@/lib/customer-email-settings";

/**
 * The customer told when a stage they can see changes (owner, 16 Nov 2026 — projects phase 3): a stage done, a stage
 * they're asked to approve, a stage that is theirs to do. To the customer's people who hold a portal link that still
 * works, each with their own link, from the company's mail server with replies to the project's manager. Business
 * mail: it goes whatever their marketing choices, and stops only on Settings › Customer emails' switch.
 *
 * Never for a project not on the portal, or a stage hidden from it. Failing to send never fails what the team did —
 * the project's log says it didn't go and why.
 */

export type StageEvent = "DONE" | "APPROVAL_ASKED" | "TODO";

export async function emailCustomerAboutStage(milestoneId: string, event: StageEvent): Promise<{ sent: number; skipped?: string }> {
  try {
    const stage = await db.projectMilestone.findUnique({
      where: { id: milestoneId },
      select: {
        id: true,
        name: true,
        projectId: true,
        portalStage: { select: { hidden: true } },
        project: { select: { id: true, code: true, name: true, companyId: true, portal: { select: { projectId: true } }, manager: { select: { name: true, email: true } } } },
      },
    });
    if (!stage || !stage.project.portal || stage.portalStage?.hidden) return { sent: 0, skipped: "not on the portal" };
    if (!(await projectStageEmailsOn())) return { sent: 0, skipped: "switched off" };
    if (!(await emailRouteFor("TRANSACTIONAL"))) return note(stage.projectId, 0, "no mail server is set up for the company");

    const now = new Date();
    const logins = await db.portalLogin.findMany({
      where: { companyId: stage.project.companyId, revokedAt: null, personEmail: { not: null }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { personName: true, personEmail: true, contactId: true, token: true, tokenCipher: true },
    });
    // One email each, to the most recent link of each address.
    const seen = new Set<string>();
    const people = logins.filter((l) => {
      const key = (l.personEmail ?? "").trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);
    if (people.length === 0) return { sent: 0, skipped: "nobody at the customer has a portal link" };

    const [org, origin] = await Promise.all([getOrganisation(), tenantOrigin()]);
    const ours = org.tradeName || org.legalName || "us";
    const p = stage.project;
    const subject =
      event === "DONE" ? `${p.name}: "${stage.name}" is done` : event === "APPROVAL_ASKED" ? `${p.name}: please approve "${stage.name}"` : `${p.name}: "${stage.name}" is waiting for you`;
    const lead =
      event === "DONE"
        ? `"${stage.name}" on ${p.name} is done.`
        : event === "APPROVAL_ASKED"
          ? `"${stage.name}" on ${p.name} is ready for you to look at. Could you approve it, or tell us what to change?`
          : `"${stage.name}" on ${p.name} is with you now — let us know on the portal once it's done.`;

    let sent = 0;
    const failed: string[] = [];
    for (const person of people) {
      const token = await shownToken(person);
      const link = token ? `${origin.replace(/\/+$/, "")}/portal/${token}` : null;
      const first = person.personName.trim().split(/\s+/)[0] || "there";
      const text = [`Hi ${first},`, "", lead, "", link ? `Follow the project here: ${link}` : "Your portal link is in an earlier email from us.", "", "Thank you,", p.manager?.name ?? ours, ours].join("\n");
      const out = await deliverNow(
        { to: person.personEmail!, toName: person.personName, fromName: ours, ...(p.manager?.email ? { replyTo: p.manager.email } : {}), subject, html: textToHtml(text), text },
        "TRANSACTIONAL",
        { delivering: true },
      );
      if (!out.ok) {
        failed.push(`${person.personEmail}: ${out.error}`);
        continue;
      }
      sent += 1;
      // In the email log, the link left out — the log is read by more people than the portal's customer.
      const logged = link ? text.replace(link, "[their portal link]") : text;
      await db.marketingMessage.create({
        data: { token: randomBytes(24).toString("base64url"), companyId: p.companyId, contactId: person.contactId, channel: "EMAIL", messageClass: "TRANSACTIONAL", subject, body: textToHtml(logged), textBody: logged, toEmail: person.personEmail!, status: "SENT", scheduledFor: now, sentAt: now, attempts: 1, fromEmail: out.fromEmail ?? out.provider },
      }).catch(() => null);
    }
    if (failed.length) return note(stage.projectId, sent, failed.join("; "));
    return { sent };
  } catch (err) {
    if (notMigratedYet(err)) return { sent: 0, skipped: "not migrated" };
    throw err;
  }
}

/** Said in the project's log, so the team knows the customer wasn't told. */
async function note(projectId: string, sent: number, why: string): Promise<{ sent: number; skipped: string }> {
  await db.projectUpdate.create({ data: { projectId, body: `The customer wasn't emailed about the stage${sent ? " (some were)" : ""}: ${why.slice(0, 500)}` } }).catch(() => null);
  return { sent, skipped: why };
}
