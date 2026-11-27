/**
 * check:tax-defaults — the workspace's default tax rate (owner, 23 Nov 2026: "do both... see how zoho books has" — Zoho
 * Books' Default Tax Preference; src/actions/tax-defaults.ts, src/lib/country-pack.ts).
 *
 *   · GST's rates since 22 Sep 2025: 0, 5, 18 and 40, with 12 and 28 kept.
 *   · A workspace's chosen rate is what `workspacePack()` starts new items and lines with; none, or one that isn't its
 *     country's, leaves the country's own.
 *   · Settings › Taxes saves it on the workspace (the country's own kept as none), refuses a rate the country hasn't, and
 *     only for whoever manages settings.
 *   · Items with no rate are given the default; an exempt, zero-rated or out-of-scope one, or one with a rate, isn't.
 *
 * The control plane stands in (what is written to it is caught); items are made here and only they are counted or
 * changed — the local database's own items are never touched. Everything made is removed.
 *
 *   npm run check:tax-defaults
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

const real = directClient();
const fixture: string[] = [];
const written: { id: string; defaultTaxRate: unknown }[] = [];
let mayManage = true;
let actorId = "";

const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {} };
  if (request === "@/lib/session") return { requireUser: async () => ({ id: actorId, name: "Probe" }) };
  if (request === "@/actions/permission") return { hasEffectivePermission: async () => mayManage };
  if (request === "@/lib/audit") return { recordAudit: async () => {} };
  const fromAction = String((parent as { filename?: string })?.filename ?? "").includes("tax-defaults");
  if (request === "@/lib/platform/control-db" && fromAction) {
    return { controlDb: () => ({ tenant: { update: async (args: { where: { id: string }; data: { defaultTaxRate: unknown } }) => void written.push({ id: args.where.id, defaultTaxRate: args.data.defaultTaxRate }) } }) };
  }
  // The action's items are this suite's only: whatever it asks is narrowed to the fixture.
  if (request === "@/lib/db" && fromAction) {
    const only = (where: object) => ({ AND: [where, { id: { in: fixture } }] });
    return {
      db: {
        item: {
          count: (args: { where: object }) => real.item.count({ where: only(args.where) }),
          updateMany: (args: { where: object; data: object }) => real.item.updateMany({ where: only(args.where), data: args.data }),
        },
      },
    };
  }
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const pack = require("../src/lib/country-pack") as typeof import("../src/lib/country-pack");
  require("../src/lib/tenancy/workspace-country");
  const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { legacyTenant } = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
  const actions = require("../src/actions/tax-defaults") as typeof import("../src/actions/tax-defaults");
  const { GST_RATES } = require("../src/lib/side-rail") as typeof import("../src/lib/side-rail");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const env = await legacyTenant();
  if (!env) throw new Error("No local workspace.");
  const as = (country: string, defaultTaxRate: number | null, source: "control" | "env" = "control") => ({ ...env, id: "zz-tax-tenant", country, defaultTaxRate, source });
  const admin = await real.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
  actorId = admin.id;

  try {
    section("GST's rates");
    const india = pack.countryPack("IN").tax;
    ok("0, 5, 18 and 40, with 12 and 28 kept", [0, 5, 12, 18, 28, 40].every((r) => india.rates.includes(r)) && india.rates.length === 6, india.rates);
    ok("  the calculator's and setup's list the same", GST_RATES.join() === india.rates.join());
    ok("  18% the usual one", india.defaultRate === 18);

    section("The rates an item may have");
    const IN = pack.countryPack("IN");
    const items = pack.itemTaxRates(IN);
    ok("in India: GST's rates, and the special ones below", items.main.join() === "0,5,12,18,28,40" && items.special.join() === "0.1,0.25,1,1.5,3,6,7.5", items);
    ok("  18, 40 and 0.25 allowed; 18.11 and 17 not", pack.isItemTaxRate(IN, 18) && pack.isItemTaxRate(IN, 40) && pack.isItemTaxRate(IN, 0.25) && !pack.isItemTaxRate(IN, 18.11) && !pack.isItemTaxRate(IN, 17));
    ok("in the UAE: 0 and 5 only", pack.isItemTaxRate(pack.countryPack("AE"), 5) && !pack.isItemTaxRate(pack.countryPack("AE"), 18));
    ok("where the country has no list: any rate", pack.itemTaxRates(pack.countryPack("US")).main.length === 0 && pack.isItemTaxRate(pack.countryPack("US"), 8.875));

    section("What new items and lines start with");
    ok("no rate chosen: the country's own", runAsTenant(as("IN", null), () => pack.workspacePack().tax.defaultRate) === 18);
    ok("5% chosen: 5%", runAsTenant(as("IN", 5), () => pack.workspacePack().tax.defaultRate) === 5);
    ok("40% chosen: 40%", runAsTenant(as("IN", 40), () => pack.workspacePack().tax.defaultRate) === 40);
    ok("a rate that isn't GST's (7%): the country's own", runAsTenant(as("IN", 7), () => pack.workspacePack().tax.defaultRate) === 18);
    ok("in the UAE, 0% chosen: 0%; 18% (not the UAE's): 5%", runAsTenant(as("AE", 0), () => pack.workspacePack().tax.defaultRate) === 0 && runAsTenant(as("AE", 18), () => pack.workspacePack().tax.defaultRate) === 5);
    ok("the country's own pack is left as it was", pack.countryPack("IN").tax.defaultRate === 18);

    section("Settings › Taxes");
    const shown = await runAsTenant(as("IN", 5), () => actions.getTaxDefaults());
    ok("shows the chosen rate, the usual one and GST's rates", shown?.rate === 5 && shown.chosen && shown.countryDefault === 18 && shown.rates.includes(40) && shown.changeable, shown);
    written.length = 0;
    const set5 = await runAsTenant(as("IN", null), () => actions.setDefaultTaxRate({ rate: 5 }));
    ok("saving 5%: kept on the workspace", set5.ok && written.length === 1 && written[0]!.defaultTaxRate === 5, { set5, written });
    written.length = 0;
    const back = await runAsTenant(as("IN", 5), () => actions.setDefaultTaxRate({ rate: 18 }));
    ok("back to 18%, the usual: kept as none chosen", back.ok && written.length === 1 && written[0]!.defaultTaxRate === null, written);
    written.length = 0;
    const same = await runAsTenant(as("IN", null), () => actions.setDefaultTaxRate({ rate: 18 }));
    ok("  the same again: nothing written", same.ok && written.length === 0);
    const odd = await runAsTenant(as("IN", null), () => actions.setDefaultTaxRate({ rate: 7 }));
    ok("7%, not a GST rate: refused", !odd.ok && written.length === 0, odd);
    const envSet = await runAsTenant(as("IN", null, "env"), () => actions.setDefaultTaxRate({ rate: 5 }));
    ok("a workspace from the server's configuration: refused", !envSet.ok && written.length === 0);
    mayManage = false;
    const notAdmin = await runAsTenant(as("IN", null), () => actions.setDefaultTaxRate({ rate: 5 }));
    const notAdminView = await runAsTenant(as("IN", null), () => actions.getTaxDefaults());
    ok("without settings.manage: refused, and the page isn't theirs", !notAdmin.ok && notAdminView === null && written.length === 0);
    mayManage = true;

    section("Items with no rate");
    const run = Date.now().toString(36);
    const mk = async (tag: string, data: object) => {
      const it = await real.item.create({ data: { name: `Zz tax ${run} ${tag}`, sku: `ZZTAX-${run}-${tag}`, type: "GOOD", sellingPrice: 100, createdById: admin.id, ...data }, select: { id: true } });
      fixture.push(it.id);
      return it.id;
    };
    const bare = await mk("bare", {});
    const standard = await mk("standard", { taxCategory: "STANDARD" });
    const exempt = await mk("exempt", { taxCategory: "EXEMPT" });
    const zero = await mk("zero", { taxCategory: "ZERO_RATED" });
    const rated = await mk("rated", { taxRatePercent: 12 });
    const count = await runAsTenant(as("IN", 5), () => actions.getTaxDefaults());
    ok("counted: the two with no rate that could have one", count?.itemsWithoutRate === 2, count?.itemsWithoutRate);
    const filled = await runAsTenant(as("IN", 5), () => actions.fillItemsWithoutRate());
    const rates = Object.fromEntries((await real.item.findMany({ where: { id: { in: fixture } }, select: { id: true, taxRatePercent: true } })).map((i) => [i.id, i.taxRatePercent == null ? null : Number(i.taxRatePercent)]));
    ok("given the default, 5%", filled.ok && filled.data.filled === 2 && rates[bare] === 5 && rates[standard] === 5, { filled, rates });
    ok("  exempt and zero-rated left alone", rates[exempt] === null && rates[zero] === null);
    ok("  one with its own rate keeps it", rates[rated] === 12);
    const again = await runAsTenant(as("IN", 5), () => actions.fillItemsWithoutRate());
    ok("run again: nothing to give", again.ok && again.data.filled === 0);
  } finally {
    await real.item.deleteMany({ where: { id: { in: fixture } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} tax default checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
