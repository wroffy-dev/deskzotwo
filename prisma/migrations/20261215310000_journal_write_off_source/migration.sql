-- A write-off's entry (owner, 15 Nov 2026 — src/lib/receivables/write-off.ts): its own source, so the journal shows it
-- for what it is and no hand-made reversal takes it apart from the write-off.
ALTER TYPE "JournalSource" ADD VALUE IF NOT EXISTS 'WRITE_OFF';
