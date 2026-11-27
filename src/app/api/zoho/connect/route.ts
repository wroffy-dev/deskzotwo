import { NextResponse } from "next/server";
import { currentUser, refuseWhileViewingAs } from "@/lib/session";
import { newState, publicOrigin, sealState } from "@/lib/mail/connect-state";
import { authorizeUrl, callbackPath, loadConnection } from "@/lib/zoho/client";
import { mayUseZoho, ZOHO_BACK, ZOHO_COOKIE, ZOHO_COOKIE_PATH } from "@/lib/zoho/access";

const TTL_SECONDS = 600;

/**
 * Step one of connecting Deskzo to Zoho Books (src/lib/zoho): off to Zoho's sign-in with the workspace's own app,
 * asking for read access. Outside the proxy (it is under /api), so it checks the session itself.
 */
export async function GET() {
  const origin = await publicOrigin();
  const back = (outcome: string) => NextResponse.redirect(new URL(`${ZOHO_BACK}?zoho=${outcome}`, origin));
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL(`/login?callbackUrl=${encodeURIComponent(ZOHO_BACK)}`, origin));
  if (await refuseWhileViewingAs()) return back("viewing-as");
  if (!(await mayUseZoho(user.id))) return back("refused");
  const c = await loadConnection();
  if (!c) return back("no-app");

  const state = newState();
  const res = NextResponse.redirect(authorizeUrl(c, `${origin}${callbackPath}`, state));
  res.cookies.set(ZOHO_COOKIE, await sealState({ state, verifier: "", userId: user.id, expires: Date.now() + TTL_SECONDS * 1000, next: ZOHO_BACK }), {
    httpOnly: true,
    // Lax: Zoho sends the browser back with a top-level GET, which lax lets the cookie ride along on.
    sameSite: "lax",
    secure: origin.startsWith("https:"),
    path: ZOHO_COOKIE_PATH,
    maxAge: TTL_SECONDS,
  });
  return res;
}
