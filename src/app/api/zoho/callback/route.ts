import { NextResponse, type NextRequest } from "next/server";
import { recordAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { currentUser, refuseWhileViewingAs } from "@/lib/session";
import { openState, publicOrigin } from "@/lib/mail/connect-state";
import { callbackPath, dataCentreOfCallback, finishSignIn, listOrganisations, ZohoRefused } from "@/lib/zoho/client";
import { mayUseZoho, ZOHO_BACK, ZOHO_COOKIE, ZOHO_COOKIE_PATH } from "@/lib/zoho/access";

/**
 * Step two: Zoho sends the browser back with a code. The state matches, the person is the one who started, and
 * may use Zoho — then the code becomes a refresh token, kept encrypted, and the organisation is chosen: by itself
 * when there is one, on the page when there are more.
 */
export async function GET(req: NextRequest) {
  const origin = await publicOrigin();
  const saved = await openState(req.cookies.get(ZOHO_COOKIE)?.value);
  const back = (outcome: string, why = "") => {
    const res = NextResponse.redirect(new URL(`${ZOHO_BACK}?zoho=${outcome}${why ? `&why=${encodeURIComponent(why.slice(0, 200))}` : ""}`, origin));
    res.cookies.set(ZOHO_COOKIE, "", { path: ZOHO_COOKIE_PATH, maxAge: 0 });
    res.headers.set("cache-control", "no-store");
    return res;
  };
  const query = req.nextUrl.searchParams;
  if (query.get("error")) return query.get("error") === "access_denied" ? back("declined") : back("failed", `Zoho said: ${query.get("error")}`);
  const code = query.get("code");
  if (!saved || !code || query.get("state") !== saved.state) return back("expired");
  const user = await currentUser();
  if (!user || user.id !== saved.userId) return back("expired");
  if (await refuseWhileViewingAs()) return back("viewing-as");
  if (!(await mayUseZoho(user.id))) return back("refused");

  try {
    await finishSignIn(code, `${origin}${callbackPath}`, user.id, dataCentreOfCallback(query.get("location"), query.get("accounts-server")));
    const orgs = await listOrganisations();
    if (orgs.length === 1) await db.zohoConnection.update({ where: { id: "default" }, data: { organizationId: orgs[0]!.id, organizationName: orgs[0]!.name, planName: orgs[0]!.plan } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ZohoConnection", entityId: "default", entityLabel: `Connected Deskzo to Zoho Books (read-only)${orgs.length === 1 ? `: ${orgs[0]!.name}` : ""}` });
    return back(orgs.length === 1 ? "connected" : "choose");
  } catch (err) {
    if (err instanceof ZohoRefused) return back("failed", err.message);
    throw err;
  }
}
