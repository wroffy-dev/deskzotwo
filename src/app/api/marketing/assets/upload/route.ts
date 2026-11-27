import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { db } from "@/lib/db";
import { keepBytes } from "@/lib/storage/files";
import { keepOrRefuse } from "@/lib/file-refusal";
import { ASSET_PATH } from "@/lib/marketing/html";
import { checkUploadRequest } from "@/lib/marketing/upload-request";
import { readFormWithin } from "@/lib/http/body";
import { sniffImage, UPLOAD_LIMITS } from "@/lib/marketing/template-upload";

/**
 * A picture for the email builder (owner, 1 Nov 2026): hosted straight away, so the design names it by its address
 * rather than carrying it. Checked by its bytes, made no wider than 1200 pixels, and served as a template's pictures
 * are (src/app/api/marketing/assets/[id]/[name]). For whoever may manage marketing, as every marketing upload is.
 */

export const dynamic = "force-dynamic";

const MAX_WIDTH = 1200;

export async function POST(request: Request) {
  const limit = UPLOAD_LIMITS.imageBytes * 3 + 64 * 1024;
  const gate = await checkUploadRequest(request, limit);
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });

  // Read within the same ceiling, the bytes counted as they arrive (security audit round three, 14 Nov 2026 — low;
  // SEC-27): `formData()` alone buffered whatever was sent, whatever Content-Length had said.
  let form: FormData | null;
  try {
    form = await readFormWithin(request, limit);
  } catch {
    return NextResponse.json({ ok: false, error: "That upload didn't arrive whole — try again." }, { status: 400 });
  }
  if (!form) return NextResponse.json({ ok: false, error: "That upload is too large." }, { status: 413 });
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "Choose a picture." }, { status: 400 });
  const raw = Buffer.from(await file.arrayBuffer());
  const type = sniffImage(raw);
  if (!type) return NextResponse.json({ ok: false, error: "That isn't a PNG, JPEG, GIF or WebP picture." }, { status: 400 });

  // A GIF keeps its frames as they are; anything else is made no wider than an email shows.
  let data = raw;
  let mimeType = type;
  if (type !== "image/gif") {
    try {
      const resized = sharp(raw).rotate().resize({ width: MAX_WIDTH, withoutEnlargement: true });
      data = type === "image/png" ? await resized.png({ compressionLevel: 9 }).toBuffer() : await resized.jpeg({ quality: 85 }).toBuffer();
      mimeType = type === "image/png" ? "image/png" : "image/jpeg";
    } catch {
      return NextResponse.json({ ok: false, error: "That picture couldn't be read." }, { status: 400 });
    }
  }
  if (data.length > UPLOAD_LIMITS.imageBytes) return NextResponse.json({ ok: false, error: "That picture is over 2 MB even made smaller — try a smaller one." }, { status: 413 });

  const id = `ma${randomBytes(12).toString("hex")}`;
  const fileName = `${(file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "picture")}.${mimeType === "image/png" ? "png" : mimeType === "image/gif" ? "gif" : "jpg"}`;
  // Kept in the storage box when one is set up, the row holding a reference; `size` stays the picture's own. Out of
  // storage, a 413 as for a picture too big, saying so, and no row (src/lib/file-refusal.ts).
  const stored = await keepOrRefuse(() => keepBytes("marketing-assets", data, mimeType));
  if (!stored.ok) return NextResponse.json({ ok: false, error: stored.error }, { status: 413 });
  await db.marketingAsset.create({ data: { id, fileName, mimeType, size: data.length, data: stored.value, createdById: gate.userId } });
  return NextResponse.json({ ok: true, url: `${ASSET_PATH}${id}/${encodeURIComponent(fileName)}` });
}
