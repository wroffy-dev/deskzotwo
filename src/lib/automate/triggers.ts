/**
 * What can start a workflow (Deskzo Automate), and the fields each hands to `{{trigger.…}}`.
 *
 * A schedule and a person pressing Run start a workflow themselves. The Deskzo events are recorded
 * where the change happens, in its transaction (src/lib/automate/emit-*.ts), and the date checks once
 * a day (src/lib/automate/dates.ts). `fields` are the top-level names a workflow reads.
 */

export type TriggerDefinition = {
  type: string;
  label: string;
  /** The top-level fields of `{{trigger.…}}`. */
  fields: readonly string[];
  /** Recorded by `emitEvent`, as opposed to started by the worker or a person. */
  event: boolean;
};

export const TRIGGERS: readonly TriggerDefinition[] = [
  { type: "schedule", label: "On a schedule", fields: ["scheduledFor", "firedAt"], event: false },
  { type: "manual", label: "When somebody presses Run", fields: ["startedById", "data"], event: false },
  { type: "webhook", label: "An outside app calls its webhook address", fields: ["body", "query", "headers", "receivedAt"], event: true },
  { type: "lead.created", label: "A lead is created", fields: ["lead", "company", "contact", "via"], event: true },
  { type: "lead.arrived", label: "A lead arrives in a pipeline (made there, carried on or moved in)", fields: ["lead", "company", "contact", "via", "from", "to"], event: true },
  { type: "lead.stage_changed", label: "A lead moves stage", fields: ["lead", "company", "contact", "from", "to"], event: true },
  { type: "lead.won", label: "A lead is won", fields: ["lead", "company", "contact", "from", "to"], event: true },
  { type: "lead.lost", label: "A lead is lost or disqualified", fields: ["lead", "company", "contact", "from", "to"], event: true },
  { type: "lead.quiet", label: "A lead has gone quiet (daily)", fields: ["lead", "company", "daysQuiet"], event: true },
  { type: "ticket.created", label: "A ticket is opened", fields: ["ticket", "company", "via"], event: true },
  { type: "ticket.status_changed", label: "A ticket's status changes", fields: ["ticket", "company", "from", "to"], event: true },
  { type: "document.issued", label: "A document is issued (quote, proforma, invoice…)", fields: ["document", "company"], event: true },
  { type: "invoice.paid", label: "An invoice is paid in full", fields: ["document", "company"], event: true },
  { type: "invoice.due_soon", label: "An invoice falls due within a week (daily)", fields: ["document", "company", "daysUntilDue"], event: true },
  { type: "invoice.overdue", label: "An invoice is overdue (daily)", fields: ["document", "company", "daysOverdue"], event: true },
  { type: "payment.received", label: "A payment comes in", fields: ["payment", "company"], event: true },
  { type: "order.created", label: "An order is placed", fields: ["order", "company"], event: true },
  { type: "order.approved", label: "An order is approved", fields: ["order", "company"], event: true },
  { type: "order.fulfilled", label: "An order is fulfilled", fields: ["order", "company"], event: true },
  { type: "renewal.due", label: "A subscription is coming up for renewal (daily)", fields: ["order", "company", "daysLeft"], event: true },
  // Any of the workspace's own date fields (owner, 7 Nov 2026; src/lib/automate/custom-dates.ts).
  { type: "custom_date.coming", label: "A custom date field is coming up (daily)", fields: ["field", "date", "daysLeft", "record", "company", "contact"], event: true },
  { type: "form.submitted", label: "A form is sent", fields: ["form", "submission", "companyId", "contactId", "leadId", "invited"], event: true },
  { type: "booking.made", label: "Somebody books a slot", fields: ["booking", "companyId", "contactId", "leadId"], event: true },
  // The Customer inbox (owner, 24 Oct 2026; src/lib/inbox/server.ts).
  { type: "conversation.started", label: "A customer starts a conversation (website chat or WhatsApp)", fields: ["conversation", "companyId", "contactId", "leadId"], event: true },
  { type: "conversation.needs_person", label: "A customer conversation needs a person (the bot handed over)", fields: ["conversation", "companyId", "contactId", "leadId"], event: true },
  // Website activity (owner, 6 Nov 2026; src/lib/inbox/activity.ts): at most twice a day for one visitor.
  { type: "website.key_page", label: "Somebody known opens a key page of the website", fields: ["visit", "lead", "company", "contact"], event: true },
  { type: "task.created", label: "A task is created", fields: ["task"], event: true },
  { type: "task.completed", label: "A task is done", fields: ["task"], event: true },
  { type: "person.joined", label: "Somebody joins the company", fields: ["person"], event: true },
  // Smart Lists (owner, 20 Nov 2026 — phase 3; src/lib/automate/emit-smart-lists.ts): a value in words, as the list shows it.
  { type: "smartlist.row_added", label: "A row is added to a Smart List", fields: ["list", "row", "addedVia", "addedBy"], event: true },
  { type: "smartlist.value_changed", label: "A column changes on a Smart List row", fields: ["list", "row", "column", "from", "to", "changedBy"], event: true },
];

export function triggerByType(type: string): TriggerDefinition | null {
  return TRIGGERS.find((t) => t.type === type) ?? null;
}

// ─── The fields inside a payload, for the builder's data picker ───────────────────────────────────

type Field = { key: string; label: string };
const f = (key: string, label: string): Field => ({ key, label });

