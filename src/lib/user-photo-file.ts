import { storedFile, StoredFileMissing } from "@/lib/storage/files";

/**
 * A profile photo's bytes, for the routes that serve it as an image (/api/users/[id]/photo, a public card's photo and
 * vCard, an email signature's photo). The row keeps a data URL, or — with the storage box set up — a reference to the
 * file in the box (src/lib/storage/files.ts). Null for no photo, and for one the box no longer has: the route answers
 * 404 and the page draws initials, as for somebody with no photo.
 */
export async function userPhotoBytes(value: string | null | undefined): Promise<Buffer | null> {
  if (!value) return null;
  try {
    return (await storedFile(value, "application/octet-stream"))?.bytes ?? null;
  } catch (err) {
    if (err instanceof StoredFileMissing) return null;
    throw err;
  }
}
