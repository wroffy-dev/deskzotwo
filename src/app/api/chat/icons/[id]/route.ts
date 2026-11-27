import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentUser, viewAsContext } from "@/lib/session";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * A group's picture (owner, 26 Oct 2026), as an image — to the group's members (and those who've left, who can
 * still read it), nobody else. The chat list carries `?v=<updatedAt>`, so a new picture is a new address.
 * Through currentUser, so the access gate applies (security audit, Nov 2026): the bare session didn't ask whether
 * its person was switched off, the session ended, or a lock or network rule held them.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Security audit round two, 13 Nov 2026 (low, chat): and not while viewing as somebody, as the chat files route —
  // chat is private to each person, so their groups' pictures are too.
  const userId = (await currentUser())?.id;
  if (!userId || (await viewAsContext())) return new NextResponse("Not found", { status: 404 });
  const { id } = await params;
  try {
    const member = await db.chatMember.findUnique({ where: { chatId_userId: { chatId: id, userId } }, select: { id: true } });
    if (!member) return new NextResponse("Not found", { status: 404 });
    const icon = await db.chatIcon.findUnique({ where: { chatId: id }, select: { dataUrl: true, mimeType: true, updatedAt: true } });
    if (!icon) return new NextResponse("Not found", { status: 404 });
    const bytes = Buffer.from(icon.dataUrl.slice(icon.dataUrl.indexOf(",") + 1), "base64");
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": icon.mimeType,
        "Content-Length": String(bytes.length),
        // `private`: a group's picture is the company's, not a shared cache's. Immutable, as its address changes with it.
        "Cache-Control": "private, max-age=31536000, immutable",
        ETag: `"${icon.updatedAt.getTime()}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  } catch (err) {
    if (notMigratedYet(err)) return new NextResponse("Not found", { status: 404 });
    throw err;
  }
}
