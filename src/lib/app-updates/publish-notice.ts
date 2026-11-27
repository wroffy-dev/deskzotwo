import { alertRecipients } from "@/lib/platform/alert-notify";
import { queuePlatformMail } from "@/lib/platform/mail/queue";

/**
 * Security audit round two, 13 Nov 2026 (R2-13): every update published to the phone app is told at once to the people
 * on call for the console's alerts — the console setting `alerts.emails`, else every active owner — so an update
 * nobody meant to publish is seen the same day and can be rolled back (`npm run app:update -- rollback`). Never throws:
 * the update is already published.
 */
export async function tellOfAppUpdatePublish(update: { id: string; kind: string; platform: string; runtimeVersion: string; commit?: string | null; files: number }, ip: string | null): Promise<number> {
  try {
    const to = await alertRecipients();
    const what = update.kind === "ROLL_BACK_TO_EMBEDDED" ? "A roll-back to the screens inside the app" : "An over-the-air update";
    const text = [
      `${what} was just published to every Deskzo phone app on its native build.`,
      [
        `Update: ${update.id}`,
        `Platform: ${update.platform}`,
        `Native build: ${update.runtimeVersion.slice(0, 16)}…`,
        update.commit ? `Commit: ${update.commit}` : null,
        `Files sent: ${update.files}`,
        `From address: ${ip ?? "not known"}`,
        `At: ${new Date().toISOString()}`,
      ]
        .filter(Boolean)
        .join("\n"),
      "If nobody on the team meant to publish this, roll it back at once (npm run app:update -- rollback), rotate the update key and APP_UPDATES_PUBLISH_SECRET, and find how they were used.",
    ].join("\n\n");
    for (const address of to) {
      await queuePlatformMail({ type: "ALERTS", to: address, subject: `Phone app update published: ${update.id.slice(0, 8)}`, text }, { key: `app-update-published:${update.id}:${address}` });
    }
    return to.length;
  } catch (err) {
    console.error("[app-updates] the publish notice could not be queued", err instanceof Error ? err.message : err);
    return 0;
  }
}
