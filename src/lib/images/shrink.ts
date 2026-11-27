/**
 * A photo shrunk in the browser before it's sent (owner, 20 Nov 2026 — reading bills and receipts, src/lib/bill-reader):
 * no longer than `maxSide` on its long side and saved again as a JPEG — smaller to send, to store, and for Deskzo AI to
 * read. A PDF, or a photo already small enough, comes back as it was; one the browser can't draw, too.
 *
 * Browser-only: it draws on a canvas.
 */
export async function shrinkPhoto(file: File, opts: { maxSide?: number; underBytes?: number; quality?: number } = {}): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const maxSide = opts.maxSide ?? 2000;
  const underBytes = opts.underBytes ?? 1.5 * 1024 * 1024;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= underBytes) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let quality = opts.quality ?? 0.85;
    let blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    // Still too big: a little more squeeze, a few times at most.
    while (blob && blob.size > underBytes && quality > 0.5) {
      quality -= 0.1;
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    }
    return blob ? new File([blob], `${file.name.replace(/\.\w+$/, "")}.jpg`, { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}
