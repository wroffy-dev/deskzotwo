import "dotenv/config";

/**
 * Seed scripts never run against a live workspace (security review, 15 Nov 2026 — SEC-01). They make demo users with a
 * password written in this repository — `db:seed` an ADMIN who becomes super admin when there is none — and fill a
 * database with made-up companies, invoices and staff. Imported first by every prisma/seed*.ts, so the check runs before
 * anything else in the script.
 *
 * Live is: PLATFORM_ENV or NODE_ENV "production", or a PLATFORM_DOMAIN that isn't a local one (localhost, *.localhost,
 * *.test, *.local). DESKZO_ALLOW_SEED=yes-on-purpose lets a deliberate run through — a staging box being rebuilt, say —
 * and says so.
 */
const env = (process.env.PLATFORM_ENV || process.env.NODE_ENV || "").trim().toLowerCase();
const domain = (process.env.PLATFORM_DOMAIN || "").trim().toLowerCase();
const localDomain = !domain || /^(localhost|127\.0\.0\.1)$|\.(localhost|test|local)$/.test(domain);
const live = env === "production" || !localDomain;

if (live) {
  if (process.env.DESKZO_ALLOW_SEED === "yes-on-purpose") {
    console.warn(`Seeding a ${env || "non-local"} setup (${domain || "no PLATFORM_DOMAIN"}) because DESKZO_ALLOW_SEED says so.`);
  } else {
    console.error(
      `Refusing to seed: this looks like a live setup (${env ? `environment "${env}"` : ""}${env && !localDomain ? ", " : ""}${!localDomain ? `domain "${domain}"` : ""}).\n` +
        "Seeds make demo users with a known password. Run them only against a local database — or set DESKZO_ALLOW_SEED=yes-on-purpose if you really mean to.",
    );
    process.exit(1);
  }
}
