import { notFound } from "next/navigation";
import { aiService } from "@/lib/ai/gateway";
import { getAiActivity } from "@/actions/copilot-review";
import { AiActivityView } from "@/components/settings/ai-activity";

export const metadata = { title: "AI activity" };
export const dynamic = "force-dynamic";

/**
 * Settings › AI activity (owner, 23 Nov 2026 — "the tenant admin can see all the chats, and each employee's usage, on a
 * proper dashboard"): who used Deskzo AI this month and how much, every person's chats — deleted ones too — and who
 * read whose. Only for `copilot.review` (admins and the super admin by default); see src/actions/copilot-review.ts.
 */
export default async function AiActivityPage() {
  const activity = await getAiActivity();
  if (!activity) notFound();
  const service = await aiService("copilot.chat").catch(() => null);
  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">AI activity</h1>
        <p className="mt-1 text-sm text-muted">
          Who used Deskzo AI in {activity.month}, how much, and what they asked. A chat somebody deletes is hidden from them and kept here. Every chat you open is
          recorded below, so reviewing is on the record too.
          {service?.masked &&
            " In chat, names saved here, street addresses, phone numbers, emails, GSTIN, PAN and bank details are masked before they reach the AI provider. A name Deskzo doesn't hold, or one misspelt, may not be."}
        </p>
      </div>
      <AiActivityView activity={activity} />
    </div>
  );
}
