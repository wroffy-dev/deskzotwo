import { WORLD_COUNTRIES } from "@/lib/geo/world-countries";
import { COUNTRY_ZONES } from "@/lib/time/zones";

/**
 * A phone number as the app keeps it: the country's calling code, a space, and the number within the
 * country — "+91 98765 43210", "+971 50 123 4567". Every phone field picks the country from a list
 * (src/components/ui/phone-input.tsx) rather than leaving the code to be typed, or left out.
 *
 * Left out was the usual case. Most numbers were saved as "98765 43210", which reads fine to a person
 * in India and is wrong everywhere else it goes: a WhatsApp link needs the code (wa.me/9876543210 is
 * somebody in another country, or nobody), and a customer abroad saved without theirs can't be told
 * apart from an Indian one. The ten digits at the end are untouched, so matching a call to its contact
 * by its last ten digits (`phoneKey`, src/lib/companies/duplicates.ts) works on old and new alike.
 *
 * Old values are never rewritten in the database: `splitPhone` reads "+91 …", "0091 …", "098765 43210"
 * and a bare "98765 43210" alike, and the number is saved in the new shape the next time its form is.
 */

export type PhoneCountry = { code: string; name: string; dial: string };

/**
 * Which country a shared calling code means when a number says no more than "+1": the one most numbers
 * with it belong to. The others (Canada, Jamaica, Kazakhstan, Jersey …) are still in the list to pick.
 */
const PRIMARY_FOR_DIAL: Record<string, string> = {
  "1": "US",
  "7": "RU",
  "44": "GB",
  "47": "NO",
  "61": "AU",
  "212": "MA",
  "262": "RE",
  "358": "FI",
  "590": "GP",
  "599": "CW",
};

/**
 * Every country with a calling code — India first, then alphabetical, as in the address forms. The
 * code is the part before GeoNames' area code: Jamaica's "+1-876" is +1, and 876 is the start of the
 * number, as it is dialled.
 */
export const PHONE_COUNTRIES: PhoneCountry[] = WORLD_COUNTRIES.flatMap((c) => {
  const dial = c.phone?.replace(/^\+/, "").split(/[-\s]/)[0] ?? "";
  return /^\d{1,3}$/.test(dial) ? [{ code: c.code, name: c.name, dial }] : [];
});

const BY_CODE = new Map(PHONE_COUNTRIES.map((c) => [c.code, c]));

export const DEFAULT_PHONE_COUNTRY = "IN";

export function phoneCountry(code: string | null | undefined): PhoneCountry {
  return BY_CODE.get(code ?? "") ?? BY_CODE.get(DEFAULT_PHONE_COUNTRY)!;
}

/** The country a time zone is in — the workspace's, for the code a new number starts with. India when unknown. */
export function phoneCountryForZone(zone: string | null | undefined): string {
  if (!zone) return DEFAULT_PHONE_COUNTRY;
  const code = Object.keys(COUNTRY_ZONES).find((c) => COUNTRY_ZONES[c] === zone && BY_CODE.has(c));
  return code ?? DEFAULT_PHONE_COUNTRY;
}

/** 🇮🇳 for IN: the two regional-indicator letters a flag is made of. */
export function flagOf(code: string): string {
  return /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : "";
}

/** The country whose calling code the digits start with, the longest code first ("1" vs "1268" never meet: codes stop at three digits). */
function countryForDigits(digits: string, preferred: string): { country: PhoneCountry } | null {
  for (const length of [3, 2, 1]) {
    const dial = digits.slice(0, length);
    const matching = PHONE_COUNTRIES.filter((c) => c.dial === dial);
    if (matching.length === 0) continue;
    // The country already chosen, when it shares this code; otherwise the code's own country.
    const country = matching.find((c) => c.code === preferred) ?? matching.find((c) => c.code === PRIMARY_FOR_DIAL[dial]) ?? matching[0]!;
    return { country };
  }
  return null;
}

/**
 * A stored number, as its two halves. `fallback` is the country a number with no code is taken to be in
 * — the workspace's; a number's own code, when it has one, always wins.
 */
export function splitPhone(value: string | null | undefined, fallback: string = DEFAULT_PHONE_COUNTRY): { country: string; national: string } {
  const text = (value ?? "").trim();
  const international = /^(\+|00)/.test(text);
  if (international) {
    const after = text.replace(/^(\+|00)/, "");
    const found = countryForDigits(after.replace(/\D/g, ""), fallback);
    if (found) {
      // The rest as it was written, its grouping kept: past as many digits as the code has.
      let seen = 0;
      let at = 0;
      while (at < after.length && seen < found.country.dial.length) if (/\d/.test(after[at++]!)) seen += 1;
      return { country: found.country.code, national: after.slice(at).replace(/^[^\d]+/, "") };
    }
  }
  return { country: phoneCountry(fallback).code, national: text };
}

/**
 * The two halves, as the number is kept: "+91 98765 43210", or "" for no number. The number keeps the
 * groups it was typed in — a helpline reads better as "80 1234 5678" — with any other separator made a
 * single space, and the trunk 0 a number is dialled with inside its own country ("098765 43210") is
 * dropped — except in Italy and its neighbours, where the 0 is part of the number.
 */
export function joinPhone(country: string, national: string): string {
  let number = national.replace(/[^\d]+/g, " ").trim();
  const { code, dial } = phoneCountry(country);
  if (!["IT", "SM", "VA"].includes(code)) number = number.replace(/^[0\s]+/, "");
  return /\d/.test(number) ? `+${dial} ${number}` : "";
}

/** A number as it should be kept, whatever shape it was typed or stored in. */
export function normalisePhone(value: string | null | undefined, fallback: string = DEFAULT_PHONE_COUNTRY): string {
  const { country, national } = splitPhone(value, fallback);
  return joinPhone(country, national);
}
