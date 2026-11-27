"use server";

import { isModuleEnabled } from "@/actions/module";
import type { ActionResult } from "@/actions/company";
import { can } from "@/lib/authz/resolve";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import {
  assignConversation,
  takeOverFromBot,
  assignablePeople,
  conversationDetail,
  conversationIdFrom,
  listConversations,
  setConversationStatus,
  staffLinkCustomer,
  staffMakeLead,
  staffUnlinkCustomer,
  staffMakeTicket,
  staffReply,
  staffSendFile,
  staffTemplate,
  staffTyping,
  chimesFor,
  unreadCount,
  visitorPeek,
  type InboxDetail,
  type InboxPeek,
  type InboxRow,
  type InboxView,
  type InboxViewer,
} from "@/lib/inbox/server";
import {
  availabilityOf,
  blockCustomer,
  savedReplies,
  setAvailability,
  setConversationTags,
  staffNote,
  tagsInUse,
  touchActive,
  unblockCustomer,
  type SavedReply,
} from "@/lib/inbox/team";
import { TEAM_LIMITS } from "@/lib/inbox/team-rules";
import { db } from "@/lib/db";
import { inboxChimes, parseReminderSounds } from "@/lib/reminder-sounds";
import { TEXT_MAX, tooMany } from "@/lib/validation/text";

/**
 * The Customer inbox's screen (src/app/(dashboard)/inbox): reading and answering customer conversations,
 * taking or passing one on, closing it, and making a lead or a ticket from it. Every action asks for the
 * inbox — in the plan, switched on, and "Answer customer conversations" — and the rules about each
 * conversation are src/lib/inbox/server.ts. Changes are refused while viewing as somebody: a reply would
 * go out in their name.
 */

const NO_INBOX = "The Customer inbox isn't open to you.";
const VIEWS: readonly InboxView[] = ["mine", "unassigned", "open", "closed"];

/** The person, as the inbox sees them — or null when it isn't theirs to use. */
async function inboxViewer(): Promise<InboxViewer | null> {
  const user = await requireModuleUser("inbox");
  if (!(await isModuleEnabled("inbox")) || !(await can(user.id, "inbox.view"))) return null;
  return { id: user.id, viewAll: await can(user.id, "inbox.viewAll") };
}

/**
 * `inboxViewer` for the actions only Customer inbox's own pages use: Customer inbox open to the person as well. The actions other
 * screens use keep `inboxViewer` alone (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-6).
 */
async function inboxViewerIfOpen(...args: Parameters<typeof inboxViewer>) {
  await requireModuleAccess("inbox");
  return inboxViewer(...args);
}

/** Like `inboxViewer`, for a change: also refused while viewing as somebody. */
async function changingViewer(): Promise<InboxViewer | string> {
  const viewer = await inboxViewerIfOpen();
  if (!viewer) return NO_INBOX;
  const refused = await refuseWhileViewingAs();
  return refused ?? viewer;
}

const done = (r: { ok: true } | { ok: false; error: string }): ActionResult<null> => (r.ok ? { ok: true, data: null } : { ok: false, error: r.error });

/** They're in Deskzo now, for round-robin — not while somebody is viewing as them. */
async function here(viewer: InboxViewer) {
  if (!(await refuseWhileViewingAs())) await touchActive(viewer.id);
}

export async function inboxList(filter: { view: string; channelId?: string | null; q?: string | null; tag?: string | null }): Promise<InboxRow[]> {
  const viewer = await inboxViewerIfOpen();
  if (!viewer) return [];
  await here(viewer);
  const view = (VIEWS as readonly string[]).includes(filter?.view) ? (filter.view as InboxView) : "open";
  return listConversations(viewer, {
    view,
    channelId: typeof filter?.channelId === "string" ? filter.channelId : null,
    q: typeof filter?.q === "string" ? filter.q : null,
    tag: typeof filter?.tag === "string" ? filter.tag : null,
  });
}

/** One conversation by its id or CNV-000123 — marked read for this person. */
export async function inboxConversation(ref: string): Promise<InboxDetail | null> {
  const viewer = await inboxViewerIfOpen();
  if (!viewer || typeof ref !== "string") return null;
  const id = await conversationIdFrom(ref);
  return id ? conversationDetail(viewer, id) : null;
}

export async function inboxUnread(): Promise<number> {
  const viewer = await inboxViewer();
  if (!viewer) return 0;
  await here(viewer);
  return unreadCount(viewer);
}

/**
 * Whether a customer's new conversation should chime on this person's screen (owner, 25 Oct 2026: "sound
 * when new visitor chat"): one they may see, with "A new customer chat" on in their sounds — and never
 * while viewing as somebody.
 */
export async function inboxChime(id: string): Promise<boolean> {
  const viewer = await inboxViewer();
  if (!viewer || (await refuseWhileViewingAs())) return false;
  const sounds = await db.user
    .findUnique({ where: { id: viewer.id }, select: { reminderSounds: true } })
    .then((u) => parseReminderSounds(u?.reminderSounds))
    .catch(() => ({}));
  return inboxChimes(sounds) && (await chimesFor(viewer, String(id ?? "")));
}

export async function inboxPeople(): Promise<{ id: string; name: string }[]> {
  const viewer = await inboxViewerIfOpen();
  return viewer ? assignablePeople() : [];
}

export async function inboxReply(id: string, text: string): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return done(await staffReply(viewer, String(id ?? ""), String(text ?? "")));
}

/**
 * Whether the website visitor is typing in this conversation (and, where the channel lets the team peek,
 * what), and which colleagues have it open or are replying — and that this person has it open.
 */
