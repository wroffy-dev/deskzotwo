-- One-time passes for the server to print a statement to PDF (src/lib/statements/render.ts).
CREATE TABLE "render_grants" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "render_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "render_grants_expiresAt_idx" ON "render_grants"("expiresAt");
