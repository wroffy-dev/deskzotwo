-- Shifts and the roster (owner, 31 Oct 2026): shifts, each person's standing shift, and days that differ.
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "graceMinutes" INTEGER NOT NULL DEFAULT 15,
    "weekOffs" INTEGER[] DEFAULT ARRAY[0, 6]::INTEGER[],
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shift_assignments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "roster_days" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "shiftId" TEXT,
    "setById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_days_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shifts_code_key" ON "shifts"("code");
CREATE UNIQUE INDEX "shift_assignments_userId_fromDate_key" ON "shift_assignments"("userId", "fromDate");
CREATE INDEX "shift_assignments_userId_idx" ON "shift_assignments"("userId");
CREATE UNIQUE INDEX "roster_days_userId_date_key" ON "roster_days"("userId", "date");
CREATE INDEX "roster_days_date_idx" ON "roster_days"("date");

ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "roster_days" ADD CONSTRAINT "roster_days_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "roster_days" ADD CONSTRAINT "roster_days_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
