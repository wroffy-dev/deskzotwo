import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

/**
 * MediaPipe's WebAssembly, served from the installed package for "Tidy my photo"
 * (src/components/profile/photo-tidy.tsx) — so the browser never fetches it from a CDN, and the
 * version is always the one in package-lock. The image holds node_modules (see the Dockerfile), so
 * this reads it there rather than committing 15 MB to public/.
 *
 * Only these two files, by name: a path from the URL never reaches the file system.
 */
const FILES: Record<string, string> = {
  "vision_wasm_internal.js": "text/javascript",
  "vision_wasm_internal.wasm": "application/wasm",
};

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const type = FILES[file];
  if (!type) return new NextResponse("Not found", { status: 404 });
  const bytes = await readFile(path.join(process.cwd(), "node_modules", "@mediapipe", "tasks-vision", "wasm", file));
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      // The address carries the package version (see photo-tidy.tsx), so a new version is a new URL.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
