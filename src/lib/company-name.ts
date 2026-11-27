/**
 * A company name reduced to what makes it the same company: case and spacing ignored.
 *
 * `companies.normalizedName` is unique on exactly this, so it is *the* duplicate rule — and it lives
 * here, on its own, so a client component can apply it without importing the validation schemas and
 * everything they pull in.
 */
export function normalizeCompanyName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The words for a company's legal form, each one way: "Pvt." is "Private", "Ltd" is "Limited". */
const LEGAL_FORMS: Record<string, string> = {
  private: "pvt",
  pvt: "pvt",
  limited: "ltd",
  ltd: "ltd",
  company: "co",
  co: "co",
  corporation: "corp",
  corp: "corp",
  incorporated: "inc",
  inc: "inc",
};

/**
 * A name as an import matches it (owner, 27 Oct 2026): "Ingram Micro India Pvt. Ltd." and "Ingram Micro India Private
 * Limited" are one company. Only the legal form, "&"/"and", a leading "the" and punctuation are let go — every other
 * word stays, so "Ingram Micro India" never meets "Ingram Micro Singapore".
 */
export function legalNameKey(name: string): string {
  return name
    .toLowerCase()
    // "(P) Ltd" is "Pvt Ltd".
    .replace(/\(\s*p\s*\)/g, " pvt ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word, i) => word && !(i === 0 && word === "the"))
    .map((word) => LEGAL_FORMS[word] ?? word)
    .join(" ");
}

/** A legal form at the end of a name — "pvt ltd", "Private Limited", "(P) Ltd.", "LLP" left out: it says which company. */
const LEGAL_ENDING = /[\s.,()&-]*\b(pvt|private|ltd|limited|co|company|corp|corporation|inc|incorporated)\b[.\s)]*$/i;

/**
 * What a picker searches for (owner, 27 Oct 2026): the typed text without its legal form, so "Ability Engineering pvt
 * ltd" finds "Ability Engineering Private Limited" — what's found is then kept only if it matches (`companyNameMatches`).
 */
export function nameSearchText(typed: string): string {
  let text = typed.trim().replace(/\(\s*p\s*\)/gi, " pvt ");
  for (let i = 0; i < 4 && LEGAL_ENDING.test(text); i++) text = text.replace(LEGAL_ENDING, "").trim();
  return text.length >= 2 ? text : typed.trim();
}

/** Whether a company's name matches what was typed: as text, or as the same name in another legal form. */
export function companyNameMatches(name: string, typed: string): boolean {
  const t = typed.trim().toLowerCase();
  if (!t || name.toLowerCase().includes(t)) return true;
  const key = legalNameKey(typed);
  return key.length > 0 && legalNameKey(name).includes(key);
}

/**
 * Whether a picker should offer "create new company" for what has been typed.
 *
 * Not when the name is already on the list — offering it anyway invited a click that could only end
 * in "already exists", and taught people to scroll past the real record to the create row. Compared
 * by the duplicate rule above, so "acme  chemicals" is the same as "Acme Chemicals".
 */
export function offersCreate(typed: string, existingNames: string[]): boolean {
  const key = normalizeCompanyName(typed);
  if (!key) return false;
  // Nor for the same name in another legal form — "ABC Private Limited" with "ABC Pvt Ltd" on the list.
  const legal = legalNameKey(typed);
  return !existingNames.some((name) => normalizeCompanyName(name) === key || legalNameKey(name) === legal);
}
