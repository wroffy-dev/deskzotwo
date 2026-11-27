#!/usr/bin/env node
/**
 * Google Play's phone screenshots (owner, 29 Oct 2026): each real screenshot of the app, taken on the emulator
 * (`adb exec-out screencap -p`), scaled down evenly — never stretched — onto a 1080 × 1920 canvas in Deskzo blue
 * with a short heading above it. Play wants 9:16; a modern phone's screen is taller, so it sits on the canvas.
 *
 *   node scripts/store-screenshots.js <today.png> <sales.png> <calls.png>
 *
 * Writes store/graphics/screenshots/01-today.png, 02-sales.png and 03-calls.png. Uses sharp from the main
 * project's node_modules, as brand-assets.js does.
 */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require(path.join(__dirname, "..", "..", "node_modules", "sharp"));

const W = 1080;
const H = 1920;
const BLUE = "#0249FE";
const SHOTS = [
  { file: "01-today.png", heading: "Your day at a glance" },
  { file: "02-sales.png", heading: "Leads one tap away" },
  { file: "03-calls.png", heading: "Calls that log themselves" },
];
/** Where the phone's screen goes: below the heading, as tall as leaves a margin at the bottom. */
const TOP = 290;
const BOTTOM = 90;
const RADIUS = 44;

async function compose(source, heading, out) {
  const meta = await sharp(source).metadata();
  const height = H - TOP - BOTTOM;
  const width = Math.round((meta.width * height) / meta.height);
  const screen = await sharp(source).resize(width, height, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
  // Rounded like the phone it came from.
  const mask = Buffer.from(`<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${RADIUS}" ry="${RADIUS}"/></svg>`);
  const rounded = await sharp(screen).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  const left = Math.round((W - width) / 2);
  const shadow = Buffer.from(
    `<svg width="${W}" height="${H}"><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter></defs>` +
      `<rect x="${left}" y="${TOP + 18}" width="${width}" height="${height}" rx="${RADIUS}" fill="#001A66" opacity="0.45" filter="url(#s)"/></svg>`,
  );
  const title = Buffer.from(
    `<svg width="${W}" height="${TOP}"><text x="${W / 2}" y="${TOP / 2 + 30}" text-anchor="middle" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="76" font-weight="700" fill="#FFFFFF">${heading}</text></svg>`,
  );
  await sharp({ create: { width: W, height: H, channels: 3, background: BLUE } })
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: title, left: 0, top: 0 },
      { input: rounded, left, top: TOP },
    ])
    .png({ compressionLevel: 9 })
    .toFile(out);
}

async function main() {
  const sources = process.argv.slice(2);
  if (sources.length !== SHOTS.length) {
    console.error(`Give the ${SHOTS.length} screenshots, in order: today, sales, calls.`);
    process.exit(1);
  }
  const dir = path.join(__dirname, "..", "store", "graphics", "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  for (const [i, shot] of SHOTS.entries()) {
    const out = path.join(dir, shot.file);
    await compose(sources[i], shot.heading, out);
    const meta = await sharp(out).metadata();
    console.log(`${shot.file}: ${meta.width} × ${meta.height}, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
