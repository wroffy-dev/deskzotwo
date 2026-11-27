-- The email builder (owner, 1 Nov 2026: a drag-and-drop template creator, "easy to use, Elementor type"): a template
-- made there keeps its design beside the HTML it sends, so it opens in the builder again. Null for every other template.
ALTER TABLE "marketing_templates" ADD COLUMN "design" JSONB;