export async function inboxPeek(id: string): Promise<InboxPeek> {
  const none: InboxPeek = { typing: false, text: null, others: [] };
  const viewer = await inboxViewerIfOpen();
  if (!viewer) return none;
  // Somebody viewing as a colleague isn't that colleague looking at it.
  return (await visitorPeek(viewer, String(id ?? ""), { here: !(await refuseWhileViewingAs()) })) ?? none;
}

/** "Typing…" for the customer while a reply is being written — the bubble's, and WhatsApp's own. */
export async function inboxTyping(id: string): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return done(await staffTyping(viewer, String(id ?? "")));
}

export async function inboxSendTemplate(id: string, template: { name: string; variables: string[] }): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  const variables = Array.isArray(template?.variables) ? template.variables.map((v) => String(v ?? "")) : [];
  return done(await staffTemplate(viewer, String(id ?? ""), { name: String(template?.name ?? ""), variables }));
}

export async function inboxAssign(id: string, userId: string | null): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return done(await assignConversation(viewer, String(id ?? ""), typeof userId === "string" && userId ? userId : null));
}

/** Takes a conversation over from the bot — the Team room's "Take over" (src/lib/inbox/server.ts `takeOverFromBot`). */
export async function inboxTakeOver(id: string): Promise<ActionResult<{ ref: string }>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return takeOverFromBot(viewer, String(id ?? ""));
}

export async function inboxSetStatus(id: string, status: string): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  if (status !== "OPEN" && status !== "CLOSED") return { ok: false, error: "Choose open or closed." };
  return done(await setConversationStatus(viewer, String(id ?? ""), status));
}

/** A lead from the conversation — for somebody who may open Leads. */
export async function inboxMakeLead(id: string): Promise<ActionResult<{ reference: string | null; contactOnly: boolean }>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  if (!(await isModuleEnabled("leads")) || !(await can(viewer.id, "leads.view"))) return { ok: false, error: "Leads aren't open to you." };
  const made = await staffMakeLead(viewer, String(id ?? ""));
  return made.ok ? { ok: true, data: { reference: made.reference, contactOnly: made.contactOnly } } : { ok: false, error: made.error };
}

/** Which customer on file this is, where it could be more than one. */
export async function inboxLinkCustomer(id: string, contactId: string): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return done(await staffLinkCustomer(viewer, String(id ?? ""), String(contactId ?? "")));
}

/** Not this customer after all: the link (and the lead it took) undone. */
export async function inboxUnlinkCustomer(id: string): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return done(await staffUnlinkCustomer(viewer, String(id ?? "")));
}

/** A helpdesk ticket from the conversation — for somebody who may open tickets. */
export async function inboxMakeTicket(id: string, title: string): Promise<ActionResult<{ ticketSeq: number }>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  if (!(await isModuleEnabled("helpdesk")) || !(await can(viewer.id, "tickets.create"))) return { ok: false, error: "You can't open tickets." };
  return staffMakeTicket(viewer, String(id ?? ""), String(title ?? ""));
}

// ─── The team's tools (owner, 24 Oct 2026) ───────────────────────────────────────────────────────

/** A private note to colleagues — "@Name" tells them. Never sent to the customer. */
export async function inboxNote(id: string, text: string): Promise<ActionResult<{ told: number }>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return staffNote(viewer, String(id ?? ""), String(text ?? ""));
}

export async function inboxSetTags(id: string, tags: string[]): Promise<ActionResult<{ tags: string[] }>> {
  // Security audit, 13 Nov 2026 (SEC-30 follow-up): at most 50 tags sent, each a short string — checked before anything is read.
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || t.length > TEXT_MAX.id)) return { ok: false, error: "Those tags aren't valid." };
  if (tags.length > 50) return { ok: false, error: tooMany(50, "tags") };
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return setConversationTags(viewer, String(id ?? ""), tags);
}

export async function inboxTags(): Promise<string[]> {
  const viewer = await inboxViewerIfOpen();
  return viewer ? tagsInUse(viewer) : [];
}

/** The team's saved replies, for "/" in the reply box. */
export async function inboxSavedReplies(): Promise<SavedReply[]> {
  const viewer = await inboxViewerIfOpen();
  return viewer ? savedReplies() : [];
}

/** A file to the customer: `id`, `file` and an optional `caption` in the form. */
export async function inboxSendFile(form: FormData): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  const file = form instanceof FormData ? form.get("file") : null;
  if (!(file instanceof File)) return { ok: false, error: "Choose a file first." };
  if (file.size > TEAM_LIMITS.file) return { ok: false, error: "Files can be up to 5 MB." };
  const bytes = Buffer.from(await file.arrayBuffer());
  const caption = form.get("caption");
  return done(await staffSendFile(viewer, String(form.get("id") ?? ""), { bytes, mime: file.type, name: file.name, caption: typeof caption === "string" ? caption : null }));
}

/** Their messages go nowhere after this, and the conversation closes. */
export async function inboxBlock(id: string, reason: string | null): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return done(await blockCustomer(viewer, String(id ?? ""), typeof reason === "string" ? reason : null));
}

export async function inboxUnblock(id: string): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  return done(await unblockCustomer(viewer, String(id ?? "")));
}

/** Whether this person is taking customer conversations now — round-robin passes over anybody away. */
export async function inboxAvailability(): Promise<"ONLINE" | "AWAY" | null> {
  const viewer = await inboxViewerIfOpen();
  return viewer ? availabilityOf(viewer.id) : null;
}

export async function inboxSetAvailability(status: string): Promise<ActionResult<null>> {
  const viewer = await changingViewer();
  if (typeof viewer === "string") return { ok: false, error: viewer };
  if (status !== "ONLINE" && status !== "AWAY") return { ok: false, error: "Choose available or away." };
  return done(await setAvailability(viewer.id, status));
}
