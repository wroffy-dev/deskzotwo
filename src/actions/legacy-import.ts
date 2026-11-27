"use server";

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { csvRow } from "@/lib/csv";
import { db } from "@/lib/db";
import { analyseAndKeep } from "@/lib/legacy-import/analyse";
import { importStep, resumeImport, startImport, undoStep, type StartInput } from "@/lib/legacy-import/run";
import { applyMasterCsv, buildMasterLists, decideMatch, listMatches, masterCounts, masterCsv } from "@/lib/legacy-import/master";
import { parseCsv } from "@/lib/legacy-import/files";
import { discardDraft, ImportRefused, removeFile, setFileKind, setFileMapping } from "@/lib/legacy-import/store";
import { requireUser } from "@/lib/session";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Data & continuity › Old CRM migration (owner, 26 Oct 2026; src/lib/legacy-import). The workspace's super
 * admin only — checked on every call, never while viewing as someone else — because the tool writes across the whole
 * workspace. Files arrive through /api/legacy-import/upload; everything after is here.
 */

async function superAdmin() {
  const user = await requireUser();
  if (!(await actingAsSuperAdmin(user.id))) throw new ImportRefused("Only the workspace's super admin can import the old CRM's data.");
  return user;
}

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    if (err instanceof ImportRefused) return { ok: false, error: err.message };
    throw err;
  }
}

const PAGE = "/settings/data/old-crm";

export async function setLegacyFileKind(fileId: string, kind: string | null) {
  return run(async () => {
    await superAdmin();
    await setFileKind(String(fileId ?? ""), kind ? String(kind) : null);
    revalidatePath(PAGE);
    return null;
  });
}

export async function setLegacyFileMapping(fileId: string, mapping: Record<string, string | null>) {
  return run(async () => {
    await superAdmin();
    await setFileMapping(String(fileId ?? ""), mapping && typeof mapping === "object" ? mapping : {});
    revalidatePath(PAGE);
    return null;
  });
}

export async function removeLegacyFile(fileId: string) {
  return run(async () => {
    await superAdmin();
    await removeFile(String(fileId ?? ""));
    revalidatePath(PAGE);
    return null;
  });
}

export async function discardLegacyDraft(importId: string) {
  return run(async () => {
    const user = await superAdmin();
    await discardDraft(String(importId ?? ""));
    await recordAudit({ userId: user.id, action: "DELETE", entityType: "LegacyImport", entityId: String(importId), entityLabel: "Threw away an old CRM import that hadn't started" });
    revalidatePath(PAGE);
    return null;
  });
}

/** Reads the draft's files as the import would and keeps what it found; writes nothing else. */
export async function analyseLegacyImport(importId: string) {
  return run(async () => {
    await superAdmin();
    const analysis = await analyseAndKeep(String(importId ?? ""));
    revalidatePath(PAGE);
    return analysis;
  });
}

/** Checks the choices, takes the backup and starts; the page then calls `stepLegacyImport` until it's done. */
export async function startLegacyImport(importId: string, input: StartInput) {
  return run(async () => {
    const user = await superAdmin();
    return startImport(String(importId ?? ""), input, user.id);
  });
}

export async function stepLegacyImport(importId: string) {
  return run(async () => {
    const user = await superAdmin();
    const result = await importStep(String(importId ?? ""), user.id);
    if (result.status !== "IMPORTING") revalidatePath(PAGE);
    return result;
  });
}

export async function resumeLegacyImport(importId: string) {
  return run(async () => {
    const user = await superAdmin();
    await resumeImport(String(importId ?? ""), user.id);
    return null;
  });
}

/** Undoes a finished or stopped import, a part a call; the page calls it until it's done. */
export async function undoLegacyImport(importId: string, confirmation: string) {
  return run(async () => {
    const user = await superAdmin();
    if (String(confirmation ?? "").trim().toUpperCase() !== "UNDO") throw new ImportRefused('Type UNDO to confirm.');
    const result = await undoStep(String(importId ?? ""), user.id);
    if (result.done) revalidatePath(PAGE);
    return result;
  });
}

/** Builds the master lists — Zoho's records beside WroffyCRM's — afresh from the draft's files. */
export async function buildLegacyMasterLists(importId: string) {
  return run(async () => {
    const user = await superAdmin();
    const built = await buildMasterLists(String(importId ?? ""));
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LegacyImport", entityId: String(importId), entityLabel: "Built the master lists of Zoho's and WroffyCRM's records" });
    revalidatePath(PAGE);
    return built;
  });
}

export async function legacyMasterCounts(importId: string) {
  return run(async () => {
    await superAdmin();
    return masterCounts(String(importId ?? ""));
  });
}

export async function legacyMatches(importId: string, list: string, group: string, query: string, page: number) {
  return run(async () => {
    await superAdmin();
    return listMatches(String(importId ?? ""), String(list ?? ""), String(group ?? ""), String(query ?? ""), Math.max(0, Math.floor(Number(page) || 0)));
  });
}

export async function decideLegacyMatch(importId: string, matchId: string, decision: "confirm" | "reject") {
  return run(async () => {
    await superAdmin();
    if (decision !== "confirm" && decision !== "reject") throw new ImportRefused("Confirm or reject.");
    await decideMatch(String(importId ?? ""), String(matchId ?? ""), decision);
    return masterCounts(String(importId ?? ""));
  });
}

export async function legacyMasterCsv(importId: string, list: string) {
  return run(async () => {
    await superAdmin();
    return { filename: `master-list-${String(list)}.csv`, csv: await masterCsv(String(importId ?? ""), String(list ?? "")) };
  });
}

/** A list back from CSV, its Decision column applied — every id checked before anything changes. */
export async function uploadLegacyMasterCsv(importId: string, list: string, text: string) {
  return run(async () => {
    const user = await superAdmin();
    if (typeof text !== "string" || text.length > 5 * 1024 * 1024) throw new ImportRefused("That file is over 5 MB.");
    const rows = parseCsv("master list", text).rows;
    const result = await applyMasterCsv(String(importId ?? ""), String(list ?? ""), rows);
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LegacyImport", entityId: String(importId), entityLabel: `Master list (${list}) from CSV: ${result.confirmed} confirmed, ${result.rejected} rejected, ${result.paired} paired by hand` });
    return { ...result, counts: await masterCounts(String(importId ?? "")) };
  });
}

/** The rows that didn't come in (and those that came in with a note), as a CSV to fix and re-upload from. */
export async function legacyErrorReport(importId: string) {
  return run(async () => {
    await superAdmin();
    const errors = await db.legacyImportError.findMany({ where: { importId: String(importId ?? "") }, orderBy: [{ createdAt: "asc" }], select: { kind: true, file: true, line: true, oldId: true, message: true } });
    const csv = [csvRow(["Table", "File", "Line", "Old id", "What happened"]), ...errors.map((e) => csvRow([e.kind, e.file, String(e.line), e.oldId ?? "", e.message]))].join("\n");
    return { filename: `old-crm-import-${String(importId).slice(-6)}-errors.csv`, csv: `${csv}\n`, count: errors.length };
  });
}
