import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { DEFAULT_LANDING, DEFAULT_POPUP, landingOf, popupOf, type LandingSettings, type PopupSettings } from "@/lib/forms/website-rules";

export * from "@/lib/forms/website-rules";

/** A form's pop-up and landing page (src/lib/forms/website-rules.ts) — the defaults, off, where none is saved or the table isn't there. */
export async function formWebsite(formId: string): Promise<{ popup: PopupSettings; landing: LandingSettings }> {
  try {
    const row = await db.formWebsite.findUnique({ where: { formId } });
    return { popup: popupOf(row?.popup), landing: landingOf(row?.landing) };
  } catch (err) {
    if (notMigratedYet(err)) return { popup: DEFAULT_POPUP, landing: DEFAULT_LANDING };
    throw err;
  }
}
