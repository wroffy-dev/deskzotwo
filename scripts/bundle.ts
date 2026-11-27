/**
 * Backup & Restore bundles by hand (src/lib/bundle — docs/runbook.md "Backup & Restore bundles").
 *
 *   npm run bundle -- create --full --out <file>                 the whole installation
 *   npm run bundle -- create --workspace <slug> --out <file>     one workspace
 *   npm run bundle -- inspect <file>                             the header — no passphrase needed
 *   npm run bundle -- verify <file>                              the whole file read once and checked
 *   npm run bundle -- restore <file> --i-understand              the whole application, from a full bundle
 *   npm run bundle -- restore <file> --workspace <slug> [--put-back-records] --i-understand
 *                                                                one workspace — over it when it is here, as a new
 *                                                                one when it isn't (src/lib/bundle/restore.ts)
 *   npm run bundle -- put-back-control <run id> --i-understand   the control plane put back from the safety copy a
 *                                                                full restore took, when its own rollback couldn't
 *
 * The passphrase comes from BUNDLE_PASSPHRASE, never the command line, where `ps` and the shell's history would
 * keep it. `--out` may be left off: the bundle then goes to BACKUP_DIR/platform/bundles/.
 *
 * PLATFORM_MASTER_KEY is not in the bundle. The server it is restored on needs the same one; `inspect` shows the
 * fingerprint of the key it was made under, and whether this server's matches.
 */
import "dotenv/config";
import { rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildFullBundle, buildWorkspaceBundle, type BundleProgress } from "../src/lib/bundle/build";
import { readBundleHeader, verifyBundle } from "../src/lib/bundle/format";
import { controlSafetyFile, putBackControlPlane, restoreFromFile } from "../src/lib/bundle/restore";
import { activeFilePath, platformRestoreDir, validRunId } from "../src/lib/bundle/restore-status";
import { closeControlDb } from "../src/lib/platform/control-db";
import { platformKeyFingerprint } from "../src/lib/platform/kek";
import { tenantBySlug } from "../src/lib/tenancy/registry";

function usage(): never {
  console.error(
    "usage: npm run bundle -- create (--full | --workspace <slug>) [--out <file>] | inspect <file> | verify <file>\n" +
      "       npm run bundle -- restore <file> [--workspace <slug> [--put-back-records]] --i-understand | put-back-control <run id> --i-understand\n" +
      "       the passphrase is read from BUNDLE_PASSPHRASE",
  );
  process.exit(2);
}

