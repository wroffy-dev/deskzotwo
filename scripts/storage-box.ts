/**
 * The storage box by hand (src/lib/storage/box.ts) — the Azure Blob container every file goes to.
 *
 *   npm run storage -- status [--workspace <slug>]     the box, and each workspace's files: in the box, still in the database
 *   npm run storage -- check                           write, read, list and delete a small object in the box
 *   npm run storage -- move [--apply] [--workspace <slug>] [--only <Model>] [--limit <n>]
 *                                                      the files still in the database copied into the box, each row
 *                                                      then pointing at its copy. Without --apply it only counts.
 *   npm run storage -- sweep [--workspace <slug>]      files in the box no row has pointed at for longer than backups
 *                                                      are kept, deleted (the nightly chore does this too)
 *   npm run storage -- measure [--workspace <slug>]    what each workspace's files take now, written where its plan's
 *                                                      storage limit is checked and the console shows it (the nightly
 *                                                      chore does this too — src/lib/storage/quota.ts)
 *
 * The box comes from the server's environment (STORAGE_AZURE_CONNECTION_STRING and STORAGE_AZURE_CONTAINER, see
 * src/lib/storage/box.ts) and PLATFORM_MASTER_KEY must be the one the server uses — files are sealed under it.
 */
import "dotenv/config";
import { checkStore } from "../src/lib/offsite/store";
import { storageBox, storageBoxState } from "../src/lib/storage/box";
import { fileColumnCounts, moveColumn, sweepStoredFiles } from "../src/lib/storage/maintenance";
import { FILE_COLUMNS } from "../src/lib/storage/registry";
import { gb, recordWorkspaceStorage } from "../src/lib/storage/quota";
import { closeControlDb } from "../src/lib/platform/control-db";
import { activeTenants, tenantBySlug } from "../src/lib/tenancy/registry";
import { runAsTenant } from "../src/lib/tenancy/resolve";
import { installLogLabels } from "../src/lib/tenancy/log-labels";
import type { Tenant } from "../src/lib/tenancy/state";

installLogLabels();

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const why = (err: unknown) => (err instanceof Error ? err.message.split("\n").filter(Boolean).pop() ?? err.name : String(err));
/** One workspace's failure is reported and the rest carry on; the run ends as failed. */
let workspaceFailures = 0;
async function each(tenants: Tenant[], work: (tenant: Tenant) => Promise<void>): Promise<void> {
  for (const tenant of tenants) {
    try {
      await work(tenant);
    } catch (err) {
      workspaceFailures += 1;
      console.log(`\n${tenant.slug}: FAILED — ${why(err)}`);
    }
  }
  if (workspaceFailures) process.exitCode = 1;
}

function usage(): never {
  console.error("usage: npm run storage -- status | check | move [--apply] [--workspace <slug>] [--only <Model>] [--limit <n>] | sweep [--workspace <slug>] | measure [--workspace <slug>]");
  process.exit(2);
}

async function workspaces(): Promise<Tenant[]> {
  const slug = option("workspace");
  if (!slug) return activeTenants();
  const one = await tenantBySlug(slug);
  if (!one) throw new Error(`No workspace ${slug}.`);
  return [one];
}

function requireBox() {
  const state = (await storageBoxState());
  if (state.error) throw new Error(`The storage box is set up wrongly: ${state.error}`);
  const box = (await storageBox());
  if (!box) throw new Error("No storage box is set up — set STORAGE_AZURE_CONNECTION_STRING and STORAGE_AZURE_CONTAINER on the server (src/lib/storage/box.ts).");
  return box;
}

async function main() {
  const command = args[0];
  if (command === "check") {
    const box = requireBox();
    console.log(`Storage box: ${box.label}`);
    let ok = true;
    for (const step of await checkStore(box)) {
      console.log(`  ${step.ok ? "ok  " : "FAIL"} ${step.step}: ${step.detail}`);
      ok &&= step.ok;
    }
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (command === "status") {
    const state = (await storageBoxState());
    console.log(state.configured ? `Storage box: ${state.label}` : state.error ? `Storage box set up wrongly: ${state.error}` : "No storage box — every file stays in the database and on this server.");
    await each(await workspaces(), async (tenant) => {
      const counts = await runAsTenant(tenant, () => fileColumnCounts());
      const here = counts.reduce((n, c) => n + c.databaseBytes, 0);
      console.log(`\n${tenant.slug}: ${counts.reduce((n, c) => n + c.inBox, 0)} files in the box, ${counts.reduce((n, c) => n + c.inDatabase, 0)} still in the database (${mb(here)})`);
      for (const c of counts) if (c.inBox || c.inDatabase) console.log(`  ${`${c.model}.${c.column}`.padEnd(40)} box ${String(c.inBox).padStart(6)}   database ${String(c.inDatabase).padStart(6)}  ${mb(c.databaseBytes)}`);
    });
    return;
  }
  if (command === "move") {
    const apply = flag("apply");
    if (apply) requireBox();
    const only = option("only");
    const limit = option("limit") ? Number(option("limit")) : undefined;
    const columns = FILE_COLUMNS.filter((c) => !only || c.model === only);
    if (columns.length === 0) throw new Error(`No file column on ${only}. Known: ${FILE_COLUMNS.map((c) => c.model).join(", ")}`);
    let failed = 0;
    await each(await workspaces(), async (tenant) => {
      console.log(`\n${tenant.slug}${apply ? "" : " (counting only — add --apply to move)"}`);
      for (const c of columns) {
        const r = await runAsTenant(tenant, () => moveColumn(c, { dryRun: !apply, limit }));
        failed += r.failed;
        if (r.moved || r.failed || r.skipped) console.log(`  ${`${c.model}.${c.column}`.padEnd(40)} ${apply ? "moved" : "to move"} ${r.moved} (${mb(r.bytes)})${r.skipped ? `, ${r.skipped} left as they were` : ""}${r.failed ? `, ${r.failed} FAILED` : ""}`);
        for (const e of r.errors) console.log(`      ${e}`);
      }
    });
    if (apply) console.log("\nThe database keeps the space until Postgres reuses it; VACUUM FULL on the big tables gives it back to the disk at once.");
    if (failed || workspaceFailures) process.exitCode = 1;
    return;
  }
  if (command === "sweep") {
    requireBox();
    await each(await workspaces(), async (tenant) => {
      const r = await runAsTenant(tenant, () => sweepStoredFiles());
      if (r) console.log(`${tenant.slug}: ${r.checked} files in the box, ${r.removed} removed, ${r.kept} unreferenced kept (younger than ${r.graceDays} days)`);
    });
    return;
  }
  if (command === "measure") {
    await each(await workspaces(), async (tenant) => {
      const m = await runAsTenant(tenant, () => recordWorkspaceStorage());
      if (!m) {
        console.log(`${tenant.slug}: no control plane here to write it on`);
        return;
      }
      const limit = tenant.entitlements.storageMb;
      const kinds = Object.entries(m.breakdown).sort((a, b) => b[1] - a[1]).map(([k, b]) => `${k} ${gb(b)}`).join(", ");
      console.log(`${tenant.slug}: ${gb(m.usedBytes)} of ${typeof limit === "number" ? gb(limit * 1024 * 1024) : "no limit"}${kinds ? ` — ${kinds}` : ""}`);
    });
    return;
  }
  usage();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb().catch(() => {}));
