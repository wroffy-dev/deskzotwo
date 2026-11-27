import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { queueCampaign } from "@/lib/marketing/pipeline";
import { abTestOf, pickWinner, resendOf, type VariantStats } from "@/lib/marketing/campaign-options";

/**
 * What the marketing tick does after a campaign has gone out (owner, 1 Nov 2026 — src/lib/marketing/campaign-options.ts):
 * picks an A/B test's winner once its hours are up and sends the winner to everybody else, and resends to those who
 * didn't open, with the new subject, once the wait is over. Each claims its row first, so two ticks never both act.
 */

/** Each version's sent, opened and clicked, over the test's messages. */
export async function variantStats(campaignId: string): Promise<{ A: VariantStats; B: VariantStats }> {
  const rows = await db.abVariant.findMany({
    where: { campaignId },
    select: { variant: true, message: { select: { status: true, events: { where: { type: { in: ["OPEN", "CLICK"] } }, select: { type: true } } } } },
  });
  const out = { A: { sent: 0, opened: 0, clicked: 0 }, B: { sent: 0, opened: 0, clicked: 0 } };
  for (const r of rows) {
    const v = r.variant === "B" ? out.B : out.A;
    if (["QUEUED", "SENDING", "SUPPRESSED", "FAILED"].includes(r.message.status)) continue;
    v.sent += 1;
    // A click counts as an open: an image-blocking mail program clicks without loading the pixel.
    const clicked = r.message.events.some((e) => e.type === "CLICK");
    if (clicked || r.message.events.some((e) => e.type === "OPEN")) v.opened += 1;
    if (clicked) v.clicked += 1;
  }
  return out;
}

/** A/B tests whose hours are up: the winner picked and sent to everybody not yet reached. */
export async function decideAbTests(origin: string, now: Date = new Date()): Promise<number> {
  let options;
  try {
    options = await db.campaignOption.findMany({ where: { abTest: { not: Prisma.DbNull } }, select: { campaignId: true, abTest: true, campaign: { select: { status: true, startedAt: true } } } });
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
  let decided = 0;
  for (const o of options) {
    const ab = abTestOf(o.abTest);
    if (!ab || ab.winner || !o.campaign.startedAt || !["SCHEDULED", "SENDING"].includes(o.campaign.status)) continue;
    if (now.getTime() - o.campaign.startedAt.getTime() < ab.hours * 3_600_000) continue;
    const stats = await variantStats(o.campaignId);
    const winner = pickWinner(stats, ab.metric);
    const next = { ...ab, winner, decidedAt: now.toISOString(), stats } as unknown as Prisma.InputJsonValue;
    // Claimed by writing the winner only where none is written yet.
    const claimed = await db.campaignOption.updateMany({ where: { campaignId: o.campaignId, abTest: { equals: o.abTest as Prisma.InputJsonValue } }, data: { abTest: next } });
    if (claimed.count === 0) continue;
    await queueCampaign(o.campaignId, origin);
    decided += 1;
  }
  return decided;
}

/** Resends whose wait is over: a campaign of its own, to those who were sent it and didn't open, with the new subject. */
export async function resendToNonOpeners(origin: string, now: Date = new Date()): Promise<number> {
  let options;
  try {
    options = await db.campaignOption.findMany({
      where: { resend: { not: Prisma.DbNull } },
      select: { campaignId: true, resend: true, campaign: { select: { id: true, reference: true, name: true, status: true, finishedAt: true, templateId: true, channel: true, createdById: true, approvedById: true, approvedAt: true } } },
    });
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
  let made = 0;
  for (const o of options) {
    const resend = resendOf(o.resend);
    const c = o.campaign;
    if (!resend || resend.doneAt || c.status !== "SENT" || !c.finishedAt || c.channel !== "EMAIL") continue;
    if (now.getTime() - c.finishedAt.getTime() < resend.afterHours * 3_600_000) continue;
    // Claimed first: the resend marked done before anything is sent.
    const claimed = await db.campaignOption.updateMany({
      where: { campaignId: o.campaignId, resend: { equals: o.resend as Prisma.InputJsonValue } },
      data: { resend: { ...resend, doneAt: now.toISOString() } as unknown as Prisma.InputJsonValue },
    });
    if (claimed.count === 0) continue;
    // Sent, and not opened or clicked since — nobody who bounced, complained, or never got it.
    const unopened = await db.marketingMessage.findMany({
      where: { campaignId: c.id, contactId: { not: null }, status: { in: ["SENT", "DELIVERED"] }, events: { none: { type: { in: ["OPEN", "CLICK"] } } } },
      select: { contactId: true },
    });
    const ids = [...new Set(unopened.map((m) => m.contactId!))];
    if (ids.length === 0) continue;
    const reference = `${c.reference}-R`;
    // Approved with the campaign it follows: the same email, to fewer of the same people.
    const child = await db.campaign.create({
      data: { reference, name: `${c.name} — resend`, templateId: c.templateId, channel: c.channel, status: "SCHEDULED", startedAt: now, createdById: c.createdById, approvedById: c.approvedById, approvedAt: c.approvedAt, options: { create: { subject: resend.subject, recipientIds: ids, parentId: c.id } } },
      select: { id: true },
    });
    const outcome = await queueCampaign(child.id, origin);
    await db.campaignOption.update({ where: { campaignId: o.campaignId }, data: { resend: { ...resend, doneAt: now.toISOString(), childId: child.id, count: outcome.queued } as unknown as Prisma.InputJsonValue } });
    made += 1;
  }
  return made;
}
