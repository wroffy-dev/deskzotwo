import { contentDisposition } from "@/lib/content-disposition";
import { bytesOf, StoredFileMissing } from "@/lib/storage/files";
import { currentUser, viewAsContext } from "@/lib/session";
import { moduleAccessFor } from "@/lib/modules-access";
import { opensInBrowser } from "@/lib/chat/rules";
import { requestFile, viewerOf } from "@/lib/desks/server";

/**
 * A file on a help desk request (src/lib/desks), to whoever may see the request and nobody else — a note's file to the
 * desk alone — checked on every fetch. Pictures, PDFs and text open in the browser; `?download=1`, or anything else, is
 * saved. Never while viewing as somebody.
 */
export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user || (await viewAsContext()) || (await moduleAccessFor(user.id, "desks")) !== "available") return notFound();
  const viewer = await viewerOf(user.id);
  const file = viewer ? await requestFile(viewer, (await context.params).id) : null;
  if (!file) return notFound();

  let bytes: Buffer;
  try {
    bytes = await bytesOf(file.data);
  } catch (err) {
    if (err instanceof StoredFileMissing) return notFound();
    throw err;
  }
  const inline = new URL(request.url).searchParams.get("download") !== "1" && opensInBrowser(file.mimeType);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": inline ? file.mimeType : "application/octet-stream",
      "content-disposition": contentDisposition(inline ? "inline" : "attachment", file.fileName),
      "x-content-type-options": "nosniff",
      ...(file.mimeType === "application/pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
      "cache-control": "private, no-store",
    },
  });
}
