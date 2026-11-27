import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { AppSignInConsent } from "@/components/auth/app-sign-in-consent";
import { getBranding } from "@/actions/branding";
import { db } from "@/lib/db";
import { normaliseIp } from "@/lib/access/ip";
import { personRefusal } from "@/lib/api/handler";
import { PHONE_REFUSALS } from "@/lib/app/handler";
import { deskzoAppReady } from "@/lib/app/ready";
import { signInKind, validChallenge } from "@/lib/app/tokens";
import { clientIpFrom } from "@/lib/client-ip";
import { requireUser, viewAsContext } from "@/lib/session";

export const metadata: Metadata = { title: "Sign in to the Deskzo app" };

/** The phone's name from the path: decoded, letters, digits, spaces and a little punctuation only, at most 60 characters. */
function phoneNameFrom(segment: string | undefined): string | null {
  if (!segment) return null;
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const clean = text.replace(/[^\p{L}\p{N} ._()+-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return clean || null;
}

/**
 * Signing in to the Deskzo app through the phone's browser (owner, 18 Oct 2026; src/lib/app/pairing.ts). The app
 * opens this page; somebody not signed in is sent through the web's own sign-in first, with all its rules, and
 * comes back here (the challenge rides in the path, which the sign-in keeps). "Allow" sends a code bound to the
 * app's challenge back to the app. A phone or tablet their role doesn't allow, or a network it refuses, is said
 * here rather than after.
 */
export default async function AppSignInPage({ params }: { params: Promise<{ kind: string; challenge: string; device?: string }> }) {
  if (!deskzoAppReady()) notFound();
  const { kind, challenge, device } = await params;
  // Security audit round two, 13 Nov 2026 (R2-12): the phone's name as the app sent it, in the path's last segment
  // (./[device]/page.tsx — a path, because the web's sign-in keeps the path and drops a query). What the app says,
  // so it is shown as that, clipped and in plain text; an app built before it sends none.
  const deviceName = phoneNameFrom(device);
  const user = await requireUser();
  const branding = await getBranding();
  // "phone" or "tablet", or "phone.link" from an app that takes the code back on a verified App Link (R2-12).
  const parsed = signInKind(kind);
  const valid = !!parsed && validChallenge(challenge);
  const form = parsed?.form ?? "phone";

  let refusal: string | null = null;
  if (!valid) refusal = "This sign-in link isn't right, or it has been changed. Start again from the Deskzo app.";
  else if (await viewAsContext()) refusal = "You're viewing Deskzo as somebody else. Stop viewing as them first — the app can only be signed in as yourself.";
  else {
    const person = await db.user.findUnique({
      where: { id: user.id },
      select: { id: true, role: true, isSuperAdmin: true, active: true, kind: true, lockedAt: true, lockedUntil: true },
    });
    // The app is approved as a device of its own, and shares its location if the role asks: neither is a reason
    // to stop here.
    const why = person ? await personRefusal(person, normaliseIp(clientIpFrom(await headers())), true, form === "tablet" ? "TABLET" : "MOBILE", true) : "switched_off";
    if (why) refusal = PHONE_REFUSALS[why];
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <AppSignInConsent
            kind={form}
            signInKind={kind}
            challenge={challenge}
            workspace={branding.appName}
            person={{ name: user.name ?? "", email: user.email ?? "" }}
            deviceName={deviceName}
            refusal={refusal}
          />
        </CardContent>
      </Card>
    </div>
  );
}
