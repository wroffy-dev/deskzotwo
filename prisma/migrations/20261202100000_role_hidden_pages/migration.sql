-- Per-page ticks on a role (owner, 2 Nov 2026): a menu page the role doesn't see. No rows to start with, so every
-- role sees what it saw before.
CREATE TABLE "role_hidden_pages" (
    "roleKey" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "role_hidden_pages_pkey" PRIMARY KEY ("roleKey","href")
);

ALTER TABLE "role_hidden_pages" ADD CONSTRAINT "role_hidden_pages_roleKey_fkey" FOREIGN KEY ("roleKey") REFERENCES "roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;
