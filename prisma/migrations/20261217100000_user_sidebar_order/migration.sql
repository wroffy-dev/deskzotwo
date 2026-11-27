-- Each person's own order for the sidebar (owner, 17 Nov 2026): sections and the pages within them. Empty is the app's.
ALTER TABLE "users" ADD COLUMN "sidebarOrder" JSONB NOT NULL DEFAULT '{}';
