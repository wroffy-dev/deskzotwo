-- Polls inside a marketing email (owner, 1 Nov 2026 — src/lib/marketing/email-widgets.ts): one answer per person per question.
CREATE TABLE "marketing_poll_answers" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "campaignId" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_poll_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketing_poll_answers_messageId_question_key" ON "marketing_poll_answers"("messageId", "question");
CREATE INDEX "marketing_poll_answers_campaignId_idx" ON "marketing_poll_answers"("campaignId");
