import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * A verification build and the dev server both default to `.next`. Running `next build` while
   * `next dev` is live overwrites the chunks the dev server is serving, and the browser then gets
   * a stale mix until the cache is cleared — which looks exactly like "my change didn't apply".
   * Setting `NEXT_DIST_DIR=.next-build` for a build keeps the two out of each other's way.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",

  /**
   * The dev server prints every Server Function call with its arguments — and those arguments
   * include what people type into secret fields: AI provider keys, email-provider and e-invoice
   * credentials, passwords. Found when a copilot key appeared in plain text in the dev log. Off, so
   * no secret lands in a terminal, a log file or a screen share.
   */
  logging: {
    serverFunctions: false,
  },

  /**
   * Each workspace is its own subdomain — locally `acme.localhost:3000`. Next 16 refuses dev assets
   * and hot reload to any origin not listed here, which would leave every workspace but the bare
   * `localhost` a page that never finishes loading in development.
   */
  allowedDevOrigins: ["*.localhost", "127.0.0.1"],

  /**
   * The control plane's and the reference database's Prisma clients (prisma/control,
   * prisma/reference), loaded by Node as they are rather than bundled — the same treatment Next gives
   * Prisma's main client. Bundled, a client's search for its own query engine on disk makes the
   * build trace the entire project.
   */
  // unpdf: pdf.js reads vendor statements (src/lib/reconcile/pdf.ts); loaded by Node itself, as pdf.js
  // expects, rather than split across the server bundle's chunks.
  serverExternalPackages: ["@deskzo/control-client", "@deskzo/reference-client", "@prisma/adapter-pg", "unpdf"],

  /**
   * Server actions accept bodies up to 6 MB: the website CMS uploads images of up to 5 MB through one
   * (src/actions/cms/media.ts), and Next's default of 1 MB would refuse them before the action's own
   * checks run. Every action still validates its own input.
   */
  experimental: {
    serverActions: { bodySizeLimit: "6mb" },
    /**
     * The proxy buffers a request's body up to this, and silently cuts it there (10 MB by default).
     * Tickets by email posts each email whole, base64 inside JSON (src/app/api/platform/inbound-email):
     * a 25 MB email, the most the mail receiver accepts, is about 34 MB. Cut short, its signature would
     * fail and the email bounce. The route itself refuses anything larger.
     */
    proxyClientMaxBodySize: "36mb",
  },

  /**
   * eSSL / ZKTeco terminals post to a fixed path.
   *
   * Their firmware lets you set the server address and port on the keypad, but the path is baked
   * in as /iclock/ — so the app has to answer there rather than somewhere tidier. The handler
   * itself lives under /api/biometric/iclock, and this points the one at the other.
   */
  /**
   * Smart Lists moved from /workspace to /smart-lists (owner, 20 Nov 2026: "the url still says workspace ! it should be
   * smart list"). Every old address — a bookmark, a link in a notification or an email already sent — lands on its new one.
   * Temporary (307) for now, so a browser doesn't hold on to it if the address ever changes again.
   */
  async redirects() {
    return [
      { source: "/workspace", destination: "/smart-lists", permanent: false },
      { source: "/workspace/:path*", destination: "/smart-lists/:path*", permanent: false },
    ];
  },

  async rewrites() {
    return [
      { source: "/iclock/:path*", destination: "/api/biometric/iclock/:path*" },
      // A terminal's own secret address (security audit SEC-06 — src/lib/hr/device-key.ts): the key sits before the
      // firmware's fixed /iclock/. It starts with "iclock" so the proxy leaves it alone, as it does the plain one.
      { source: "/iclock-k/:key/iclock/:path*", destination: "/api/biometric/key/:key/iclock/:path*" },
      // Android's App Link check (security audit round two, R2-12 — src/lib/app/asset-links.ts): read with no session on
      // any host; the proxy's matcher leaves this exact path alone, and the answer is the /api route's.
      { source: "/.well-known/assetlinks.json", destination: "/api/app/asset-links" },
    ];
  },

  /**
   * Security audit, 11 Nov 2026 (SEC-58). Pages get their hardening headers from src/proxy.ts (`harden`), which
   * returns early for /api — so /api answers went out with neither nosniff nor a referrer policy unless each route
   * remembered. Here, for every /api answer, with the values the pages use. No Content-Security-Policy on /api:
   * a header set here wins over a route's own, and several /api routes serve uploads under a stricter `sandbox`
   * policy of their own that this would loosen.
   *
   * And HSTS on everything: every Deskzo address is HTTPS (Cloudflare in front, src/lib/tenancy/host.ts
   * `protocolFor`), and a browser that has seen this won't try plain HTTP for a year. Browsers ignore it over
   * plain HTTP, so local development on http://*.localhost is untouched. `includeSubDomains` only on the platform's
   * own domain: a workspace's custom domain may be a customer's bare domain, and that would force every other
   * name of theirs — which we don't run — onto HTTPS in their visitors' browsers. Later rules win (Next's docs).
   */
  async headers() {
    const platformHosts = [...new Set([process.env.PLATFORM_DOMAIN?.trim().toLowerCase(), "deskzo.com"])].filter((h): h is string => !!h && h !== "localhost");
    const platformHost = `(?:.+\\.)?(?:${platformHosts.map((h) => h.replace(/\./g, "\\.")).join("|")})`;
    return [
      { source: "/:path*", headers: [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] },
      { source: "/:path*", has: [{ type: "host", value: platformHost }], headers: [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] },
      {
        source: "/api/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
