-- The AI teammates' names and photos by country, set in the console (owner, 23 Nov 2026 — src/lib/ai/teammate-looks.ts).
CREATE TABLE "platform_teammate_looks" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT,
    "photo" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_teammate_looks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_teammate_looks_country_key_key" ON "platform_teammate_looks"("country", "key");
