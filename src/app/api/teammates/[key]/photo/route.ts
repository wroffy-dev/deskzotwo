import { teammatePhoto } from "@/lib/ai/teammates-server";

/**
 * An AI teammate's photo (src/lib/ai/teammates.ts), as the workspace saved it — so pages carry only this address. The
 * address changes with every new photo (?v=), so it is cached for a day; a sandboxed picture, never a page.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const photo = await teammatePhoto(key);
  if (!photo) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(photo.bytes), {
    headers: {
      "content-type": photo.type,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
}
