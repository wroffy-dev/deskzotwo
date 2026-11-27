/**
 * The home page refresh (owner, 15 Nov 2026: "upgrade the frontend website … improve design and ui") into a home page
 * that is published in the website CMS. The built-in home page has it already; a home page someone published from the
 * CMS is that copy, and keeps showing it until these are added there.
 *
 *   npm run site:home-refresh              add what's missing, and publish
 *   npm run site:home-refresh -- --dry-run say what it would do; write nothing
 *
 * What it adds, each only when the page doesn't have one already:
 *   · in the hero: the product as tabs (Sales, Invoices, People, Support), and a third button when it has two — "Book
 *     a demo" when neither button already leads to the demo form;
 *   · a trust strip straight under the hero;
 *   · the comparison cards ("How it stacks up") and the contact options before the closing calls to action.
 * The words are the built-in page's (src/components/site/defaults.ts), editable in the CMS afterwards. It refuses when
 * the home page has changes saved but not yet published — publishing would publish those too. Runs against
 * CONTROL_DATABASE_URL; the publish is in the CMS's history as "script".
 */
import "dotenv/config";
import type { HeroProps, SiteAction, SiteBlock } from "../src/components/site/blocks/types";
import { HOME_COMPARE, HOME_CONTACT, HOME_TRUST_STRIP } from "../src/components/site/defaults";
import { refLabels } from "../src/lib/cms/audit";
import { publishPage } from "../src/lib/cms/content";
import type { CmsMe, PageDocument } from "../src/lib/cms/types";
import { stableJson } from "../src/lib/cms/validate";
import { closeControlDb, controlConfigured, controlDb } from "../src/lib/platform/control-db";

const SCRIPT: CmsMe = { id: "script", email: "", name: "Script", role: "ADMIN", script: true };
const dryRun = process.argv.includes("--dry-run");

const TABS: NonNullable<HeroProps["previewTabs"]> = [
  { label: "Sales", preview: "pipeline" },
  { label: "Invoices", preview: "invoice" },
  { label: "People", preview: "attendance" },
  { label: "Support", preview: "tickets" },
];
const DEMO: SiteAction = { kind: "link", label: "Book a demo", href: "/contact?topic=demo" };
const leadsToDemo = (a?: SiteAction) => a?.kind === "link" && /topic=demo/.test(a.href);

async function main() {
  if (!controlConfigured()) throw new Error("CONTROL_DATABASE_URL is not set: the home page is in the control plane's website content.");
  const row = await controlDb().sitePage.findUnique({ where: { slug: "home" } });
  if (!row || row.status !== "PUBLISHED" || !row.published) {
    console.log("The home page isn't published from the CMS, so the site shows its built-in home page, which has the refresh. Nothing to do.");
    return;
  }
  if (row.archivedAt) {
    console.log("The home page is archived in the CMS. Nothing done.");
    return;
  }
  if (stableJson(row.draft) !== stableJson(row.published)) {
    const by = (await refLabels([row.updatedBy])).get(row.updatedBy) ?? row.updatedBy;
    console.log(
      `The home page has changes saved but not published (last saved by ${by} on ${row.updatedAt.toISOString().slice(0, 10)}). Publishing the refresh would publish them too, so nothing is done: publish or discard those changes and run this again.`,
    );
    process.exitCode = 1;
    return;
  }

  const published = row.published as unknown as PageDocument;
  const blocks: SiteBlock[] = structuredClone(published.blocks);
  const taken = new Set(blocks.map((b) => b.id));
  const fresh = (block: SiteBlock): SiteBlock => ({ ...structuredClone(block), id: taken.has(block.id) ? `${block.id}-${Date.now().toString(36)}` : block.id });
  const done: string[] = [];

  // The hero: tabs, and a third button.
  const heroAt = blocks.findIndex((b) => b.type === "hero");
  if (heroAt >= 0) {
    const hero = blocks[heroAt] as Extract<SiteBlock, { type: "hero" }>;
    const props: HeroProps = { ...hero.props };
    if (!props.previewTabs?.length) {
      props.previewTabs = TABS;
      done.push("the product tabs in the hero");
    }
    if (!props.tertiary && props.primary && props.secondary && !leadsToDemo(props.primary) && !leadsToDemo(props.secondary)) {
      props.tertiary = DEMO;
      done.push(`a third hero button, "${DEMO.label}"`);
    }
    blocks[heroAt] = { ...hero, props };
  }

  // The trust strip, straight under the hero.
  if (!blocks.some((b) => b.type === "trustStrip")) {
    blocks.splice(heroAt >= 0 ? heroAt + 1 : 0, 0, fresh(HOME_TRUST_STRIP));
    done.push("the trust strip under the hero");
  }

  // The comparisons and the contact options, before the closing calls to action.
  const closing = () => {
    let at = blocks.length;
    while (at > 0 && blocks[at - 1]!.type === "cta") at -= 1;
    return at;
  };
  const hasCompare = blocks.some((b) => b.type === "relatedLinks" && (b.props as { links?: { href: string }[] }).links?.some((l) => l.href.startsWith("/compare/")));
  if (!hasCompare) {
    blocks.splice(closing(), 0, fresh(HOME_COMPARE));
    done.push("the comparison cards");
  }
  if (!blocks.some((b) => b.type === "contactOptions")) {
    blocks.splice(closing(), 0, fresh(HOME_CONTACT));
    done.push("the contact options");
  }

  if (!done.length) {
    console.log("The home page has the refresh already. Nothing done.");
    return;
  }
  if (dryRun) {
    console.log(`Would add to the home page: ${done.join("; ")} — and publish it.`);
    return;
  }
  await publishPage(row.id, { document: { ...published, blocks }, version: row.updatedAt.toISOString(), note: "The home page refresh (site:home-refresh)" }, SCRIPT);
  console.log(`Added to the home page: ${done.join("; ")} — and published it.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
