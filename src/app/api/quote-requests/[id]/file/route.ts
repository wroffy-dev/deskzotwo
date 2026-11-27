import { NextResponse } from "next/server";
import { contentDisposition } from "@/lib/content-disposition";
import { currentUser } from "@/lib/session";
import { requestFile } from "@/lib/quote-requests";

/**
 * The file a reseller attached to a quote request (src/lib/quote-requests.ts), for somebody who may work it — asked on
 * every fetch. Anything else is not found, as an id that never existed.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });
  const { id } = await context.params;
  const file = await requestFile(user.id, id);
  if (!file) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType || "application/octet-stream",
      "Content-Disposition": contentDisposition("inline", file.name),
      "Cache-Control": "private, no-store",
      // What it says it is, and — a PDF apart — unable to run anything in the app's name: it came from outside.
      "X-Content-Type-Options": "nosniff",
      ...(file.contentType === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
    },
  });
}
