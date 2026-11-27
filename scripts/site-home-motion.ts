/**
 * The new home page (owner, 18 Nov 2026: "i love their frontend website ! lets do similar for deskzo" — then "Build
 * it") into a home page that is published in the website CMS. The built-in home page has it already; a home page
 * someone published from the CMS is that copy, and keeps showing the earlier one until these are added there. The new
 * look of the blocks themselves (the dark hero, the marquee, the figures, the product cards, the dark closing band)
 * needs nothing here — it is the blocks' own.
 *
 *   npm run site:home-motion              add what's missing, and publish
 *   npm run site:home-motion -- --dry-run say what it would do; write nothing
 *
 * What it adds, each only when the page doesn't have one already:
 *   · in the hero: words that take turns after the headline — and the headline becomes the built-in one, "One
 *     workspace for your", which they finish (a headline already written to be finished is left alone);
 *   · the workflow steps, after the product strip (else after the trust strip, else the hero);
 *   · the AI questions, after the module groups (else before the closing calls to action);
 *   · the AI teammates (owner, 19 Nov 2026), after the AI questions;
 *   · the live demo on the visitor's website (owner, 22 Nov 2026), straight after the hero;
 *   · the AI team at work, replayed on a made-up company (owner, 22 Nov 2026), straight after the AI teammates.
 * Nothing is taken away. The words are the built-in page's (src/components/site/defaults.ts), editable in the CMS
 * afterwards. It refuses when the home page has changes saved but not yet published — publishing would publish those
 * too. Runs against CONTROL_DATABASE_URL; the publish is in the CMS's history as "script".
 */
import "dotenv/config";
import type { HeroProps, SiteBlock } from "../src/components/site/blocks/types";
import { DEFAULT_SITE_PAGES, HOME_AI, HOME_DEMO, HOME_TEAM, HOME_TEAM_DEMO, HOME_WORKFLOW } from "../src/components/site/defaults";
import { refLabels } from "../src/lib/cms/audit";
import { publishPage } from "../src/lib/cms/content";
import type { CmsMe, PageDocument } from "../src/lib/cms/types";
import { stableJson } from "../src/lib/cms/validate";
import { closeControlDb, controlConfigured, controlDb } from "../src/lib/platform/control-db";

const SCRIPT: CmsMe = { id: "script", email: "", name: "Script", role: "ADMIN", script: true };
const dryRun = process.argv.includes("--dry-run");

