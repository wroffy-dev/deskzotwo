-- ---------------------------------------------------------------------------------------------
-- Deskzo AI masks customer data before it reaches a provider (owner, 23 Nov 2026 — "we will use the API, but the data
-- goes masked"; src/lib/ai/mask.ts). On for every account, as it should be for a provider's API; off for a
-- self-hosted server (OpenAI-compatible: Deskzo's own Ollama), where nothing leaves Deskzo. Changed per account in
-- console › Settings › Deskzo AI.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "ai_accounts" ADD COLUMN IF NOT EXISTS "maskData" BOOLEAN NOT NULL DEFAULT true;
UPDATE "ai_accounts" SET "maskData" = false WHERE "kind" = 'OPENAI_COMPATIBLE';
