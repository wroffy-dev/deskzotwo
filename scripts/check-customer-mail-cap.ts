/**
 * The most renewal, workflow and marketing emails one customer gets in 24 hours (owner, 13 Nov 2026 —
 * src/lib/customer-mail-cap.ts): "nothing can override this"; nothing else counts. Each of the three senders mail leaves through is tried at the limit — the company's provider
 * (the mock), somebody's own mailbox, and Deskzo's own mail — and sends at once can't slip past it together.
 *
 * Runs against the local workspace with addresses of its own (@zz-mail-cap.test), and puts the limit back as it found it.
 *
 *   npm run check:customer-mail-cap
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

async function main() {
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const cap = require("../src/lib/customer-mail-cap") as typeof import("../src/lib/customer-mail-cap");
  const { providerByKey } = require("../src/lib/marketing/providers") as typeof import("../src/lib/marketing/providers");
  const { sendAsUser } = require("../src/lib/mail/mailbox") as typeof import("../src/lib/mail/mailbox");
  const { deliverMail } = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { currentTenantOrNull } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const run = randomUUID().slice(0, 8);
  const addr = (who: string) => `${who}.${run}@zz-mail-cap.test`;
  const mock = providerByKey.mock;
  // Only renewal, workflow and marketing emails count (owner, 13 Nov 2026): these are marketing unless said otherwise.
  const send = (to: string, extra: { cc?: string[]; bcc?: string[]; moreTo?: string[]; kind?: "renewal" | "automation" | "marketing" | null } = {}) =>
    cap.countedAs(extra.kind === undefined ? "marketing" : extra.kind, () =>
      mock.send({ to, subject: `zz cap ${run}`, html: "<p>zz</p>", text: "zz", cc: extra.cc, bcc: extra.bcc, moreTo: extra.moreTo?.map((email) => ({ email, name: null })) }, {}),
    );

  const tenant = await currentTenantOrNull();
  ok("a workspace to send in", !!tenant, tenant?.slug ?? "none");
  const before = await db.customerEmailSettings.findUnique({ where: { id: "global" }, select: { maxPerRecipientPerDay: true } });
  const setLimit = (limit: number | null) =>
    db.customerEmailSettings.upsert({ where: { id: "global" }, create: { id: "global", maxPerRecipientPerDay: limit }, update: { maxPerRecipientPerDay: limit }, select: { id: true } });
  const counted = (address: string) => db.customerMailSend.count({ where: { address } });

  try {
    section("1. No limit set: nothing counted, nothing stopped");
    await setLimit(null);
    const free = addr("free");
    for (let i = 0; i < 4; i += 1) await send(free);
    ok("four emails go", (await send(free)).ok);
    ok("  and nothing is written to count", (await counted(free)) === 0);

    section("2. The company's own provider, at a limit of 2");
    await setLimit(2);
    const asha = addr("asha");
    ok("the first goes", (await send(asha)).ok);
    ok("  the second goes", (await send(asha)).ok);
    const third = await send(asha);
    ok("  the third is refused, for good, saying why", !third.ok && !third.retryable && /Not sent: .*asha.* 2 renewal, workflow or marketing emails .* 24 hours/.test(third.ok ? "" : third.error), third);
    ok("  two counted, not three", (await counted(asha)) === 2);
    const uncounted = await send(asha, { kind: null });
    ok("an email that isn't renewal, workflow or marketing — an invoice, a helpdesk reply — still goes, and isn't counted", uncounted.ok && (await counted(asha)) === 2, uncounted);
    const mixed = addr("mixed");
    await send(mixed, { kind: "renewal" });
    await send(mixed, { kind: "automation" });
    ok("renewal, workflow and marketing count together: a renewal reminder and a workflow's email use up the day", !(await send(mixed)).ok);
    const kinds = (await db.customerMailSend.findMany({ where: { address: mixed }, select: { via: true } })).map((r) => r.via).sort();
    ok("  each written down with what it was", kinds.join() === "automation:mock,renewal:mock", kinds);

    const other = addr("other");
    const viaCopy = await send(other, { cc: [asha] });
    ok("a copy to somebody at the limit stops the whole email — to nobody", !viaCopy.ok && (await counted(other)) === 0, viaCopy);
    const viaMore = await send(other, { moreTo: [asha] });
    ok("  as does sending it to them alongside somebody else", !viaMore.ok && (await counted(other)) === 0);
    ok("  a blind copy isn't counted: it's always the sender's own", (await send(other, { bcc: [asha] })).ok && (await counted(other)) === 1);

    const staffUser = await db.user.findFirst({ where: { active: true }, select: { id: true, email: true } });
    if (staffUser?.email) {
      const colleague = staffUser.email.toLowerCase();
      for (let i = 0; i < 3; i += 1) await send(colleague);
      ok("somebody in the workspace isn't a customer: never counted, never stopped", (await send(colleague)).ok && (await counted(colleague)) === 0);
    }

    const window = addr("window");
    await send(window);
    await send(window);
    await db.customerMailSend.updateMany({ where: { address: window }, data: { sentAt: new Date(Date.now() - 24 * 3_600_000 - 60_000) } });
    ok("24 hours after the earliest, they can be emailed again", (await send(window)).ok);

    section("3. Somebody's own mailbox");
    const mailboxUser = staffUser?.id ?? "nobody";
    const own = await cap.countedAs("automation", () => sendAsUser(mailboxUser, { subject: "zz", html: "<p>zz</p>", to: [{ name: null, email: asha }], attachments: [] }));
    ok("refused before the mailbox is even asked", !own.ok && own.error.startsWith("Not sent:") && own.error.includes(asha), own);
    const ownCopy = await cap.countedAs("automation", () => sendAsUser(mailboxUser, { subject: "zz", html: "<p>zz</p>", to: [{ name: null, email: addr("mb") }], cc: [{ name: null, email: asha }], attachments: [] }));
    ok("  a copy to them stops it too", !ownCopy.ok && ownCopy.error.includes(asha));
    const failed = addr("failed");
    const noMailbox = await cap.countedAs("automation", () => sendAsUser("zz-no-such-user", { subject: "zz", html: "<p>zz</p>", to: [{ name: null, email: failed }], attachments: [] }));
    ok("  an email that then fails doesn't use up the day", !noMailbox.ok && (await counted(failed)) === 0, noMailbox);
    const ownDocument = await sendAsUser(mailboxUser, { subject: "zz", html: "<p>zz</p>", to: [{ name: null, email: asha }], attachments: [] });
    ok("  a document sent by hand isn't stopped by the limit", ownDocument.ok || !ownDocument.error.startsWith("Not sent:"), ownDocument);

    section("4. Deskzo's own mail, sent for the workspace");
    let deskzoRefused: unknown = null;
    try {
      await cap.countedAs("automation", () => deliverMail({ type: "DOCUMENTS", to: asha, subject: "zz", text: "zz" }));
    } catch (err) {
      deskzoRefused = err;
    }
    ok("refused like a server's 550, so the queue gives up at once", deskzoRefused instanceof Error && /Not sent: .*asha/.test(deskzoRefused.message) && (deskzoRefused as { responseCode?: number }).responseCode === 550, String(deskzoRefused));
    const fresh = addr("fresh");
    let deskzoSent = true;
    try {
      await cap.countedAs("automation", () => deliverMail({ type: "DOCUMENTS", to: fresh, subject: "zz", text: "zz" }));
    } catch {
      deskzoSent = false;
    }
    ok("  somebody under the limit: counted as it goes", (await counted(fresh)) === (deskzoSent ? 1 : 0), { deskzoSent });
    let invoiceRefused: unknown = null;
    try {
      await deliverMail({ type: "DOCUMENTS", to: asha, subject: "zz", text: "zz" });
    } catch (err) {
      invoiceRefused = err;
    }
    ok("  an invoice sent by hand through Deskzo still goes to them", !(invoiceRefused instanceof Error && invoiceRefused.message.includes("24 hours")), String(invoiceRefused));

    section("5. Sends at once can't slip past together");
    const rush = addr("rush");
    const all = await Promise.all(Array.from({ length: 6 }, () => cap.countedAs("marketing", () => cap.reserveCustomerMail([rush], "check"))));
    ok("six at once at a limit of 2: two go, four are refused", all.filter((r) => r.ok).length === 2 && (await counted(rush)) === 2, all.map((r) => r.ok));
    const given = all.find((r) => r.ok);
    if (given) await cap.releaseCustomerMail(given);
    ok("  one given back frees its place", (await cap.countedAs("marketing", () => cap.reserveCustomerMail([rush], "check"))).ok);

    section("6. Settings shows who's at the limit");
    const atLimit = await cap.addressesAtLimit();
    ok("the addresses at it, with their counts", atLimit.some((a) => a.address === asha && a.count === 2), atLimit.filter((a) => a.address.endsWith("zz-mail-cap.test")));
  } finally {
    await db.customerMailSend.deleteMany({ where: { address: { endsWith: "@zz-mail-cap.test" } } });
    if (before) await setLimit(before.maxPerRecipientPerDay);
    else await db.customerEmailSettings.updateMany({ where: { id: "global" }, data: { maxPerRecipientPerDay: null } });
    await db.$disconnect();
  }

  console.log(`\n${failures === 0 ? `All ${passes} customer mail limit checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
