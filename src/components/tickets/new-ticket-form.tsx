"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { z } from "zod";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import {
  createTicketSchema,
  type CreateTicketInput,
  ticketPriorityValues,
  ticketTypeValues,
} from "@/lib/validation/ticket";
import {
  addTicketContact,
  createTicket,
  listCompanyOrderOptions,
  listTicketContacts,
  searchTicketCompanies,
  ticketContactFieldSetup,
  ticketNamesakes,
} from "@/actions/ticket";
import { NewContactDialog, type CreatedContact } from "@/components/companies/new-contact-dialog";
import type { TicketContact, TicketContacts } from "@/lib/ticket-contacts";
import { ticketTypeLabels } from "@/lib/tickets";
import { formatOrderId } from "@/lib/order-id";
import { formatCalendarDay } from "@/lib/time/zone";
import { ticketPath } from "@/lib/record-links";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";

type AssignableUser = { id: string; name: string; role: string };
type OrderOption = Awaited<ReturnType<typeof listCompanyOrderOptions>>[number];
type Namesake = Awaited<ReturnType<typeof ticketNamesakes>>[number];
type FormValues = z.input<typeof createTicketSchema>;

export function NewTicketForm({
  companies: sent,
  initialCompanyId,
  initialContacts = null,
  companySearch = false,
  itemsEnabled,
  initialOrders = [],
  initialNamesakes = [],
  users,
}: {
  /** The first page of companies by name, without contacts — the page sends a few hundred, not the book. */
  companies: CompanyComboOption[];
  initialCompanyId?: string;
  /** The prefilled company's people, so the field is ready without a round trip. */
  initialContacts?: TicketContacts | null;
  /** `companies` is incomplete: the picker searches the server for the rest. */
  companySearch?: boolean;
  itemsEnabled: boolean;
  initialOrders?: OrderOption[];
  /** The prefilled company's namesakes with something live, when it has nothing. */
  initialNamesakes?: Namesake[];
  users: AssignableUser[];
}) {
  const router = useRouter();
  const w = useWording();
  const [serverError, setServerError] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrderOption[]>(initialOrders);
  const [ordersPending, startOrdersTransition] = useTransition();
  // The company last picked, for one that came from a search and so is not in `companies`.
  const [picked, setPicked] = useState<CompanyComboOption | null>(null);
  const [onlyLive, setOnlyLive] = useState(false);
  // With the one last picked, so a namesake chosen below the field is one the field can name.
  const companies = useMemo(() => (picked && !sent.some((c) => c.id === picked.id) ? [picked, ...sent] : sent), [sent, picked]);
  // Companies of the same name with something live, when the one picked has nothing. Keyed by company, as contacts are.
  const [namesakes, setNamesakes] = useState<{ companyId: string; rows: Namesake[] }>({ companyId: initialCompanyId ?? "", rows: initialNamesakes });
  // The chosen company's people, fetched when it is picked (owner, 30 Oct 2026) rather than sent for
  // every company with the page. Keyed by company, so a slow answer for an earlier pick is never shown.
  const [contacts, setContacts] = useState<{ companyId: string; options: TicketContact[]; mayAdd?: boolean; state?: "failed" | "ready" }>({
    companyId: initialCompanyId ?? "",
    options: initialContacts?.contacts ?? [],
    mayAdd: initialContacts?.mayAdd,
    state: "ready",
  });
  const [contactDialog, setContactDialog] = useState(false);
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateTicketInput>({
    resolver: zodResolver(createTicketSchema),
    defaultValues: { companyId: initialCompanyId ?? "", priority: "MEDIUM", ticketType: "PRODUCT_SUPPORT" },
  });

  const selectedCompanyId = watch("companyId");
  const selectedCompany =
    companies.find((c) => c.id === selectedCompanyId) ?? (picked?.id === selectedCompanyId ? picked : undefined);
  const theirs = selectedCompany && contacts.companyId === selectedCompany.id ? contacts : null;
  const contactOptions = theirs?.options ?? [];

  function loadContactsFor(companyId: string) {
    listTicketContacts(companyId)
      .then((found) => setContacts((now) => (now.companyId === companyId ? { companyId, options: found.contacts, mayAdd: found.mayAdd, state: "ready" } : now)))
      .catch(() => setContacts((now) => (now.companyId === companyId ? { ...now, state: "failed" } : now)));
  }

  function contactAdded(companyId: string, contact: CreatedContact) {
    setContacts((now) => (now.companyId === companyId ? { ...now, options: [...now.options, contact] } : now));
    setValue("contactId", contact.id);
    setContactDialog(false);
  }

  // The company orders were last asked for, so a slow answer for an earlier pick is never shown.
  const ordersFor = useRef(initialCompanyId ?? "");
  function loadOrdersFor(companyId: string) {
    if (!itemsEnabled) return;
    startOrdersTransition(async () => {
      const result = await listCompanyOrderOptions(companyId);
      if (ordersFor.current === companyId) setOrders(result);
    });
  }

  // Their one live order is the one it is about, until somebody says otherwise. After the list is drawn: the field can't
  // hold a choice it hasn't got yet.
  useEffect(() => {
    if (orders.length === 1) setValue("companyProductId", orders[0]!.id);
  }, [orders, setValue]);

  function pickCompany(company: CompanyComboOption | null) {
    setValue("companyId", company?.id ?? "", { shouldValidate: !!company });
    setValue("companyProductId", "");
    // Nobody from the company picked before.
    setValue("contactId", "");
    setPicked(company);
    setContacts({ companyId: company?.id ?? "", options: [] });
    setNamesakes({ companyId: company?.id ?? "", rows: [] });
    setOrders([]);
    ordersFor.current = company?.id ?? "";
    if (!company) return;
    loadContactsFor(company.id);
    loadOrdersFor(company.id);
    if (itemsEnabled && !company.live) {
      ticketNamesakes(company.id)
        .then((rows) => setNamesakes((now) => (now.companyId === company.id ? { companyId: company.id, rows } : now)))
        .catch(() => {});
    }
  }

  async function onSubmit(values: CreateTicketInput) {
    setServerError(null);
    const result = await createTicket(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.push(ticketPath(result.data.ticketSeq));
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {serverError && <div className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</div>}

          <div className="space-y-1.5">
            <Label htmlFor="companyId">{slot(w, "Company *", "company", "{one} *")}</Label>
            <Controller
              name="companyId"
              control={control}
              render={({ field }) => (
                <CompanyCombobox
                  companies={companies}
                  search={companySearch ? searchTicketCompanies : undefined}
                  value={field.value ?? ""}
                  only={onlyLive ? (c) => !!c.live : undefined}
                  panelHeader={
                    itemsEnabled ? (
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
                        <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--brand)]" checked={onlyLive} onChange={(e) => setOnlyLive(e.target.checked)} />
                        {slot(w, "Only companies with an active order", "company", "Only {many:lower} with an active order")}
                      </label>
                    ) : undefined
                  }
                  onSelect={pickCompany}
                />
              )}
            />
            {errors.companyId && <p className="text-xs text-danger">{errors.companyId.message}</p>}
            {selectedCompany?.live && <Badge tone="green">Live</Badge>}
            {selectedCompany && namesakes.companyId === selectedCompany.id && namesakes.rows.length > 0 && (
              <div className="rounded-md bg-warning-bg px-3 py-2 text-xs text-warning" role="status">
                <p>No active order for this one. Did you mean:</p>
                {namesakes.rows.map((n) => (
                  <p key={n.id} className="mt-1">
                    <button type="button" className="font-medium underline underline-offset-2" onClick={() => pickCompany(n)}>
                      {n.name}
                    </button>
                    <Badge tone="green" className="ml-1.5">
                      Live
                    </Badge>
                  </p>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="contactId">{slot(w, "Contact", "contact", "{one}")}</Label>
            <div className="flex gap-2">
              {/* Controlled: one added below is picked from code, which an uncontrolled SearchSelect wouldn't show. */}
              <Controller
                name="contactId"
                control={control}
                render={({ field }) => (
                  <SearchSelect
                    id="contactId"
                    className="flex-1"
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={(e) => field.onChange(e.target.value)}
                    disabled={!selectedCompany}
                    searchPlaceholder="Search contacts…"
                  >
                    <option value="">
                      {theirs && !theirs.state
                        ? slot(w, "Loading contacts…", "contact", "Loading {many:lower}…")
                        : slot(w, "No specific contact", "contact", "No specific {one:lower}")}
                    </option>
                    {contactOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.designation.replaceAll("_", " ")})
                      </option>
                    ))}
                  </SearchSelect>
                )}
              />
              {theirs?.mayAdd && (
                <Button type="button" variant="secondary" onClick={() => setContactDialog(true)}>
                  {slot(w, "Add contact", "contact", "Add {one:lower}")}
                </Button>
              )}
            </div>
            {theirs?.state === "failed" && (
              <p className="text-xs text-danger" role="alert">
                {slot(w, "The contacts couldn't be loaded.", "contact", "The {many:lower} couldn't be loaded.")}{" "}
                <button type="button" className="font-medium underline underline-offset-2" onClick={() => loadContactsFor(theirs.companyId)}>
                  Try again
                </button>
              </p>
            )}
            {theirs?.state === "ready" && theirs.mayAdd && contactOptions.length === 0 && (
              <p className="text-xs text-subtle">
                {slot(w, "No contact here yet — add the person who asked.", "contact", "No {one:lower} here yet — add the person who asked.")}
              </p>
            )}
          </div>

          {itemsEnabled && (
            <div className="space-y-1.5">
              <Label htmlFor="companyProductId">{slot(w, "Order this is about", "order", "{one} this is about")}</Label>
              <Select id="companyProductId" {...register("companyProductId")} disabled={!selectedCompany || ordersPending}>
                <option value="">{slot(w, "Free Support (no specific order)", "order", "Free Support (no specific {one:lower})")}</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {formatOrderId(o.orderSeq)} — {o.item.name}
                    {o.until ? ` · until ${formatCalendarDay(o.until)}` : ""}
                  </option>
                ))}
              </Select>
              {selectedCompany && !ordersPending && orders.length === 0 && (
                <p className="text-xs text-subtle">
                  Nothing live for this {slot(w, "company", "company", "{one:lower}")} — no delivered product or active subscription — so this will be logged as Free Support.
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="title">Title *</Label>
            <Input id="title" placeholder="e.g. Can't sign in to Microsoft 365" {...register("title")} />
            {errors.title && <p className="text-xs text-danger">{errors.title.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" {...register("description")} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ticketType">Support type</Label>
              <Select id="ticketType" {...register("ticketType")}>
                {ticketTypeValues.map((t) => (
                  <option key={t} value={t}>
                    {ticketTypeLabels[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="priority">Priority</Label>
              <Select id="priority" {...register("priority")}>
                {ticketPriorityValues.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="assignedToUserId">Assign to</Label>
            <SearchSelect id="assignedToUserId" {...register("assignedToUserId")} searchPlaceholder="Search people…">
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </SearchSelect>
            {users.length === 0 && (
              <p className="text-xs text-subtle">
                {slot(w, "No one is in the Tech Support department yet — mark a department for ticket assignment under Settings.", "ticket", "No one is in the Tech Support department yet — mark a department for {one:lower} assignment under Settings.")}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : slot(w, "Create ticket", "ticket", "Create {one:lower}")}
            </Button>
          </div>
        </form>
      </CardContent>
      {selectedCompany && theirs?.mayAdd && (
        <NewContactDialog
          key={selectedCompany.id}
          open={contactDialog}
          companyId={selectedCompany.id}
          companyName={selectedCompany.name}
          save={addTicketContact}
          fieldSetup={ticketContactFieldSetup}
          note={slot(w, "Added to the company's contacts, and picked for this ticket.", "ticket", "Added to the company's contacts, and picked for this {one:lower}.")}
          onClose={() => setContactDialog(false)}
          onCreated={(contact) => contactAdded(selectedCompany.id, contact)}
        />
      )}
    </Card>
  );
}
