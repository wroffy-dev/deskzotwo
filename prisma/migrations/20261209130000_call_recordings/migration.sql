-- Call recordings from the Deskzo app (owner, 9 Nov 2026): the row here, the sound in the recordings store. New tables only.
CREATE TABLE "call_recordings" (
    "id" TEXT NOT NULL,
    "callLogId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "fileName" TEXT,
    "appDeviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleteAfter" TIMESTAMP(3),
    CONSTRAINT "call_recordings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "call_recordings_callLogId_key" ON "call_recordings"("callLogId");
CREATE INDEX "call_recordings_deleteAfter_idx" ON "call_recordings"("deleteAfter");
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_callLogId_fkey" FOREIGN KEY ("callLogId") REFERENCES "call_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "call_recording_plays" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "call_recording_plays_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "call_recording_plays_recordingId_idx" ON "call_recording_plays"("recordingId");
ALTER TABLE "call_recording_plays" ADD CONSTRAINT "call_recording_plays_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "call_recordings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "call_recording_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "retentionDays" INTEGER DEFAULT 90,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "call_recording_settings_pkey" PRIMARY KEY ("id")
);
