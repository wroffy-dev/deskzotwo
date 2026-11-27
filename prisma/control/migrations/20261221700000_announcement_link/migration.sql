-- "Know more" on a platform announcement (owner, 20 Nov 2026): a page on the platform's own public site, checked by
-- src/lib/platform/announcements.ts on every save and again before a workspace is shown it.
ALTER TABLE "platform_announcements" ADD COLUMN "link" TEXT;
ALTER TABLE "platform_announcements" ADD CONSTRAINT "platform_announcements_link_check" CHECK ("link" IS NULL OR (char_length("link") <= 500 AND "link" LIKE 'http%://%'));
