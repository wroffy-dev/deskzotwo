import { db } from "@/lib/db";
import { leadAccess } from "@/lib/authz/access";
import { leadMasker, resolveFieldPolicies } from "@/lib/authz/fields";
import { can } from "@/lib/authz/resolve";
import { contactMasker } from "@/lib/contacts/masking";
import { exportCells } from "@/lib/custom-fields/sheets";
import { leadRedactor, leadSecrets } from "@/lib/leads/masking";
import { customLeftBlank, maskedOnlyInExports } from "./field-export";
import { leadStages, stagesOfLeads } from "@/lib/pipeline/server";
import { MAIN_PIPELINE_ID, kindOf, pipelineById } from "@/lib/pipeline/rules";
import { workspaceClock } from "@/lib/time/workspace";
import type { Exporter } from "./types";

/**
 * Leads, the ones this person may see (`leadAccess`, as the list asks), masked as the list masks them —
 * an export is a list that leaves the building, never unmasked — with each field's export answer on top (owner,
 * 5 Nov 2026 — Phase 3 masking fixes, audit H.4.4: left out, masked though the list shows it, or in the clear where the
 * person sees it so somewhere). Its columns are the leads import's (src/lib/portability/importers/leads.ts), so an
 * exported file edited and handed back changes only what was edited, and a masked cell reads back as no change — which
 * is why a cell masked by the export alone goes out blank (`maskedOnlyInExports`).
 *
 * Days are the workspace's: a closed deal's `Closed on` is when it moved to its closing stage, `Created on`
 * when it was made, each on the workspace's clock.
 */
