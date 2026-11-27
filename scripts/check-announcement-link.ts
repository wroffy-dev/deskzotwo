/**
 * check:announcement-link — "Know more" on a platform announcement (owner, 20 Nov 2026 — src/lib/platform/announcements.ts).
 *
 *   1. Only a page on the platform's own site: deskzo.com or www.deskzo.com, https, its own port, no name or password.
 *   2. Never anywhere else — another site, a look-alike, a workspace's subdomain, javascript:, data:, //host.
 *   3. "/blog/x" is a page on the site; empty is no link.
 *   4. A save is refused for a link elsewhere, and kept for one on the site.
 *   5. A workspace is never shown a stored link that doesn't pass — checked again as it is shown.
 *
 * Pure but for (5), which hands the workspace side its own rows: no database.
 *
 *   npm run check:announcement-link
 */
import "dotenv/config";
import assert from "node:assert/strict";

// The platform as production has it, set before the host module reads it.
process.env.PLATFORM_DOMAIN = "deskzo.com";
// Emptied rather than deleted: a Prisma client reloads .env, which would put a deleted one back.
process.env.PLATFORM_PORT = "";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function main() {
  const { linkProblem, announcementLink, validateAnnouncement, activeAnnouncementsFor } = await import("../src/lib/platform/announcements");
  const ok = (v: string) => {
    const r = linkProblem(v);
    assert.ok("link" in r, `${v} should pass: ${"problem" in r ? r.problem : ""}`);
    return r.link;
  };
  const refused = (v: string) => assert.ok("problem" in linkProblem(v), `${v} should be refused`);

  console.log("1. The platform's own site");
  await test("deskzo.com and www.deskzo.com, https", () => {
    assert.equal(ok("https://deskzo.com/blog/maintenance-21-november"), "https://deskzo.com/blog/maintenance-21-november");
    assert.equal(ok("https://www.deskzo.com/help/status?x=1#when"), "https://www.deskzo.com/help/status?x=1#when");
    assert.equal(ok("https://DESKZO.com/Blog"), "https://deskzo.com/Blog");
  });

  console.log("2. Never anywhere else");
  await test("another site, or one that only looks like ours", () => {
    refused("https://evil.com/deskzo.com");
    refused("https://deskzo.com.evil.com/x");
    refused("https://deskzo.co/x");
    refused("https://evil.com?u=https://deskzo.com");
  });
  await test("a workspace's own subdomain — its owner writes those pages", () => {
    refused("https://acme.deskzo.com/book/demo");
    refused("https://admin.deskzo.com/x");
  });
  await test("plain http, another port, a name and password in it", () => {
    refused("http://deskzo.com/x");
    refused("https://deskzo.com:8443/x");
    refused("https://user:pass@deskzo.com/x");
    refused("https://deskzo.com@evil.com/x");
  });
  await test("javascript:, data:, a protocol-relative address", () => {
    refused("javascript:alert(1)");
    refused("data:text/html,<b>x</b>");
    refused("//evil.com/x");
    refused("ftp://deskzo.com/x");
  });
  await test("over-long", () => refused(`https://deskzo.com/${"a".repeat(500)}`));

  console.log("3. A path, or nothing");
  await test("/blog/x is a page on the site", () => assert.equal(ok("/blog/maintenance"), "https://deskzo.com/blog/maintenance"));
  await test("empty is no link", () => {
    assert.equal(ok("   "), null);
    assert.deepEqual(linkProblem(undefined), { link: null });
    assert.equal(announcementLink("https://evil.com"), null);
  });

  console.log("4. Saving");
  const now = new Date("2026-11-20T10:00:00Z");
  const base = { title: "Planned maintenance", body: "Workspaces will be unavailable for 30 minutes.", tone: "WARNING", audience: "COUNTRIES", targets: ["IN"], endsAt: "2026-11-22T00:00:00Z" };
  await test("a link elsewhere is refused, saying where it may go", () => {
    assert.throws(() => validateAnnouncement({ ...base, link: "https://evil.com/x" }, now), /only link to a page on deskzo\.com/);
  });
  await test("a link on the site is kept; none is null", () => {
    assert.equal(validateAnnouncement({ ...base, link: "/blog/maintenance" }, now).link, "https://deskzo.com/blog/maintenance");
    assert.equal(validateAnnouncement(base, now).link, null);
  });

  console.log("5. What a workspace is shown");
  const tenant = { id: "t1", country: "IN", entitlements: { plans: [] }, source: "control" } as unknown as Parameters<typeof activeAnnouncementsFor>[0];
  const row = (id: string, link: string | null) => ({ id, title: "Maintenance", body: "Tonight.", tone: "WARNING" as const, audience: "ALL" as const, targets: [], startsAt: new Date("2026-11-20T00:00:00Z"), endsAt: null, dismissible: true, link });
  await test("a stored link elsewhere is dropped; one on the site is kept", async () => {
    if (!process.env.CONTROL_DATABASE_URL) {
      console.log("      (skipped: no control plane configured here)");
      return;
    }
    const shown = await activeAnnouncementsFor(tenant, now, async () => [row("a", "https://evil.com/x"), row("b", "https://deskzo.com/blog/x")]);
    assert.equal(shown.find((s) => s.id === "a")?.link, null);
    assert.equal(shown.find((s) => s.id === "b")?.link, "https://deskzo.com/blog/x");
  });

  console.log(`\nAll ${passed} announcement link checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
