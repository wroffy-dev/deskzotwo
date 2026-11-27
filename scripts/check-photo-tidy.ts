/**
 * check:photo-tidy — "Tidy my photo": a phone photo made into a head-and-shoulders profile photo on
 * the person's own device (src/components/profile/photo-tidy.tsx).
 *
 * The arithmetic by hand-worked cases (src/lib/photo-tidy/geometry.ts): the crop around a face, the
 * fallback square, the shrink before work, the light fix, the brand tint, the size the server counts.
 * Then what keeps the photo on the device: the models and the WebAssembly are served from this
 * project (no CDN address anywhere in the component), the WebAssembly route serves its two files and
 * nothing else, and the manager offers the tool for your own photo only. No database.
 *
 *   npm run check:photo-tidy
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  BACKDROPS,
  MAX_BYTES,
  adjust,
  centredSquare,
  cropPlacement,
  dataUrlBytes,
  fitWithin,
  headAndShoulders,
  levels,
  lightGamma,
  tint,
} from "../src/lib/photo-tidy/geometry";
import { GET } from "../src/app/api/vendor/mediapipe/[file]/route";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

async function main() {
  console.log("The crop");
  // A 100px face in the middle of a 1200×1600 portrait: a 260px square, the face's top 52px down.
  const crop = headAndShoulders({ x: 550, y: 500, width: 100, height: 100 }, 1200, 1600);
  check("head-and-shoulders is 2.6 face-heights a side", crop.width === 260 && crop.height === 260, crop);
  check("centred on the face across", crop.x === 470, crop);
  check("the face's top three tenths of the way down, room for the hair", crop.y === 422, crop);
  const edge = headAndShoulders({ x: 0, y: 0, width: 200, height: 200 }, 800, 600);
  check("a face at the photo's corner: kept inside across, reaching above rather than cutting the head", edge.x === 0 && edge.y === -156 && edge.width === 520, edge);
  const tight = headAndShoulders({ x: 100, y: 100, width: 300, height: 300 }, 500, 400);
  check("a face filling the frame: the square shrinks to the picture, room above added", tight.width === 400 && tight.x + tight.width <= 500 && tight.y === -20, tight);
  const placed = cropPlacement(edge, 512);
  check("  the strip above is filled, the photo drawn below it to the square's foot", placed.band?.height === 154 && placed.dest.y === 154 && placed.dest.y + placed.dest.height === 512 && placed.source.y === 0 && placed.source.height === 364, placed);
  check("  a crop inside the photo has no strip", cropPlacement(crop, 512).band === null && cropPlacement(crop, 512).dest.height === 512);
  const right = headAndShoulders({ x: 1100, y: 300, width: 100, height: 100 }, 1200, 1600);
  check("a face at the right edge is moved in, not cut", right.x + right.width === 1200, right);
  const centred = centredSquare(1200, 1600);
  check("no face: the largest square, a little above the middle", centred.width === 1200 && centred.x === 0 && centred.y === 120, centred);
  check("a landscape photo with no face: centred across", centredSquare(1600, 900).x === 350);
  check("a 48 MP photo shrinks to 1600 on its longest side", JSON.stringify(fitWithin(8000, 6000)) === JSON.stringify({ width: 1600, height: 1200 }));
  check("a small photo is never enlarged", JSON.stringify(fitWithin(400, 300)) === JSON.stringify({ width: 400, height: 300 }));

  console.log("The light fix");
  check("a well-lit photo is left alone", lightGamma(0.55) === 1 && lightGamma(0.57) === 1);
  check("a dark photo is brightened", lightGamma(0.3) > 1);
  check("a bright photo is toned down", lightGamma(0.8) < 1);
  check("a very dark photo is helped at most 1.6", lightGamma(0.02) === 1.6);
  check("a blown-out photo is toned at most 0.6", lightGamma(0.99) === 0.6);
  const flat = new Array(256).fill(0);
  for (let v = 60; v <= 190; v++) flat[v] = 10;
  const stretch = levels(flat, 1310);
  check("a flat photo's levels are stretched, gently (40 / 215)", stretch.low === 40 && stretch.high === 215, stretch);
  const narrow = new Array(256).fill(0);
  for (let v = 100; v <= 140; v++) narrow[v] = 10;
  check("a narrow range is not stretched into a poster", JSON.stringify(levels(narrow, 410)) === JSON.stringify({ low: 0, high: 255 }));
  const wide = new Array(256).fill(4);
  check("the stretch never cuts deeper than 40 / 215", levels(wide, 1024).low <= 40 && levels(wide, 1024).high >= 215);
  check("adjust: the black point goes to 0", adjust(60, 60, 190, 1) === 0);
  check("adjust: the white point goes to 255", adjust(190, 60, 190, 1) === 255);
  check("adjust: a brightening gamma lifts the middle", adjust(128, 0, 255, 1.4) > 128);

  console.log("Backgrounds and size");
  check("six backgrounds, studio among them, 'Keep mine' last", BACKDROPS.length === 6 && BACKDROPS.some((b) => b.key === "studio") && BACKDROPS.at(-1)!.key === "original");
  check("brand tint mixes towards white", tint("#000000", 0.5) === "#808080", tint("#000000", 0.5));
  check("brand tint of a brand blue is pale", tint("#0249FE") === "#d1deff", tint("#0249FE"));
  check("a malformed brand colour falls back to a pale indigo", tint("var(--x)") === "#eef2ff");
  check("data URL size counted the server's way", dataUrlBytes(`data:image/jpeg;base64,${"A".repeat(400)}`) === 300);
  const action = readFileSync(path.join(process.cwd(), "src/actions/user-photo.ts"), "utf8");
  check("the cap matches the profile-photo action's", action.includes(`const MAX_BYTES = ${MAX_BYTES / 1024} * 1024;`));

  console.log("The photo stays on the device");
  const component = readFileSync(path.join(process.cwd(), "src/components/profile/photo-tidy.tsx"), "utf8");
  check("no CDN or outside address in the component", !/https?:\/\//.test(component));
  check("no server action or fetch in the component — only the manager saves", !/from "@\/actions|fetch\(/.test(component));
  for (const model of ["blaze_face_short_range.tflite", "selfie_segmenter.tflite"]) {
    check(`model served from this project: ${model}`, component.includes(`/models/photo/${model}`) && existsSync(path.join(process.cwd(), "public/models/photo", model)));
  }
  const version = JSON.parse(readFileSync(path.join(process.cwd(), "node_modules/@mediapipe/tasks-vision/package.json"), "utf8")).version;
  check("the WebAssembly address carries the installed version", component.includes(`const MEDIAPIPE_VERSION = "${version}";`), version);
  const ask = (file: string) => GET(new Request(`http://localhost/api/vendor/mediapipe/${file}`), { params: Promise.resolve({ file }) });
  const wasm = await ask("vision_wasm_internal.wasm");
  check("the route serves the WebAssembly", wasm.status === 200 && wasm.headers.get("content-type") === "application/wasm");
  const loader = await ask("vision_wasm_internal.js");
  check("…and its loader", loader.status === 200 && loader.headers.get("content-type") === "text/javascript");
  check("…cached for good (the version is in the address)", (wasm.headers.get("cache-control") ?? "").includes("immutable"));
  for (const other of ["package.json", "..%2F..%2Fpackage.json", "../../../.env", "vision_wasm_nosimd_internal.wasm"]) {
    check(`…and nothing else: ${other}`, (await ask(other)).status === 404);
  }
  const manager = readFileSync(path.join(process.cwd(), "src/components/profile/photo-manager.tsx"), "utf8");
  check("offered for your own photo only", /\{!forUserId && tidying && \(\s*<PhotoTidy/.test(manager) && /\{!forUserId && \(\s*<Button/.test(manager));

  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
