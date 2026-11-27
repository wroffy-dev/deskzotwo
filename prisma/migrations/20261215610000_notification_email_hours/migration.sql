-- Notification emails go between 10:00 and 17:45, workspace time (16 Nov 2026): one raised outside those hours is
-- held here and sent when they open (src/lib/notifications/held-emails.ts). A new table, so a workspace not
-- migrated yet sends at once, as before.
CREATE TABLE "notification_email_held" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "sendAfter" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_email_held_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notification_email_held_sendAfter_idx" ON "notification_email_held"("sendAfter");
