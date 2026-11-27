import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { ApiError } from "@/lib/api/handler";
import { sendChatMessage } from "@/actions/chat";
import { readFormWithin } from "@/lib/http/body";

/**
 * Sending: a form with `body`, optionally `replyToId` and up to five `files` (5 MB together) — the web's own
 * sendChatMessage, so the word filter, the file types and the mentions are its.
 */

export const dynamic = "force-dynamic";

/** The files' 5 MB, the text and the form's own framing. */
const MAX_MESSAGE_FORM = 5 * 1024 * 1024 + 256 * 1024;

export const POST = appRoute({}, async ({ actor, req, params }) => {
  await needAppModule("chat", actor.userId);
  let form: FormData | null;
  try {
    // Security audit round two, 13 Nov 2026 (Low): read streamed and stopped at the ceiling before it is parsed.
    form = await readFormWithin(req, MAX_MESSAGE_FORM);
  } catch {
    throw new ApiError(400, "invalid_request", "Send the message as a form.");
  }
  if (!form) throw new ApiError(413, "too_large", "Those files are too big — 5 MB together at most.");
  form.set("chatId", params.id ?? "");
  const result = await sendChatMessage(form);
  if (!result.ok) refused(result);
  return { status: 201, data: result.data };
});
