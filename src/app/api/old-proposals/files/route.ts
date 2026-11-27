import { NextResponse } from "next/server";
import { can } from "@/lib/authz/resolve";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { isStorageFull } from "@/lib/file-refusal";
import { FILE_LIMITS, filesWanted, keepOldProposalFile } from "@/lib/old-proposals/files";
import { currentUser } from "@/lib/session";
import { requestHost } from "@/lib/tenancy/host";

/**
 * Settings › Old CRM migration › Old proposals: the proposals' own files (src/lib/old-proposals/files.ts). A route rather
 * than a server action, as files are more than an action takes; so it checks for itself that the request comes from this
 * app, and then that it comes from the workspace's super admin.
 */
async function allowed(): Promise<boolean> {
  const user = await currentUser();
  return !!user && (await can(user.id, "settings.manage")) && (await actingAsSuperAdmin(user.id));
}

export async function GET() {
  if (!(await allowed())) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json({ wanted: await filesWanted() }, { headers: { "cache-control": "private, no-store" } });
}

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
  if (!(await allowed())) return new NextResponse("Not found", { status: 404 });
  if (Number(request.headers.get("content-length") ?? "0") > FILE_LIMITS.requestBytes) return NextResponse.json({ error: "Too much in one go." }, { status: 413 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "The upload couldn't be read." }, { status: 400 });
  }
  const paths = form.getAll("path").map(String);
  const files = form.getAll("file").filter((f): f is File => typeof f !== "string");
  if (!files.length || files.length !== paths.length || files.length > FILE_LIMITS.perRequest) return NextResponse.json({ error: "The upload couldn't be read." }, { status: 400 });
  let kept = 0;
  try {
    for (const [i, file] of files.entries()) if (await keepOldProposalFile(paths[i]!, Buffer.from(await file.arrayBuffer()))) kept += 1;
  } catch (err) {
    if (isStorageFull(err)) return NextResponse.json({ error: err.message, kept }, { status: 507 });
    throw err;
  }
  return NextResponse.json({ ok: true, kept });
}
