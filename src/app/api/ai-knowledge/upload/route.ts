import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { requestHost } from "@/lib/tenancy/host";
import { readFormWithin } from "@/lib/http/body";
import { readKnowledgeUpload, UPLOAD_LIMITS } from "@/lib/ai-knowledge/upload";
import { saveKnowledgeTexts } from "@/lib/ai-knowledge/store";

/**
 * Settings › AI Knowledge's upload (owner, 3 Nov 2026): several .md or .txt files at once, or a .zip of them, as
 * `files` in a multipart form. A name already in AI Knowledge has its file replaced; the rest are added. Answers with
 * what was added, replaced and left out, and why (src/lib/ai-knowledge/upload.ts, ./store.ts).
 *
 * A route rather than a server action because a .zip of a company's guides can be past the 6 MB an action takes —
 * so it checks for itself what an action checks for free: that the request comes from this app's own page, not
 * another site posting with the signed-in person's cookie. Then the same as the page: `settings.manage`, and never
 * while viewing as somebody.
 */

export const dynamic = "force-dynamic";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  // The real host of this request (src/lib/tenancy/host.ts) — a forwarded one is only a claim.
  const checked = requestHost(request.headers);
  const host = typeof checked === "string" ? checked : null;
  try {
    return !!origin && !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ ok: false, error: "Uploads are only accepted from this app." }, { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > UPLOAD_LIMITS.requestBytes) {
    return NextResponse.json({ ok: false, error: "That's over 25 MB in one go — upload it in parts." }, { status: 413 });
  }
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return NextResponse.json({ ok: false, error: viewing }, { status: 403 });
  if (!(await can(user.id, "settings.manage"))) {
    return NextResponse.json({ ok: false, error: "Only somebody who can change the workspace's settings can manage AI Knowledge." }, { status: 403 });
  }

  let form: FormData;
  try {
    // Security audit, 13 Nov 2026 (A6): read under the ceiling as it streams — content-length alone holds nothing
    // against a chunked body, which declares none. Past the ceiling, the same answer as the check above.
    const read = await readFormWithin(request, UPLOAD_LIMITS.requestBytes);
    if (!read) return NextResponse.json({ ok: false, error: "That's over 25 MB in one go — upload it in parts." }, { status: 413 });
    form = read;
  } catch {
    return NextResponse.json({ ok: false, error: "That upload didn't arrive whole — try again." }, { status: 400 });
  }
  const uploads = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!uploads.length) return NextResponse.json({ ok: false, error: "Choose .md or .txt files, or a .zip of them." }, { status: 400 });
  const total = uploads.reduce((sum, f) => sum + f.size, 0);
  if (total > UPLOAD_LIMITS.requestBytes) return NextResponse.json({ ok: false, error: "That's over 25 MB in one go — upload it in parts." }, { status: 413 });

  const read = await readKnowledgeUpload(await Promise.all(uploads.map(async (f) => ({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) }))));
  const saved = await saveKnowledgeTexts(user.id, read.files);
  const skipped = [...read.skipped, ...saved.skipped];
  if (saved.added.length || saved.replaced.length) {
    const names = [...saved.added, ...saved.replaced];
    await recordAudit({
      userId: user.id,
      action: saved.added.length ? "CREATE" : "UPDATE",
      entityType: "AiKnowledgeFile",
      entityId: "upload",
      entityLabel: `AI Knowledge: ${saved.added.length} added, ${saved.replaced.length} replaced — ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`,
    });
    revalidatePath("/settings/ai-knowledge");
  }
  return NextResponse.json({ ok: true, data: { added: saved.added, replaced: saved.replaced, skipped } });
}
