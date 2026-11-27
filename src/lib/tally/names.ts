/**
 * A Tally company, ledger or item name as typed (src/lib/tally): Tally matches names exactly, so only stray spacing and
 * control characters are taken out — never case or punctuation. Pure.
 */
export function cleanTallyName(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
