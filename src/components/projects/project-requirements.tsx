"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Paperclip, Send } from "lucide-react";
import { sendProjectQuestionnaire, withdrawProjectQuestionnaire, type projectQuestionnaires } from "@/actions/project-questionnaire";
import { getProjectDocumentFile } from "@/actions/project-document";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useClock } from "@/components/time/clock-provider";
import { ROUND_STATE_LABELS, answerText, roundState, type FileAnswer } from "@/lib/projects/questionnaire";

type Data = NonNullable<Awaited<ReturnType<typeof projectQuestionnaires>>>;

/**
 * A project's Requirements tab (owner, 16 Nov 2026): send the questionnaire to one of the customer's people, and read
 * what they answered — every round kept, the latest first.
 */
export function ProjectRequirements({ data }: { data: Data }) {
  const router = useRouter();
  const clock = useClock();
  const [contactId, setContactId] = useState(data.contacts.find((c) => c.primary)?.id ?? data.contacts[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();

  const latest = data.rounds[0] ?? null;
  const state = latest ? roundState(latest) : null;
  const open = state !== null && state !== "SUBMITTED" && state !== "CLOSED";
  const answered = state === "SUBMITTED";
  const asked = data.questions.filter((q) => q.type !== "HEADING").length;
  const when = (d: string | Date | null) => (d ? clock.dateTime(new Date(d)) : null);

  const send = (reopen: boolean) =>
    start(async () => {
      const r = await sendProjectQuestionnaire({ projectId: data.project.id, contactId, note, reopen });
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.data.reminder ? "Sent again, with a new link — the old one no longer works." : reopen ? "Reopened and sent." : "Questionnaire sent.");
      setNote("");
      router.refresh();
    });

  const openFile = async (f: FileAnswer) => {
    const r = await getProjectDocumentFile(f.documentId);
    if (!r.ok) return void toast.error(r.error);
    const blob = await (await fetch(r.data.fileDataUrl)).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = r.data.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {data.canSend && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">{open ? "Send it again" : answered ? "Reopen for changes" : "Send the questionnaire"}</CardHeader>
          <CardContent className="space-y-3">
            {!data.project.hasType ? (
              <p className="text-sm text-muted">Give this project a type first (Edit) — the questions come from its type.</p>
            ) : asked === 0 && !open && !answered ? (
              <p className="text-sm text-muted">This kind of project has no questions yet. Add them in Settings › Lists › Project types › Questionnaire.</p>
            ) : data.contacts.length === 0 ? (
              <p className="text-sm text-muted">Nobody at this customer has an email address. Add one on the customer first.</p>
            ) : (
              <>
                <p className="text-xs text-subtle">
                  {open
                    ? "A reminder with a new link — the old link stops working. What they've filled in so far is kept."
                    : answered
                      ? "A new round, starting from their answers, for them to change and send back. The answers you have stay on record."
                      : `${asked} question${asked === 1 ? "" : "s"} from this project's type. They can save and come back; the answers land here.`}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="rq-to">To</Label>
                    <Select id="rq-to" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                      {data.contacts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} — {c.email}
                          {c.primary ? " (primary)" : ""}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rq-note">Your note (optional)</Label>
                  <Textarea id="rq-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Replaces the standard opening line of the email. The link is added for you." />
                </div>
                <Button disabled={pending || !contactId} onClick={() => send(answered)}>
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  {pending ? "Sending…" : open ? "Send again" : answered ? "Reopen and send" : "Send questionnaire"}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {data.rounds.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted">Nothing sent yet. Once the customer answers, their answers show here.</CardContent>
        </Card>
      )}

      {data.rounds.map((r) => {
        const s = roundState(r);
        return (
          <Card key={r.id}>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-text">Round {r.round}</span>
                <Badge tone={s === "SUBMITTED" ? "green" : s === "CLOSED" ? "default" : "amber"}>{ROUND_STATE_LABELS[s]}</Badge>
                <span className="text-xs text-muted">
                  {r.contact ? `to ${r.contact}` : ""}
                  {r.sentBy ? ` · sent by ${r.sentBy}` : ""} · {when(r.sentAt)}
                  {r.submittedAt ? ` · answered ${when(r.submittedAt)}` : r.savedAt ? ` · last saved ${when(r.savedAt)}` : r.openedAt ? ` · opened ${when(r.openedAt)}` : ""}
                </span>
              </div>
              {data.canSend && (s === "SENT" || s === "OPENED" || s === "STARTED") && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const res = await withdrawProjectQuestionnaire(r.id);
                      if (!res.ok) return void toast.error(res.error);
                      router.refresh();
                    })
                  }
                >
                  Withdraw
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {Object.keys(r.answers).length === 0 ? (
                <p className="text-sm text-muted">No answers yet.</p>
              ) : (
                <dl className="space-y-2.5">
                  {r.questions.map((q) =>
                    q.type === "HEADING" ? (
                      <h3 key={q.key} className="pt-2 text-xs font-semibold uppercase tracking-wide text-subtle first:pt-0">
                        {q.label}
                      </h3>
                    ) : (
                      <div key={q.key} className="grid gap-0.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-3">
                        <dt className="text-sm text-muted">{q.label}</dt>
                        <dd className="whitespace-pre-wrap text-sm text-text">
                          {q.type === "FILE" && Array.isArray(r.answers[q.key]) && (r.answers[q.key] as FileAnswer[]).length > 0
                            ? (r.answers[q.key] as FileAnswer[]).map((f) => (
                                <button key={f.documentId} type="button" onClick={() => void openFile(f)} className="mr-3 inline-flex items-center gap-1 text-brand hover:underline">
                                  <Paperclip className="h-3.5 w-3.5" aria-hidden />
                                  {f.name}
                                </button>
                              ))
                            : answerText(q, r.answers[q.key])}
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
