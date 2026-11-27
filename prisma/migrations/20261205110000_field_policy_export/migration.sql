-- The export dimension of a field policy (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.4 and C.3.2;
-- src/lib/authz/field-policy.ts `ExportMode`). Expand-only: one nullable column on each policy table, null — every row
-- there today — meaning "as the list shows it", so nothing anybody exports changes until an admin sets it.
--
--   "none"    left out of exports (the cell goes out blank)
--   "masked"  masked in exports even where the screens show it in the clear
--   "clear"   in the clear, only where the person may see it in the clear somewhere
--
-- A field that can't be read is restricted in a file too, so it has no export of its own — the same rule the
-- *_view_first constraints keep for masking and unmasking.

ALTER TABLE "role_field_policies" ADD COLUMN "export" TEXT;
ALTER TABLE "user_field_policies" ADD COLUMN "export" TEXT;

ALTER TABLE "role_field_policies" ADD CONSTRAINT "role_field_policies_export_known"
  CHECK ("export" IS NULL OR ("view" AND "export" IN ('none', 'masked', 'clear')));
ALTER TABLE "user_field_policies" ADD CONSTRAINT "user_field_policies_export_known"
  CHECK ("export" IS NULL OR ("view" AND "export" IN ('none', 'masked', 'clear')));
