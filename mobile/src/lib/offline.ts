import { useEffect, useState } from "react";
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { KEPT_FOR_MS, decodeCopy, encodeCopy, keepsPath, type Kept } from "@/lib/offline-rules";

/**
 * The phone's last copies, in the app's private files (owner, 6 Nov 2026 — offline-rules.ts says which). Each is named
 * by a hash of this sign-in and its address, so one person's never answers for another's, and all go on sign-out. A
 * failure here never gets in the way: offline just shows what it would have without a copy.
 */

const folder = () => new Directory(Paths.document, "offline");
const nameOf = (token: string, host: string | null, path: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${token}|${host ?? ""}|${path}`);

export async function saveCopy(token: string | null | undefined, host: string | null, path: string, data: unknown, page: unknown): Promise<void> {
  if (!token || !keepsPath(path)) return;
  try {
    const dir = folder();
    if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
    const file = new File(dir, `${await nameOf(token, host, path)}.json`);
    if (file.exists) file.delete();
    file.create();
    file.write(encodeCopy(data, page, Date.now()));
  } catch {
    // A full phone, a locked file: there's just no copy.
  }
}

export async function readCopy(token: string | null | undefined, host: string | null, path: string): Promise<Kept | null> {
  if (!token || !keepsPath(path)) return null;
  try {
    const file = new File(folder(), `${await nameOf(token, host, path)}.json`);
    if (!file.exists) return null;
    return decodeCopy(await file.text(), Date.now());
  } catch {
    return null;
  }
}

/** Every copy gone: signing out, or told this phone is signed out. */
export function wipeCopies(): void {
  try {
    const dir = folder();
    if (dir.exists) dir.delete();
  } catch {
    // Nothing more to do; they expire by themselves.
  }
  shownCopyFrom(null);
}

/** Copies past their three days gone, when the app opens. */
export function purgeOldCopies(): void {
  try {
    const dir = folder();
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      if (entry instanceof File && (entry.modificationTime ?? 0) < Date.now() - KEPT_FOR_MS) entry.delete();
    }
  } catch {
    // They still can't be shown: decodeCopy says so.
  }
}

// ─── Saying so ────────────────────────────────────────────────────────────────

let shown: number | null = null;
const listeners = new Set<(savedAt: number | null) => void>();

/** A kept copy was just shown, from this moment — or, null, the server answered. */
export function shownCopyFrom(savedAt: number | null): void {
  if (shown === savedAt) return;
  shown = savedAt;
  listeners.forEach((l) => l(savedAt));
}

/** When the copy on screen was saved, or null while the app is reaching Deskzo. */
export function useOfflineCopy(): number | null {
  const [savedAt, setSavedAt] = useState(shown);
  useEffect(() => {
    listeners.add(setSavedAt);
    setSavedAt(shown);
    return () => void listeners.delete(setSavedAt);
  }, []);
  return savedAt;
}
