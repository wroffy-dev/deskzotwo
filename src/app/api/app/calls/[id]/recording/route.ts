import { ApiError } from "@/lib/api/handler";
import { appRoute } from "@/lib/app/handler";
import { keepRecording, MAX_RECORDING_BYTES, RecordingRefused } from "@/lib/calls/recordings";
import { readBytesWithin } from "@/lib/http/body";

/**
 * A call's recording from the Deskzo app (owner, 9 Nov 2026 — src/lib/calls/recordings.ts): the file the phone's own
 * recorder made, as the request's body, its name in `X-File-Name`. For a call this phone logged; once a call.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({ calls: true }, async ({ req, params, actor, device }) => {
  // Security audit, 11 Nov 2026 (SEC-27): read streamed and stopped at the ceiling, chunked bodies included.
  const bytes = await readBytesWithin(req, MAX_RECORDING_BYTES);
  if (!bytes) throw new ApiError(413, "too_big", "A recording is up to 40 MB.");
  try {
    const kept = await keepRecording({ callId: params.id ?? "", appDeviceId: device.id, userId: actor.userId, fileName: decodeURIComponent(req.headers.get("x-file-name") ?? ""), bytes });
    return { status: kept.again ? 200 : 201, data: { id: kept.id } };
  } catch (err) {
    if (err instanceof RecordingRefused) throw new ApiError(err.status, err.code, err.message);
    throw err;
  }
});
