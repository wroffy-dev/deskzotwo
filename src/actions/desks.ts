"use server";

import { revalidatePath } from "next/cache";
import { refuseWhileViewingAs } from "@/lib/session";
import { moduleAccessFor, requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { chatFileType } from "@/lib/chat/rules";
import { keepOrRefuse } from "@/lib/file-refusal";
import { keepBytes } from "@/lib/storage/files";
import { moveAsset } from "@/actions/it-asset";
import { FILE_MAX_BYTES, FILES_PER_MESSAGE, deskPath, requestPath, timesProblem } from "@/lib/desks/rules";
import {
  addNote,
  addStep,
  askApproval,
  assetsFor,
  assign,
  changeStep,
  closeOwn,
  decide,
  deleteDesk,
  DeskRefusal,
  findRequest,
  mayRaiseFor,
  moveTo,
  noteRepair,
  pickUp,
  raiseProblem,
  raiseRequest,
  replyFromDesk,
  replyFromRequester,
  requestAsset,
  saveDesk,
  setStatus,
  viewerOf,
  type DeskFile,
  type DeskInput,
  type Viewer,
} from "@/lib/desks/server";
import type { ActionResult } from "@/actions/company";

/**
 * The internal help desk (owner, 25 Nov 2026 — src/lib/desks). Anybody in the company asks a desk; who sees and works a
 * request is decided in the server part, again as it is written. Never while viewing as somebody: a colleague's requests
 * are theirs and the desk's. Setting desks up takes `settings.manage`, and shows no request.
 *
 * Requests are in no audit log, on purpose — it would tell others somebody asked. Their own events are the trail.
 */

type Who = { ok: true; v: Viewer } | { ok: false; error: string };

async function asThemselves(userId: string): Promise<Who> {
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const v = await viewerOf(userId);
  return v ? { ok: true, v } : { ok: false, error: "The help desk is for the people who work here." };
}

async function viewer(): Promise<Who> {
  return asThemselves((await requireModuleAccess("desks")).id);
}

/** The same, for a desk's own list (/desks/[seq]), whose address no menu link of the registry covers (SHARED_ACTIONS). */
async function listViewer(): Promise<Who> {
  const user = await requireModuleUser("desks");
  if ((await moduleAccessFor(user.id, "desks")) !== "available") return { ok: false, error: "The help desk isn't open to you." };
  return asThemselves(user.id);
}

function refusal<T>(err: unknown): ActionResult<T> {
  if (err instanceof DeskRefusal) return { ok: false, error: err.message };
  throw err;
}

const GONE = { ok: false as const, error: "That request isn't there." };
const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};

/** The files sent, checked and kept in the storage box; or why not. */
async function filesOf(form: FormData): Promise<{ ok: true; files: DeskFile[] } | { ok: false; error: string }> {
  const sent = form.getAll("files").filter((f): f is File => typeof f === "object" && "arrayBuffer" in f && f.size > 0);
  if (sent.length > FILES_PER_MESSAGE) return { ok: false, error: `At most ${FILES_PER_MESSAGE} files at a time.` };
  const checked: { file: File; mimeType: string }[] = [];
  for (const f of sent) {
    if (f.size > FILE_MAX_BYTES) return { ok: false, error: `"${f.name}" is more than 10 MB.` };
    const mimeType = chatFileType(f.type, f.name);
    if (!mimeType) return { ok: false, error: `"${f.name}" isn't a kind of file a request takes — pictures, PDFs, office documents, text and zip files are.` };
    checked.push({ file: f, mimeType });
  }
  const files: DeskFile[] = [];
  for (const { file, mimeType } of checked) {
    const kept = await keepOrRefuse(async () => keepBytes("desk-request-files", Buffer.from(await file.arrayBuffer()), mimeType));
    if (!kept.ok) return kept;
    files.push({ fileName: file.name.slice(0, 200), mimeType, size: file.size, data: kept.value });
  }
  return { ok: true, files };
}

function touched(seq: number) {
  revalidatePath(requestPath(seq));
  revalidatePath("/help-desk");
  revalidatePath("/desks", "layout");
}

