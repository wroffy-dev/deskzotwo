/**
 * check:audit-round2-vault-mail — the security audit's round two (13 Nov 2026, docs/reports/security-audit-2026-11-11.md
 * section 11), group V: the vault, mail from a person's own mailbox, and chat. Each fix shown to hold the way it was
 * broken, by calling the server's own code:
 *
 *   R2-02  opening a vault secret confirms through confirmIdentity: wrong passwords lock out after the limit (and end
 *          the session), the right one is then refused too; somebody with two-factor needs the code
 *   R2-18  every vault action is refused while viewing as somebody; the pickers come back empty
 *   R2-17  Settings › Blocked addresses holds for mail sent from a person's own mailbox (to and copies), and the
 *          invitation and document screens say which address is left out
 *   low    a reply quoting a message from before the reader joined shows them a blank quote, on the page and live
 *   low    copilot settings refused while viewing as somebody; a vCard's bare carriage return escaped
 *
 * Its own fixture, tagged ZZR2V (people on @zzr2v.invalid, addresses on zzr2v-*.example), removed in a finally. The
 * mailbox's provider is stood in for: nothing is sent.
 *
 *   npx tsx scripts/check-audit-round2-vault-mail.ts
 */
import "dotenv/config";
import Module from "node:module";
import bcrypt from "bcryptjs";

process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let sid: string | null = null;
let viewingAs = false;
let graphSends = 0;
const published: { userId: string; event: { type: string; message?: { id: string; replyTo: { body: string; senderName: string | null } | null } } }[] = [];

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      requireUser: async () => {
        if (!actor) throw new Error("Unauthorized");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => (viewingAs ? { actor, user: actor } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody." : null),
    };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleAccess: async () => actor, requireModuleUser: async () => actor };
  }
  if (request === "@/lib/auth") return { auth: async () => (actor ? { user: { ...actor, sid } } : null), signIn: async () => undefined };
  if (request === "@/lib/notify") return { notifyUser: async () => undefined };
  if (request === "@/lib/workplace/settings") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, mailProviders: async () => ["MICROSOFT"] };
  }
  // The person's own mailbox: Outlook stood in for, counting what would have gone.
  if (request === "@/lib/mail/microsoft") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      sendWithGraph: async () => {
        graphSends += 1;
        return { ok: true };
      },
    };
  }
  // The live bus: what each member would be sent.
  if (request === "@/lib/chat/bus") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      publish: async (ids: Iterable<string>, event: unknown) => {
        for (const userId of new Set(ids)) published.push({ userId, event: typeof event === "function" ? event(userId) : event });
      },
    };
  }
  if (request === "@/lib/app/push") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, pushChatToPhones: async () => undefined };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const TAG = "ZZR2V";
