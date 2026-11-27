"use client";

import { useId, useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { consoleCheckStorageBox, consoleRemoveStorageBox, consoleSaveStorageBox } from "@/actions/platform/console-storage";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { CheckResult } from "@/components/console/settings/offsite-settings";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { CheckStep } from "@/lib/offsite/store";

/**
 * Settings › Backups & logs › Storage box (src/actions/platform/console-storage.ts): the Azure container for every
 * workspace's files, as a form for an owner. The connection string's field starts empty and an empty one keeps what is
 * saved; it is never shown back. Check connection tries the typed settings before they are saved; Save checks again
 * and refuses a box that doesn't answer.
 */

type Checked = { label: string; steps: CheckStep[] };

export function StorageBoxEditor({ savedHere, container, inUse, canEdit, canCheck }: { savedHere: boolean; container: string | null; inUse: boolean; canEdit: boolean; canCheck: boolean }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [connection, setConnection] = useState("");
  const [name, setName] = useState(container ?? "deskzo-files");
  const [acknowledge, setAcknowledge] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [removing, setRemoving] = useState(false);
  const save = useConsoleAction<{ label: string }>();
  const check = useConsoleAction<Checked>();
  const remove = useConsoleAction<null>();
  const busy = save.pending || check.pending;
  const needsAck = /holds workspaces' files/.test(save.error ?? "") || /holds workspaces' files/.test(remove.error ?? "");

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    save.run(() => consoleSaveStorageBox({ connection, container: name, acknowledge }), {
      success: "Storage box saved. New files go there now; files already in workspaces' databases move with `npm run storage -- move --apply`.",
      onDone: () => {
        setEditing(false);
        setConnection("");
        setAcknowledge(false);
      },
    });
  }

  const checkSaved = () => {
    setChecked(null);
    check.run(() => consoleCheckStorageBox(null), { success: "", refresh: false, onDone: (data) => setChecked(data) });
  };

  if (!editing) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <Button type="button" size="sm" variant={savedHere ? "secondary" : "primary"} onClick={() => setEditing(true)}>
              {savedHere ? "Change connection…" : "Connect Azure Blob Storage…"}
            </Button>
          )}
          {canCheck && inUse && (
            <Button type="button" size="sm" variant="secondary" disabled={check.pending} onClick={checkSaved}>
              {check.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              Check connection
            </Button>
          )}
          {canEdit && savedHere && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-danger hover:bg-danger-bg hover:text-danger"
              onClick={() => {
                remove.reset();
                setAcknowledge(false);
                setRemoving(true);
              }}
            >
              Remove…
            </Button>
          )}
        </div>
        <div aria-live="polite">
          {checked && <CheckResult result={checked} />}
          <ActionNoticeRegion notice={check.error ? { tone: "error", message: check.error } : null} />
        </div>
        <ConfirmDialog
          open={removing}
          onClose={() => setRemoving(false)}
          title="Remove the storage box saved here"
          confirmLabel="Remove"
          tone="danger"
          pending={remove.pending}
          error={remove.error}
          onConfirm={() => remove.run(() => consoleRemoveStorageBox({ acknowledge }), { success: "Storage box removed from the console.", onDone: () => setRemoving(false) })}
        >
          <p>The connection string saved here is deleted. The server&apos;s own settings (STORAGE_AZURE_*) decide again — or, without them, new files stay in each workspace&apos;s database.</p>
          <p className="text-xs text-muted">Files already in the box stay there, and stop opening unless the same box is set up again.</p>
          {needsAck && (
            <label className="flex items-start gap-2 text-sm text-text">
              <input type="checkbox" className="mt-1" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />I understand workspaces&apos; existing files stop opening.
            </label>
          )}
        </ConfirmDialog>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Storage box connection">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-connection`}>Connection string</Label>
        <Input
          id={`${id}-connection`}
          type="password"
          value={connection}
          onChange={(e) => {
            setChecked(null);
            setConnection(e.target.value);
          }}
          placeholder={savedHere ? "Saved — leave empty to keep it" : "DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…;EndpointSuffix=core.windows.net"}
          autoComplete="off"
          spellCheck={false}
          readOnly={busy}
          aria-describedby={`${id}-connection-hint`}
        />
        <p id={`${id}-connection-hint`} className="text-xs text-muted">
          Azure portal › Storage account › Security + networking › Access keys › Connection string. It is sealed when saved and never shown again; the account key
          never leaves this server.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-container`}>Container</Label>
        <Input
          id={`${id}-container`}
          value={name}
          onChange={(e) => {
            setChecked(null);
            setName(e.target.value.toLowerCase());
          }}
          autoComplete="off"
          spellCheck={false}
          readOnly={busy}
          aria-describedby={`${id}-container-hint`}
        />
        <p id={`${id}-container-hint`} className="text-xs text-muted">
          Make it first in Azure (Containers › + Container) with Anonymous access set to Private. Turn on soft delete for blobs too — the database backups no
          longer hold the files themselves.
        </p>
      </div>
      {needsAck && (
        <label className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-text">
          <input type="checkbox" className="mt-1" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />I understand: the files already in the
          current box stay there, and workspaces&apos; existing documents and photos stop opening until they are copied to the new one.
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || (needsAck && !acknowledge)}>
          {save.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Check and save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setChecked(null);
            check.run(() => consoleCheckStorageBox({ connection, container: name }), { success: "", refresh: false, onDone: (data) => setChecked(data) });
          }}
        >
          {check.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Check connection
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setEditing(false);
            setConnection("");
            setChecked(null);
            setAcknowledge(false);
            save.reset();
          }}
        >
          Cancel
        </Button>
      </div>
      <div aria-live="polite">
        {checked && <CheckResult result={checked} />}
        <ActionNoticeRegion notice={check.error ? { tone: "error", message: check.error } : save.error ? { tone: "error", message: save.error } : null} />
      </div>
    </form>
  );
}
