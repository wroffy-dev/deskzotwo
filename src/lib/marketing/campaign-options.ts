import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { NO_OPTIONS, abTestOf, resendOf, type CampaignOptions } from "@/lib/marketing/campaign-option-rules";

export * from "@/lib/marketing/campaign-option-rules";

/** A campaign's options — none where it has none, or where the table isn't there yet. */
export async function campaignOptions(campaignId: string): Promise<CampaignOptions> {
  try {
    const row = await db.campaignOption.findUnique({ where: { campaignId } });
    if (!row) return NO_OPTIONS;
    return {
      abTest: abTestOf(row.abTest),
      resend: resendOf(row.resend),
      subject: row.subject?.trim() || null,
      recipientIds: Array.isArray(row.recipientIds) ? row.recipientIds.filter((v): v is string => typeof v === "string") : null,
      parentId: row.parentId,
      sendTime: row.sendTime === "best" ? "best" : null,
    };
  } catch (err) {
    if (notMigratedYet(err)) return NO_OPTIONS;
    throw err;
  }
}

