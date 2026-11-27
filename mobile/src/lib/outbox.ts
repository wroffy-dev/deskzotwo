import { useEffect, useState } from "react";
import { AppState } from "react-native";
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { ApiError, api, newIdempotencyKey } from "@/lib/api";
import { calls } from "@/lib/native";
import { EMPTY, added, afterTry, mayWait, parseHeld, type Held, type Pending } from "@/lib/outbox-rules";

/**
 * What was done without a connection, sent when there is one (owner, 6 Nov 2026 — outbox-rules.ts says what may wait).
 * In order, one at a time, each with a key of its own so a retry after a lost answer can't make it twice. Kept in the
 * app's private files, per sign-in. One the server refuses is shown, not retried for ever.
 */

const folder = () => new Directory(Paths.document, "outbox");
let held: Held = EMPTY;
let loadedFor: string | null = null;
const listeners = new Set<(h: Held) => void>();

async function fileFor(): Promise<File | null> {
  const session = calls.getSession();
  if (!session) return null;
  const name = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${session.token}|${session.host ?? ""}`);
  return new File(folder(), `${name}.json`);
}

async function load(): Promise<void> {
  const session = calls.getSession();
  if (!session || loadedFor === session.token) return;
  loadedFor = session.token;
  try {
    const file = await fileFor();
    set(file?.exists ? parseHeld(await file.text()) : EMPTY, false);
  } catch {
    set(EMPTY, false);
  }
}

function set(next: Held, save = true): void {
  held = next;
  listeners.forEach((l) => l(held));
  if (save) void persist();
}

async function persist(): Promise<void> {
  try {
    const dir = folder();
    if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
    const file = await fileFor();
    if (!file) return;
    if (file.exists) file.delete();
    file.create();
    file.write(JSON.stringify(held));
  } catch {
    // Still held in memory, and sent while the app stays open.
  }
}

/**
 * Do it now; with no connection, and if it's safe to send later, hold it. `queued` says which, so a screen can say so
 * rather than call it done. Anything else is thrown, as `api` would.
 */
export async function sendOrHold<T>(method: "POST" | "PATCH", path: string, body: unknown, label: string): Promise<{ queued: false; data: T } | { queued: true }> {
  const key = newIdempotencyKey();
  try {
    return { queued: false, data: await api<T>(method, path, body, { idempotencyKey: key }) };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 0 || !mayWait(method, path)) throw e;
    await load();
    set(added(held, { id: key, method, path, body, label, queuedAt: Date.now() }));
    return { queued: true };
  }
}

let flushing = false;

/** Sends what's waiting, in order; stops at the first that can't get through. */
export async function flushOutbox(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    await load();
    for (const item of [...held.pending] as Pending[]) {
      let outcome: "sent" | { status: number; message: string };
      try {
        await api(item.method, item.path, item.body, { idempotencyKey: item.id });
        outcome = "sent";
      } catch (e) {
        outcome = e instanceof ApiError ? { status: e.status, message: e.message } : { status: 0, message: "" };
      }
      const next = afterTry(outcome === "sent" ? "sent" : { status: outcome.status });
      if (next === "later") return;
      set({
        pending: held.pending.filter((p) => p.id !== item.id),
        failed: next === "refused" && outcome !== "sent" ? [...held.failed, { id: item.id, label: item.label, why: outcome.message }] : held.failed,
      });
    }
  } finally {
    flushing = false;
  }
}

export function dismissFailed(id: string): void {
  set({ ...held, failed: held.failed.filter((f) => f.id !== id) });
}

/** Gone on sign-out: nothing of theirs stays, and nothing of theirs goes in somebody else's name. */
export function wipeOutbox(): void {
  try {
    const dir = folder();
    if (dir.exists) dir.delete();
  } catch {
    // Named for that sign-in: it can't be sent by another.
  }
  loadedFor = null;
  set(EMPTY, false);
}

export function heldNow(): Held {
  return held;
}

/** What's waiting, kept current. */
export function useOutbox(): Held {
  const [state, setState] = useState(held);
  useEffect(() => {
    listeners.add(setState);
    void load().then(() => setState(held));
    return () => void listeners.delete(setState);
  }, []);
  return state;
}

/** At the root: tries when the app opens and comes back to the front, and every half minute while anything waits. */
export function useOutboxSender(paired: boolean): void {
  useEffect(() => {
    if (!paired) return;
    void flushOutbox();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void flushOutbox();
    });
    const timer = setInterval(() => {
      if (held.pending.length) void flushOutbox();
    }, 30_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [paired]);
}
