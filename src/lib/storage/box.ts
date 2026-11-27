import { KeptByStore, openAzureWithKey, openStore, OffsiteError, type OffsiteStore } from "@/lib/offsite/store";

/**
 * The storage box (owner, 13 Nov 2026: "deskzo k saare pdf and doc vhi pr save ho naa ki vm mein"): one Azure Blob
 * container that holds every file Deskzo keeps — documents, attachments, photos, call recordings, backups and logs —
 * so neither the server's disk nor its database carries them.
 *
 * Set in the platform console (owner, 24 Nov 2026: "ye saas admin me option add kr do whi se add ho jaye") — Settings ›
 * Backups & logs › Storage box: the connection string, sealed under the platform key and never shown back, and the
 * container (`storage.connection`, `storage.container` — src/actions/platform/console-storage.ts). What the console
 * saves comes first. Without it, the server's environment, as before:
 *
 *   STORAGE_AZURE_CONNECTION_STRING   the storage account's connection string (Azure portal › Storage account ›
 *                                     Access keys). Its key never leaves the server: each request carries a
 *                                     container SAS signed with it for the hour (src/lib/offsite/store.ts).
 *   STORAGE_AZURE_CONTAINER           the container, "deskzo" unless set. Private — no anonymous access.
 *   or, instead of the two above,
 *   STORAGE_AZURE_CONTAINER_URL       https://<account>.blob.core.windows.net/<container>
 *   STORAGE_AZURE_SAS                 a SAS token on it with read, add, create, write, delete and list
 *
 *   STORAGE_DIR                       a folder instead of Azure — the check suite, and a server being tried out
 *   STORAGE_PREFIX                    a folder inside the container for this installation ("" unless set). Tidiness
 *                                     only, never isolation (security audit round three, 14 Nov 2026): a SAS or
 *                                     account key opens the whole container whatever the prefix, so a staging
 *                                     server that shares production's container can read and delete production's
 *                                     files. Give every environment its own container — better, its own storage
 *                                     account — and its own PLATFORM_MASTER_KEY.
 *
 * None set: there is no box, and every file stays where it always was — nothing changes until one is.
 *
 * What lives where inside it:
 *
 *   workspaces/<workspace id>/files/<kind>/<yyyy-mm>/<id>   documents, attachments and photos (src/lib/storage/files.ts)
 *   workspaces/<workspace id>/recordings/…                  call recordings (src/lib/calls/recordings.ts)
 *   offsite/…                                               backups and archived logs, when the console sets no
 *                                                           off-site store of its own (src/lib/offsite/config.ts)
 *   support/…                                               support requests' attachments (src/lib/support/storage.ts)
 */

export type BoxMode = "azure" | "filesystem";

export type BoxSource = "console" | "environment";

let cached: { signature: string; store: OffsiteStore | null; mode: BoxMode | null; error: string | null; source: BoxSource | null } | null = null;

/** The console's saved box, read at most every 30 seconds — every file saved and opened asks for the box. */
type ConsoleBox = { connection: string; container: string } | null;
let consoleCache: { at: number; value: ConsoleBox } | null = null;
const CONSOLE_TTL_MS = 30_000;

async function consoleBox(): Promise<ConsoleBox> {
  if (consoleCache && Date.now() - consoleCache.at < CONSOLE_TTL_MS) return consoleCache.value;
  let value: ConsoleBox = null;
  // Loaded when asked, not imported: the request proxy reaches this file, and needs no database client to.
  const { controlConfigured } = await import("@/lib/platform/control-db");
  if (controlConfigured()) {
    const { getSecret, getSetting } = await import("@/lib/platform/settings");
    const [connection, container] = await Promise.all([getSecret("storage.connection").catch(() => null), getSetting("storage.container").catch(() => null)]);
    if (connection) value = { connection, container: container?.trim() || "deskzo" };
  }
  consoleCache = { at: Date.now(), value };
  return value;
}

/** After the console saves or removes the box: the next file saved or opened reads it again. */
export function forgetStorageBoxSettings(): void {
  consoleCache = null;
  cached = null;
}

const env = (name: string) => process.env[name]?.trim() || "";

/** What the environment says now — read each call, so a changed environment in the checks is seen. */
function signature(): string {
  return ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_AZURE_SAS", "STORAGE_DIR", "STORAGE_PREFIX"].map(env).join("\u0000");
}

/** "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=y;EndpointSuffix=core.windows.net" → its parts. */
export function parseConnectionString(text: string): { account: string; key: string; blobEndpoint: string } {
  const parts = new Map<string, string>();
  for (const piece of text.split(";")) {
    const at = piece.indexOf("=");
    if (at > 0) parts.set(piece.slice(0, at).trim().toLowerCase(), piece.slice(at + 1).trim());
  }
  const account = parts.get("accountname") ?? "";
  const key = parts.get("accountkey") ?? "";
  if (!account || !key) throw new OffsiteError("The connection string has no AccountName or AccountKey.");
  const protocol = parts.get("defaultendpointsprotocol") || "https";
  const blobEndpoint = (parts.get("blobendpoint") || `${protocol}://${account}.blob.${parts.get("endpointsuffix") || "core.windows.net"}`).replace(/\/+$/, "");
  return { account, key, blobEndpoint };
}

/** Plain http only to this machine — the emulator in the checks. Anything else would send the files in the clear. */
function checkAddress(url: string): void {
  const u = new URL(url);
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return;
  throw new OffsiteError("The storage box's address must be https.");
}

