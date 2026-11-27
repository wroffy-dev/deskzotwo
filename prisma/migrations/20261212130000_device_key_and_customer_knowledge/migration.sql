-- Security audit 11 Nov 2026, the two the owner said yes to on 12 Nov.
-- SEC-06: a biometric terminal's own secret address — the digest of the key in it. Null keeps the plain address.
ALTER TABLE "biometric_devices" ADD COLUMN "accessKeyHash" TEXT;
-- SEC-46: which AI Knowledge files the website chat's bot may answer visitors from. None until somebody ticks them.
ALTER TABLE "ai_knowledge_files" ADD COLUMN "forCustomers" BOOLEAN NOT NULL DEFAULT false;
