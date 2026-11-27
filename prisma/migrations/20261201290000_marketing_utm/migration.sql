-- UTM tags on the links in Deskzo's emails (owner, 1 Nov 2026): on or off, the source word, and whether only the
-- workspace's own sites are tagged. Null until chosen — on, "deskzo", every site (src/lib/marketing/utm.ts).
ALTER TABLE "organisation_settings" ADD COLUMN "marketingUtm" JSONB;
