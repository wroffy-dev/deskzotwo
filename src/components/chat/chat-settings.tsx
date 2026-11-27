"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { Download, Search } from "lucide-react";
import { findChatsToExport, saveChatSettings, type ExportableChat } from "@/actions/chat-admin";
import { checkChatExportIdentity } from "@/actions/chat";
import { Dialog } from "@/components/ui/dialog";
import { IdentityFields } from "@/components/security/identity-fields";
import { secretConfirmed, useSecretConfirmation } from "@/components/security/secret-confirmation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { RETENTION_CHOICES } from "@/lib/chat/rules";
import { confirmAction } from "@/components/ui/confirm";
import { Switch } from "@/components/settings/access/switch";

/** The workspace's chat rules: files, the emoji button, reactions and important messages, view-only files and how long messages are kept. */
export function ChatSettingsForm({
  initial,
}: {
  initial: {
    attachmentsAllowed: boolean;
    emojiAllowed: boolean;
    reactionsAllowed: boolean;
    importantAllowed: boolean;
    attachmentsViewOnly: boolean;
    retentionDays: number | null;
  };
}) {
  const [allowed, setAllowed] = useState(initial.attachmentsAllowed);
  const [emojiOn, setEmojiOn] = useState(initial.emojiAllowed);
  const [reactionsOn, setReactionsOn] = useState(initial.reactionsAllowed);
  const [importantOn, setImportantOn] = useState(initial.importantAllowed);
  const [viewOnly, setViewOnly] = useState(initial.attachmentsViewOnly);
  const [retention, setRetention] = useState<number | null>(initial.retentionDays);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const shortening = retention !== null && (initial.retentionDays === null || retention < initial.retentionDays);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (shortening && !(await confirmAction("Messages older than this will be deleted for everybody tonight, files and all, and can't be brought back. Go ahead?"))) return;
        start(async () => {
          const res = await saveChatSettings({
            attachmentsAllowed: allowed,
            emojiAllowed: emojiOn,
            reactionsAllowed: reactionsOn,
            importantAllowed: importantOn,
            attachmentsViewOnly: viewOnly,
            retentionDays: retention,
          });
          setMessage(res.ok ? { tone: "ok", text: "Saved." } : { tone: "error", text: res.error });
        });
      }}
    >
      <Toggle checked={allowed} onChange={setAllowed} label="Files and pictures">
        Off, chat is text only: there is no attach button, and pasted pictures are turned away — on the phone app too. Files already sent stay
        where they are.
      </Toggle>
      <Toggle checked={emojiOn} onChange={setEmojiOn} label="Emoji button">
        The smiley in the message box, for putting an emoji in a message. Off, it isn&apos;t offered — though a phone&apos;s own keyboard still has
        them.
      </Toggle>
      <Toggle checked={reactionsOn} onChange={setReactionsOn} label="Reactions">
        Reacting to a message with 👍 ❤️ 😂 and the rest. Off, nobody can react, and reactions already given are hidden — not deleted; they come
        back if this is turned on again.
      </Toggle>
      <Toggle checked={importantOn} onChange={setImportantOn} label="Important messages">
        A message starting with ! (&ldquo;!call me before 5&rdquo;) is marked Important, opens by itself for the others in the chat on whatever
        page they are, and is heard even where they muted the chat. Off, ! is just a character and the message is an ordinary one.
      </Toggle>
      <label className="flex items-start gap-2.5">
        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={viewOnly} onChange={(e) => setViewOnly(e.target.checked)} />
        <span>
          <span className="block text-sm text-text">Files are view-only</span>
          <span className="block text-xs text-muted">
            Pictures, PDFs and text open in the browser and there is no download button; other files can&apos;t be opened at all. A deterrent, like the
            copy and screenshot rules — not a guarantee.
          </span>
        </span>
      </label>
      <div className="space-y-1.5">
        <Label htmlFor="chat-retention">Keep messages</Label>
        <Select id="chat-retention" value={retention === null ? "" : String(retention)} onChange={(e) => setRetention(e.target.value ? Number(e.target.value) : null)} className="max-w-sm">
          {RETENTION_CHOICES.map((c) => (
            <option key={c.label} value={c.days === null ? "" : String(c.days)}>
              {c.label}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted">Older messages are deleted each night, with their files.</p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {message && <span className={message.tone === "ok" ? "text-sm text-success" : "text-sm text-danger"}>{message.text}</span>}
      </div>
    </form>
  );
}

/** One of chat's switches: on, the thing is offered; off, it isn't. */
function Toggle({ checked, onChange, label, children }: { checked: boolean; onChange: (on: boolean) => void; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span>
        <span className="block text-sm text-text">{label}</span>
        <span className="block text-xs text-muted">{children}</span>
      </span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

/** The super admin's search for one chat to export: names and people only. */
export function ChatExportPanel() {
  const clock = useClock();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; chats: ExportableChat[] } | null>(null);
  const [exporting, setExporting] = useState<ExportableChat | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const timer = setTimeout(() => void findChatsToExport(q).then((chats) => setResult({ query: q, chats })).catch(() => setResult({ query: q, chats: [] })), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const found = result && result.query === query.trim() && query.trim().length >= 2 ? result.chats : null;

  return (
    <div className="space-y-3">
      <label className="relative block max-w-sm">
        <span className="sr-only">Find a chat</span>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="A person's or a group's name" className="pl-8" />
      </label>
      {found && found.length === 0 && <p className="text-sm text-muted">No chats with messages match that.</p>}
      {found && found.length > 0 && (
        <ul role="list" className="divide-y divide-line rounded-base border border-line">
          {found.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text">{c.title}</span>
                <span className="block truncate text-xs text-muted">
                  {c.kind === "GROUP" ? `${c.members.length} people · ` : ""}
                  {c.messageCount} message{c.messageCount === 1 ? "" : "s"}
                  {c.lastMessageAt ? ` · last ${clock.date(c.lastMessageAt)}` : ""}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setExporting(c)}
                className="inline-flex h-8 items-center gap-1.5 rounded-base border border-line-strong px-3 text-[13px] text-text hover:bg-surface-sunken"
              >
                <Download className="h-3.5 w-3.5" /> Export
              </button>
            </li>
          ))}
        </ul>
      )}
      {exporting && <ExportDialog chat={exporting} onClose={() => setExporting(null)} />}
      {/* Where the export's answer lands — kept here, not in the dialog, so closing it doesn't cut the download off. */}
      <iframe name="chat-export-sink" title="Export" className="hidden" aria-hidden />
    </div>
  );
}

