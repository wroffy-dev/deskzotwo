"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deskColleagueAssets, raiseDeskRequest } from "@/actions/desks";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { FilePicker } from "@/components/desks/file-picker";
import { BODY_MAX, LEVELS, LEVEL_LABELS, TITLE_MAX, type Level, type TypeApproval } from "@/lib/desks/rules";
import { cn } from "@/lib/utils";

type DeskView = { id: string; name: string; people: string[]; types: { id: string; name: string; asksAsset: boolean; approval: TypeApproval }[]; promises: Record<Level, string> };

const pick = (on: boolean) => cn("min-h-11 rounded-base border px-3.5 py-2 text-left text-sm transition-colors", on ? "border-brand bg-brand-subtle text-brand" : "border-line-strong bg-surface text-text hover:bg-surface-sunken");

/** Asking a desk (owner, 25 Nov 2026 — src/lib/desks): what it's about, what happens, how much it's holding them up. */
export function NewDeskRequestForm({ desk, assets, colleagues, approver }: { desk: DeskView; /** Who approves this person's own, when a kind needs it; null: nobody does. */ approver: string | null; assets: { id: string; label: string }[]; colleagues: { id: string; name: string; email: string }[] | null }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [typeId, setTypeId] = useState(desk.types.length === 1 ? desk.types[0]!.id : "");
  const [level, setLevel] = useState<Level>("SLOW");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [assetId, setAssetId] = useState("");
  const [forUserId, setForUserId] = useState("");
  const [theirs, setTheirs] = useState<{ id: string; label: string }[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const asksAsset = desk.types.find((t) => t.id === typeId)?.asksAsset === true;
  const options = colleagues ? theirs : assets;
  const needsApproval = desk.types.find((t) => t.id === typeId)?.approval === "MANAGER" && (!!colleagues || !!approver);

  function chooseColleague(id: string) {
    setForUserId(id);
    setAssetId("");
    setTheirs([]);
    if (id) void deskColleagueAssets(desk.id, id).then(setTheirs);
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const form = new FormData();
    form.set("deskId", desk.id);
    form.set("typeId", typeId);
    form.set("title", title);
    form.set("details", details);
    form.set("level", level);
    if (asksAsset && assetId) form.set("assetId", assetId);
    if (forUserId) form.set("forUserId", forUserId);
    for (const f of files) form.append("files", f);
    start(async () => {
      const r = await raiseDeskRequest(form);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push(r.data.href);
      router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
      <Card>
        <CardContent>
          <form onSubmit={send} className="space-y-5">
            {colleagues && (
              <div className="space-y-1.5">
                <Label htmlFor="for">For</Label>
                <SearchSelect id="for" value={forUserId} onChange={(e) => chooseColleague(e.target.value)} searchPlaceholder="Search colleagues…" required>
                  <option value="">Choose a colleague</option>
                  {colleagues.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.email}
                    </option>
                  ))}
                </SearchSelect>
              </div>
            )}
            {desk.types.length > 0 && (
              <fieldset>
                <legend className="mb-2 text-[13px] font-medium text-muted">What is it about?</legend>
                <div className="flex flex-wrap gap-2">
                  {desk.types.map((t) => (
                    <button key={t.id} type="button" aria-pressed={t.id === typeId} onClick={() => setTypeId(t.id)} className={pick(t.id === typeId)}>
                      {t.name}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            {needsApproval && (
              <p className="rounded-base bg-warning-bg px-3.5 py-2.5 text-[13px] text-warning">
                {colleagues ? "Their manager approves this first." : `${approver} approves this first.`} {desk.name} sees it once it&apos;s approved.
              </p>
            )}
            {asksAsset && options.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="asset">{colleagues ? "Which of their assets?" : "Which of your assets?"}</Label>
                <Select id="asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                  <option value="">None of these</option>
                  {options.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="title">In one line</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TITLE_MAX} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="details">What happens, and when did it start?</Label>
              <Textarea id="details" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={BODY_MAX} className="min-h-28" />
            </div>
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-muted">How much is it holding {colleagues ? "them" : "you"} up?</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {LEVELS.map((l) => (
                  <button key={l} type="button" aria-pressed={l === level} onClick={() => setLevel(l)} className={pick(l === level)}>
                    <span className="block font-medium">{LEVEL_LABELS[l]}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <FilePicker files={files} onChange={setFiles} hint="A screenshot usually saves a question." />
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              <Button type="submit" disabled={busy}>
                {busy ? "Sending…" : `Send to ${desk.name}`}
              </Button>
              <Link href="/help-desk" className="inline-flex h-9 items-center rounded-base px-3.5 text-sm font-medium text-muted hover:bg-surface-sunken hover:text-text">
                Cancel
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-4 text-[13px]">
          <div>
            <h2 className="font-semibold text-text">Who sees it</h2>
            <p className="mt-1 text-muted">
              {colleagues ? "Your colleague" : "You"}, the {desk.name} desk ({desk.people.join(", ")}) and the super admin. Nobody else, unless it needs somebody&apos;s approval: they see what you ask, not the conversation.
            </p>
          </div>
          <div>
            <h2 className="font-semibold text-text">When you hear back</h2>
            <p className="mt-1 text-muted">{needsApproval ? `Once it's approved: ${desk.promises[level].charAt(0).toLowerCase()}${desk.promises[level].slice(1)}` : desk.promises[level]}</p>
          </div>
          <div>
            <h2 className="font-semibold text-text">Where it&apos;s followed</h2>
            <p className="mt-1 text-muted">On Help desk, with a notification for every reply.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
