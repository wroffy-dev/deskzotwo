-- A workspace's own names and photos for its AI teammates (src/lib/ai/teammates.ts).
CREATE TABLE "ai_teammate_names" (
    "key" TEXT NOT NULL,
    "name" TEXT,
    "photo" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_teammate_names_pkey" PRIMARY KEY ("key")
);
