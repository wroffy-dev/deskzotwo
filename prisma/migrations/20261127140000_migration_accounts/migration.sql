-- CreateTable
CREATE TABLE "books_migration_accounts" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "type" TEXT NOT NULL,
    "parent" TEXT,
    "accountId" TEXT,
    "reason" TEXT,
    "created" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "books_migration_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "books_migration_accounts_migrationId_name_key" ON "books_migration_accounts"("migrationId", "name");

-- AddForeignKey
ALTER TABLE "books_migration_accounts" ADD CONSTRAINT "books_migration_accounts_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "books_migrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
