import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { idCardIssuer, idCardsFor, readIdCardDesign } from "@/lib/id-cards/cards";
import { backsOrder, parseCardIds, sheetsOf } from "@/lib/id-cards/design";
import { IdCardBack, IdCardBlank, IdCardFront } from "@/components/hr/id-card";
import { PrintButton } from "@/components/billing/print-button";

export const metadata = { title: "ID cards" };

/** An ID card printer takes one side a page, edge to edge, at the card's own size. */
const CARD_PRINTER_PAGE = `
@page { size: 54mm 85.6mm; margin: 0; }
@media print { .id-side { break-after: page; } .id-side:last-child { break-after: auto; } }
`;

const A4_PAGE = `@media print { .id-sheet { break-after: page; } .id-sheet:last-child { break-after: auto; } }`;

/**
 * Employee ID cards to print (owner, 31 Oct 2026 — People › ID cards), for whoever manages people records. "a4": nine
 * to a sheet to cut out, each sheet's fronts then its backs mirrored, so printing both sides puts each back behind its
 * front. "card": one side a page for an ID card printer — front, back, next person.
 */
export default async function IdCardsPrintPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const one = (key: string) => (Array.isArray(query[key]) ? query[key][0] : query[key]) as string | undefined;
  const viewer = await currentUser();
  if (!viewer || !(await isModuleEnabled("hr")) || !(await can(viewer.id, "hr.manage"))) notFound();
  const ids = parseCardIds(one("ids"));
  const paper = one("paper") === "card" ? "card" : "a4";
  const design = await readIdCardDesign();
  const [cards, issuer] = await Promise.all([idCardsFor(ids, design), idCardIssuer(design)]);
  if (cards.length === 0) notFound();
  const switchTo = (p: string) => `/id-cards/print?${new URLSearchParams({ ids: ids.join(","), paper: p }).toString()}`;

  return (
    <div>
      <style>{paper === "card" ? CARD_PRINTER_PAGE : A4_PAGE}</style>
      <div className="mx-auto mb-4 flex max-w-[190mm] flex-wrap items-center justify-between gap-3 px-2 text-sm print:hidden">
        <div className="text-neutral-600">
          {cards.length} {cards.length === 1 ? "card" : "cards"} ·{" "}
          {paper === "a4" ? (
            <>
              A4, nine to a sheet — print on both sides, flipped on the long edge ·{" "}
              <Link href={switchTo("card")} className="text-blue-700 hover:underline">
                ID card printer instead
              </Link>
            </>
          ) : (
            <>
              ID card printer, one side a page ·{" "}
              <Link href={switchTo("a4")} className="text-blue-700 hover:underline">
                A4 sheets instead
              </Link>
            </>
          )}
        </div>
        <PrintButton />
      </div>

      {paper === "card" ? (
        <div className="mx-auto flex w-fit flex-col gap-4 print:gap-0">
          {cards.flatMap((c) => [
            <div key={`${c.userId}-f`} className="id-side">
              <IdCardFront data={c} issuer={issuer} outline={false} />
            </div>,
            <div key={`${c.userId}-b`} className="id-side">
              <IdCardBack data={c} issuer={issuer} backNote={design.backNote} outline={false} />
            </div>,
          ])}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-6 print:gap-0">
          {sheetsOf(cards).flatMap((sheet, s) => [
            <div key={`f${s}`} className="id-sheet grid w-fit grid-cols-3 gap-x-[6mm] gap-y-[4mm] bg-white p-[4mm] shadow print:p-0 print:shadow-none">
              {sheet.map((c) => (
                <IdCardFront key={c.userId} data={c} issuer={issuer} />
              ))}
            </div>,
            <div key={`b${s}`} className="id-sheet grid w-fit grid-cols-3 gap-x-[6mm] gap-y-[4mm] bg-white p-[4mm] shadow print:p-0 print:shadow-none">
              {backsOrder(sheet).map((c, i) => (c ? <IdCardBack key={c.userId} data={c} issuer={issuer} backNote={design.backNote} /> : <IdCardBlank key={`blank${i}`} />))}
            </div>,
          ])}
        </div>
      )}
    </div>
  );
}
