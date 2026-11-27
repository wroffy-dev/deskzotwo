-- Zoho's calls a day as the organisation's admin says (owner, 29 Oct 2026): Zoho can raise an organisation's limit
-- past its plan's (7,500 on a Professional plan here), and the plan name alone can't tell. Empty: the plan's.
ALTER TABLE "zoho_connections" ADD COLUMN "dailyCallLimit" INTEGER;