export async function raiseDeskRequest(form: FormData): Promise<ActionResult<{ href: string }>> {
  const who = await viewer();
  if (!who.ok) return who;
  const forUserId = text(form, "forUserId") || null;
  const input = { deskId: text(form, "deskId"), typeId: text(form, "typeId") || null, title: text(form, "title"), details: text(form, "details"), level: text(form, "level"), assetId: text(form, "assetId") || null, forUserId };
  const problem = await raiseProblem(who.v, input);
  if (problem) return { ok: false, error: problem };
  const kept = await filesOf(form);
  if (!kept.ok) return kept;
  try {
    const made = await raiseRequest(who.v, { ...input, files: kept.files });
    touched(made.seq);
    // Raised for a colleague and held for approval, it isn't the desk's to see yet.
    return { ok: true, data: { href: (await findRequest(who.v, { id: made.id })) ? requestPath(made.seq) : "/help-desk" } };
  } catch (err) {
    return refusal(err);
  }
}

/** Says something on a request: a reply, or — the desk's people — a note only the desk sees. */
export async function sayOnDeskRequest(form: FormData): Promise<ActionResult<null>> {
  const who = await viewer();
  if (!who.ok) return who;
  const found = await findRequest(who.v, { id: text(form, "id") });
  if (!found) return GONE;
  const note = text(form, "kind") === "note";
  // Before any file is kept: a note is the desk's, and whoever approves it says what they have to with their answer.
  if ((note && found.side !== "desk") || found.side === "approver") return GONE;
  const kept = await filesOf(form);
  if (!kept.ok) return kept;
  const body = text(form, "body");
  try {
    if (found.side === "requester") await replyFromRequester(who.v, found.id, body, kept.files);
    else if (note) await addNote(who.v, found.id, body, kept.files);
    else await replyFromDesk(who.v, found.id, body, kept.files, text(form, "resolve") === "1");
    touched(found.seq);
    return { ok: true, data: null };
  } catch (err) {
    return refusal(err);
  }
}

/** One of the desk's people does something to a request. */
async function onDesk(who: Who, id: string, work: (v: Viewer, id: string) => Promise<void>): Promise<ActionResult<null>> {
  if (!who.ok) return who;
  const found = await findRequest(who.v, { id: String(id ?? "") });
  if (!found || found.side !== "desk") return GONE;
  try {
    await work(who.v, found.id);
    touched(found.seq);
    return { ok: true, data: null };
  } catch (err) {
    return refusal(err);
  }
}

export async function pickUpDeskRequest(id: string): Promise<ActionResult<null>> {
  return onDesk(await listViewer(), id, (v, r) => pickUp(v, r));
}

export async function assignDeskRequest(id: string, toId: string | null): Promise<ActionResult<null>> {
  return onDesk(await viewer(), id, (v, r) => assign(v, r, toId ? String(toId) : null));
}

export async function setDeskRequestStatus(id: string, status: string): Promise<ActionResult<null>> {
  return onDesk(await viewer(), id, (v, r) => setStatus(v, r, String(status ?? "")));
}

/** To another desk. `href`: where to go next — the request, or this desk's list when it isn't theirs to see any more. */
export async function moveDeskRequest(id: string, deskId: string): Promise<ActionResult<{ href: string }>> {
  const who = await viewer();
  if (!who.ok) return who;
  const found = await findRequest(who.v, { id: String(id ?? "") });
  if (!found || found.side !== "desk") return GONE;
  try {
    const { stillSees, fromSeq } = await moveTo(who.v, found.id, String(deskId ?? ""));
    touched(found.seq);
    return { ok: true, data: { href: stillSees ? requestPath(found.seq) : deskPath(fromSeq) } };
  } catch (err) {
    return refusal(err);
  }
}

/** Whoever asked says it's sorted. */
export async function closeDeskRequest(id: string): Promise<ActionResult<null>> {
  const who = await viewer();
  if (!who.ok) return who;
  const found = await findRequest(who.v, { id: String(id ?? "") });
  if (!found || found.side !== "requester") return GONE;
  try {
    await closeOwn(who.v, found.id);
    touched(found.seq);
    return { ok: true, data: null };
  } catch (err) {
    return refusal(err);
  }
}

// ─── Approval, steps and the asset (phase 2) ─────────────────────────────────────────────────────

