import { currentUser } from "@/lib/session";
import { moduleAccessFor } from "@/lib/modules-access";
import { notMigratedYet } from "@/lib/not-migrated";
import { listenable, notePlay, recordingStore } from "@/lib/calls/recordings";

/**
 * A phone call's recording, played (owner, 9 Nov 2026 — src/lib/calls/recordings.ts): asked of every play whether this
 * person may hear it, and every play written down. A seek's Range is answered, so the player can skip about.
 */
export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user || (await moduleAccessFor(user.id, "calls")) !== "available") return notFound();
  const { id } = await context.params;

  let found: Awaited<ReturnType<typeof listenable>>;
  try {
    found = await listenable(user.id, id);
  } catch (err) {
    if (!notMigratedYet(err)) console.error("call recording failed", err);
    return notFound();
  }
  if (!found) return notFound();
  const store = await recordingStore();
  const sound = store ? await store.get(found.storageKey).catch(() => null) : null;
  if (!sound) return new Response("This recording isn't in the store any more.", { status: 404 });

  // A play, written down, for any request that sends sound — once per person per recording in a few minutes, not each
  // seek within it (security audit, 11 Nov 2026 — SEC-52: a suffix range fetched the whole file unlogged).
  const range = request.headers.get("range");
  await notePlay(found.recordingId, user.id);

  const headers: Record<string, string> = {
    "content-type": found.contentType,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; media-src 'self'",
    "cache-control": "private, no-store",
  };
  const asked = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (asked && (asked[1] || asked[2])) {
    const size = sound.length;
    const start = asked[1] ? Number(asked[1]) : Math.max(0, size - Number(asked[2]));
    const end = asked[1] && asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    return new Response(new Uint8Array(sound.subarray(start, end + 1)), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(new Uint8Array(sound), { status: 200, headers: { ...headers, "content-length": String(sound.length) } });
}