/** A box from a connection string and a container — the console's, or one typed to be checked before it is saved. */
export function openAzureBox(connection: string, container: string, prefix = ""): OffsiteStore {
  const { key, blobEndpoint } = parseConnectionString(connection);
  const name = container.trim() || "deskzo";
  if (!/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/.test(name)) throw new OffsiteError("A container's name is 3–63 lower-case letters, digits and dashes, like deskzo-files.");
  const containerUrl = `${blobEndpoint}/${name}`;
  checkAddress(containerUrl);
  return openAzureWithKey({ provider: "azure", containerUrl, prefix }, key);
}

function open(saved: ConsoleBox): { store: OffsiteStore | null; mode: BoxMode | null; error: string | null; source: BoxSource | null } {
  const prefix = env("STORAGE_PREFIX");
  if (saved) {
    try {
      return { store: openAzureBox(saved.connection, saved.container, prefix), mode: "azure", error: null, source: "console" };
    } catch (err) {
      return { store: null, mode: null, error: err instanceof Error ? err.message : String(err), source: "console" };
    }
  }
  try {
    const connection = env("STORAGE_AZURE_CONNECTION_STRING");
    if (connection) {
      const { key, blobEndpoint } = parseConnectionString(connection);
      const containerUrl = `${blobEndpoint}/${env("STORAGE_AZURE_CONTAINER") || "deskzo"}`;
      checkAddress(containerUrl);
      return { store: openAzureWithKey({ provider: "azure", containerUrl, prefix }, key), mode: "azure", error: null, source: "environment" };
    }
    const containerUrl = env("STORAGE_AZURE_CONTAINER_URL");
    if (containerUrl) {
      checkAddress(containerUrl);
      return { store: openStore({ provider: "azure", containerUrl, prefix }, env("STORAGE_AZURE_SAS") || null), mode: "azure", error: null, source: "environment" };
    }
    const dir = env("STORAGE_DIR");
    if (dir) return { store: openStore({ provider: "filesystem", path: dir, prefix }, null), mode: "filesystem", error: null, source: "environment" };
    return { store: null, mode: null, error: null, source: null };
  } catch (err) {
    return { store: null, mode: null, error: err instanceof Error ? err.message : String(err), source: "environment" };
  }
}

async function current() {
  const saved = await consoleBox();
  // The console's connection is part of what decides the box: a new one opens a new store.
  const sig = `${signature()}\u0001${saved ? `${saved.container}\u0000${saved.connection}` : ""}`;
  if (!cached || cached.signature !== sig) cached = { signature: sig, ...open(saved) };
  return cached;
}

/**
 * The box, at its root, or null when the server has none. A box set up wrongly (a connection string without a key,
 * an http address) throws rather than quietly keeping files on the server the owner meant to empty.
 */
export async function storageBox(): Promise<OffsiteStore | null> {
  const c = await current();
  if (c.error) throw new OffsiteError(`The storage box is set up wrongly: ${c.error}`);
  return c.store;
}

/** Whether a box is set up — and if it is set up wrongly, why. For the console and the status script. */
export async function storageBoxState(): Promise<{ configured: boolean; mode: BoxMode | null; label: string | null; error: string | null; source: BoxSource | null }> {
  const c = await current();
  return { configured: Boolean(c.store), mode: c.mode, label: c.store?.label ?? null, error: c.error, source: c.source };
}

/** A part of the box: everything under `folder` ("workspaces/abc/files"), keys relative to it. */
export function boxFolder(store: OffsiteStore, folder: string): OffsiteStore {
  const base = folder.replace(/^\/+|\/+$/g, "") + "/";
  const strip = (key: string) => (key.startsWith(base) ? key.slice(base.length) : key);
  return {
    label: `${store.label} › ${base.slice(0, -1)}`,
    fingerprint: `${store.fingerprint}|${base}`,
    put: (key, body) => store.put(base + key, body),
    putFile: (key, file) => store.putFile(base + key, file),
    get: (key) => store.get(base + key),
    getToFile: (key, file) => store.getToFile(base + key, file),
    async list(prefix, options) {
      const listing = await store.list(base + prefix, options);
      return { objects: listing.objects.map((o) => ({ ...o, key: strip(o.key) })), prefixes: listing.prefixes.map(strip) };
    },
    remove: (key) => store.remove(base + key),
  };
}

/**
 * Security audit round three, 14 Nov 2026 (R3-24): everything under `folder` deleted — a closed workspace's
 * `workspaces/<id>/` and `support/<id>/` when it is purged (src/lib/platform/lifecycle.ts). `folder` must name a
 * folder ("workspaces/abc"), never the box's root. Returns how many files went; one the store's own retention keeps
 * (KeptByStore) is left and not counted.
 */
export async function removeBoxFolder(store: OffsiteStore, folder: string): Promise<number> {
  const base = folder.replace(/^\/+|\/+$/g, "");
  if (!base || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(base)) throw new OffsiteError(`Not a folder that can be emptied: "${folder}".`);
  const { objects } = await store.list(`${base}/`);
  let removed = 0;
  for (const o of objects) {
    try {
      await store.remove(o.key);
      removed += 1;
    } catch (err) {
      if (!(err instanceof KeptByStore)) throw err;
    }
  }
  return removed;
}

/** A workspace's own part of the box: `workspaces/<id>/<area>`. */
export function workspaceBox(store: OffsiteStore, tenantId: string, area: "files" | "recordings"): OffsiteStore {
  const id = tenantId.replace(/[^A-Za-z0-9._-]/g, "-");
  return boxFolder(store, `workspaces/${id}/${area}`);
}
