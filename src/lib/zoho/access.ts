import { can } from "@/lib/authz/resolve";
import { isModuleEntitled } from "@/lib/modules-access";

/**
 * Who may connect Deskzo to Zoho Books and pull from it: whoever may bring a year across (src/actions/migration.ts)
 * — accounting in the plan, and the rights to post journals and import finance data. The master lists' files
 * reach the old-CRM import only when the super admin pulls (src/lib/zoho/pull.ts).
 */
export async function mayUseZoho(userId: string): Promise<boolean> {
  if (!(await isModuleEntitled("accounting"))) return false;
  return (await can(userId, "ledger.post")) && (await can(userId, "data.importFinance"));
}

export const ZOHO_COOKIE = "deskzo.zoho-connect";
export const ZOHO_COOKIE_PATH = "/api/zoho";
export const ZOHO_BACK = "/settings/data/switch";
