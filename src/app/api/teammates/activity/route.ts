import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { teamActivityToday, teamDayStart, teamFeedFor, workOn } from "@/lib/ai/teammate-work";
import { kabirLiveFor } from "@/lib/ai/kabir-live";

/**
 * The signed-in person's AI team, live (src/lib/ai/teammate-work.ts): what is going, what just ended and the day's
 * counts (with `?feed=1`, the Team room's longer feed too) — or, with `?subject=lead:<id>`, the one job on that record,
 * for its card's live steps. A route, not a server
 * action: a card asks this while its own action (the job itself) is still out, and actions from one page run in turn.
 * Only ever that person's own rows.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const subject = new URL(request.url).searchParams.get("subject");
  if (subject) {
    if (!/^((lead|company):[a-z0-9]{1,40}|workflow:draft)$/i.test(subject)) return NextResponse.json({ ok: false }, { status: 400 });
    return NextResponse.json({ ok: true, work: await workOn(user.id, subject) }, { headers: { "cache-control": "no-store" } });
  }
  const feed = new URL(request.url).searchParams.get("feed") === "1" ? await teamFeedFor(user.id) : undefined;
  // Kabir's chats, for somebody the Customer inbox is open to — the ones their own Inbox would show (src/lib/ai/kabir-live.ts).
  const kabir = await kabirLiveFor(user.id, await teamDayStart()).catch(() => null);
  return NextResponse.json({ ok: true, ...(await teamActivityToday(user.id)), kabir, ...(feed ? { feed } : {}) }, { headers: { "cache-control": "no-store" } });
}
