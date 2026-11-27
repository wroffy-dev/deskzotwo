import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { isModuleEntitled } from "@/lib/modules-access";
import { MigrationRefused, openMigration } from "@/lib/migration/state";
import { isStepKey } from "@/lib/migration/steps";
import { uploadBalances } from "@/lib/migration/balances";
import { parseFile } from "@/lib/portability/import";
import { readMigrationUpload, storeUpload, UPLOAD_LIMITS } from "@/lib/migration/upload";
import { currentUser } from "@/lib/session";
import { requestHost } from "@/lib/tenancy/host";

/**
 * Settings › Import & export › Switch to Deskzo: a step's file, or a whole Zoho Books backup as a ZIP
 * (src/lib/migration/upload.ts). A route rather than a server action, because a year of invoices is more than an
 * action takes; so it checks for itself what an action gets free — that the request comes from this app — and
 * then what the switch's actions ask (src/actions/migration.ts): accounting in the plan, and the rights to post
 * journals and import finance data.
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
  if (!(await isModuleEntitled("accounting"))) return NextResponse.json({ error: "Accounting is not part of this workspace's plan." }, { status: 403 });
  if (!(await can(user.id, "ledger.post")) || !(await can(user.id, "data.importFinance"))) {
    return NextResponse.json({ error: "Bringing a year across needs the rights to post journal entries and to import finance data." }, { status: 403 });
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > UPLOAD_LIMITS.requestBytes + 1024 * 1024) return NextResponse.json({ error: `That's over ${UPLOAD_LIMITS.requestBytes / 1024 / 1024} MB — upload it in more than one go.` }, { status: 413 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "The upload couldn't be read." }, { status: 400 });
  }
  const stepField = form.get("step");
  const step = typeof stepField === "string" && stepField ? stepField : null;
  if (step !== null && !isStepKey(step)) return NextResponse.json({ error: "Choose a step." }, { status: 400 });
  const uploads: { name: string; bytes: Buffer }[] = [];
  for (const value of form.getAll("files")) {
    if (typeof value === "string") continue;
    uploads.push({ name: value.name, bytes: Buffer.from(await value.arrayBuffer()) });
  }
  if (uploads.length === 0) return NextResponse.json({ error: "Choose a file." }, { status: 400 });

  // A month-end trial balance (src/lib/migration/balances.ts) — by this route too, since a server action takes 6 MB and
  // a file sent to one grows by a third (owner, 28 Oct 2026).
  if (form.get("kind") === "balances") {
    const file = uploads[0]!;
    if (!/.(csv|xlsx)$/i.test(file.name)) return NextResponse.json({ error: "Use a .csv or .xlsx file." }, { status: 400 });
    try {
      const m = await openMigration();
      if (!m) throw new MigrationRefused("No migration is open.");
      const rows = await parseFile(file.bytes.toString("base64"), file.name);
      if (rows.length === 0) throw new MigrationRefused("That file has no rows.");
      const month = form.get("month");
      const result = await uploadBalances(m, rows, typeof month === "string" && month ? month : null);
      if (result.failed.length === 0) {
        await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Migration", entityId: m.id, entityLabel: `Uploaded the old system's trial balance for ${result.months.join(", ")} (${file.name})` });
        revalidatePath("/settings/data/switch");
      }
      return NextResponse.json({ ok: true, data: result });
    } catch (err) {
      if (err instanceof MigrationRefused) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
  }

  try {
    const m = await openMigration();
    if (!m) throw new MigrationRefused("No migration is open.");
    const files = await readMigrationUpload(uploads);
    const outcome = await storeUpload(m, files, step, user.id);
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Migration",
      entityId: m.id,
      entityLabel: `Uploaded the old system's files: ${[...outcome.stored.map((s) => `${s.step} (${s.units})`), ...(outcome.chart ? [`chart of accounts (${outcome.chart.accounts})`] : [])].join(", ").slice(0, 300)}`,
    });
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    if (err instanceof MigrationRefused) return NextResponse.json({ error: err.message }, { status: 400 });
    if (err instanceof Error && /would both be read as/.test(err.message)) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