function flag(args: string[], name: string): string | null {
  const at = args.indexOf(name);
  if (at < 0) return null;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

function passphrase(): string {
  const value = process.env.BUNDLE_PASSPHRASE ?? "";
  if (!value) {
    console.error("Set BUNDLE_PASSPHRASE to the bundle's passphrase. It is never taken from the command line.");
    process.exit(2);
  }
  return value;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function progressPrinter(): (p: BundleProgress) => void {
  let last = 0;
  let lastEntry = "";
  return (p) => {
    const now = Date.now();
    if (p.entry === lastEntry && now - last < 1000) return;
    last = now;
    lastEntry = p.entry;
    process.stderr.write(`  ${mb(p.bytes)} · ${p.entries} entries · ${p.entry} (${mb(p.entryBytes)})\n`);
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") {
    const full = args.includes("--full");
    const slug = flag(args, "--workspace");
    if (full === !!slug) usage();
    const out = flag(args, "--out") ?? undefined;
    const secret = passphrase();
    const createdBy = `script:${os.userInfo().username}`;
    const options = { out, passphrase: secret, createdBy, onProgress: progressPrinter() };
    let result;
    if (full) {
      result = await buildFullBundle(options);
    } else {
      const tenant = await tenantBySlug(slug!);
      if (!tenant) throw new Error(`There is no workspace "${slug}".`);
      if (tenant.status === "DEPROVISIONED") throw new Error(`${slug} is closed; there is nothing of it to put in a bundle.`);
      result = await buildWorkspaceBundle(tenant, options);
    }
    console.log(`Written: ${result.file}`);
    console.log(`  ${mb(result.sizeBytes)}, ${result.manifest.counts.entries} entries, sha256 ${result.sha256}`);
    console.log(`  workspaces: ${result.header.workspaces.map((w) => w.slug).join(", ") || "none"}`);
    for (const note of result.manifest.notes ?? []) console.log(`  note: ${note}`);
    if (result.backupId) console.log(`  recorded as ${result.backupId}`);
    return;
  }
  if (command === "inspect") {
    const file = args[0] ?? usage();
    const header = await readBundleHeader(file);
    // The KDF salt, verifier and nonce prefix are not secret, but mean nothing to a person reading this.
    const shown: Record<string, unknown> = { ...header };
    for (const k of ["kdf", "verifier", "noncePrefix"]) delete shown[k];
    console.log(JSON.stringify(shown, null, 2));
    const here = platformKeyFingerprint();
    console.log(
      header.keyFingerprint === here
        ? "This server's PLATFORM_MASTER_KEY is the one it was made under."
        : `This server's PLATFORM_MASTER_KEY is NOT the one it was made under (${here ?? "none set here"}) — a restore here would be refused.`,
    );
    return;
  }
  if (command === "verify") {
    const file = args[0] ?? usage();
    const result = await verifyBundle(file, passphrase());
    if (result.ok) {
      console.log(`Sound: ${result.manifest!.counts.entries} entries, ${mb(result.manifest!.counts.bytes)} — every frame authenticated, every entry matches its manifest.`);
      return;
    }
    console.error("NOT sound:");
    for (const p of result.problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  if (command === "restore") {
    const file = args[0] && !args[0].startsWith("--") ? args[0] : usage();
    const workspace = flag(args, "--workspace");
    if (!args.includes("--i-understand")) {
      console.error(
        workspace
          ? `This replaces the workspace ${workspace} with the backup's (or adds it, when this server hasn't got it). A safety copy is taken first. Add --i-understand to go ahead.`
          : "This replaces the whole control plane — staff, plans, settings, billing, every workspace's record — with the backup's, and gives every workspace in it a new database. A safety copy of the control plane is taken first; this server's workspace databases are left untouched. Add --i-understand to go ahead.",
      );
      process.exit(2);
    }
    const outcome = await restoreFromFile({ file, workspace, passphrase: passphrase(), putBackControlRows: args.includes("--put-back-records"), by: `script:${os.userInfo().username}` });
    for (const line of outcome.log) console.log(`  ${line.at.slice(11, 19)} [${line.step}] ${line.message}`);
    if (outcome.status === "SUCCEEDED") {
      console.log(workspace ? "Restored." : "Restored. Sign in to the console with a staff account from the backup.");
      return;
    }
    console.error(`\n${outcome.status === "ROLLED_BACK" ? "Failed, and put back as it was" : "Not restored"}: ${outcome.error}`);
    process.exitCode = 1;
    return;
  }
  if (command === "put-back-control") {
    const id = args[0];
    if (!validRunId(id) || !args.includes("--i-understand")) {
      console.error("usage: npm run bundle -- put-back-control <run id> --i-understand — replaces the control plane with the safety copy that full restore took.");
      process.exit(2);
    }
    const file = controlSafetyFile(id);
    if (!(await stat(file).catch(() => null))?.isFile()) throw new Error(`There is no safety copy at ${file}.`);
    await putBackControlPlane(file, path.join(platformRestoreDir(), `${id}-put-back`));
    await rm(path.join(platformRestoreDir(), `${id}-put-back`), { recursive: true, force: true });
    await rm(activeFilePath(), { force: true });
    console.log(`The control plane is back as it was before restore ${id}, and the application is open again.`);
    return;
  }
  usage();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeControlDb();
    // A restore leaves workspace clients and timers behind; nothing is left worth waiting for.
    setTimeout(() => process.exit(), 1000).unref();
  });
