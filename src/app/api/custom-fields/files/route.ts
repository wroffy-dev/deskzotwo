import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { isModuleEnabled } from "@/actions/module";
import { fieldsFor } from "@/lib/custom-fields/server";
import { CUSTOM_FIELD_LIMITS } from "@/lib/custom-fields/rules";
import { keepUploadedFile } from "@/lib/custom-fields/secure";
import { readFormWithin } from "@/lib/http/body";
import { requestHost } from "@/lib/tenancy/host";

/**
 * A file for a custom field — a subscription's licence certificate (owner, 29 Oct 2026 — src/lib/custom-fields/
 * secure.ts). A route rather than an action: a server action takes 6 MB, and a 5 MB PDF grows past it on the way.
 * Kept until the order's form is saved naming it; the save checks it is this person's, for this field.
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
  if (!sameOrigin) return NextResponse.json({ ok: false, error: "Files are only accepted from this app." }, { status: 403 });

  const user = await currentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in again." }, { status: 401 });
  if (!(await isModuleEnabled("orders"))) return NextResponse.json({ ok: false, error: "Orders aren't on here." }, { status: 404 });

  // Security audit, 11 Nov 2026 (SEC-27): read streamed and stopped at the file's ceiling and the form around it.
  let form: FormData | null;
  try {
    form = await readFormWithin(request, CUSTOM_FIELD_LIMITS.fileBytes + 64 * 1024);
  } catch {
    return NextResponse.json({ ok: false, error: "The upload couldn't be read." }, { status: 400 });
  }
  if (!form) return NextResponse.json({ ok: false, error: `A file is ${CUSTOM_FIELD_LIMITS.fileBytes / 1024 / 1024} MB at most.` }, { status: 400 });
  const fieldKey = String(form.get("field") ?? "");
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "Choose a file." }, { status: 400 });
  if (file.size > CUSTOM_FIELD_LIMITS.fileBytes) return NextResponse.json({ ok: false, error: `A file is ${CUSTOM_FIELD_LIMITS.fileBytes / 1024 / 1024} MB at most.` }, { status: 400 });
  // Only a field this person sees on orders — a restricted one needs the permission, as on the form.
  const field = (await fieldsFor("ORDER", user.id)).visible.find((d) => d.key === fieldKey && d.type === "FILE");
  if (!field) return NextResponse.json({ ok: false, error: "That field doesn't take files." }, { status: 404 });
  const kept = await keepUploadedFile({ entity: "ORDER", fieldKey: field.key, name: file.name, bytes: Buffer.from(await file.arrayBuffer()), userId: user.id });
  // Out of the workspace's storage: 413, saying so (src/lib/file-refusal.ts).
  return NextResponse.json(kept, { status: kept.ok ? 200 : kept.full ? 413 : 400 });
}
