/**
 * People's pictures and conversation files in the storage box (src/lib/storage/files.ts).
 *
 * Each column, through its real writer and its real readers, in a scratch workspace:
 *
 *   profile photos (UserPhoto)            setProfilePhoto → /api/users/[id]/photo, the email signature's photo, a
 *                                         public card's photo and vCard, ID cards (print, design preview, the
 *                                         public check page)
 *   visitor photos (VisitorEntry)         the kiosk's checkIn → the visitor book
 *   celebration pictures (Celebration)    saveCelebration → the list HR edits, today's splash
 *   prize pictures (Prize, PrizeWinner)   savePrize → the settings tab, the showcase, the hall of fame
 *   task files (TaskAttachment)           uploadTaskFile → /api/tasks/files/[id]
 *   chat files (ChatAttachment)           sendChatMessage → /api/chat/files/[id] and the app's /api/app/chat/files/[id]
 *   inbox files (ConversationFile)        a website visitor's file and a WhatsApp customer's (kept once fetched) →
 *                                         the visitor's bubble and /api/inbox/files/[id]
 *   marketing pictures (MarketingAsset)   the builder's upload and a template's own pictures →
 *                                         /api/marketing/assets/[id]/[name] (inside emails already sent)
 *
 * With no box every row keeps the file itself, exactly as before; with one (a folder, STORAGE_DIR) every row keeps a
 * reference and every reader gives back the original; a reference the box doesn't have is a 404 or no picture, never
 * an error.
 *
 *   npm run check:storage-people
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ─── Who is calling, and the bits of Next a script doesn't have ─────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:storage-people" });
const nextHeaders = { headers: async () => requestHeaders, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
const load = Module.createRequire(__filename);
/**
 * The phone app's wrapper (src/lib/app/handler.ts) signs a paired phone in; here the route's own body runs as the
 * caller, its ApiError answered as the wrapper answers one.
 */
const appHandler = {
  appRoute: (_options: unknown, handler: (call: { actor: { userId: string }; params: Record<string, string>; req: Request }) => Promise<unknown>) =>
    async (req: Request, context?: { params: Promise<Record<string, string>> }) => {
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const { ApiError } = require("../src/lib/api/handler") as typeof import("../src/lib/api/handler");
      try {
        const out = await handler({ actor: { userId: actor!.id }, params: (await context?.params) ?? {}, req });
        return out instanceof Response ? out : Response.json(out);
      } catch (err) {
        if (err instanceof ApiError) return new Response(err.message, { status: err.status });
        throw err;
      }
    },
};
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/headers", nextHeaders],
  ["@/lib/session", session],
  ["@/lib/app/handler", appHandler],
  ["@/lib/email", { sendEmailNotification: async () => {} }],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/headers"), nextHeaders],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/app/handler"), appHandler],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

// ─── Files ───────────────────────────────────────────────────────────────────────────────────────

/** Four red pixels, a real PNG (sharp reads it, as the email builder's upload does). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8AARwgWXg4ArpMP8bh5W0YAAAAASUVORK5CYII=", "base64");
const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;
/** What a kiosk's camera sends: a JPEG, checked only by its first bytes. */
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const JPEG_URL = `data:image/jpeg;base64,${JPEG.toString("base64")}`;
/** References to files the box has never had. */
const LOST = (kind: string, type: string) => `dzblob:${kind}/2026-11/${"0".repeat(24)}|${type}`;
const LOST_BYTES = (kind: string, type: string) => new Uint8Array(Buffer.concat([Buffer.from("\u0000DZBLOB\u0000", "latin1"), Buffer.from(LOST(kind, type), "utf8")]));

