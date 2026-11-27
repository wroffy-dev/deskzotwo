import sharp from "sharp";
import { Prisma, type MarketingTopic } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { sanitizeEmailHtml } from "@/lib/marketing/html";
import { designSchema, readDesign, renderDesign, type Design } from "@/lib/marketing/email-design";
import { libraryBrand } from "@/lib/marketing/library-brand";
import { storeUploadedTemplate } from "@/lib/marketing/template-store";

/**
 * A builder design saved as a template (owner, 1 Nov 2026 — src/lib/marketing/email-design.ts): its text cleaned, drawn
 * in the workspace's look, stored as an uploaded HTML template is (src/lib/marketing/template-store.ts — cleaned, its
 * merge fields checked, any picture carried in hosted), and the design kept beside it so it opens in the builder again.
 */

/** The workspace's logo as a PNG an email can carry — an SVG drawn, a big picture made small; null when there's none. */
export async function emailLogo(dataUrl: string | null): Promise<string | null> {
  const m = dataUrl ? /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl) : null;
  if (!m) return null;
  try {
    const png = await sharp(Buffer.from(m[1]!.replace(/\s+/g, ""), "base64"), { density: 300 })
      .resize({ width: 320, withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

/** The text a person wrote, cleaned as the email will be — what is kept is what is sent. */
function cleanDesign(design: Design): Design {
  return {
    ...design,
    blocks: design.blocks.map((b) => (b.type === "text" || b.type === "html" ? { ...b, html: sanitizeEmailHtml(b.html) } : b)),
  };
}

export type SaveDesignInput = { userId: string; id?: string; name: string; topic: MarketingTopic; subject: string | null; preheader: string | null; design: unknown; fileName?: string };

export async function saveDesign(input: SaveDesignInput): Promise<{ ok: true; data: { id: string; warnings: string[] } } | { ok: false; error: string }> {
  const parsed = designSchema.safeParse(input.design);
  if (!parsed.success) return { ok: false, error: `The design couldn't be read: ${(parsed.error.issues[0]?.message ?? "a block isn't right").replace(/\.$/, "")}.` };
  if (parsed.data.blocks.length === 0) return { ok: false, error: "Add a block or two first — the email is empty." };
  const design = cleanDesign(parsed.data);
  const brand = await libraryBrand();
  const html = renderDesign(design, { ...brand, logo: await emailLogo(brand.logo) }, input.name);

  const stored = await storeUploadedTemplate({
    userId: input.userId,
    id: input.id,
    name: input.name,
    topic: input.topic,
    subject: input.subject,
    preheader: input.preheader,
    fileName: input.fileName ?? "email-builder.html",
    bytes: Buffer.from(html, "utf8"),
  });
  if (!stored.ok) return stored;

  const warnings = [...stored.data.warnings];
  try {
    await db.marketingTemplate.update({ where: { id: stored.data.id }, data: { design: design as unknown as Prisma.InputJsonValue } });
  } catch (err) {
    if (!designsNotKeptYet(err)) throw err;
    warnings.push("Saved — but this workspace can't keep the design yet, so it opens as HTML until its next update.");
  }
  return { ok: true, data: { id: stored.data.id, warnings } };
}

/**
 * A database without the column, or a running server whose client was made before it (owner, 1 Nov 2026: a dev
 * server started before `prisma generate` refused the whole Templates page) — designs aren't kept yet, nothing worse.
 */
function designsNotKeptYet(err: unknown): boolean {
  return notMigratedYet(err) || (err instanceof Prisma.PrismaClientValidationError && /\bdesign\b/.test(err.message));
}

/** A template's design, when it was made in the builder — null for any other, or before the workspace keeps designs. */
export async function designOf(templateId: string): Promise<Design | null> {
  try {
    const row = await db.marketingTemplate.findUnique({ where: { id: templateId }, select: { design: true } });
    return readDesign(row?.design ?? null);
  } catch (err) {
    if (designsNotKeptYet(err)) return null;
    throw err;
  }
}

/** Which of these templates open in the builder. */
export async function designedIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  try {
    const rows = await db.marketingTemplate.findMany({ where: { id: { in: ids }, design: { not: Prisma.DbNull } }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    if (designsNotKeptYet(err)) return new Set();
    throw err;
  }
}