export const leadsExporter: Exporter = async (scope) => {
  const [rows, pipeline, masker, clock] = await Promise.all([
    db.lead.findMany({
      where: { AND: [await leadAccess(scope.userId, "view")] },
      orderBy: { leadSeq: "asc" },
      select: {
        id: true,
        leadSeq: true,
        title: true,
        status: true,
        estimatedValue: true,
        expectedCloseDate: true,
        stageChangedAt: true,
        source: true,
        sourceDetail: true,
        lostReason: true,
        description: true,
        externalId: true,
        captureKeyId: true,
        createdAt: true,
        // Its locations only so a lost reason quoting the address is redacted with it (`leadSecrets`); never a column.
        company: { select: { name: true, locations: { select: { address: true, city: true, state: true, pincode: true, country: true, isPrimary: true } } } },
        contact: { select: { id: true, name: true, email: true, phone: true } },
        owner: { select: { name: true } },
      },
    }),
    leadStages(),
    leadMasker(scope.userId, "export"),
    workspaceClock(),
  ]);
  const stages = await stagesOfLeads(rows.map((l) => ({ id: l.id, status: l.status })));
  const several = pipeline.pipelines.filter((p) => !p.archived).length > 1;
  const unsafe = await maskedOnlyInExports(scope.userId, "leads");
  const show = (field: string, value: string | null | undefined) => (unsafe(field) ? "" : (masker.present(field, value) ?? ""));
  /**
   * The contact's email and phone (owner, 5 Nov 2026 — Phase 3 masking fixes, audit M-12): how to reach somebody is
   * `contacts.view`'s to give, as on the lead's own page (`getLead`), and the contact's own field access
   * (src/lib/contacts/masking.ts) applies to them as on the Contacts list — this export carried both in full to
   * anybody with "Export CRM data". Asked of the resolver (`can`): an export runs for `scope.userId`, signed in or not.
   *
   * Where the lead's own rules mask the cell, it goes out as before (the import reads those back as "leave alone").
   * Where only the contact's rules conceal it, it goes out blank: the leads import (src/lib/portability/importers/leads.ts)
   * knows the lead's masks, not the contact's, and would take "s*****@g***.com" for an address to find or make a
   * contact by — blank is what it already reads as "leave alone".
   */
  const reachable = await can(scope.userId, "contacts.view");
  const people = reachable ? await contactMasker(scope.userId, "export", [...new Set(rows.flatMap((l) => (l.contact ? [l.contact.id] : [])))]) : null;
  // The contact's own export answers (audit H.4.4): "masked" or "left out" is never opened by a "Show" today.
  const contactRules = reachable ? await resolveFieldPolicies(scope.userId, "contacts") : null;
  const setByExport = (field: "email" | "phone") => {
    const mode = contactRules?.fields.get(field)?.policy.export;
    return mode === "masked" || mode === "none";
  };
  const reach = (contact: (typeof rows)[number]["contact"], field: "email" | "phone") => {
    const raw = contact?.[field];
    if (!people) return "";
    const asLead = show(field, raw);
    if (!contact || raw == null) return asLead;
    if (asLead !== raw) return asLead;
    return !setByExport(field) && people.present(contact.id, field, raw) === raw ? raw : "";
  };

  /**
   * Why it was lost (owner, 5 Nov 2026 — Phase 3 masking fixes, audit L-8): free text quoting the lead's own values, as
   * often as not, went out whole beside the masked columns. Redacted as the "Lost reason" breakdown in Reports is
   * (src/lib/analytics/sources.ts `lostReasonsAsListed`) — by the lead redactor with this person's list answers, and their
   * export answers on top (audit H.4.4) — except
   * that a reason the redactor changes goes out blank rather than redacted: the leads import writes this column back
   * as typed, so a redacted reason handed back would overwrite the real one, and blank is "leave alone" there. A reason
   * quoting nothing concealed goes out exactly as it did.
   */
  const lostReason = (l: (typeof rows)[number]) => {
    const reason = l.lostReason ?? "";
    if (!reason || !masker.active) return reason;
    return leadRedactor(masker, leadSecrets(l))(reason) === reason ? reason : "";
  };

  const base = rows.map((l) => {
    const stage = stages.get(l.id);
    const closed = kindOf(l.status) !== "OPEN";
    return {
      Key: `LEAD-${String(l.leadSeq).padStart(6, "0")}`,
      // The other CRM's id, kept so its file re-imports onto the same lead; a website's enquiry id isn't one.
      "Old system ID": l.captureKeyId ? "" : (l.externalId ?? ""),
      Title: show("title", l.title),
      Company: show("companyName", l.company.name),
      Contact: show("contactName", l.contact?.name),
      "Contact email": reach(l.contact, "email"),
      "Contact phone": reach(l.contact, "phone"),
      Pipeline: several ? pipelineById(pipeline.pipelines, stage?.pipelineId ?? MAIN_PIPELINE_ID).name : "",
      Stage: stage?.label ?? l.status,
      Owner: l.owner?.name ?? "",
      Value: l.estimatedValue === null ? null : Number(l.estimatedValue),
      // A calendar day held as midnight UTC, so its UTC date is the day typed.
      "Expected close": l.expectedCloseDate ? l.expectedCloseDate.toISOString().slice(0, 10) : "",
      "Closed on": closed && l.stageChangedAt ? clock.dateKey(l.stageChangedAt) : "",
      "Created on": clock.dateKey(l.createdAt),
      Source: show("source", l.source),
      "Source detail": show("source", l.sourceDetail),
      "Lost reason": lostReason(l),
      Description: show("description", l.description),
    };
  });
  // The workspace's own lead fields this person may see, after the built-in columns (src/lib/custom-fields/sheets.ts) —
  // blank where the export leaves them out, or masks them though the list doesn't (`customLeftBlank`).
  const blank = await customLeftBlank(scope.userId, "leads");
  const custom = await exportCells("LEAD", scope.userId, rows.map((l) => l.id), Object.keys(base[0] ?? {}), { hiddenFor: () => (blank.size ? blank : undefined) });
  return base.map((b, n) => ({ ...b, ...custom(rows[n]!.id) }));
};
