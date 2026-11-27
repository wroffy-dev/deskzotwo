import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { eachUploadFile, UploadRefused, UPLOAD_LIMITS } from "@/lib/legacy-import/files";
import { receivePart } from "@/lib/legacy-import/parts";
import { addFiles, ImportRefused } from "@/lib/legacy-import/store";
import { currentUser } from "@/lib/session";
import { requestHost } from "@/lib/tenancy/host";

/**
 * Settings › Data & continuity › Old CRM migration: the files arrive here (src/lib/legacy-import). A route rather
 * than a server action, because an old CRM's export is more than an action takes; so it checks for itself what an
 * action gets free — that the request comes from this app — and then that it comes from the workspace's super admin,
 * the one person the tool is for.
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
  if (!sameOrigin) return NextResponse.json({ error: "Uploads are only accepted from this app." }, { status: 403 });

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await actingAsSuperAdmin(user.id))) return NextResponse.json({ error: "Only the workspace's super admin can import the old CRM's data." }, { status: 403 });

  // A request is one upload whole, or one part of a big one (src/lib/legacy-import/parts.ts).
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > UPLOAD_LIMITS.partBytes + 1024 * 1024) return NextResponse.json({ error: `That's over ${UPLOAD_LIMITS.partBytes / 1024 / 1024} MB in one go — reload the page so it sends a big file in parts.` }, { status: 413 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "The upload couldn't be read." }, { status: 400 });
  }
  try {
    const uploads: { name: string; bytes: Buffer }[] = [];
    // One part of a big file: kept until the last, then the file whole.
    const partOf = form.get("uploadId");
    if (typeof partOf === "string") {
      const chunk = form.get("chunk");
      if (!chunk || typeof chunk === "string") return NextResponse.json({ error: "That part had nothing in it." }, { status: 400 });
      const got = await receivePart({
        uploadId: partOf,
        index: Number(form.get("part")),
        count: Number(form.get("parts")),
        name: String(form.get("name") ?? ""),
        size: Number(form.get("size")),
        userId: user.id,
        bytes: Buffer.from(await chunk.arrayBuffer()),
      });
      if (!got.done) return NextResponse.json({ ok: true, received: true });
      uploads.push({ name: got.name, bytes: got.bytes });
    } else {
      for (const value of form.getAll("files")) {
        if (typeof value === "string") continue;
        uploads.push({ name: value.name, bytes: Buffer.from(await value.arrayBuffer()) });
      }
    }
    if (uploads.length === 0) return NextResponse.json({ error: "Choose a ZIP or CSV files." }, { status: 400 });

    // A file at a time: each stored before the next is read, so a big ZIP never sits in memory whole as rows.
    const stored: { name: string; rows: number }[] = [];
    let runId = "";
    await eachUploadFile(uploads, async (file) => {
      const run = await addFiles([file], user.id);
      runId = run.id;
      stored.push({ name: file.name, rows: file.rows.length });
    });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "LegacyImport", entityId: runId, entityLabel: `Uploaded ${stored.length} file(s) of the old CRM's data: ${stored.map((f) => f.name).join(", ").slice(0, 300)}` });
    return NextResponse.json({ ok: true, importId: runId, files: stored });
  } catch (err) {
    if (err instanceof UploadRefused || err instanceof ImportRefused) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