/** The fields of each part of a payload, as src/lib/automate/emit-*.ts and dates.ts build them. */
const PARTS: Record<string, readonly Field[]> = {
  lead: [f("id", "id"), f("ref", "number"), f("title", "title"), f("status", "status"), f("stageId", "stage id"), f("pipelineId", "pipeline id"), f("source", "source"), f("ownerUserId", "owner"), f("companyId", "customer id"), f("contactId", "contact id"), f("value", "value"), f("expectedCloseDate", "expected close date"), f("lostReason", "lost reason"), f("categories", "product categories"), f("brands", "brands"), f("families", "product families")],
  company: [f("id", "id"), f("name", "name"), f("ownerUserId", "account manager")],
  field: [f("label", "name"), f("key", "key"), f("entity", "record type")],
  record: [f("id", "id"), f("name", "name"), f("ref", "number"), f("type", "type")],
  contact: [f("id", "id"), f("name", "name")],
  stage: [f("stageId", "stage id"), f("status", "status"), f("pipelineId", "pipeline id")],
  ticket: [f("id", "id"), f("ref", "number"), f("title", "title"), f("type", "type"), f("priority", "priority"), f("status", "status"), f("companyId", "customer id"), f("contactId", "contact id"), f("assignedToUserId", "assigned to")],
  document: [f("id", "id"), f("number", "number"), f("type", "type"), f("status", "status"), f("companyId", "customer id"), f("total", "total"), f("currency", "currency"), f("issueDate", "issue date"), f("dueDate", "due date"), f("salespersonId", "salesperson"), f("categories", "product categories"), f("brands", "brands"), f("families", "product families")],
  payment: [f("id", "id"), f("ref", "number"), f("amount", "amount"), f("currency", "currency"), f("method", "method"), f("reference", "reference"), f("companyId", "customer id"), f("invoiceId", "invoice id")],
  order: [f("id", "id"), f("ref", "number"), f("status", "status"), f("companyId", "customer id"), f("itemId", "product id"), f("itemName", "product"), f("itemSku", "product SKU"), f("itemCategory", "product category"), f("brand", "brand"), f("family", "product family"), f("quantity", "quantity"), f("unitPrice", "unit price"), f("endDate", "ends on"), f("addedByUserId", "added by")],
  booking: [f("id", "id"), f("pageId", "booking page id"), f("page", "booking page"), f("hostUserId", "host"), f("startsAt", "starts at"), f("endsAt", "ends at")],
  person: [f("id", "id"), f("name", "name"), f("role", "role"), f("designation", "designation"), f("departmentId", "team id"), f("department", "team"), f("managerId", "manager"), f("joinedOn", "joining date")],
  task: [f("id", "id"), f("title", "title"), f("status", "status"), f("priority", "priority"), f("dueDate", "due date"), f("assignedToUserId", "assigned to"), f("createdByUserId", "created by"), f("companyId", "customer id"), f("leadId", "lead id"), f("ticketId", "ticket id")],
  form: [f("id", "id"), f("name", "name")],
  list: [f("id", "id"), f("name", "name"), f("kind", "kind (ROWS or COMPANIES)")],
  row: [f("id", "id"), f("title", "title")],
  column: [f("id", "id"), f("name", "name"), f("kind", "kind")],
  submission: [f("id", "id")],
  visit: [f("path", "page"), f("title", "page title"), f("host", "site"), f("visits", "visits so far"), f("city", "city"), f("country", "country"), f("device", "device"), f("network", "network")],
  conversation: [
    f("id", "id"),
    f("ref", "number"),
    f("channel", "channel"),
    f("kind", "kind (WEB or WHATSAPP)"),
    f("customerName", "customer's name"),
    f("customerPhone", "customer's phone"),
    f("customerEmail", "customer's email"),
    f("firstMessage", "first message"),
    f("pageUrl", "page it started on"),
    f("assignedToUserId", "assigned to"),
  ],
};

const LABELS: Record<string, string> = {
  lead: "Lead",
  company: "Customer",
  contact: "Contact",
  ticket: "Ticket",
  document: "Document",
  payment: "Payment",
  order: "Order",
  booking: "Booking",
  task: "Task",
  person: "Person",
  form: "Form",
  list: "Smart List",
  row: "Row",
  column: "Column",
  addedVia: "Added via (hand, import, form or repeat)",
  addedBy: "Added by",
  changedBy: "Changed by",
  submission: "Response",
  conversation: "Conversation",
  visit: "Visit",
  from: "From",
  to: "To",
  field: "Date field",
  record: "Record",
  date: "The date",
};

/**
 * Every reference a trigger offers — "trigger.lead.title", labelled "Lead › title" — so the builder's
 * data picker inserts them and nobody types `{{…}}` by hand. A lead move's from and to are stages; a
 * ticket's are statuses.
 */
export function triggerPaths(type: string): { ref: string; label: string }[] {
  const trigger = triggerByType(type);
  if (!trigger) return [];
  const out: { ref: string; label: string }[] = [];
  for (const field of trigger.fields) {
    const part = (field === "from" || field === "to") && type.startsWith("lead.") ? "stage" : PARTS[field] ? field : null;
    const title = LABELS[field] ?? field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
    if (!part) {
      out.push({ ref: `trigger.${field}`, label: title });
      continue;
    }
    for (const sub of PARTS[part]!) out.push({ ref: `trigger.${field}.${sub.key}`, label: `${title} › ${sub.label}` });
  }
  return out;
}
