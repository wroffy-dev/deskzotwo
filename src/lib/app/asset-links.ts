/**
 * Android's Digital Asset Links statement for deskzo.com (security audit round two, 13 Nov 2026, R2-12): what lets
 * Android verify that https://deskzo.com/app-return/… belongs to Deskzo's own app, so the browser sign-in's code goes
 * back on a link no other app on the phone can claim (src/lib/app/tokens.ts `signedInLink`).
 *
 *   ANDROID_APP_SHA256_CERT_FINGERPRINTS — the SHA-256 fingerprints of the certificates the app is signed with:
 *     Play's app-signing key (Play Console › Test and release › App integrity) and the upload key, comma-separated,
 *     each as Play shows it ("AB:CD:…", 32 pairs).
 *   ANDROID_APP_PACKAGE — the app's package name; com.deskzo.app unless set.
 *
 * Unset (or nothing valid in it), there is no statement: 404, and an app without App Links carries on with deskzo://.
 */

const FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

export function assetLinksStatement(env: Record<string, string | undefined> = process.env): unknown[] | null {
  const fingerprints = (env.ANDROID_APP_SHA256_CERT_FINGERPRINTS ?? "")
    .split(/[,\s]+/)
    .map((f) => f.trim().toUpperCase())
    .filter((f) => FINGERPRINT.test(f));
  if (fingerprints.length === 0) return null;
  const pkg = (env.ANDROID_APP_PACKAGE ?? "").trim() || "com.deskzo.app";
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) return null;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: [...new Set(fingerprints)] },
    },
  ];
}

/** The answer at /.well-known/assetlinks.json. */
export function assetLinksResponse(env: Record<string, string | undefined> = process.env): Response {
  const statement = assetLinksStatement(env);
  if (!statement) return new Response("Not found.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return new Response(JSON.stringify(statement), { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
}