async function main() {
  if (!controlConfigured()) throw new Error("CONTROL_DATABASE_URL is not set: the home page is in the control plane's website content.");
  const row = await controlDb().sitePage.findUnique({ where: { slug: "home" } });
  if (!row || row.status !== "PUBLISHED" || !row.published) {
    console.log("The home page isn't published from the CMS, so the site shows its built-in home page, which has the new one. Nothing to do.");
    return;
  }
  if (row.archivedAt) {
    console.log("The home page is archived in the CMS. Nothing done.");
    return;
  }
  if (stableJson(row.draft) !== stableJson(row.published)) {
    const by = (await refLabels([row.updatedBy])).get(row.updatedBy) ?? row.updatedBy;
    console.log(
      `The home page has changes saved but not published (last saved by ${by} on ${row.updatedAt.toISOString().slice(0, 10)}). Publishing would publish them too, so nothing is done: publish or discard those changes and run this again.`,
    );
    process.exitCode = 1;
    return;
  }

  const published = row.published as unknown as PageDocument;
  const blocks: SiteBlock[] = structuredClone(published.blocks);
  const taken = new Set(blocks.map((b) => b.id));
  const fresh = (block: SiteBlock): SiteBlock => ({ ...structuredClone(block), id: taken.has(block.id) ? `${block.id}-${Date.now().toString(36)}` : block.id });
  const done: string[] = [];

  // The hero's words that take turns, finishing the built-in headline.
  const builtInHero = DEFAULT_SITE_PAGES.find((p) => p.slug === "home")?.blocks.find((b) => b.type === "hero")?.props as HeroProps | undefined;
  const heroAt = blocks.findIndex((b) => b.type === "hero");
  if (heroAt >= 0 && builtInHero?.rotatingWords?.length) {
    const hero = blocks[heroAt] as Extract<SiteBlock, { type: "hero" }>;
    if (!hero.props.rotatingWords?.length) {
      const props: HeroProps = { ...hero.props, rotatingWords: [...builtInHero.rotatingWords] };
      // A headline that ends on "your", "for" or the like is already written to be finished; any other is replaced.
      if (!/\b(your|for|to|in)\s*$/i.test(props.heading)) props.heading = builtInHero.heading;
      if (builtInHero.subheading) props.subheading = builtInHero.subheading;
      blocks[heroAt] = { ...hero, props };
      done.push(`the hero's turning words (${builtInHero.rotatingWords.join(", ")}) and its headline "${props.heading} …"`);
    }
  }

  // The workflow, after the product strip — else the trust strip, else the hero.
  if (!blocks.some((b) => b.type === "workflow")) {
    const after = ["productStrip", "trustStrip", "hero"].map((type) => blocks.findIndex((b) => b.type === type)).find((i) => i >= 0) ?? -1;
    blocks.splice(after + 1, 0, fresh(HOME_WORKFLOW));
    done.push("the workflow steps");
  }

  // The AI questions, after the module groups — else before the closing calls to action. (Not "before the figures":
  // on a page published before 18 Nov they sit straight under the hero.)
  if (!blocks.some((b) => b.type === "aiShowcase")) {
    let at = blocks.findIndex((b) => b.type === "moduleGrid") + 1;
    if (at <= 0) {
      at = blocks.length;
      while (at > 0 && blocks[at - 1]!.type === "cta") at -= 1;
    }
    blocks.splice(at, 0, fresh(HOME_AI));
    done.push("the AI questions");
  }

  // The AI teammates, straight after the AI questions — else before the closing calls to action.
  if (!blocks.some((b) => b.type === "aiTeam")) {
    let at = blocks.findIndex((b) => b.type === "aiShowcase") + 1;
    if (at <= 0) {
      at = blocks.length;
      while (at > 0 && blocks[at - 1]!.type === "cta") at -= 1;
    }
    blocks.splice(at, 0, fresh(HOME_TEAM));
    done.push("the AI teammates");
  }

  // The live demo, straight after the hero — where a visitor is still deciding.
  if (!blocks.some((b) => b.type === "liveDemo")) {
    blocks.splice(blocks.findIndex((b) => b.type === "hero") + 1, 0, fresh(HOME_DEMO));
    done.push("the live demo");
  }

  // The AI team at work, straight after the teammates are met — else after the AI questions, else before the closing
  // calls to action. A replay on a made-up company: no AI behind it.
  if (!blocks.some((b) => b.type === "aiTeamDemo")) {
    let at = blocks.findIndex((b) => b.type === "aiTeam") + 1;
    if (at <= 0) at = blocks.findIndex((b) => b.type === "aiShowcase") + 1;
    if (at <= 0) {
      at = blocks.length;
      while (at > 0 && blocks[at - 1]!.type === "cta") at -= 1;
    }
    blocks.splice(at, 0, fresh(HOME_TEAM_DEMO));
    done.push("the AI team at work");
  }

  if (!done.length) {
    console.log("The home page has the new home page's blocks already. Nothing done.");
    return;
  }
  if (dryRun) {
    console.log(`Would add to the home page: ${done.join("; ")} — and publish it.`);
    return;
  }
  await publishPage(row.id, { document: { ...published, blocks }, version: row.updatedAt.toISOString(), note: "The new home page (site:home-motion)" }, SCRIPT);
  console.log(`Added to the home page: ${done.join("; ")} — and published it.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
