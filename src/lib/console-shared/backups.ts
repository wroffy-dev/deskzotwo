import type { Tone } from "@/lib/console-shared/types";

/**
 * The console's Backups page, the parts a browser may know (src/lib/bundle/jobs.ts and upload.ts are the server's):
 * sizes in words, what each status is called, and the compatibility report — worked out from a bundle's header,
 * which is readable without its passphrase, against what this server is. Pure: nothing here reads anything.
 */

export function sizeText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export const BACKUP_STATUS: Record<"RUNNING" | "READY" | "FAILED" | "EXPIRED" | "DELETED", { label: string; tone: Tone }> = {
  RUNNING: { label: "Being made", tone: "info" },
  READY: { label: "Ready", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  DELETED: { label: "Deleted", tone: "neutral" },
};

export const RESTORE_STATUS: Record<"RUNNING" | "SUCCEEDED" | "FAILED" | "ROLLED_BACK", { label: string; tone: Tone }> = {
  RUNNING: { label: "Running", tone: "info" },
  SUCCEEDED: { label: "Restored", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  ROLLED_BACK: { label: "Put back", tone: "warning" },
};

/** The part of a bundle's header the report reads — never its KDF, verifier or nonce. */
export type HeaderSummary = {
  kind: "full" | "workspace";
  createdAt: string;
  app: { name: string; version: string | null; commit: string | null };
  control: { schemaVersion: string | null } | null;
  workspaces: { id: string; slug: string; name: string; schemaVersion: string | null }[];
  keyFingerprint: string | null;
};

/** A header from a row's JSON, down to what may be shown; null when it isn't one. */
export function headerSummary(value: unknown): HeaderSummary | null {
  const h = value as Partial<HeaderSummary> | null;
  if (!h || (h.kind !== "full" && h.kind !== "workspace") || !Array.isArray(h.workspaces)) return null;
  return {
    kind: h.kind,
    createdAt: typeof h.createdAt === "string" ? h.createdAt : "",
    app: { name: String(h.app?.name ?? ""), version: h.app?.version ?? null, commit: h.app?.commit ?? null },
    control: h.control ? { schemaVersion: h.control.schemaVersion ?? null } : null,
    workspaces: h.workspaces.map((w) => ({ id: String(w?.id ?? ""), slug: String(w?.slug ?? ""), name: String(w?.name ?? ""), schemaVersion: w?.schemaVersion ?? null })),
    keyFingerprint: typeof h.keyFingerprint === "string" ? h.keyFingerprint : null,
  };
}

/** What this server is, for the report: its key's fingerprint, the migrations its code carries, its workspaces. */
export type ServerFacts = {
  keyFingerprint: string | null;
  /** Oldest first, as the folders sort. */
  controlMigrations: string[];
  workspaceMigrations: string[];
  /** This server's workspaces by id. */
  workspaces: Record<string, { slug: string; status: string }>;
  appVersion: string | null;
};

export type SchemaAge = "same" | "older" | "newer" | "unknown";

/** A schema version against the migrations this code carries: the latest, an earlier one, past them, or neither. */
export function schemaAge(version: string | null, names: string[]): SchemaAge {
  const latest = names.at(-1);
  if (!version || !latest) return "unknown";
  if (version === latest) return "same";
  if (names.includes(version)) return "older";
  return version > latest ? "newer" : "unknown";
}

function versionCompare(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const y = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export type CompatLine = { key: string; tone: Tone; label: string; text: string };
export type Compatibility = { verdict: "ok" | "warning" | "blocked"; lines: CompatLine[] };

const SCHEMA_WORDS: Record<SchemaAge, { tone: Tone; label: string; text: (what: string) => string }> = {
  same: { tone: "success", label: "Same", text: (what) => `${what} is at this server's latest migration.` },
  older: { tone: "success", label: "Older", text: (what) => `${what} is at an earlier migration than this server's; a restore brings it up to date.` },
  newer: { tone: "danger", label: "Newer", text: (what) => `${what} is at a newer migration than this server has — it can't be restored here until this server is updated.` },
  unknown: { tone: "warning", label: "Unknown", text: (what) => `${what}'s migration is not one this server carries, or is not recorded.` },
};

/**
 * Whether this bundle could be restored on this server, from its header alone — no passphrase: the platform key it was
 * made under, the control plane's and each workspace's schema against this server's migrations (newer means it waits
 * for this server to be updated), each workspace there or not here (by id), and the app's version.
 */
export function compatibilityOf(header: HeaderSummary, here: ServerFacts): Compatibility {
  const lines: CompatLine[] = [];
  const theirs = header.keyFingerprint;
  if (theirs && here.keyFingerprint && theirs === here.keyFingerprint) {
    lines.push({ key: "key", tone: "success", label: "Same key", text: "Made with this server's PLATFORM_MASTER_KEY." });
  } else if (!theirs && !here.keyFingerprint) {
    lines.push({ key: "key", tone: "neutral", label: "No key", text: "No PLATFORM_MASTER_KEY was set where it was made, nor here." });
  } else if (!here.keyFingerprint) {
    lines.push({ key: "key", tone: "danger", label: "No key here", text: "This server has no PLATFORM_MASTER_KEY — set the one it was made with on this server before restoring." });
  } else if (!theirs) {
    lines.push({ key: "key", tone: "danger", label: "Different key", text: "Made where no PLATFORM_MASTER_KEY was set — this server's key can't open what it holds." });
  } else {
    lines.push({ key: "key", tone: "danger", label: "Different key", text: "Made with a different PLATFORM_MASTER_KEY — set that key on this server before restoring." });
  }

  if (header.kind === "full") {
    const age = schemaAge(header.control?.schemaVersion ?? null, here.controlMigrations);
    const w = SCHEMA_WORDS[age];
    lines.push({ key: "control", tone: w.tone, label: `Control plane: ${w.label.toLowerCase()}`, text: w.text("The control plane") });
  }

  for (const ws of header.workspaces) {
    const age = schemaAge(ws.schemaVersion, here.workspaceMigrations);
    const w = SCHEMA_WORDS[age];
    const there = here.workspaces[ws.id];
    const where = there
      ? there.status === "DEPROVISIONED"
        ? ` It was here as ${there.slug} (the same id), and is closed.`
        : ` It is on this server as ${there.slug} (the same id) — a restore would replace it.`
      : " It is not on this server — a restore would add it.";
    lines.push({ key: `ws:${ws.id}`, tone: w.tone === "success" ? (there ? "info" : "success") : w.tone, label: `${ws.slug}: ${w.label.toLowerCase()}${there ? ", here" : ", not here"}`, text: `${w.text(ws.slug)}${where}` });
  }

  const v = header.app.version;
  if (v && here.appVersion) {
    const c = versionCompare(v, here.appVersion);
    lines.push(
      c === 0
        ? { key: "app", tone: "success", label: "Same version", text: `Made by version ${v}, as this server runs.` }
        : c < 0
          ? { key: "app", tone: "neutral", label: "Older version", text: `Made by version ${v}; this server runs ${here.appVersion}.` }
          : { key: "app", tone: "warning", label: "Newer version", text: `Made by version ${v}, newer than this server's ${here.appVersion}.` },
    );
  } else {
    lines.push({ key: "app", tone: "neutral", label: "Version unknown", text: `Made by version ${v ?? "unknown"}; this server runs ${here.appVersion ?? "an unknown version"}.` });
  }

  const verdict = lines.some((l) => l.tone === "danger") ? "blocked" : lines.some((l) => l.tone === "warning") ? "warning" : "ok";
  return { verdict, lines };
}

/** A sha256 shortened for a table: the first 12 characters. */
export const shortSha = (sha: string | null) => (sha ? sha.slice(0, 12) : "—");
