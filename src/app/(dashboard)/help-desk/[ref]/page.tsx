import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText, Lock } from "lucide-react";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { helpDeskViewer } from "@/components/desks/help-desk-gate";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { isModuleEnabled } from "@/actions/module";
import { DeskControls, SayBox } from "@/components/desks/request-controls";
import { AskApproval, DecideBox, DeskSteps, SendForRepair } from "@/components/desks/request-extras";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { moduleAccessFor } from "@/lib/modules-access";
import { statusLabels as assetStatusLabels } from "@/lib/assets/lifecycle";
import { fileSizeLabel } from "@/lib/chat/rules";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { formatCalendarDay } from "@/lib/time/zone";
import { deskLabel, deskPath, dueState, dueWords, formatRequestId, isClosed, requestPath, LEVEL_LABELS, LEVEL_SHORT, levelTone, statusTone, statusWords, type Level } from "@/lib/desks/rules";
import { findRequest, requestDetail } from "@/lib/desks/server";
import { workspaceClock } from "@/lib/time/workspace";

export const metadata = { title: "Help desk request" };
export const dynamic = "force-dynamic";

/** A help desk request (src/lib/desks), as its reader sees it: whoever asked, the desk, or whoever approves it. Not theirs is not there. */
export default async function Page({ params }: { params: Promise<{ ref: string }> }) {
  if (!(await isModuleEnabled("desks"))) return <ModuleDisabledNotice moduleKey="desks" />;
  const gate = await helpDeskViewer();
  if ("instead" in gate) return gate.instead;
  const { ref: segment } = await params;
  const ref = parseRecordRef(segment);
  const found = await findRequest(gate.viewer, ref.kind === "seq" ? { seq: ref.seq } : { id: ref.id });
  if (!found) notFound();
  canonicalise(segment, "/help-desk", formatRequestId(found.seq));
  const [r, clock] = await Promise.all([requestDetail(gate.viewer, found.id), workspaceClock()]);
  if (!r) notFound();
  const desk = r.side === "desk";
  const approver = r.side === "approver";
  const closed = isClosed(r.status);
  // Where the asset register is open to them, and they may move assets.
  const mayRepair = desk && !!r.asset?.withThem && r.asset.status !== "UNDER_REPAIR" && (await moduleAccessFor(gate.viewer.userId, "it_assets")) === "available" && (await can(gate.viewer.userId, "assets.manage"));
  const colleagues = desk && !closed && r.status !== "ASKED" ? await db.user.findMany({ where: { active: true, kind: "MEMBER", id: { notIn: [gate.viewer.userId, r.requester.id] } }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];
  const pending = r.approvals.find((a) => a.status === "PENDING");
  const due = dueState(r, new Date());
  const late = (due.kind === "reply" || due.kind === "fix") && due.late;
  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <Link href={desk ? deskPath(r.desk.seq) : approver ? "/approvals" : "/help-desk"} className="text-[13px] text-brand hover:underline">
          {desk ? deskLabel(r.desk.name) : approver ? "Approvals" : "Help desk"}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="text-xl font-semibold text-text">{r.title}</h1>
          <Badge tone={statusTone(r.status)}>{statusWords(r.status, desk ? "desk" : "requester")}</Badge>
          {desk && <Badge tone={levelTone(r.level)}>{LEVEL_SHORT[r.level as Level] ?? r.level}</Badge>}
          {desk && (due.kind === "reply" || due.kind === "fix") && <Badge tone={late ? "red" : "default"}>{dueWords(due, (at) => clock.dateTimeShort(at))}</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted">
          {formatRequestId(r.seq)} {desk || approver ? `from ${r.requester.name}${r.requester.department ? `, ${r.requester.department}` : ""}` : `to ${r.desk.name}`}, {clock.dateTimeShort(r.createdAt)}
          {approver && `, to ${r.desk.name}`}
          {r.raisedBy && `, raised by ${r.raisedBy}`}
        </p>
      </div>

      {desk && <DeskControls request={{ id: r.id, status: r.status, deskId: r.desk.id, deskName: r.desk.name, assignedTo: r.assignedTo }} people={r.people} desks={r.otherDesks} me={{ id: gate.viewer.userId, name: gate.viewer.name }} />}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <Card>
          <CardHeader className="text-sm font-medium text-text">{approver ? "What was asked" : "Conversation"}</CardHeader>
          <CardContent className="space-y-4">
            <Said name={nameFor(gate.viewer.userId, r.requester)} when={clock.dateTimeShort(r.createdAt)} body={r.details || r.title} files={r.files} />
            {r.messages.map((m) =>
              m.kind === "EVENT" ? (
                <p key={m.id} className="text-[13px] text-muted">
                  {m.body}, {clock.dateTimeShort(m.createdAt)}
                </p>
              ) : (
                <Said key={m.id} note={m.kind === "NOTE"} name={m.author ? nameFor(gate.viewer.userId, m.author) : "Somebody who has left"} when={clock.dateTimeShort(m.createdAt)} body={m.body} files={m.files} />
              ),
            )}
          </CardContent>
          {r.mayDecide && pending && (
            <div className="border-t border-line px-5 py-4">
              <DecideBox id={r.id} question={`${r.inPlace ? `It's with ${pending.approver}. As the super admin, you can answer in their place. ` : ""}${pending.stage === "FIRST" ? `Should ${r.requester.name} have this? ${r.desk.name} sees it once it's approved.` : `${pending.askedBy ?? r.desk.name} asked ${r.inPlace ? pending.approver : "you"} to approve: ${pending.reason}`}`} reasonSeenBy={pending.stage === "FIRST" ? `${r.requester.name} and ${r.desk.name}` : `the ${deskLabel(r.desk.name)}`} />
            </div>
          )}
          {r.side !== "approver" && <div className="border-t border-line px-5 py-4">
            <SayBox id={r.id} side={r.side} resolved={closed} waiting={r.status === "APPROVAL"} canReopen={r.canReopen} requester={r.requester.name} deskName={r.desk.name} />
          </div>}
        </Card>
        <div className="space-y-5">
        <Card>
          <CardHeader className="text-sm font-medium text-text">Details</CardHeader>
          <CardContent className="space-y-2.5 text-[13px]">
            {(desk || approver) && <Fact label="From" value={r.requester.name} />}
            <Fact label="Desk" value={r.desk.name} />
            {!approver && <Fact label="With" value={r.assignedTo?.name ?? "Not picked up yet"} />}
            {r.type && <Fact label="About" value={r.type} />}
            <Fact label={desk || approver ? "Holding them up" : "Holding you up"} value={desk || approver ? (LEVEL_SHORT[r.level as Level] ?? r.level) : (LEVEL_LABELS[r.level as Level] ?? r.level)} />
            {due.kind === "reply" && <Fact label="First reply by" value={clock.dateTimeShort(due.at)} />}
            {r.fixDueAt && (due.kind === "reply" || due.kind === "fix") && <Fact label="Put right by" value={clock.dateTimeShort(r.fixDueAt)} />}
            {due.kind === "paused" && <Fact label="Clock" value="Stopped" />}
            {r.resolvedAt && <Fact label={r.status === "REJECTED" ? "Closed" : "Resolved"} value={clock.dateTimeShort(r.resolvedAt)} />}
            {r.asset && !desk && <Fact label="Asset" value={`${r.asset.assetTag}, ${r.asset.name}`} />}
          </CardContent>
        </Card>
        {r.approvals.length > 0 && (
          <Card>
            <CardHeader className="text-sm font-medium text-text">Approval</CardHeader>
            <CardContent className="space-y-3 text-[13px]">
              {r.approvals.map((a) => (
                <div key={a.id}>
                  <p className="text-text">
                    {a.status === "PENDING" ? `Waiting for ${a.approver}` : `${a.decidedBy ?? a.approver} ${a.status === "APPROVED" ? "approved it" : "didn't approve it"}${a.decidedAt ? `, ${clock.dateTimeShort(a.decidedAt)}` : ""}`}
                  </p>
                  {a.reason && <p className="text-muted">Asked by {a.askedBy ?? "the desk"}: {a.reason}</p>}
                  {a.comment && <p className="text-muted">{a.comment}</p>}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        {desk && r.asset && (
          <Card>
            <CardHeader className="text-sm font-medium text-text">The asset</CardHeader>
            <CardContent className="space-y-2.5 text-[13px]">
              <p className="font-medium text-text">
                {r.asset.assetTag}, {r.asset.name}
              </p>
              <Fact label="Now" value={assetStatusLabels[r.asset.status as keyof typeof assetStatusLabels] ?? r.asset.status} />
              {r.asset.warrantyEndsOn && <Fact label="Warranty until" value={formatCalendarDay(r.asset.warrantyEndsOn)} />}
              {r.earlier.length > 0 && (
                <div className="border-t border-line pt-2.5">
                  <p className="text-muted">Asked about before</p>
                  <ul className="mt-1 space-y-1">
                    {r.earlier.map((e) => (
                      <li key={e.seq}>
                        <Link href={requestPath(e.seq)} className="text-brand hover:underline">
                          {formatRequestId(e.seq)}, {e.title}
                        </Link>
                        <span className="text-muted">, {clock.date(e.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {mayRepair && <SendForRepair id={r.id} assetTag={r.asset.assetTag} holder={r.requester.name} />}
            </CardContent>
          </Card>
        )}
        {desk && (
          <Card>
            <CardHeader className="text-sm font-medium text-text">Steps</CardHeader>
            <CardContent>
              <DeskSteps
                id={r.id}
                open={!closed}
                people={r.people}
                steps={r.steps.map((s) => ({ id: s.id, title: s.title, assignee: s.assignee, done: s.doneAt !== null, doneNote: s.doneAt ? `Done by ${s.doneBy ?? "the desk"}, ${clock.dateTimeShort(s.doneAt)}` : null }))}
              />
            </CardContent>
          </Card>
        )}
        {desk && !closed && r.status !== "ASKED" && (
          <Card>
            <CardHeader className="text-sm font-medium text-text">Needs money or a decision?</CardHeader>
            <CardContent>
              <AskApproval id={r.id} colleagues={colleagues} />
            </CardContent>
          </Card>
        )}
        </div>
      </div>
    </div>
  );
}

const nameFor = (viewerId: string, who: { id: string; name: string }) => (who.id === viewerId ? "You" : who.name);

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span className="text-muted">{label}</span>
      <span className="text-right text-text">{value}</span>
    </div>
  );
}

function Said({ name, when, body, files, note = false }: { name: string; when: string; body: string; files: { id: string; fileName: string; size: number }[]; note?: boolean }) {
  return (
    <div className={note ? "rounded-base bg-warning-bg px-3.5 py-3" : undefined}>
      <p className="flex flex-wrap items-center gap-x-2 text-[13px]">
        {note && <Lock aria-hidden="true" className="h-3.5 w-3.5 text-warning" />}
        <span className="font-semibold text-text">{note ? `${name}, desk only` : name}</span>
        <span className="text-muted">{when}</span>
      </p>
      {body && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text">{body}</p>}
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {files.map((f) => (
            <li key={f.id}>
              <a href={`/api/desks/files/${f.id}`} target="_blank" rel="noopener" className="flex items-center gap-1.5 rounded-base border border-line bg-surface px-2 py-1 text-xs text-brand hover:underline">
                <FileText aria-hidden="true" className="h-3.5 w-3.5" />
                <span className="max-w-52 truncate">{f.fileName}</span>
                <span className="text-muted">{fileSizeLabel(f.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
