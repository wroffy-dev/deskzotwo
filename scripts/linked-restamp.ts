/**
 * Moves linked sign-in members made before two-factor joined the credential stamp onto the new stamp — once,
 * at deploy, before the next nightly sweep (security audit, Nov 2026; restampLegacyLinks in
 * src/lib/platform/linked/sweep.ts). Idempotent. Skip it, and every older link is unlinked by the sweep instead.
 *
 *   npm run linked:restamp
 */
import { restampLegacyLinks } from "../src/lib/platform/linked/sweep";

restampLegacyLinks()
  .then((r) => {
    console.log(`Linked sign-in: ${r.checked} member(s) checked, ${r.restamped} moved to the new stamp.`);
    for (const f of r.failed) console.warn(`  could not check ${f}`);
    process.exit(r.failed.length ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
