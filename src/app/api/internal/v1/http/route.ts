import { runAsInternalActor } from "@/lib/internal-api/actor";
import { internalApiHost } from "@/lib/internal-api/gate";
import { plain, verifyInternalCall } from "@/lib/internal-api/verify";
import * as backupFile from "@/app/platform-console/backup-files/[id]/route";
import * as backupUploads from "@/app/platform-console/backup-uploads/route";
import * as backupUpload from "@/app/platform-console/backup-uploads/[id]/route";
import * as supportFile from "@/app/platform-console/support-files/[id]/route";

/**
 * The console's few routes that move files rather than JSON, for the admin app: a backup bundle
 * downloaded, uploaded in parts, and a support request's attachment. The admin app forwards the request
 * here, signed (the target path, method and body bytes are all covered), and gets the console's own
 * response back, streamed — headers, ranges and refusals as they always were.
 *
 *   x-deskzo-target: /backup-uploads/<id>?part=3      one of the paths below, and nothing else
 *
 * The console route runs as the admin app's staff member (src/lib/internal-api/actor.ts), so its own role
 * checks and step-up window apply. Server to server only, on the private host (src/lib/internal-api/gate.ts).
 */

export const dynamic = "force-dynamic";

const PATH = "/api/internal/v1/http";
/** One upload part (16 MB, src/lib/bundle/upload.ts) and a little room. */
const MAX_BODY = 17 * 1024 * 1024;
const PASSED_HEADERS = ["content-type", "range", "if-range", "x-bundle-name", "x-bundle-size", "x-part-sha256"];

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type RouteModule = Partial<Record<"GET" | "HEAD" | "POST" | "PUT" | "DELETE", unknown>>;
const TARGETS: { re: RegExp; mod: RouteModule }[] = [
  { re: /^\/backup-files\/([A-Za-z0-9_-]{1,100})$/, mod: backupFile },
  { re: /^\/backup-uploads$/, mod: backupUploads },
  { re: /^\/backup-uploads\/([A-Za-z0-9_-]{1,100})$/, mod: backupUpload },
  { re: /^\/support-files\/([A-Za-z0-9_-]{1,100})$/, mod: supportFile },
];

async function bridge(request: Request): Promise<Response> {
  const target = request.headers.get("x-deskzo-target") ?? "";
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return plain(413, "Too large.");
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > MAX_BODY) return plain(413, "Too large.");
  const actor = await verifyInternalCall(request, body, `${PATH} ${target}`);
  if (actor instanceof Response) return actor;

  if (!target.startsWith("/") || target.startsWith("//")) return plain(404, "Not found.");
  const url = new URL(target, "http://internal.invalid");
  const route = TARGETS.map((t) => ({ t, m: url.pathname.match(t.re) })).find((x) => x.m);
  if (!route?.m) return plain(404, "Not found.");
  const handler = route.t.mod[request.method as keyof RouteModule] as Handler | undefined;
  if (typeof handler !== "function") return plain(405, "Not allowed.");

  // The console route sees a request from its own page on this host: the admin app checked the
  // browser's origin on its side, and the signature says this came from the admin app.
  const host = internalApiHost() ?? "localhost";
  const headers = new Headers({ host, origin: `http://${host}`, "sec-fetch-site": "same-origin" });
  for (const name of PASSED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const inner = new Request(`http://${host}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(body),
  });
  return runAsInternalActor(actor, () => handler(inner, { params: Promise.resolve({ id: route.m?.[1] ?? "" }) }));
}

export const GET = bridge;
export const POST = bridge;
export const PUT = bridge;
export const DELETE = bridge;
export const HEAD = bridge;