const same = (a: Uint8Array | null | undefined, b: Buffer) => !!a && Buffer.from(a).equals(b);
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${new URL(url).pathname.slice(1)}_storagepeople`;
  const scratchUrl = withDatabase(url, scratch);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  const folder = await mkdtemp(path.join(os.tmpdir(), "deskzo-people-box-"));
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";
    for (const k of ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_AZURE_SAS", "STORAGE_DIR", "STORAGE_PREFIX"]) delete process.env[k];

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const files = require("../src/lib/storage/files") as typeof import("../src/lib/storage/files");
    const photoActions = require("../src/actions/user-photo") as typeof import("../src/actions/user-photo");
    const photoRoute = require("../src/app/api/users/[id]/photo/route") as typeof import("../src/app/api/users/[id]/photo/route");
    const sigPhotoRoute = require("../src/app/api/signatures/photo/[token]/route") as typeof import("../src/app/api/signatures/photo/[token]/route");
    const cardPhotoRoute = require("../src/app/(public)/c/[handle]/photo/route") as typeof import("../src/app/(public)/c/[handle]/photo/route");
    const vcardRoute = require("../src/app/(public)/c/[handle]/vcard/route") as typeof import("../src/app/(public)/c/[handle]/vcard/route");
    const { photoToken } = require("../src/lib/signatures/person") as typeof import("../src/lib/signatures/person");
    const { defaultTemplate } = require("../src/lib/cards/server") as typeof import("../src/lib/cards/server");
    const idCards = require("../src/lib/id-cards/cards") as typeof import("../src/lib/id-cards/cards");
    const visitorPublic = require("../src/actions/visitor-public") as typeof import("../src/actions/visitor-public");
    const visitors = require("../src/actions/visitor") as typeof import("../src/actions/visitor");
    const celebrations = require("../src/actions/celebration") as typeof import("../src/actions/celebration");
    const { todaysMoments } = require("../src/lib/hr/today") as typeof import("../src/lib/hr/today");
    const prizes = require("../src/actions/prizes") as typeof import("../src/actions/prizes");
    const prizeStore = require("../src/lib/wins/prize-store") as typeof import("../src/lib/wins/prize-store");
    const { prizeShowcase } = require("../src/lib/wins/prize-showcase") as typeof import("../src/lib/wins/prize-showcase");
    const tasks = require("../src/actions/task") as typeof import("../src/actions/task");
    const taskExtras = require("../src/actions/task-extras") as typeof import("../src/actions/task-extras");
    const taskFileRoute = require("../src/app/api/tasks/files/[id]/route") as typeof import("../src/app/api/tasks/files/[id]/route");
    const chat = require("../src/actions/chat") as typeof import("../src/actions/chat");
    const chatFileRoute = require("../src/app/api/chat/files/[id]/route") as typeof import("../src/app/api/chat/files/[id]/route");
    const appChatFileRoute = require("../src/app/api/app/chat/files/[id]/route") as typeof import("../src/app/api/app/chat/files/[id]/route");
    const inbox = require("../src/lib/inbox/server") as typeof import("../src/lib/inbox/server");
    const whatsapp = require("../src/lib/inbox/whatsapp") as typeof import("../src/lib/inbox/whatsapp");
    const { defaultChannelSettings } = require("../src/lib/inbox/settings") as typeof import("../src/lib/inbox/settings");
    const inboxFileRoute = require("../src/app/api/inbox/files/[id]/route") as typeof import("../src/app/api/inbox/files/[id]/route");
    const assetUpload = require("../src/app/api/marketing/assets/upload/route") as typeof import("../src/app/api/marketing/assets/upload/route");
    const assetRoute = require("../src/app/api/marketing/assets/[id]/[name]/route") as typeof import("../src/app/api/marketing/assets/[id]/[name]/route");
    const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
    const { storeUploadedTemplate } = require("../src/lib/marketing/template-store") as typeof import("../src/lib/marketing/template-store");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const person = (key: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name: `Zz ${key}`, email: `${key}@zz-storagepeople.in`, passwordHash: "!", role: "ADMIN", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("boss", { isSuperAdmin: true });
    const colleague = await person("colleague");
    const as = (u: Actor) => {
      actor = u;
    };
    as(boss);
    const viewer = { id: boss.id, viewAll: true };
    const clock = await workspaceClock();
    const visitorTokens = new Map<string, string>();
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

    // Things the columns hang off.
    const template = await defaultTemplate(boss.id);
    const card = await db.digitalCard.create({ data: { userId: boss.id, templateId: template.id, handle: "zz-boss-box" } });
    const kioskMade = await visitors.saveKiosk({ name: "Zz reception" });
    if (!kioskMade.ok) throw new Error(kioskMade.error);
    const kiosk = await db.visitorKiosk.findUniqueOrThrow({ where: { id: kioskMade.data.id }, select: { token: true } });
    const taskMade = await tasks.createTask({ title: "Zz box task" });
    if (!taskMade.ok) throw new Error(taskMade.error);
    const taskId = taskMade.data.id;
    const direct = await chat.startDirectChat(colleague.id);
    if (!direct.ok) throw new Error(direct.error);
    const webChannel = await db.inboxChannel.create({ data: { kind: "WEB", name: "Zz site", publicKey: `zzbox${Date.now()}`, settings: defaultChannelSettings("WEB") as object, createdById: boss.id } });
    await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: "Zz wa", phoneNumberId: "990000000911", settings: { ...defaultChannelSettings("WHATSAPP"), autoLead: false } as object, createdById: boss.id } });
    whatsapp.setTestWhatsAppSender(async () => ({ ok: true, id: `wamid.zzsent${Date.now()}` }));
    whatsapp.setTestWhatsAppRead(async () => true);
    const waBytes = Buffer.concat([JPEG, Buffer.from("zz-whatsapp-photo")]);
    whatsapp.setTestWhatsAppMedia(async () => ({ ok: true, bytes: waBytes, mime: "image/jpeg" }));

    /** What a column holds, as the mode expects: the file itself without a box, a reference with one. */
    const kept = (boxed: boolean, value: string | Uint8Array | null | undefined, original: string | Buffer) =>
      boxed ? files.isStoredRef(value) : typeof original === "string" ? value === original : same(value as Uint8Array, original);

    // ─── Every writer and reader, without a box and with one ────────────────────────────────────
    for (const boxed of [false, true]) {
      const mode = boxed ? "with the box" : "without a box";
      if (boxed) process.env.STORAGE_DIR = folder;
      else delete process.env.STORAGE_DIR;

      section(`Profile photos, ${mode}`);
      as(boss);
      const set = await photoActions.setProfilePhoto(PNG_URL);
      const photoRow = await db.userPhoto.findUnique({ where: { userId: boss.id } });
      ok("setProfilePhoto saves it", set.ok && !!photoRow, set.ok ? "" : set.error);
      ok(boxed ? "  the row holds a reference" : "  the row holds the data URL, as always", kept(boxed, photoRow?.dataUrl, PNG_URL), photoRow?.dataUrl.slice(0, 60));
      ok("  the size and type are the photo's own", photoRow?.byteSize === Math.floor((PNG.toString("base64").length * 3) / 4) && photoRow.mimeType === "image/png");
      const served = await photoRoute.GET(new Request(`http://x/api/users/${boss.id}/photo`), params({ id: boss.id }));
      ok("/api/users/[id]/photo serves the photo", served.status === 200 && Buffer.from(await served.arrayBuffer()).equals(PNG) && served.headers.get("content-type") === "image/png");
      const token = await photoToken(boss.id);
      const sig = await sigPhotoRoute.GET(new Request(`http://x/api/signatures/photo/${token}`), params({ token }));
      ok("the email signature's photo too", sig.status === 200 && Buffer.from(await sig.arrayBuffer()).equals(PNG), sig.status);
      const cardPhoto = await cardPhotoRoute.GET(new Request(`http://x/c/${card.handle}/photo`), params({ handle: card.handle }));
      ok("a public card's photo too", cardPhoto.status === 200 && Buffer.from(await cardPhoto.arrayBuffer()).equals(PNG), cardPhoto.status);
      const vcard = await vcardRoute.GET(new Request(`http://x/c/${card.handle}/vcard`), params({ handle: card.handle }));
      const vcardText = await vcard.text();
      ok("  and its vCard carries it", vcard.status === 200 && vcardText.replace(/\r?\n /g, "").includes(`PHOTO;ENCODING=b;TYPE=PNG:${PNG.toString("base64")}`), vcardText.slice(0, 120));
      const [idCard] = await idCards.fullIdCards([boss.id]);
      ok("an ID card (the print page and the design preview) draws it", idCard?.photoDataUrl === PNG_URL, idCard?.photoDataUrl?.slice(0, 40));
      const [printed] = await idCards.idCardsFor([boss.id], await idCards.readIdCardDesign());
      ok("  the print page's cards as the design shows them", printed?.photoDataUrl === PNG_URL, printed?.photoDataUrl?.slice(0, 40));
      ok("  and the public check page a scanned card opens", (await idCards.idCardCheck(boss.id))?.photoDataUrl === PNG_URL);

      section(`Visitor photos, ${mode}`);
      const signedIn = await visitorPublic.checkIn({ token: kiosk.token, purpose: "MEETING", hostUserId: colleague.id, name: `Zz Visitor ${mode}`, phone: "98765 43210", company: "Zz Acme Ltd", email: "zz@acme.example", photoDataUrl: JPEG_URL });
      const entry = await db.visitorEntry.findFirst({ where: { name: `Zz Visitor ${mode}` } });
      ok("a walk-in signs in with a photo", signedIn.ok && !!entry, signedIn.ok ? "" : signedIn.error);
      ok(boxed ? "  the entry holds a reference" : "  the entry holds the data URL", kept(boxed, entry?.photoDataUrl, JPEG_URL), entry?.photoDataUrl?.slice(0, 60));
      const book = await visitors.listVisitors({ status: "ALL" });
      ok("  and the visitor book shows the photo", book?.find((e) => e.id === entry?.id)?.photoDataUrl === JPEG_URL);
      const invite = await visitors.createInvite({ name: `Zz Invited ${mode}`, phone: "9876500000", company: "Zz Acme Ltd", email: "inv@acme.example", purpose: "MEETING", expectedAt: clock.input(new Date()), hostUserId: boss.id });
      const arrived = invite.ok ? await visitorPublic.checkInWithInvite({ token: kiosk.token, code: invite.data.code, photoDataUrl: JPEG_URL }) : null;
      const invited = await db.visitorEntry.findFirst({ where: { name: `Zz Invited ${mode}` } });
      ok("an invited visitor signs in with a photo", !!arrived?.ok && kept(boxed, invited?.photoDataUrl, JPEG_URL), invite.ok ? (arrived && !arrived.ok ? arrived.error : invited?.photoDataUrl?.slice(0, 60)) : invite.error);
      ok("  shown in the book as well", (await visitors.listVisitors({ status: "ALL" }))?.find((e) => e.id === invited?.id)?.photoDataUrl === JPEG_URL);

      section(`Celebration pictures, ${mode}`);
      const saved = await celebrations.saveCelebration({ kind: "ACHIEVEMENT", audience: "EVERYONE", title: `Zz Splash ${mode}`, startsOn: day(-1), endsOn: day(1), image: { name: "splash.png", fileDataUrl: PNG_URL, mimeType: "image/png" } });
      const celebration = saved.ok ? await db.celebration.findUnique({ where: { id: saved.data.id } }) : null;
      ok("saveCelebration keeps its picture", saved.ok && kept(boxed, celebration?.imageDataUrl, PNG_URL), saved.ok ? celebration?.imageDataUrl?.slice(0, 60) : saved.error);
      ok("  the list HR edits shows it", (await celebrations.listCelebrations()).find((c) => c.id === celebration?.id)?.imageDataUrl === PNG_URL);
      const moments = (await todaysMoments()).moments;
      ok("  and so does today's splash", moments.find((m) => m.title === `Zz Splash ${mode}`)?.imageDataUrl === PNG_URL, moments.map((m) => m.title).join(", "));
      await db.celebration.update({ where: { id: celebration!.id }, data: { active: false } });

      section(`Prize pictures, ${mode}`);
      const prize = await prizes.savePrize({ race: "TOP_SELLERS", period: "", slot: "1", name: `Zz Phone ${mode}`, image: PNG_URL });
      const prizeRow = await db.prize.findFirst({ where: { race: "TOP_SELLERS", period: "", slot: "1" } });
      ok("savePrize keeps its picture", prize.ok && kept(boxed, prizeRow?.imageDataUrl, PNG_URL), prize.ok ? prizeRow?.imageDataUrl?.slice(0, 60) : prize.error);
      ok("  the settings tab shows it", (await prizes.getPrizesAdmin())?.prizes.find((p) => p.period === "" && p.slot === "1")?.imageDataUrl === PNG_URL);
      const showcase = await prizeShowcase();
      ok("  the showcase (Wins page and the office TV) too", showcase.find((r) => r.race === "TOP_SELLERS")?.items.find((i) => i.slot === "1")?.imageDataUrl === PNG_URL, JSON.stringify(showcase).slice(0, 120));
      const period = `zz-${boxed ? "box" : "nobox"}`;
      await prizeStore.recordWinners({ race: "TOP_SELLERS", period, periodLabel: period, audience: "EVERYONE", prizes: await prizeStore.prizesForPeriod("TOP_SELLERS", period), winners: [{ slot: "1", userId: colleague.id, score: 10 }] });
      const winner = await db.prizeWinner.findFirst({ where: { period } });
      ok("  a winner's line keeps the prize's picture as it was", kept(boxed, winner?.prizeImage, PNG_URL), winner?.prizeImage?.slice(0, 60));
      ok("  and the hall of fame shows it", (await prizes.getHallOfFame())?.rows.find((r) => r.period === period)?.prizeImage === PNG_URL);

      section(`Task files, ${mode}`);
      const taskBytes = Buffer.from(`timings ${mode}`);
      const form = new FormData();
      form.set("taskId", taskId);
      form.set("file", new File([taskBytes], "timings.txt", { type: "text/plain" }));
      const upload = await taskExtras.uploadTaskFile(form);
      const attachment = upload.ok ? await db.taskAttachment.findUnique({ where: { id: upload.data.id } }) : null;
      ok("uploadTaskFile keeps it", upload.ok && kept(boxed, attachment?.data, taskBytes), upload.ok ? "" : upload.error);
      ok("  with its real size", attachment?.size === taskBytes.length);
      const taskServed = await taskFileRoute.GET(new Request(`http://x/api/tasks/files/${attachment?.id}`), params({ id: attachment?.id ?? "" }));
      ok("  /api/tasks/files/[id] serves it", taskServed.status === 200 && Buffer.from(await taskServed.arrayBuffer()).equals(taskBytes), taskServed.status);

      section(`Chat files, ${mode}`);
      const chatForm = new FormData();
      chatForm.set("chatId", direct.data.chatId);
      chatForm.set("body", "");
      chatForm.append("files", new File([PNG], "pixel.png", { type: "image/png" }));
      const sent = await chat.sendChatMessage(chatForm);
      const chatFile = sent.ok ? await db.chatAttachment.findFirst({ where: { messageId: sent.data.id } }) : null;
      ok("sendChatMessage keeps the file", sent.ok && kept(boxed, chatFile?.data, PNG), sent.ok ? "" : sent.error);
      ok("  with its real size", chatFile?.size === PNG.length);
      const chatServed = await chatFileRoute.GET(new Request(`http://x/api/chat/files/${chatFile?.id}`), params({ id: chatFile?.id ?? "" }));
      ok("  /api/chat/files/[id] serves it", chatServed.status === 200 && Buffer.from(await chatServed.arrayBuffer()).equals(PNG), chatServed.status);
      as(colleague);
      const appServed = await appChatFileRoute.GET(new Request(`http://x/api/app/chat/files/${chatFile?.id}`), params({ id: chatFile?.id ?? "" }));
      ok("  and the app's /api/app/chat/files/[id] to the other member", appServed.status === 200 && Buffer.from(await appServed.arrayBuffer()).equals(PNG), appServed.status);
      as(boss);

      section(`Inbox files, ${mode}`);
      const started = await inbox.receiveWebMessage(webChannel, { text: `Hello ${mode}` });
      visitorTokens.set(started.conversationId, started.token);
      const visitorPng = Buffer.concat([PNG, Buffer.from(mode)]);
      const received = await inbox.receiveWebFile(webChannel, started.token, { bytes: visitorPng, mime: "image/png", name: "bill.png" });
      const fileMessage = await db.conversationMessage.findFirst({ where: { conversationId: started.conversationId, file: { isNot: null } }, include: { file: true } });
      ok("a website visitor's file is kept", received?.ok === true && kept(boxed, fileMessage?.file?.bytes, visitorPng), received && !received.ok ? received.error : "");
      ok("  with its real size", fileMessage?.file?.size === visitorPng.length);
      ok("  their bubble gets it back", same((await inbox.visitorFile(webChannel.id, started.token, fileMessage?.id ?? ""))?.bytes, visitorPng));
      const teamOpens = await inboxFileRoute.GET(new Request(`http://x/api/inbox/files/${fileMessage?.id}`), params({ id: fileMessage?.id ?? "" }));
      ok("  and /api/inbox/files/[id] serves it to the team", teamOpens.status === 200 && Buffer.from(await teamOpens.arrayBuffer()).equals(visitorPng), teamOpens.status);
      const waId = `wamid.zzbox${boxed ? 1 : 0}${Date.now()}`;
      await inbox.receiveWhatsApp({ phoneNumberId: "990000000911", from: boxed ? "919900000921" : "919900000920", profileName: "Zz Wa", id: waId, at: new Date(), text: "[Photo]", media: { id: `zz-media-${boxed}`, mime: "image/jpeg", name: null } });
      const waMessage = await db.conversationMessage.findFirst({ where: { externalId: waId } });
      const waOpened = waMessage ? await inbox.conversationFile(viewer, waMessage.id) : null;
      const waRow = waMessage ? await db.conversationFile.findUnique({ where: { messageId: waMessage.id } }) : null;
      ok("a WhatsApp photo, fetched the first time it's opened, is kept", !!waOpened?.ok && same(waOpened.bytes, waBytes) && kept(boxed, waRow?.bytes, waBytes), waOpened && !waOpened.ok ? waOpened.error : "");
      const waAgain = waMessage ? await inbox.conversationFile(viewer, waMessage.id) : null;
      ok("  and read from what was kept after that", !!waAgain?.ok && same(waAgain.bytes, waBytes));

      section(`Marketing pictures, ${mode}`);
      as(boss);
      const builderForm = new FormData();
      builderForm.set("file", new File([PNG], "hero.png", { type: "image/png" }));
      const uploaded = await assetUpload.POST(new Request("http://deskzo.localhost:3000/api/marketing/assets/upload", { method: "POST", headers: { origin: "http://deskzo.localhost:3000", host: "deskzo.localhost:3000" }, body: builderForm }));
      const uploadedJson = (await uploaded.json()) as { ok: boolean; url?: string; error?: string };
      const [assetId, assetName] = (uploadedJson.url ?? "").replace("/api/marketing/assets/", "").split("/");
      const asset = assetId ? await db.marketingAsset.findUnique({ where: { id: assetId } }) : null;
      ok("the email builder's upload is kept", uploadedJson.ok && !!asset && (boxed ? files.isStoredRef(asset.data) : !files.isStoredRef(asset.data) && asset.data.length === asset.size), uploadedJson.error ?? asset?.data.length);
      const builderBytes = asset ? await files.bytesOf(asset.data) : null;
      const assetServed = await assetRoute.GET(new Request(`http://x${uploadedJson.url}`), params({ id: assetId ?? "", name: assetName ?? "" }));
      const assetBody = Buffer.from(await assetServed.arrayBuffer());
      ok("  and served, as in an email already sent", assetServed.status === 200 && !!builderBytes && assetBody.equals(builderBytes) && assetServed.headers.get("cache-control") === "public, max-age=31536000, immutable" && assetServed.headers.get("content-length") === String(assetBody.length), assetServed.status);
      ok("  the row's size is the picture's own", asset?.size === assetBody.length);
      const stored = await storeUploadedTemplate({ userId: boss.id, name: `Zz template ${mode}`, topic: "OFFERS", subject: "Zz", preheader: null, fileName: "zz.html", bytes: Buffer.from(`<html><body><p>Hello</p><img src="${PNG_URL}" alt=""></body></html>`) });
      const templateAsset = stored.ok ? await db.marketingAsset.findFirst({ where: { templateId: stored.data.id } }) : null;
      ok("a template's own pictures are kept", stored.ok && kept(boxed, templateAsset?.data, PNG), stored.ok ? "" : stored.error);
      const templateServed = templateAsset ? await assetRoute.GET(new Request("http://x"), params({ id: templateAsset.id, name: templateAsset.fileName })) : null;
      ok("  and served", templateServed?.status === 200 && Buffer.from(await templateServed.arrayBuffer()).equals(PNG));
    }

    // ─── A reference the box doesn't have ────────────────────────────────────────────────────────
    section("A file the box has lost");
    as(boss);
    await db.userPhoto.update({ where: { userId: boss.id }, data: { dataUrl: LOST("user-photos", "image/png") } });
    const lostPhoto = await photoRoute.GET(new Request(`http://x/api/users/${boss.id}/photo`), params({ id: boss.id }));
    ok("a profile photo: a 404, as for nobody's", lostPhoto.status === 404, lostPhoto.status);
    const token = await photoToken(boss.id);
    ok("  the signature's photo a 404", (await sigPhotoRoute.GET(new Request("http://x"), params({ token }))).status === 404);
    ok("  the card's photo a 404", (await cardPhotoRoute.GET(new Request("http://x"), params({ handle: card.handle }))).status === 404);
    const lostVcard = await vcardRoute.GET(new Request("http://x"), params({ handle: card.handle }));
    ok("  the vCard still downloads, without a photo", lostVcard.status === 200 && !(await lostVcard.text()).includes("PHOTO;"));
    ok("  an ID card draws initials instead", (await idCards.fullIdCards([boss.id]))[0]?.photoDataUrl === null && (await idCards.idCardCheck(boss.id))?.photoDataUrl === null);

    const someEntry = await db.visitorEntry.findFirstOrThrow({ where: { photoDataUrl: { not: null } } });
    await db.visitorEntry.update({ where: { id: someEntry.id }, data: { photoDataUrl: LOST("visitor-photos", "image/jpeg") } });
    const lostBook = await visitors.listVisitors({ status: "ALL" });
    ok("a visitor's photo: the book shows the entry without it", !!lostBook?.find((e) => e.id === someEntry.id) && lostBook.find((e) => e.id === someEntry.id)?.photoDataUrl === null);

    const lostCelebration = await db.celebration.create({ data: { kind: "ACHIEVEMENT", audience: "EVERYONE", title: "Zz Lost splash", startsOn: new Date(`${day(-1)}T00:00:00Z`), endsOn: new Date(`${day(1)}T00:00:00Z`), imageDataUrl: LOST("celebrations", "image/png"), createdById: boss.id } });
    ok("a celebration's picture: listed without it", (await celebrations.listCelebrations()).find((c) => c.id === lostCelebration.id)?.imageDataUrl === null);
    const lostMoment = (await todaysMoments()).moments.find((m) => m.title === "Zz Lost splash");
    ok("  and the splash still shows, without it", !!lostMoment && lostMoment.imageDataUrl === null, JSON.stringify(lostMoment ?? null).slice(0, 100));

    await db.prize.updateMany({ where: { race: "TOP_SELLERS", period: "", slot: "1" }, data: { imageDataUrl: LOST("prizes", "image/png") } });
    await db.prizeWinner.updateMany({ data: { prizeImage: LOST("prizes", "image/png") } });
    ok("a prize's picture: the settings tab, the showcase and the hall of fame go without it",
      (await prizes.getPrizesAdmin())?.prizes.find((p) => p.period === "" && p.slot === "1")?.imageDataUrl === null &&
        (await prizeShowcase()).find((r) => r.race === "TOP_SELLERS")?.items.find((i) => i.slot === "1")?.imageDataUrl === null &&
        ((await prizes.getHallOfFame())?.rows ?? []).every((r) => r.prizeImage === null));

    const someTaskFile = await db.taskAttachment.findFirstOrThrow({});
    await db.taskAttachment.update({ where: { id: someTaskFile.id }, data: { data: LOST_BYTES("task-attachments", "text/plain") } });
    ok("a task file: a 404", (await taskFileRoute.GET(new Request("http://x"), params({ id: someTaskFile.id }))).status === 404);

    const someChatFile = await db.chatAttachment.findFirstOrThrow({});
    await db.chatAttachment.update({ where: { id: someChatFile.id }, data: { data: LOST_BYTES("chat-attachments", "image/png") } });
    ok("a chat file: a 404 on the website", (await chatFileRoute.GET(new Request("http://x"), params({ id: someChatFile.id }))).status === 404);
    ok("  and in the app", (await appChatFileRoute.GET(new Request("http://x"), params({ id: someChatFile.id }))).status === 404);

    const someInboxFile = await db.conversationFile.findFirstOrThrow({ where: { message: { author: "CUSTOMER", conversation: { channelId: webChannel.id } } }, include: { message: { select: { id: true, conversationId: true } } } });
    await db.conversationFile.update({ where: { id: someInboxFile.id }, data: { bytes: LOST_BYTES("inbox-files", "image/png") } });
    const lostInbox = await inbox.conversationFile(viewer, someInboxFile.message.id);
    ok("an inbox file: a 404 for the team", !lostInbox.ok && lostInbox.status === 404);
    ok("  through the route too", (await inboxFileRoute.GET(new Request("http://x"), params({ id: someInboxFile.message.id }))).status === 404);
    ok("  and nothing in the visitor's bubble", (await inbox.visitorFile(webChannel.id, visitorTokens.get(someInboxFile.message.conversationId) ?? "", someInboxFile.message.id)) === null);

    const someAsset = await db.marketingAsset.findFirstOrThrow({});
    await db.marketingAsset.update({ where: { id: someAsset.id }, data: { data: LOST_BYTES("marketing-assets", "image/png") } });
    const lostAsset = await assetRoute.GET(new Request("http://x"), params({ id: someAsset.id, name: someAsset.fileName }));
    ok("a marketing picture: a 404 that no cache keeps", lostAsset.status === 404 && lostAsset.headers.get("cache-control") === "no-store", lostAsset.headers.get("cache-control"));

    whatsapp.setTestWhatsAppSender(null);
    whatsapp.setTestWhatsAppRead(null);
    whatsapp.setTestWhatsAppMedia(null);
  } finally {
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect().catch(() => {});
    await rm(folder, { recursive: true, force: true });
    ok("the scratch database is dropped", true);
  }

  console.log(`\n${failures ? `${passes} passed, ${failures} FAILED` : `All ${passes} storage checks for people's pictures and conversation files passed.`}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