const MAIL = "@zzr2v.invalid";
const PASSWORD = "Zz-correct-horse-2";
const SECRET = "the-stored-secret-r2v";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const vault = require("../src/actions/vault") as typeof import("../src/actions/vault");
  const { confirmLockKey } = require("../src/lib/security/confirm-identity") as typeof import("../src/lib/security/confirm-identity");
  const { MAX_FAILURES, clearFailures } = require("../src/lib/security/lockout") as typeof import("../src/lib/security/lockout");
  const { encryptSecret, digestSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
  const { authenticator } = require("otplib") as typeof import("otplib");
  const { sendAsUser } = require("../src/lib/mail/mailbox") as typeof import("../src/lib/mail/mailbox");
  const { screenInvitees } = require("../src/lib/calendar/invitees") as typeof import("../src/lib/calendar/invitees");
  const { recipientsFor } = require("../src/lib/documents/send-email") as typeof import("../src/lib/documents/send-email");
  const chat = require("../src/actions/chat") as typeof import("../src/actions/chat");
  const copilot = require("../src/actions/copilot") as typeof import("../src/actions/copilot");
  const { buildVCard } = require("../src/lib/cards/vcard") as typeof import("../src/lib/cards/vcard");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const lockKeys: string[] = [];
  const cleanup = async () => {
    const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
    await db.chat.deleteMany({ where: { name: { startsWith: TAG } } });
    await db.signIn.deleteMany({ where: { userId: { in: ids } } });
    await db.vaultCredential.deleteMany({ where: { ownerId: { in: ids } } });
    await db.mailConnection.deleteMany({ where: { userId: { in: ids } } });
    const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await db.contact.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
    await db.suppression.deleteMany({ where: { value: { contains: "zzr2v" } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.activityLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await db.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: ids } } });
  };

  await cleanup();
  try {
    const make = async (name: string, extra: object = {}) =>
      db.user.create({
        data: {
          name: `Zzr2v ${name}`,
          email: `${name}${MAIL}`,
          role: "ADMIN",
          passwordHash: await bcrypt.hash(PASSWORD, 4),
          permissionGrants: { create: [{ permission: "vault.use", allowed: true, reason: TAG }] },
          ...extra,
        },
        select: { id: true, role: true, name: true, email: true },
      });
    const credential = async (ownerId: string, loginName: string) =>
      db.vaultCredential.create({ data: { ownerId, loginName: `${TAG} ${loginName}`, secretCipher: await encryptSecret(SECRET), secretDigest: await digestSecret(SECRET) }, select: { id: true } });

    section("R2-02: opening a secret confirms it's you, with a limit on guesses");
    const guesser = await make("guesser");
    actor = guesser;
    lockKeys.push(await confirmLockKey(guesser.id));
    const guessed = await credential(guesser.id, "registrar");
    sid = `zzr2v-${Date.now()}`;
    await db.signIn.create({ data: { sid, userId: guesser.id, provider: "credentials", at: new Date() } });
    let r = await vault.revealSecret(guessed.id, PASSWORD);
    ok("the right password opens it", r.ok && r.data.secret === SECRET, r.ok ? "" : r);
    let last: Awaited<ReturnType<typeof vault.revealSecret>> = r;
    for (let i = 0; i < MAX_FAILURES; i += 1) last = await vault.revealSecret(guessed.id, `wrong-${i}`);
    ok(`after ${MAX_FAILURES} wrong passwords it locks`, !last.ok && /Too many wrong tries/.test(last.error), last);
    const ended = await db.signIn.findUnique({ where: { sid }, select: { endedAt: true } });
    ok("  and the session that guessed is ended", !!ended?.endedAt);
    r = await vault.revealSecret(guessed.id, PASSWORD);
    ok("  the right password is then refused too", !r.ok && /Too many wrong tries/.test(r.error), r);
    const failedRows = await db.auditLog.count({ where: { userId: guesser.id, entityId: guessed.id, entityLabel: { startsWith: "Failed open" } } });
    ok("  each failed open is recorded on the record", failedRows >= MAX_FAILURES, failedRows);
    sid = null;

    const totpSecret = authenticator.generateSecret();
    const twoFactor = await make("twofactor", { twoFactorEnabledAt: new Date(), twoFactorSecretCipher: await encryptSecret(totpSecret) });
    actor = twoFactor;
    lockKeys.push(await confirmLockKey(twoFactor.id));
    const tfaRow = await credential(twoFactor.id, "bank");
    r = await vault.revealSecret(tfaRow.id, PASSWORD);
    ok("with two-factor on, the password alone asks for the code", !r.ok && r.needsCode === true, r);
    r = await vault.revealSecret(tfaRow.id, PASSWORD, "PASSWORD", "000000");
    ok("  a wrong code doesn't open it", !r.ok, r);
    r = await vault.revealSecret(tfaRow.id, "wrong", "PASSWORD", authenticator.generate(totpSecret));
    ok("  nor the right code with a wrong password", !r.ok, r);
    r = await vault.revealSecret(tfaRow.id, PASSWORD, "PASSWORD", authenticator.generate(totpSecret));
    ok("  the password and the code do", r.ok && r.data.secret === SECRET, r.ok ? "" : r);
    const opened = await db.auditLog.findFirst({ where: { userId: twoFactor.id, entityId: tfaRow.id, entityLabel: { startsWith: "Opened" } }, select: { id: true } });
    ok("  and the opening is recorded", !!opened);

    section("R2-18: nothing in the vault while viewing as somebody");
    const owner = await make("owner");
    const colleague = await make("colleague");
    actor = owner;
    lockKeys.push(await confirmLockKey(owner.id));
    const mine = await credential(owner.id, "hosting");
    const share = await db.vaultShare.create({ data: { credentialId: mine.id, userId: colleague.id, level: "VIEW", sharedById: owner.id }, select: { id: true } });
    const tag = await db.credentialTag.create({ data: { kind: "CATEGORY", name: `${TAG} tag` }, select: { id: true } });
    viewingAs = true;
    const refused = (x: { ok: boolean; error?: string }) => !x.ok && /viewing as/i.test(x.error ?? "");
    const calls: [string, Promise<{ ok: boolean; error?: string }>][] = [
      ["listVault", vault.listVault()],
      ["credentialTrail", vault.credentialTrail(mine.id)],
      ["saveCredential (new)", vault.saveCredential({ loginName: `${TAG} planted`, secret: "x" })],
      ["saveCredential (change)", vault.saveCredential({ id: mine.id, loginName: `${TAG} renamed`, secret: "changed" })],
      ["revealSecret", vault.revealSecret(mine.id, PASSWORD)],
      ["shareCredential", vault.shareCredential({ credentialId: mine.id, userId: colleague.id, level: "MANAGE" })],
      ["unshareCredential", vault.unshareCredential(share.id)],
      ["setCredentialPin", vault.setCredentialPin(mine.id, true)],
      ["deleteCredential", vault.deleteCredential(mine.id)],
      ["listArchivedVault", vault.listArchivedVault()],
      ["restoreCredential", vault.restoreCredential(mine.id)],
      ["destroyArchivedCredential", vault.destroyArchivedCredential(mine.id)],
      ["saveCredentialTag", vault.saveCredentialTag({ kind: "CATEGORY", name: `${TAG} other` })],
      ["deleteCredentialTag", vault.deleteCredentialTag(tag.id)],
    ];
    for (const [name, call] of calls) {
      const answer = await call;
      ok(`${name} refused`, refused(answer), answer);
    }
    const options = await vault.vaultOptions();
    ok("the pickers come back empty", options.users.length === 0 && options.companies.length === 0);
    const after = await db.vaultCredential.findUnique({ where: { id: mine.id }, select: { loginName: true, archivedAt: true, shares: { select: { id: true, level: true } } } });
    ok("  and the record is as it was: name, shares, not archived", after?.loginName === `${TAG} hosting` && !after.archivedAt && after.shares.length === 1 && after.shares[0]!.level === "VIEW", after);
    ok("  nothing new was stored", (await db.vaultCredential.count({ where: { loginName: `${TAG} planted` } })) === 0);
    ok("  the tag is still there", !!(await db.credentialTag.findUnique({ where: { id: tag.id }, select: { id: true } })));

    const savedCopilot = await copilot.saveCopilotSettings({ enabled: false, draftingEnabled: false, dailyCreditLimit: null });
    ok("copilot settings: saving refused", refused(savedCopilot), savedCopilot);
    ok("  and reading them gives nothing", (await copilot.getCopilotSettings()) === null);
    viewingAs = false;
    const listed = await vault.listVault();
    ok("as yourself, the vault lists again", listed.ok && listed.data.rows.some((row) => row.id === mine.id), listed.ok ? "" : listed);
    await db.credentialTag.delete({ where: { id: tag.id } });

    section("R2-17: Settings › Blocked addresses holds for a person's own mailbox");
    const sender = await make("sender");
    await db.mailConnection.create({
      data: {
        userId: sender.id,
        provider: "MICROSOFT",
        mailbox: `sender${MAIL}`,
        refreshTokenCipher: await encryptSecret("zz-refresh"),
        accessTokenCipher: await encryptSecret("zz-access"),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        scopes: "Mail.Send",
      },
    });
    await db.suppression.createMany({
      data: [
        { scope: "EMAIL", value: "ravi@zzr2v-solo.example", reason: "MANUAL", allMail: true, createdById: owner.id },
        { scope: "DOMAIN", value: "zzr2v-acme.example", reason: "MANUAL", allMail: true, createdById: owner.id },
        // Marketing and reminders only: not a block on everything.
        { scope: "EMAIL", value: "offers@zzr2v-soft.example", reason: "MANUAL", allMail: false, createdById: owner.id },
      ],
    });
    const mail = (to: string[], cc: string[] = []) => ({ subject: "zz", html: "<p>zz</p>", to: to.map((email) => ({ name: null, email })), cc: cc.map((email) => ({ name: null, email })), attachments: [] });
    let sent = await sendAsUser(sender.id, mail(["anyone@zzr2v-fine.example"]));
    ok("an ordinary address goes out through the mailbox", sent.ok && graphSends === 1, { sent, graphSends });
    sent = await sendAsUser(sender.id, mail(["Ravi@zzr2v-solo.example"]));
    ok("a blocked address is refused, saying so", !sent.ok && sent.error.startsWith("Not sent:") && sent.error.includes("blocked from all mail"), sent);
    ok("  and the mailbox wasn't asked", graphSends === 1, graphSends);
    sent = await sendAsUser(sender.id, mail(["anyone@zzr2v-fine.example"], ["buyer@mail.zzr2v-acme.example"]));
    ok("a copy to a blocked domain's subdomain stops the whole send", !sent.ok && sent.error.includes("zzr2v-acme.example") && graphSends === 1, sent);
    sent = await sendAsUser(sender.id, mail(["offers@zzr2v-soft.example"]));
    ok("a block on marketing only doesn't stop a person's own email", sent.ok && graphSends === 2, sent);

    const verdicts = await screenInvitees(["anyone@zzr2v-fine.example", "ravi@zzr2v-solo.example", "pat@zzr2v-acme.example"]);
    const verdictOf = (email: string) => verdicts.find((v) => v.email === email);
    const fine = verdictOf("anyone@zzr2v-fine.example");
    const solo = verdictOf("ravi@zzr2v-solo.example");
    const acme = verdictOf("pat@zzr2v-acme.example");
    ok("an invitation leaves out a blocked address, saying which", !!solo && !solo.ok && solo.detail.includes("ravi@zzr2v-solo.example") && solo.detail.includes("blocked from all mail"), solo);
    ok("  and one at a blocked domain, naming the domain", !!acme && !acme.ok && acme.detail.includes("zzr2v-acme.example"), acme);
    ok("  the others may be invited", !!fine && fine.ok, fine);

    const company = await db.company.create({ data: { name: `${TAG} Buyer`, normalizedName: `${TAG.toLowerCase()} buyer`, createdById: owner.id }, select: { id: true } });
    await db.contact.createMany({
      data: [
        { companyId: company.id, name: `${TAG} Pat`, email: "pat@zzr2v-acme.example" },
        { companyId: company.id, name: `${TAG} Sam`, email: "sam@zzr2v-fine.example" },
      ],
    });
    const recipients = await recipientsFor(company.id);
    const pat = recipients.find((c) => c.email === "pat@zzr2v-acme.example");
    const sam = recipients.find((c) => c.email === "sam@zzr2v-fine.example");
    ok("the document dialog marks a blocked contact, saying why", !!pat && !pat.canReceive && !!pat.blockedBecause?.includes("blocked from all mail"), pat);
    ok("  and leaves the others as they were", !!sam && sam.canReceive, sam);

    section("Chat: a quote from before somebody joined");
    const early = await make("early");
    const late = await make("late");
    const group = await db.chat.create({ data: { kind: "GROUP", name: `${TAG} group`, createdById: early.id }, select: { id: true } });
    const start = Date.now() - 3_600_000;
    await db.chatMember.create({ data: { chatId: group.id, userId: early.id, isAdmin: true, joinedAt: new Date(start) } });
    const before = await db.chatMessage.create({ data: { chatId: group.id, senderId: early.id, body: `${TAG} said before the late one joined`, createdAt: new Date(start + 60_000) }, select: { id: true } });
    await db.chatMember.create({ data: { chatId: group.id, userId: late.id, joinedAt: new Date(start + 120_000) } });
    const reply = await db.chatMessage.create({ data: { chatId: group.id, senderId: early.id, body: `${TAG} a reply`, replyToId: before.id, createdAt: new Date(start + 180_000) }, select: { id: true } });

    actor = early;
    let opened2 = await chat.openChat(group.id);
    const earlyView = opened2?.messages.find((m) => m.id === reply.id);
    ok("the member who was there sees the quote", !!earlyView?.replyTo?.body.includes("said before"), earlyView?.replyTo);
    actor = late;
    opened2 = await chat.openChat(group.id);
    const lateView = opened2?.messages.find((m) => m.id === reply.id);
    ok("the late joiner sees the reply, with a blank quote", !!lateView && lateView.replyTo?.body === "" && lateView.replyTo.senderName === null, lateView?.replyTo);
    ok("  and not the message itself", !opened2?.messages.some((m) => m.id === before.id));

    actor = early;
    published.length = 0;
    const form = new FormData();
    form.set("chatId", group.id);
    form.set("body", `${TAG} replying again`);
    form.set("replyToId", before.id);
    const live = await chat.sendChatMessage(form);
    ok("a new reply to the old message is sent", live.ok, live.ok ? "" : live);
    const forLate = published.find((p) => p.userId === late.id && p.event.type === "message");
    const forEarly = published.find((p) => p.userId === early.id && p.event.type === "message");
    ok("  live, the late joiner's copy has a blank quote", forLate?.event.message?.replyTo?.body === "", forLate?.event.message?.replyTo);
    ok("  and the sender's has the text", !!forEarly?.event.message?.replyTo?.body.includes("said before"), forEarly?.event.message?.replyTo);
    if (live.ok) {
      published.length = 0;
      const edited = await chat.editChatMessage(live.data.id, `${TAG} replying again, edited`);
      const editLate = published.find((p) => p.userId === late.id && p.event.type === "message-updated");
      ok("  an edit goes out the same way", edited.ok && editLate?.event.message?.replyTo?.body === "", editLate?.event.message?.replyTo);
    }

    section("vCard: a bare carriage return");
    const card = buildVCard(
      { name: "Zz Card", company: null, department: null, title: `Sales\rEMAIL:evil@zzr2v.example`, fields: [] } as unknown as Parameters<typeof buildVCard>[0],
      { cardUrl: "https://zz.example/c/x" },
    );
    ok("a bare CR can't start a new property", !card.includes("\rEMAIL") && card.includes("TITLE:Sales\\nEMAIL:evil@zzr2v.example"), card);
    const controls = buildVCard(
      { name: `Zz${String.fromCharCode(0)}Card${String.fromCharCode(27)}`, company: null, department: null, title: null, fields: [] } as unknown as Parameters<typeof buildVCard>[0],
      { cardUrl: "https://zz.example/c/x" },
    );
    ok("  other control characters are dropped", controls.includes("FN:ZzCard\r\n"), controls);
  } finally {
    viewingAs = false;
    actor = null;
    clearFailures(lockKeys);
    await cleanup().catch((err: unknown) => console.error("cleanup failed", err));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  await db.$disconnect().catch(() => undefined);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
