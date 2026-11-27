"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, ShieldCheck } from "lucide-react";
import type { FaceDetector, ImageSegmenter } from "@mediapipe/tasks-vision";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  BACKDROPS,
  MAX_BYTES,
  OUTPUT_SIDE,
  QUALITIES,
  adjust,
  centredSquare,
  cropPlacement,
  dataUrlBytes,
  fitWithin,
  headAndShoulders,
  levels,
  lightGamma,
  tint,
} from "@/lib/photo-tidy/geometry";

/**
 * "Tidy my photo" (owner, 31 Oct 2026): a phone photo turned into a head-and-shoulders profile
 * photo — the person cut out, a plain or brand-coloured backdrop behind them, the light evened out.
 * It is their own photo, tidied; no face is generated.
 *
 * Everything runs here, in the browser, with MediaPipe's selfie segmenter and face detector
 * (Apache-2.0): the photo is never uploaded to be processed, so no AI service sees a face and no
 * credits are charged. Only the finished square leaves the device, when the person presses "Use
 * this photo", through the ordinary profile-photo action. The models load from this server
 * (public/models/photo, /api/vendor/mediapipe) — nothing from a CDN.
 *
 * Offered for your own photo only (owner's rule: an admin tidies a colleague's photo only with their
 * say-so, and the simplest honest form of that is that they do it themselves).
 */

const MEDIAPIPE_VERSION = "1.2.0";

type Tools = { faces: FaceDetector; segmenter: ImageSegmenter };

/** Loaded once per page: the WebAssembly is ~15 MB, cached by the browser after the first time. */
let toolsPromise: Promise<Tools> | null = null;

function loadTools(): Promise<Tools> {
  toolsPromise ??= (async () => {
    const { FaceDetector, ImageSegmenter } = await import("@mediapipe/tasks-vision");
    const fileset = {
      wasmLoaderPath: `/api/vendor/mediapipe/vision_wasm_internal.js?v=${MEDIAPIPE_VERSION}`,
      wasmBinaryPath: `/api/vendor/mediapipe/vision_wasm_internal.wasm?v=${MEDIAPIPE_VERSION}`,
    };
    const [faces, segmenter] = await Promise.all([
      FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "/models/photo/blaze_face_short_range.tflite", delegate: "CPU" },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.5,
      }),
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "/models/photo/selfie_segmenter.tflite", delegate: "CPU" },
        runningMode: "IMAGE",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }),
    ]);
    return { faces, segmenter };
  })().catch((err) => {
    toolsPromise = null;
    throw err;
  });
  return toolsPromise;
}

