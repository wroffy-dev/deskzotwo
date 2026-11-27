"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { OffsiteError, checkStore, type CheckStep, type OffsiteStore } from "@/lib/offsite/store";
import { MANAGERS, OWNERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { ConsoleRefused } from "@/lib/platform/refused";
import { getSecret, getSetting, setSecret, setSetting } from "@/lib/platform/settings";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { forgetStorageBoxSettings, openAzureBox, parseConnectionString, storageBox } from "@/lib/storage/box";

/**
 * Settings › Backups & logs › Storage box (owner, 24 Nov 2026: "Azure Blob Storage connection — ye saas admin me option
 * add kr do whi se add ho jaye"): the Azure container every workspace's files go to, set here rather than on the server.
 *
 *   Save, Remove         owners — it decides where every workspace's files are kept
 *   Check connection     owners and admins; an owner may check what is typed before saving it
 *
 * The connection string is sealed under the platform key as it is saved and never shown back; an empty field keeps
 * the one saved. A save is refused unless the box answers writing, reading, listing and deleting. What is saved here
 * comes before the server's environment (src/lib/storage/box.ts).
 *
 * Moving to another account or container while the current box holds files leaves those files where they are: every
 * workspace's existing documents and photos would stop opening until they are copied across. So that change, and
 * removing a box in use, need saying so in words.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    if (err instanceof OffsiteError) return { ok: false, error: err.message };
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

export type StorageBoxInput = {
  /** The account's connection string; empty keeps the one saved here. */
  connection?: unknown;
  container?: unknown;
  /** "I understand the files already in the box stay there": needed to change a box that holds files, or remove it. */
  acknowledge?: unknown;
};

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** What is typed, the saved connection string standing in for an empty field. */
async function readInput(input: StorageBoxInput): Promise<{ connection: string; container: string; typedConnection: string | null }> {
  const typed = text(input.connection, 4000).replace(/^"|"$/g, "");
  const container = text(input.container, 63) || "deskzo";
  if (typed) {
    if (/\s/.test(typed)) throw new ConsoleRefused("Paste the connection string exactly as Azure shows it, on one line.");
    parseConnectionString(typed);
    return { connection: typed, container, typedConnection: typed };
  }
  const saved = await getSecret("storage.connection");
  if (!saved) throw new ConsoleRefused("Paste the storage account's connection string (Azure portal › Storage account › Access keys).");
  return { connection: saved, container, typedConnection: null };
}

/** Whether the box holds any workspace's files — one listing of its top folder, never every file. */
async function holdsFiles(box: OffsiteStore): Promise<boolean> {
  const { prefixes, objects } = await box.list("workspaces/", { delimiter: true });
  return prefixes.length > 0 || objects.length > 0;
}

export async function consoleCheckStorageBox(input?: StorageBoxInput | null): Promise<ConsoleResult<{ label: string; steps: CheckStep[] }>> {
  return asStaff(input ? OWNERS : MANAGERS, async () => {
    let store: OffsiteStore | null;
    if (input) {
      const { connection, container } = await readInput(input);
      store = openAzureBox(connection, container);
    } else {
      store = await storageBox();
      if (!store) throw new ConsoleRefused("No storage box is set up yet.");
    }
    return { label: store.label, steps: await checkStore(store) };
  });
}

export async function consoleSaveStorageBox(input: StorageBoxInput): Promise<ConsoleResult<{ label: string }>> {
  return asStaff(OWNERS, async (staff) => {
    const { connection, container, typedConnection } = await readInput(input ?? {});
    const next = openAzureBox(connection, container);
    const steps = await checkStore(next);
    const failed = steps.find((s) => !s.ok);
    if (failed) throw new ConsoleRefused(`Not saved — the box didn't answer ${failed.step}: ${failed.detail}`);

    const now = await storageBox().catch(() => null);
    if (now && now.fingerprint !== next.fingerprint && input?.acknowledge !== true && (await holdsFiles(now))) {
      throw new ConsoleRefused(
        `The storage box now in use (${now.label}) holds workspaces' files. Saving a different account or container leaves them there, and every existing document and photo stops opening until they are copied across. Tick the box to say you understand, then save again.`,
      );
    }
    if (typedConnection) await setSecret("storage.connection", typedConnection, staff.id);
    await setSetting("storage.container", container, staff.id);
    forgetStorageBoxSettings();
    await consoleAudit(staff, "storage.save", { box: next.label, connection: typedConnection ? "replaced" : "kept", changedFrom: now && now.fingerprint !== next.fingerprint ? now.label : null });
    revalidateConsole();
    return { label: next.label };
  });
}

/** The box saved here taken away: the server's environment decides again (or none). */
export async function consoleRemoveStorageBox(input?: StorageBoxInput | null): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    const saved = await getSecret("storage.connection");
    if (!saved) throw new ConsoleRefused("No storage box is saved in the console.");
    const now = await storageBox().catch(() => null);
    if (now && input?.acknowledge !== true && (await holdsFiles(now).catch(() => true))) {
      throw new ConsoleRefused(`${now.label} holds workspaces' files. Without it they stop opening. Tick the box to say you understand, then remove it again.`);
    }
    const label = now?.label ?? (await getSetting("storage.container"));
    await setSecret("storage.connection", null, staff.id);
    await setSetting("storage.container", null, staff.id);
    forgetStorageBoxSettings();
    await consoleAudit(staff, "storage.remove", { box: label });
    revalidateConsole();
    return null;
  });
}
