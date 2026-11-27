import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused, tasksFor } from "@/lib/app/daily";
import { createTask } from "@/actions/task";
import { claimOnce, finishOnce, releaseOnce } from "@/lib/app/once";

/**
 * The person's tasks in the Deskzo app (owner, 18 Oct 2026). GET `?view=today|overdue|open|done`. POST `{ title,
 * due? }`: a quick task for themselves — the web's own createTask.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor, url }) => ({ data: await tasksFor(actor.userId, url.searchParams.get("view") ?? "open") }));

export const POST = appRoute({}, async ({ actor, body, req }) => {
  await needAppModule("tasks", actor.userId);
  const input = await body();
  // Sent again after a lost answer (the phone's outbox), it's the task already made.
  const claim = await claimOnce(actor.userId, req.headers.get("idempotency-key"));
  if (claim.done) return { status: 201, data: { id: claim.recordId } };
  // Not made, whichever way that went: another try may make it.
  const result = await createTask({ title: input.title, dueDate: input.due || undefined, assignedToUserId: actor.userId }).catch(async (err) => {
    await releaseOnce(claim.key);
    throw err;
  });
  if (!result.ok) {
    await releaseOnce(claim.key);
    refused(result);
  }
  await finishOnce(claim.key, result.data.id);
  return { status: 201, data: { id: result.data.id } };
});