function canvas(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function context(c: HTMLCanvasElement) {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser can't edit images.");
  return ctx;
}

/**
 * A soft blur without `ctx.filter` (Safari draws it unfiltered): shrink, then stretch back with
 * smoothing on. `factor` is how far down it goes.
 */
function softened(source: HTMLCanvasElement, factor: number): HTMLCanvasElement {
  const small = canvas(Math.max(1, Math.round(source.width / factor)), Math.max(1, Math.round(source.height / factor)));
  const sctx = context(small);
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(source, 0, 0, small.width, small.height);
  const back = canvas(source.width, source.height);
  const bctx = context(back);
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(small, 0, 0, back.width, back.height);
  return back;
}

/** The cut, worked out once per photo — changing the backdrop or the light fix only re-draws. */
type Cut = { crop: HTMLCanvasElement; mask: HTMLCanvasElement; faceFound: boolean };

export async function cutOut(file: File): Promise<Cut> {
  const bitmap = await createImageBitmap(file);
  const size = fitWithin(bitmap.width, bitmap.height);
  const work = canvas(size.width, size.height);
  context(work).drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();

  const { faces, segmenter } = await loadTools();
  const found = faces.detect(work).detections.map((d) => d.boundingBox).filter((b) => !!b);
  // The biggest face is the person the photo is of; anyone behind them is smaller.
  const face = found.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const box = face
    ? headAndShoulders({ x: face.originX, y: face.originY, width: face.width, height: face.height }, size.width, size.height)
    : centredSquare(size.width, size.height);

  const crop = canvas(OUTPUT_SIDE, OUTPUT_SIDE);
  const cctx = context(crop);
  cctx.imageSmoothingQuality = "high";
  // A head near the photo's top edge: the square reaches above it, and that strip is the photo's own top rows
  // stretched up — a wall or sky carries on, and with a cut-out the backdrop shows there anyway.
  const { source, dest, band } = cropPlacement(box, OUTPUT_SIDE);
  if (band) cctx.drawImage(work, source.x, source.y, source.width, Math.max(1, source.height * 0.01), band.x, band.y, band.width, band.height);
  cctx.drawImage(work, source.x, source.y, source.width, source.height, dest.x, dest.y, dest.width, dest.height);

  const result = segmenter.segment(crop);
  const confidence = result.confidenceMasks?.[0];
  if (!confidence) {
    result.close();
    throw new Error("Couldn't find a person in that photo.");
  }
  const values = confidence.getAsFloat32Array();
  const raw = canvas(confidence.width, confidence.height);
  const rctx = context(raw);
  const pixels = rctx.createImageData(raw.width, raw.height);
  for (let i = 0; i < values.length; i++) {
    // A gentle S-curve: hair and shoulders keep their soft edge, the background's faint guesses go.
    const v = Math.min(1, Math.max(0, (values[i]! - 0.2) / 0.6));
    pixels.data[i * 4 + 3] = Math.round(v * v * (3 - 2 * v) * 255);
  }
  rctx.putImageData(pixels, 0, 0);
  result.close();

  const mask = canvas(OUTPUT_SIDE, OUTPUT_SIDE);
  const mctx = context(mask);
  mctx.imageSmoothingQuality = "high";
  mctx.drawImage(raw, 0, 0, OUTPUT_SIDE, OUTPUT_SIDE);
  return { crop, mask: softened(mask, 2), faceFound: !!face };
}

/** The crop with the light fix, worked out over the person's pixels only — a bright window behind them doesn't count. */
function lit(cut: Cut): HTMLCanvasElement {
  const out = canvas(OUTPUT_SIDE, OUTPUT_SIDE);
  const octx = context(out);
  const image = context(cut.crop).getImageData(0, 0, OUTPUT_SIDE, OUTPUT_SIDE);
  const alpha = context(cut.mask).getImageData(0, 0, OUTPUT_SIDE, OUTPUT_SIDE).data;
  const histogram = new Uint32Array(256);
  let total = 0;
  let sum = 0;
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    if (alpha[i + 3]! < 128) continue;
    const y = Math.round(0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!);
    histogram[y]!++;
    sum += y;
    total++;
  }
  if (total < 500) {
    octx.drawImage(cut.crop, 0, 0);
    return out;
  }
  const { low, high } = levels(histogram, total);
  const stretchedMean = Math.min(1, Math.max(0, (sum / total - low) / (high - low)));
  const gamma = lightGamma(stretchedMean);
  const table = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) table[v] = adjust(v, low, high, gamma);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = table[d[i]!]!;
    d[i + 1] = table[d[i + 1]!]!;
    d[i + 2] = table[d[i + 2]!]!;
  }
  octx.putImageData(image, 0, 0);
  return out;
}

function brandColour(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--brand").trim() || "#4f46e5";
}

export function compose(cut: Cut, backdrop: string, lightFix: boolean): string {
  const person = lightFix ? lit(cut) : cut.crop;
  const out = canvas(OUTPUT_SIDE, OUTPUT_SIDE);
  const ctx = context(out);
  const S = OUTPUT_SIDE;

  if (backdrop === "original") {
    ctx.drawImage(person, 0, 0);
  } else {
    if (backdrop === "white") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, S, S);
    } else if (backdrop === "grey") {
      ctx.fillStyle = "#e7e9ee";
      ctx.fillRect(0, 0, S, S);
    } else if (backdrop === "studio" || backdrop === "brand") {
      const [inner, outer] = backdrop === "studio" ? ["#f6f7f9", "#c9ced6"] : [tint(brandColour(), 0.88), tint(brandColour(), 0.66)];
      const g = ctx.createRadialGradient(S / 2, S * 0.38, S * 0.08, S / 2, S * 0.45, S * 0.78);
      g.addColorStop(0, inner);
      g.addColorStop(1, outer);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    } else if (backdrop === "blur") {
      ctx.drawImage(softened(person, 24), 0, 0);
    }
    const layer = canvas(S, S);
    const lctx = context(layer);
    lctx.drawImage(person, 0, 0);
    lctx.globalCompositeOperation = "destination-in";
    lctx.drawImage(cut.mask, 0, 0);
    ctx.drawImage(layer, 0, 0);
  }

  for (const q of QUALITIES) {
    const url = out.toDataURL("image/jpeg", q);
    if (dataUrlBytes(url) <= MAX_BYTES) return url;
  }
  return out.toDataURL("image/jpeg", 0.4);
}

