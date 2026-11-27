/**
 * Invisible and control characters are taken out of what is saved, and nothing else is (owner, 15 Nov 2026 —
 * src/lib/text/clean.ts, applied in src/lib/db.ts to every write, inside transactions too).
 *
 *   npx tsx scripts/check-text-clean.ts
 *
 * Characters are built from their codes, never written as escapes in this file.
 */
import { db } from "../src/lib/db";
import { cleanText, cleanWriteArgs, cleanWriteData } from "../src/lib/text/clean";

let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failed += 1;
}
const ch = (...codes: number[]) => String.fromCharCode(...codes);
const ZWSP = ch(0x200b), BOM = ch(0xfeff), RLO = ch(0x202e), NUL = ch(0), BEL = ch(7), DEL = ch(0x7f), C1 = ch(0x85);
const ZWJ = ch(0x200d), ZWNJ = ch(0x200c), RLM = ch(0x200f);

async function main() {
  console.log("The rules");
  ok("zero-width space, BOM and a direction override go", cleanText(`Ac${ZWSP}me${BOM} ${RLO}Ltd`) === "Acme Ltd");
  ok("control characters go: NUL, BEL, DEL, C1", cleanText(`a${NUL}b${BEL}c${DEL}d${C1}e`) === "abcde");
  ok("tab, new line and carriage return stay", cleanText("a\tb\nc\r\nd") === "a\tb\nc\r\nd");
  const hindi = `क्${ZWNJ}ष`, emoji = `👩${ZWJ}💻`, arabic = `مرحبا${RLM}`;
  ok("Hindi's non-joiner, an emoji's joiner and Arabic's right-to-left mark stay", cleanText(hindi) === hindi && cleanText(emoji) === emoji && cleanText(arabic) === arabic);
  const plain = "Nothing to clean here";
  ok("a clean string comes back as the same string", cleanText(plain) === plain);
  const data = { name: `Zz${ZWSP}`, nested: { create: [{ title: `t${BEL}` }] }, when: new Date(0), count: 3, json: { note: `n${NUL}` } };
  const cleaned = cleanWriteData(data);
  ok("nested creates, lists and JSON are cleaned", cleaned.name === "Zz" && cleaned.nested.create[0]!.title === "t" && cleaned.json.note === "n");
  ok("  dates and numbers untouched", cleaned.when === data.when && cleaned.count === 3);
  const untouched = { data: { name: "fine" } };
  ok("a write with nothing to clean is passed through as it came", cleanWriteArgs("create", [untouched])[0] === untouched);
  ok("a read is never changed", cleanWriteArgs("findMany", [{ where: { name: `x${ZWSP}` } }])[0] !== undefined && (cleanWriteArgs("findMany", [{ where: { name: `x${ZWSP}` } }])[0] as { where: { name: string } }).where.name === `x${ZWSP}`);
  const up = cleanWriteArgs("upsert", [{ where: { id: "1" }, create: { name: `a${ZWSP}` }, update: { name: `b${BEL}` } }])[0] as { create: { name: string }; update: { name: string } };
  ok("an upsert's create and update are both cleaned", up.create.name === "a" && up.update.name === "b");

  console.log("Saved");
  const user = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!user) throw new Error("Seed the app first — this needs a user.");
  const stamp = Date.now();
  const ids: string[] = [];
  try {
    const direct = await db.company.create({
      data: { name: `ZzClean${ZWSP} Direct ${stamp}${BEL}`, normalizedName: `zzclean direct ${stamp}`, createdById: user.id },
      select: { id: true, name: true },
    });
    ids.push(direct.id);
    ok("through db: stored without the invisible and control characters", direct.name === `ZzClean Direct ${stamp}`, direct.name);
    const viaTx = await db.$transaction(async (tx) =>
      tx.company.create({ data: { name: `ZzClean${RLO} Tx ${stamp}`, normalizedName: `zzclean tx ${stamp}`, createdById: user.id }, select: { id: true, name: true } }),
    );
    ids.push(viaTx.id);
    ok("inside a transaction too", viaTx.name === `ZzClean Tx ${stamp}`, viaTx.name);
    const kept = await db.company.update({ where: { id: direct.id }, data: { name: `ZzClean ${hindi} ${stamp}` }, select: { name: true } });
    ok("  and Hindi text is saved as typed", kept.name === `ZzClean ${hindi} ${stamp}`);
  } finally {
    await db.company.deleteMany({ where: { id: { in: ids } } });
  }

  console.log(failed ? `\n${failed} failed` : "\nAll text clean-up checks passed.");
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
