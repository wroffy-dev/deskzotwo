import { NextResponse } from "next/server";
import { deskzoUpdateKey } from "@/lib/app-updates/protocol";
import { publishAppUpdate, updatesNotMigrated } from "@/lib/app-updates/store";
import { readFormWithin } from "@/lib/http/body";
import { publisherSecretRefusal, publishRateRefusal } from "@/lib/app-updates/publish-guard";
import { tellOfAppUpdatePublish } from "@/lib/app-updates/publish-notice";
import { normaliseIp } from "@/lib/access/ip";
import { clientIpFrom } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

/** The most a published update may come to — its JavaScript and every file it adds. */
const MAX_UPLOAD = 34 * 1024 * 1024;

const answer = (status: number, body: unknown) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Publishing a phone app update (owner, 23 Oct 2026) — what `npm run app:update` sends: a form with `package` (JSON:
 * `{ kind, body, signature }`) and each new file under its hash. The update must be signed with Deskzo's update key,
 * which only the publishing computer holds, and nothing is kept unless that signature checks out against the
 * certificate the app trusts (src/lib/app-updates/certificate.ts). Since 13 Nov 2026 (R2-13) the publisher secret is
 * asked for too, tries are limited per address, and every publish is emailed to the platform's owners.
 */
export async function POST(req: Request) {
  // Security audit round two, 13 Nov 2026 (R2-13): so many tries an hour from one address, and the publisher secret —
  // a second factor beside the update key (src/lib/app-updates/publish-guard.ts) — both before the body is read.
  const ip = normaliseIp(clientIpFrom(req.headers));
  const refused = publishRateRefusal(ip) ?? publisherSecretRefusal(req.headers);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status, headers: { "cache-control": "no-store", ...(refused.headers ?? {}) } });

  // Security audit, 11 Nov 2026 (SEC-27): the form is read streamed and stopped at MAX_UPLOAD before it is parsed,
  // so a chunked body with no length can't make the process hold more.
  let form: FormData | null;
  try {
    form = await readFormWithin(req, MAX_UPLOAD);
  } catch {
    return answer(400, { error: "Send the update as a form." });
  }
  if (!form) return answer(413, { error: "That update is too big." });
  let pkg: { kind?: unknown; body?: unknown; signature?: unknown } | null = null;
  try {
    pkg = JSON.parse(String(form.get("package") ?? ""));
  } catch {
    pkg = null;
  }
  if (!pkg || typeof pkg.kind !== "string" || typeof pkg.body !== "string" || typeof pkg.signature !== "string") {
    return answer(400, { error: "The form needs the update's package." });
  }
  const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  for (const [name, value] of form.entries()) {
    if (name === "package" || typeof value === "string") continue;
    files.set(name, { bytes: new Uint8Array(await value.arrayBuffer()), contentType: value.type || "application/octet-stream" });
  }
  try {
    const done = await publishAppUpdate({ kind: pkg.kind, body: pkg.body, signature: pkg.signature, files }, deskzoUpdateKey());
    if (!done.ok) return answer(done.status, { error: done.error });
    const u = done.update;
    // R2-13: told to the platform's owners, every time.
    await tellOfAppUpdatePublish({ id: u.id, kind: u.kind, platform: u.platform, runtimeVersion: u.runtimeVersion, commit: u.commit, files: files.size }, ip);
    return answer(201, { id: u.id, kind: u.kind, platform: u.platform, runtimeVersion: u.runtimeVersion, createdAt: u.createdAt.toISOString(), files: u.assets.length });
  } catch (err) {
    if (updatesNotMigrated(err)) return answer(503, { error: "This server's control plane hasn't been migrated for app updates yet (npm run tenants:migrate)." });
    throw err;
  }
}
