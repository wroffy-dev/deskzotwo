"use server";

import { isModuleEnabled } from "@/actions/module";
import { can } from "@/lib/authz/resolve";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { activityOfConversation, recentVisitors, visitorDetail } from "@/lib/inbox/activity";
import { staffStartVisitorChat, visibleConversation, type InboxViewer } from "@/lib/inbox/server";

/**
 * The Customer inbox's Visitors tab (owner, 7 Nov 2026; src/lib/inbox/activity.ts): who's on the website, their journey,
 * and starting a chat with one of them. Each asks for the inbox and for "See website activity"; which visitors
 * that reaches is `visitorReach`'s to say.
 */

const NOT_ALLOWED = "Seeing website visitors takes the Customer inbox and “See website activity”.";

async function visitorViewer(): Promise<InboxViewer | null> {
  await requireModuleAccess("inbox");
  const user = await requireModuleUser("inbox");
  if (!(await isModuleEnabled("inbox")) || !(await can(user.id, "inbox.view")) || !(await can(user.id, "website.activity"))) return null;
  return { id: user.id, viewAll: await can(user.id, "inbox.viewAll") };
}

const EMPTY = { visitors: [], total: 0, identified: 0 };

export async function inboxVisitors(filter: { knownOnly?: boolean }) {
  const viewer = await visitorViewer();
  if (!viewer) return EMPTY;
  return recentVisitors({ viewerId: viewer.id, seesEveryChat: viewer.viewAll, knownOnly: filter?.knownOnly === true, take: 60 });
}

export async function inboxVisitorDetail(visitorId: string) {
  const viewer = await visitorViewer();
  if (!viewer) return null;
  return visitorDetail({ viewerId: viewer.id, seesEveryChat: viewer.viewAll, visitorId: String(visitorId ?? "") });
}

/** The visitor behind a chat, for the panel beside it: only a chat this person may see. */
export async function inboxConversationActivity(conversationId: string) {
  const viewer = await visitorViewer();
  if (!viewer) return null;
  const c = await visibleConversation(viewer, String(conversationId ?? ""));
  return c ? activityOfConversation(c.id) : null;
}

/** Their first message to somebody on the website now. Reaches them beside their bubble within 20 seconds. */
export async function inboxStartVisitorChat(visitorId: string, text: string): Promise<{ ok: true; data: { id: string } } | { ok: false; error: string }> {
  const viewer = await visitorViewer();
  if (!viewer) return { ok: false, error: NOT_ALLOWED };
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  // Only somebody this person can see in the tab.
  const visitor = await visitorDetail({ viewerId: viewer.id, seesEveryChat: viewer.viewAll, visitorId: String(visitorId ?? "") });
  if (!visitor) return { ok: false, error: "That visitor isn't there any more." };
  return staffStartVisitorChat(viewer, visitor.id, String(text ?? ""));
}
