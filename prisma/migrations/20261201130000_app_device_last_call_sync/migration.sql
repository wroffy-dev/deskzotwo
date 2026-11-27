-- When each paired phone last sent its calls (owner, 31 Oct 2026: Settings › Security › Access › Phones).
ALTER TABLE "app_devices" ADD COLUMN "lastCallSyncAt" TIMESTAMP(3);
