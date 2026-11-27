-- Copied on the team's renewal reminder emails (owner, 23 Nov 2026 — src/lib/renewal-team-copies.ts): addresses on each
-- step of the ladder, once a step. Empty, the default: nobody copied, as before.
ALTER TABLE "renewal_settings" ADD COLUMN "teamReminderCc" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
