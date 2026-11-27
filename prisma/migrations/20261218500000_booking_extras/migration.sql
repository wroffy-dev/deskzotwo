-- Booking pages' own questions, and each booking's answers, time zone, invited colleagues and manage link.
CREATE TABLE "booking_page_forms" (
    "pageId" TEXT NOT NULL,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_page_forms_pkey" PRIMARY KEY ("pageId")
);

CREATE TABLE "booking_details" (
    "bookingId" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "zone" TEXT,
    "guests" JSONB NOT NULL DEFAULT '[]',
    "tokenHash" TEXT NOT NULL,
    "rescheduledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_details_pkey" PRIMARY KEY ("bookingId")
);

CREATE UNIQUE INDEX "booking_details_tokenHash_key" ON "booking_details"("tokenHash");

ALTER TABLE "booking_page_forms" ADD CONSTRAINT "booking_page_forms_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "booking_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "booking_details" ADD CONSTRAINT "booking_details_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