export async function askDeskApproval(id: string, approverId: string, reason: string): Promise<ActionResult<null>> {
  return onDesk(await viewer(), id, (v, r) => askApproval(v, r, String(approverId ?? ""), String(reason ?? "")));
}

/** Approved or not, by whoever was asked — or the super admin. */
export async function decideDeskRequest(id: string, approve: boolean, comment: string): Promise<ActionResult<null>> {
  const who = await viewer();
  if (!who.ok) return who;
  const found = await findRequest(who.v, { id: String(id ?? "") });
  if (!found || found.side === "requester") return GONE;
  try {
    await decide(who.v, found.id, approve === true, String(comment ?? ""));
    touched(found.seq);
    revalidatePath("/approvals");
    return { ok: true, data: null };
  } catch (err) {
    return refusal(err);
  }
}

export async function addDeskStep(id: string, title: string, assigneeId: string | null): Promise<ActionResult<null>> {
  return onDesk(await viewer(), id, (v, r) => addStep(v, r, String(title ?? ""), assigneeId ? String(assigneeId) : null));
}

/** Ticked, opened again, or taken off (null). */
export async function changeDeskStep(stepId: string, done: boolean | null): Promise<ActionResult<null>> {
  const who = await viewer();
  if (!who.ok) return who;
  try {
    const { seq } = await changeStep(who.v, String(stepId ?? ""), done === null ? null : done === true);
    touched(seq);
    return { ok: true, data: null };
  } catch (err) {
    return refusal(err);
  }
}

/**
 * The asset a request is about, sent for repair in the asset register — as its own page sends it, with the right to move
 * assets — and said on the request. The register's record names neither the request nor what it's about.
 */
export async function sendDeskAssetForRepair(id: string, where: string): Promise<ActionResult<null>> {
  const who = await viewer();
  if (!who.ok) return who;
  const asset = await requestAsset(who.v, String(id ?? ""));
  if (!asset) return GONE;
  if ((await moduleAccessFor(who.v.userId, "it_assets")) !== "available") return { ok: false, error: "IT Assets isn't open to you." };
  if (!asset.withThem) return { ok: false, error: "It isn't with them any more. Send it from its own page in IT Assets." };
  const toLabel = String(where ?? "").trim();
  if (!toLabel) return { ok: false, error: "Say where it goes." };
  const moved = await moveAsset({ assetId: asset.assetId, type: "SENT_FOR_REPAIR", toLabel });
  if (!moved.ok) return moved;
  return onDesk(who, id, (v, r) => noteRepair(v, r, asset.assetTag));
}

/** A colleague's company assets, for whoever raises a request for them: one of a desk's people. */
export async function deskColleagueAssets(deskId: string, userId: string): Promise<{ id: string; label: string }[]> {
  const who = await viewer();
  if (!who.ok) return [];
  return (await mayRaiseFor(who.v, String(deskId ?? ""), String(userId ?? ""))) ? assetsFor(String(userId)) : [];
}

// ─── Settings › Help desk ────────────────────────────────────────────────────────────────────────

async function manager() {
  const user = await requireModuleUser("desks");
  return (await moduleAccessFor(user.id, "desks")) === "available" && (await can(user.id, "settings.manage")) ? user : null;
}
const NO_RIGHT: ActionResult<never> = { ok: false, error: "You can't set up the help desk." };

export async function saveDeskSettings(input: DeskInput): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return NO_RIGHT;
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  try {
    const saved = await saveDesk(input, timesProblem(input?.times));
    await recordAudit({ userId: user.id, action: saved.made ? "CREATE" : "UPDATE", entityType: "Desk", entityId: saved.id, entityLabel: `Help desk “${String(input.name).trim().slice(0, 60)}” ${saved.made ? "added" : "changed"}` });
    revalidatePath("/settings/help-desk");
    revalidatePath("/", "layout");
    return { ok: true, data: { id: saved.id } };
  } catch (err) {
    return refusal(err);
  }
}

export async function deleteDeskSettings(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return NO_RIGHT;
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  try {
    const name = await deleteDesk(String(id ?? ""));
    await recordAudit({ userId: user.id, action: "DELETE", entityType: "Desk", entityId: String(id), entityLabel: `Help desk “${name}” deleted` });
    revalidatePath("/settings/help-desk");
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (err) {
    return refusal(err);
  }
}