/** Mounted while open (the manager renders it only then), so every opening starts fresh. */
export function PhotoTidy({
  file,
  onClose,
  onUse,
}: {
  /** A photo already picked — the manager hands over one too big to save as it is. */
  file: File | null;
  onClose: () => void;
  onUse: (dataUrl: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [cut, setCut] = useState<Cut | null>(null);
  const [busy, setBusy] = useState(!!file);
  const [error, setError] = useState<string | null>(null);
  const [backdrop, setBackdrop] = useState("studio");
  const [lightFix, setLightFix] = useState(true);
  const result = useMemo(() => (cut ? compose(cut, backdrop, lightFix) : null), [cut, backdrop, lightFix]);

  function work(picked: File) {
    return cutOut(picked)
      .then(setCut)
      .catch((err) => setError(err instanceof Error && err.message ? err.message : "That photo couldn't be read."))
      .finally(() => setBusy(false));
  }

  function take(picked: File) {
    setError(null);
    setCut(null);
    if (!picked.type.startsWith("image/") || picked.type === "image/svg+xml") {
      setError("Choose a photo — a JPEG, PNG or WebP from your phone.");
      return;
    }
    setBusy(true);
    void work(picked);
  }

  // A photo handed over by the manager is worked on as soon as the dialog opens.
  useEffect(() => {
    if (file) void work(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog open onClose={onClose} title="Tidy my photo">
      <div className="space-y-4">
        <p className="flex gap-2 rounded-lg bg-surface-sunken p-3 text-xs leading-5 text-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <span>
            This runs on your device. Your photo isn&apos;t sent anywhere to be edited, and no AI service sees it —
            only the finished photo is saved, when you press <strong className="text-text">Use this photo</strong>.
          </span>
        </p>

        {!cut && !busy && (
          <div className="space-y-2">
            <p className="text-sm text-muted">
              Choose a photo of yourself — a phone photo is fine. You&apos;ll get a head-and-shoulders crop, a clean
              background and evened-out light, for your profile, your digital card and your email signature.
            </p>
            <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
              <ImagePlus className="h-4 w-4" />
              Choose a photo
            </Button>
          </div>
        )}

        {busy && (
          <p className="text-sm text-muted" aria-live="polite">
            Finding you in the photo… The first time takes a little longer while the tools load.
          </p>
        )}

        {cut && result && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={result} alt="Your tidied photo" className="h-44 w-44 rounded-xl border border-line object-cover" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={result} alt="" className="h-20 w-20 rounded-full border border-line object-cover" />
            </div>
            {!cut.faceFound && (
              <p className="text-xs text-warning">No face was found, so the photo is cropped to the middle. A clearer, front-facing photo works best.</p>
            )}
            <div>
              <p className="text-xs font-medium text-muted">Background</p>
              <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Background">
                {BACKDROPS.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    role="radio"
                    aria-checked={backdrop === b.key}
                    onClick={() => setBackdrop(b.key)}
                    className={
                      backdrop === b.key
                        ? "rounded-full border border-brand bg-brand-subtle px-3 py-1 text-xs font-medium text-brand"
                        : "rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-line-strong hover:text-text"
                    }
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-3 text-sm text-text">
              <Switch checked={lightFix} onChange={setLightFix} aria-label="Even out the light" />
              Even out the light
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => onUse(result)}>
                Use this photo
              </Button>
              <Button type="button" variant="ghost" onClick={() => fileRef.current?.click()}>
                Choose another
              </Button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) take(picked);
          e.target.value = "";
        }}
      />
    </Dialog>
  );
}
