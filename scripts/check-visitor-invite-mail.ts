/**
 * A visitor's invitation code by email (owner, 18 Nov 2026 — src/lib/visitors/invite-mail.ts): what it says, who it goes
 * to, and when it isn't sent. Against the local workspace, on invitations of its own, with nothing really sent.
 *
 *   npm run check:visitor-invite-mail
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

async function main() {
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const mail = require("../src/lib/visitors/invite-mail") as typeof import("../src/lib/visitors/invite-mail");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const sent: { to: string; subject: string; text: string; html: string; replyTo: string | null }[] = [];
  mail.setInviteTestMailer(async (m) => {
    sent.push(m);
  });

  const host = await db.user.findFirst({ where: { active: true }, select: { id: true, name: true, email: true } });
  if (!host) throw new Error("no user to host");
  const tag = randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z2-9]/g, "X");
  const made: string[] = [];
  const invite = async (data: { name: string; email?: string | null; status?: "PENDING" | "CANCELLED" }) => {
    const row = await db.visitorInvite.create({
      data: {
        code: `Z${tag.slice(0, 5)}${"ABCDEFGHJK"[made.length]}Z`,
        name: data.name,
        email: data.email ?? null,
        status: data.status ?? "PENDING",
        hostUserId: host.id,
        createdById: host.id,
        expectedAt: new Date(Date.now() + 86_400_000),
      },
      select: { id: true, code: true },
    });
    made.push(row.id);
    return row;
  };

  try {
    const asha = await invite({ name: "Asha Visitor", email: `asha.${tag.toLowerCase()}@zzvisit.invalid` });
    const r = await mail.emailVisitorInvite(asha.id, host.id);
    const m = sent[0];
    ok("an invitation with an email address is emailed", r.ok && sent.length === 1 && m?.to === `asha.${tag.toLowerCase()}@zzvisit.invalid`, r);
    ok("  the code is in the subject, the text and the HTML", !!m && m.subject.includes(asha.code) && m.text.includes(asha.code) && m.html.includes(asha.code));
    ok("  it says who they're seeing", !!m && m.text.includes(host.name) && m.html.includes(host.name.replace(/&/g, "&amp;")));
    ok("  replies go to the host", m?.replyTo === (host.email || null));

    const bold = await invite({ name: "<b>Ravi</b>", email: `ravi.${tag.toLowerCase()}@zzvisit.invalid` });
    await mail.emailVisitorInvite(bold.id, host.id);
    ok("  a name with markup is escaped in the HTML", !sent[1]?.html.includes("<b>Ravi</b>") && !!sent[1]?.html.includes("&lt;b&gt;Ravi&lt;/b&gt;"));

    const none = await invite({ name: "No Mail" });
    const r2 = await mail.emailVisitorInvite(none.id, host.id);
    ok("no address: not sent, and it says so", !r2.ok && /no email address/i.test(r2.ok ? "" : r2.error) && sent.length === 2);

    const off = await invite({ name: "Called Off", email: `off.${tag.toLowerCase()}@zzvisit.invalid`, status: "CANCELLED" });
    const r3 = await mail.emailVisitorInvite(off.id, host.id);
    ok("a cancelled invitation isn't sent", !r3.ok && sent.length === 2, r3);

    const r4 = await mail.emailVisitorInvite("zz-not-there", host.id);
    ok("one that isn't there says so", !r4.ok);
  } finally {
    await db.visitorInvite.deleteMany({ where: { id: { in: made } } });
    await db.$disconnect();
  }
  console.log(`\n${failures === 0 ? `All ${passes} visitor invitation email checks passed.` : `${failures} check(s) FAILED (${passes} passed).`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
