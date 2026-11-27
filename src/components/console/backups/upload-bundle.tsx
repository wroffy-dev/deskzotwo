"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Meter } from "@/components/console/charts/meter";
import { useConsoleNotice } from "@/components/console/kit/notice";
import { Button } from "@/components/ui/button";
import { sizeText } from "@/lib/console-shared/backups";

/**
 * Uploading a backup to this server (src/lib/bundle/upload.ts, through admin.<domain>/backup-uploads): the file's first
 * bytes to begin — a file that isn't a backup, or doesn't fit on the disk, is refused before anything else is sent —
 * then 16 MB parts, each with its SHA-256, then "complete". A part that fails is sent again a few times before giving
 * up. The upload's id is kept in this browser, so after a dropped connection or a reload, choosing the same file
 * carries on from the part the server says comes next. Nothing secret is kept: the id, the file's name and size.
 */

const KEY = "deskzo.console.bundleUpload";
type Saved = { id: string; name: string; size: number; lastModified: number };
type Phase = "idle" | "starting" | "sending" | "finishing" | "done" | "failed";

function readSaved(): Saved | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Saved | null;
    return value && typeof value.id === "string" && typeof value.size === "number" ? value : null;
  } catch {
    return null;
  }
}
function writeSaved(value: Saved | null) {
  try {
    if (value) window.localStorage.setItem(KEY, JSON.stringify(value));
    else window.localStorage.removeItem(KEY);
  } catch {
    // Private windows: the upload still works, it just can't be carried on after a reload.
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function answer(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

class Stop extends Error {}

export function UploadBundle() {
  const router = useRouter();
  const { show } = useConsoleNotice();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [sent, setSent] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<(Saved & { received: number }) | null>(null);
  const cancelled = useRef(false);

  // An upload this browser began and didn't finish: what the server has of it.
  useEffect(() => {
    const saved = readSaved();
    if (!saved) return;
    let live = true;
    fetch(`/backup-uploads/${encodeURIComponent(saved.id)}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await answer(res);
        if (!live) return;
        if (res.ok && typeof body.received === "number") setWaiting({ ...saved, received: body.received });
        else writeSaved(null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const send = useCallback(
    async (file: File) => {
      cancelled.current = false;
      setError(null);
      setTotal(file.size);
      setSent(0);
      let saved = readSaved();
      let id: string;
      let partSize: number;
      let next: number;
      try {
        const resume = saved && saved.name === file.name && saved.size === file.size && saved.lastModified === file.lastModified;
        const status = resume ? await fetch(`/backup-uploads/${encodeURIComponent(saved!.id)}`, { cache: "no-store" }) : null;
        const statusBody = status ? await answer(status) : null;
        if (status?.ok && statusBody && typeof statusBody.partSize === "number" && typeof statusBody.nextPart === "number") {
          id = saved!.id;
          partSize = statusBody.partSize;
          next = statusBody.nextPart;
          setSent(Number(statusBody.received) || 0);
        } else {
          setPhase("starting");
          const head = await file.slice(0, Math.min(64 * 1024, file.size)).arrayBuffer();
          const res = await fetch("/backup-uploads", {
            method: "POST",
            headers: { "x-bundle-name": encodeURIComponent(file.name), "x-bundle-size": String(file.size), "content-type": "application/octet-stream" },
            body: head,
          });
          const body = await answer(res);
          if (!res.ok || typeof body.id !== "string") throw new Stop(String(body.error ?? "The server didn't take the upload."));
          id = body.id;
          partSize = Number(body.partSize);
          next = 0;
          saved = { id, name: file.name, size: file.size, lastModified: file.lastModified };
          writeSaved(saved);
        }
        setWaiting(null);
        setPhase("sending");
        const parts = Math.max(1, Math.ceil(file.size / partSize));
        for (let n = next; n < parts; n++) {
          if (cancelled.current) throw new Stop("Stopped. Choose the same file to carry on from where it got to.");
          const bytes = await file.slice(n * partSize, Math.min(file.size, (n + 1) * partSize)).arrayBuffer();
          const sha = await sha256Hex(bytes);
          let tries = 0;
          for (;;) {
            let res: Response | null = null;
            try {
              res = await fetch(`/backup-uploads/${encodeURIComponent(id)}?part=${n}`, { method: "PUT", headers: { "x-part-sha256": sha, "content-type": "application/octet-stream" }, body: bytes });
            } catch {
              res = null; // the connection dropped: tried again below
            }
            if (res?.ok) break;
            const body = res ? await answer(res) : {};
            const retry = !res || res.status >= 500 || res.status === 409 || (res.status === 400 && /did not arrive whole/.test(String(body.error ?? "")));
            tries += 1;
            if (!retry || tries >= 6) throw new Stop(String(body.error ?? "The connection keeps dropping. Choose the same file again to carry on from where it got to."));
            await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** tries)));
          }
          setSent(Math.min(file.size, (n + 1) * partSize));
        }
        setPhase("finishing");
        const done = await fetch(`/backup-uploads/${encodeURIComponent(id)}`, { method: "POST" });
        const body = await answer(done);
        if (!done.ok) throw new Stop(String(body.error ?? "The server couldn't finish the upload."));
        writeSaved(null);
        setPhase("done");
        show("success", "Backup uploaded. Verify it before restoring from it.");
        router.refresh();
      } catch (err) {
        setPhase("failed");
        setError(err instanceof Stop ? err.message : "The upload stopped. Choose the same file again to carry on from where it got to.");
      }
    },
    [router, show],
  );

  async function forget() {
    const saved = readSaved();
    writeSaved(null);
    setWaiting(null);
    if (saved) await fetch(`/backup-uploads/${encodeURIComponent(saved.id)}`, { method: "DELETE" }).catch(() => {});
  }

  const busy = phase === "starting" || phase === "sending" || phase === "finishing";
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">
        A backup file (.dzbk) made by this or another Deskzo server. It is checked as it arrives and kept here for a day; nothing is restored by uploading it.
      </p>
      {waiting && !busy && (
        <p className="rounded-base border border-info/30 bg-info-bg px-3 py-2 text-xs text-text">
          {`An upload of ${waiting.name} stopped at ${sizeText(waiting.received)} of ${sizeText(waiting.size)}. Choose the same file to carry on from there, or `}
          <button type="button" className="font-medium text-brand hover:underline" onClick={() => void forget()}>
            throw it away
          </button>
          .
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          id={inputId}
          type="file"
          accept=".dzbk"
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void send(file);
          }}
        />
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
          <Upload aria-hidden="true" className="h-4 w-4" />
          {waiting ? "Choose the file to carry on" : "Upload a backup"}
        </Button>
        {phase === "sending" && (
          <Button type="button" size="sm" variant="ghost" onClick={() => (cancelled.current = true)}>
            Stop
          </Button>
        )}
      </div>
      {busy && (
        <div className="max-w-md space-y-1">
          <Meter value={sent} max={Math.max(1, total)} label="Uploaded" tone="brand" />
          <p className="text-xs text-muted tabular-nums">
            {phase === "starting" ? "Checking the file…" : phase === "finishing" ? "Checking what arrived…" : `${sizeText(sent)} of ${sizeText(total)}`}
          </p>
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
