import { NextResponse } from "next/server";
import { commitImport, previewImport } from "@/actions/data-import";
import { requestHost } from "@/lib/tenancy/host";
import { readTextWithin } from "@/lib/http/body";

/** 25 MB of file as base64, and the few fields beside it. */
const MAX_BODY_BYTES = Math.ceil((25 * 1024 * 1024 * 4) / 3) + 64 * 1024;

/**
 * Settings › Import & export: an area's file, previewed or brought in (src/actions/data-import.ts). A route rather
 * than the actions themselves, because a server action takes 6 MB and a file sent to one grows by a third on the
 * way — Zoho's Contacts.csv for a few thousand customers broke the page instead of importing (owner, 28 Oct 2026).
 * The actions do the rest as before: who may import, the size the import takes, the logs. This checks for itself
 * what an action gets free — that the request comes from this app.
 */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const checked = requestHost(request.headers);
  const host = typeof checked === "string" ? checked : null;
  let sameOrigin = false;
  try {
    sameOrigin = !!origin && !!host && new URL(origin).host === host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return NextResponse.json({ ok: false, error: "Imports are only accepted from this app." }, { status: 403 });

  let body: { mode?: unknown; area?: unknown; filename?: unknown; base64?: unknown; from?: unknown; count?: unknown; upload?: unknown };
  // Security audit round two, 13 Nov 2026 (R2-19): read with a ceiling, as a stream — `request.json()` buffered
  // whatever arrived. The import takes 25 MB, which base64 makes a third larger, with room for the rest of the JSON.
  const text = await readTextWithin(request, MAX_BODY_BYTES);
  if (text === null) return NextResponse.json({ ok: false, error: "That file is over 25MB. Split it and import in batches." }, { status: 413 });
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "The upload couldn't be read." }, { status: 400 });
  }
  // A window of rows, when the screen sends a large file in parts (src/lib/portability/import.ts `RowWindow`).
  const input = { area: String(body.area ?? ""), filename: String(body.filename ?? ""), base64: String(body.base64 ?? ""), from: Number(body.from), count: Number(body.count), upload: typeof body.upload === "string" ? body.upload : undefined };
  if (body.mode === "preview") return NextResponse.json(await previewImport(input));
  if (body.mode === "commit") return NextResponse.json(await commitImport(input));
  return NextResponse.json({ ok: false, error: "Preview or import?" }, { status: 400 });
}
