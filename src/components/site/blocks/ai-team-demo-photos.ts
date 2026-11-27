import { DEFAULT_TEAMMATE_PHOTOS } from "@/lib/ai/teammate-default-photos";
import { TEAMMATES, TEAMMATE_KEYS } from "@/lib/ai/teammates";

/**
 * The demo's screens with the teammates' photos (owner, 23 Nov 2026 — "update the ai team mate demo screen also"). The
 * screens (/ai-team/screens.json, `npm run site:ai-team-screens`) were taken when every teammate was a drawn face; each
 * drawn face in them — and in the faces the steps put on the page — becomes that teammate's built-in photo
 * (src/lib/ai/teammate-default-photos.ts) as they load, so the file needn't be taken again and a new one is right too.
 * Deskzo AI keeps its mark. Pure.
 */

// A drawn face as the avatar renders it: a 40×40 SVG named for its teammate, "Ved, AI researcher".
const DRAWN = /<svg viewBox="0 0 40 40" width="(\d+)" height="(\d+)" role="img" aria-label="([^"]+)" class="overflow-hidden rounded-full">[\s\S]*?<\/svg>/g;

const BY_NAME = new Map(
  TEAMMATE_KEYS.filter((k) => k !== "deskzo").map((k) => [TEAMMATES[k].defaultName, { photo: DEFAULT_TEAMMATE_PHOTOS[k as Exclude<typeof k, "deskzo">], colour: TEAMMATES[k].colour }]),
);

/** The markup with each named teammate's drawn face as their photo; anything else is left as it was. */
export function withTeammatePhotos(html: string): string {
  return html.replace(DRAWN, (whole, width: string, height: string, label: string) => {
    const name = label.split(", AI ")[0] ?? "";
    const t = BY_NAME.get(name);
    if (!t) return whole;
    return `<img src="${t.photo}" alt="${label}" width="${width}" height="${height}" class="rounded-full object-cover" style="box-shadow:0 0 0 2px ${t.colour}">`;
  });
}

/** The whole file's worth: every screen and every face. */
export function screensWithPhotos<T extends { screens: Record<string, string>; faces: Record<string, string> }>(data: T): T {
  const map = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, withTeammatePhotos(v)]));
  return { ...data, screens: map(data.screens), faces: map(data.faces) };
}