/**
 * "Is this really you?" before a chat is exported — the super admin's password and two-factor code (security audit
 * round two, 13 Nov 2026), as a backup download asks. Checked first, then the form posts to a hidden frame, so the
 * browser saves the file and a refusal can't replace the page.
 */
function ExportDialog({ chat, onClose }: { chat: ExportableChat; onClose: () => void }) {
  const confirmation = useSecretConfirmation("act");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [askCode, setAskCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const ready = secretConfirmed(confirmation, password) && !checking;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setChecking(true);
    setError(null);
    try {
      const checked = await checkChatExportIdentity({ password, code });
      if (!checked.ok) {
        if (checked.needsCode) setAskCode(true);
        setError(checked.error);
        return;
      }
      formRef.current?.submit();
      setTimeout(onClose, 0);
    } catch {
      setError("That couldn't be checked. Try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={`Export "${chat.title}"`}>
      <form ref={formRef} method="post" action={`/api/chat/export/${chat.id}`} target="chat-export-sink" onSubmit={submit} className="space-y-3">
        <p className="text-sm text-muted">This is recorded in the audit trail and the activity log. Confirm it&apos;s you first.</p>
        <input type="hidden" name="password" value={password} />
        <input type="hidden" name="code" value={code} />
        <IdentityFields idPrefix={`chat-export-${chat.id}`} confirmation={confirmation} password={password} onPassword={setPassword} code={code} onCode={setCode} showCode={askCode} />
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!ready}>
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
