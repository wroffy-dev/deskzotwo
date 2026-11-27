/**
 * UAE banks and their WPS routing codes (owner, 15 Nov 2026 — "lets give top 10 banks of UAE"). The salary file (SIF)
 * is one layout for every bank — the Central Bank's (src/lib/uae/sif.ts) — so the bank only decides two codes in it: the
 * employer's bank in the control line, and each employee's bank (the "agent") on their line.
 *
 * Codes are the CBUAE's 9-digit head-office routing codes as Emirates Islamic's WPS guide lists them. A UAE IBAN carries
 * the bank as 3 digits after "AE" and the check digits (AE07 033 …), and those 3 digits are the bank's entity ID in the
 * same list — so an employee's routing code is read from their IBAN, and can be typed over where a bank says otherwise.
 * Banks have merged since the list was published: FAB's IBANs carry NBAD's 035, Emirates NBD's carry 026.
 */

export type WpsBank = { entityId: string; name: string; routingCode: string; top?: true };

/** The ten biggest banks first, as payroll picks its own bank from them. */
export const TOP_BANKS: WpsBank[] = [
  { entityId: "035", name: "First Abu Dhabi Bank (FAB)", routingCode: "603510102", top: true },
  { entityId: "026", name: "Emirates NBD", routingCode: "302620122", top: true },
  { entityId: "003", name: "Abu Dhabi Commercial Bank (ADCB)", routingCode: "600310101", top: true },
  { entityId: "024", name: "Dubai Islamic Bank", routingCode: "802420101", top: true },
  { entityId: "033", name: "Mashreq", routingCode: "203320101", top: true },
  { entityId: "050", name: "Abu Dhabi Islamic Bank (ADIB)", routingCode: "405010101", top: true },
  { entityId: "023", name: "Commercial Bank of Dubai", routingCode: "502320103", top: true },
  { entityId: "040", name: "RAKBANK", routingCode: "604060101", top: true },
  { entityId: "034", name: "Emirates Islamic", routingCode: "703420114", top: true },
  { entityId: "041", name: "Sharjah Islamic Bank", routingCode: "404130101", top: true },
];

/** The rest — for an employee's account elsewhere, and the exchange houses and salary-card agents many workers use. */
export const OTHER_BANKS: WpsBank[] = [
  { entityId: "004", name: "Al Ahli Bank of Kuwait", routingCode: "200420101" },
  { entityId: "007", name: "Arab African International Bank", routingCode: "500710102" },
  { entityId: "009", name: "Arab Bank", routingCode: "000910101" },
  { entityId: "011", name: "Bank of Baroda", routingCode: "801120101" },
  { entityId: "012", name: "Bank of Sharjah", routingCode: "401230101" },
  { entityId: "015", name: "Banque Misr", routingCode: "001510102" },
  { entityId: "020", name: "HSBC", routingCode: "302020120" },
  { entityId: "021", name: "Citibank", routingCode: "102120101" },
  { entityId: "022", name: "Commercial Bank International", routingCode: "002220101" },
  { entityId: "027", name: "First Gulf Bank (now FAB)", routingCode: "802710101" },
  { entityId: "028", name: "Habib Bank Ltd", routingCode: "102820111" },
  { entityId: "029", name: "Habib Bank AG Zurich", routingCode: "302920101" },
  { entityId: "030", name: "Invest Bank", routingCode: "503030102" },
  { entityId: "038", name: "National Bank of Fujairah", routingCode: "503870102" },
  { entityId: "042", name: "National Bank of Umm Al Qaiwain", routingCode: "104251001" },
  { entityId: "044", name: "Standard Chartered", routingCode: "504420120" },
  { entityId: "045", name: "Union National Bank (now ADCB)", routingCode: "804510183" },
  { entityId: "046", name: "United Arab Bank", routingCode: "904630101" },
  { entityId: "047", name: "United Bank Ltd", routingCode: "604720106" },
  { entityId: "054", name: "Doha Bank", routingCode: "705420101" },
  { entityId: "056", name: "National Bank of Kuwait", routingCode: "505620101" },
  { entityId: "057", name: "Ajman Bank", routingCode: "805740101" },
  { entityId: "206", name: "Al Ansari Exchange", routingCode: "720610101" },
  { entityId: "291", name: "UAE Exchange", routingCode: "929110101" },
  { entityId: "313", name: "Sharaf Exchange", routingCode: "031310101" },
  { entityId: "314", name: "LuLu Exchange", routingCode: "931410101" },
  { entityId: "401", name: "C3 (salary cards)", routingCode: "640110101" },
];

export const WPS_BANKS: WpsBank[] = [...TOP_BANKS, ...OTHER_BANKS];

/** A UAE IBAN, tidied: "AE07 0331 2345 6789 0123 456" → "AE070331234567890123456"; null unless it is one. */
export function uaeIban(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (!/^AE\d{21}$/.test(s)) return null;
  // ISO 13616: country and check digits moved to the end, letters as numbers, mod 97 is 1.
  const moved = s.slice(4) + s.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1 ? s : null;
}

/** The bank an IBAN is at — by its three digits — or null when it isn't one listed. */
export function bankOfIban(iban: string | null | undefined): WpsBank | null {
  const s = uaeIban(iban);
  if (!s) return null;
  const id = s.slice(4, 7);
  return WPS_BANKS.find((b) => b.entityId === id) ?? null;
}

export function bankByRoutingCode(code: string | null | undefined): WpsBank | null {
  return WPS_BANKS.find((b) => b.routingCode === code) ?? null;
}
