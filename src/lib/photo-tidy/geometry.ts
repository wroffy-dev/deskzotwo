/**
 * "Tidy my photo" (owner, 31 Oct 2026) — the arithmetic, kept apart from the browser so a suite can
 * run it. The photo itself never leaves the person's device: the cut-out, the crop and the light fix
 * run in their browser (src/components/profile/photo-tidy.tsx), and only the finished square is
 * saved, through the ordinary profile-photo action. No faces are generated — it is their own photo,
 * tidied.
 */

export type Box = { x: number; y: number; width: number; height: number };

/** The finished photo's side, in pixels — the card shows it at 96, a retina header at 56. */
export const OUTPUT_SIDE = 512;

/** The profile-photo action's cap (src/actions/user-photo.ts); the encoder steps quality down to fit. */
export const MAX_BYTES = 96 * 1024;

/** A picked photo is shrunk to this longest side before anything runs: a 48 MP phone photo is slow and no better. */
export const WORK_SIDE = 1600;

/**
 * The head-and-shoulders square around a detected face.
 *
 * The square is about 2.6 face-heights a side, centred on the face across, with the top of the face
 * three tenths of the way down — the detector's box starts at the forehead, so that leaves room for
 * the hair and puts the eyes a little above the middle, as a passport or LinkedIn photo has them.
 * Kept inside the picture across and below: moved first, shrunk only when the picture is smaller.
 * Above, it may reach past the photo's top edge (a negative `y`) rather than slide down and cut the
 * head (owner, 31 Oct 2026); the tidy fills that strip in (`cropPlacement`).
 */
export function headAndShoulders(face: Box, imageWidth: number, imageHeight: number): Box {
  let side = Math.max(face.width, face.height) * 2.6;
  side = Math.min(side, imageWidth, imageHeight);
  const centreX = face.x + face.width / 2;
  let x = centreX - side / 2;
  let y = face.y - side * HEADROOM;
  x = Math.min(Math.max(0, x), imageWidth - side);
  y = Math.min(y, imageHeight - side);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(side), height: Math.round(side) };
}

/** How far down the square the top of the face sits. */
export const HEADROOM = 0.3;

/**
 * Where a crop that reaches above the photo lands: the part of the photo it covers (`source`), and where that goes
 * in the output square (`dest`) — the strip above it is the photo's own top edge, stretched (`band`, null when none).
 */
export function cropPlacement(box: Box, side: number): { source: Box; dest: Box; band: Box | null } {
  const above = Math.max(0, -box.y);
  const scale = side / box.height;
  const source = { x: box.x, y: box.y + above, width: box.width, height: box.height - above };
  const top = Math.round(above * scale);
  return { source, dest: { x: 0, y: top, width: side, height: side - top }, band: top > 0 ? { x: 0, y: 0, width: side, height: top } : null };
}

/** No face found: the largest centred square, a little above the middle, where a portrait's head usually is. */
export function centredSquare(imageWidth: number, imageHeight: number): Box {
  const side = Math.min(imageWidth, imageHeight);
  const x = (imageWidth - side) / 2;
  const y = Math.max(0, Math.min(imageHeight - side, (imageHeight - side) * 0.3));
  return { x: Math.round(x), y: Math.round(y), width: side, height: side };
}

/** A picture's size after shrinking it to fit `WORK_SIDE` (never enlarged). */
export function fitWithin(width: number, height: number, longest = WORK_SIDE): { width: number; height: number } {
  const scale = Math.min(1, longest / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * The light fix: a gamma that brings the person's average brightness (0–1) towards a well-lit 0.55,
 * held between 0.6 and 1.6 so a deliberately dark or bright photo is helped, never flattened. A photo
 * already near the target is left as it is.
 */
export function lightGamma(meanLuminance: number): number {
  const mean = Math.min(0.95, Math.max(0.05, meanLuminance));
  if (Math.abs(mean - 0.55) < 0.04) return 1;
  // Applied as value^(1/gamma): a gamma above 1 lifts the middle tones.
  const gamma = Math.log(mean) / Math.log(0.55);
  return Math.min(1.6, Math.max(0.6, gamma));
}

/** The levels stretch: the darkest and brightest 1% of the person's pixels become near-black and near-white. */
export function levels(histogram: ArrayLike<number>, total: number): { low: number; high: number } {
  const cut = total * 0.01;
  let low = 0;
  let high = 255;
  for (let seen = 0; low < 255 && seen + histogram[low]! <= cut; low++) seen += histogram[low]!;
  for (let seen = 0; high > 0 && seen + histogram[high]! <= cut; high--) seen += histogram[high]!;
  // A stretch over a narrow range would posterise; skip it rather than make a poster.
  if (high - low < 64) return { low: 0, high: 255 };
  return { low: Math.min(low, 40), high: Math.max(high, 215) };
}

/** One channel value through the levels stretch and the gamma. */
export function adjust(value: number, low: number, high: number, gamma: number): number {
  const stretched = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return Math.round(Math.pow(stretched, 1 / gamma) * 255);
}

export type Backdrop = { key: string; label: string };

/** What goes behind the person. "Brand" is the workspace's own colour, read from the page. */
export const BACKDROPS: readonly Backdrop[] = [
  { key: "white", label: "White" },
  { key: "grey", label: "Light grey" },
  { key: "studio", label: "Studio" },
  { key: "brand", label: "Brand colour" },
  { key: "blur", label: "Blurred" },
  { key: "original", label: "Keep mine" },
];

/** A soft tint of a `#rrggbb` colour — the brand colour at full strength is too loud behind a face. */
export function tint(hex: string, amount = 0.82): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#eef2ff";
  const n = parseInt(m[1]!, 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const [r, g, b] = [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)];
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** The JPEG qualities tried in turn until the photo fits `MAX_BYTES`. */
export const QUALITIES = [0.9, 0.85, 0.78, 0.7, 0.6, 0.5] as const;

/** A data URL's decoded size, the way the server counts it. */
export function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.floor((base64.length * 3) / 4);
}
