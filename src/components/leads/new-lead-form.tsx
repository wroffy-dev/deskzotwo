"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { firstFormMessage, FORM_REFUSED } from "@/lib/forms/first-message";
import type { z } from "zod";
import { useForm, useFieldArray, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { unstable_rethrow, useRouter } from "next/navigation";
import { createLeadSchema, type CreateLeadInput } from "@/lib/validation/lead";
import { createLead } from "@/actions/lead";
import { companyContactOptions, searchCompanyOptions } from "@/actions/company-options";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  CustomFieldInputs,
  missingRequired,
  type CustomFieldFormValues,
  type CustomFieldPerson,
} from "@/components/custom-fields/custom-field-inputs";
import type { CustomFieldDef } from "@/lib/custom-fields/rules";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { QuickCreateCompanyDialog, type QuickCreatedCompany } from "@/components/companies/quick-create-company-dialog";
import { NewContactDialog, type CreatedContact } from "@/components/companies/new-contact-dialog";
import { ItemCombobox } from "@/components/items/item-combobox";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { leadPath } from "@/lib/record-links";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";
import { SearchSelect } from "@/components/ui/search-select";
import { baseSymbol } from "@/lib/currency";

type ItemOption = {
  id: string;
  name: string;
  sku: string;
  type: string;
  unit: string | null;
  sellingPrice: unknown;
};

type IndustryOption = { id: string; name: string };

type ContactOption = { id: string; name: string; designation: string };

type FormValues = z.input<typeof createLeadSchema>;

export function NewLeadForm({
  companies,
  companySearch = false,
  initialCompanyId,
  items,
  itemsEnabled,
  industries,
  currentUser,
  canAssign,
  canAddContact = true,
  people,
  customFields = { fields: [], values: {}, people: [] },
  pipelines = [],
  initialPipelineId,
  fromCall,
  prefill,
}: {
  companies: CompanyComboOption[];
  /** `companies` is not the whole book: two typed characters search the server. */
  companySearch?: boolean;
  initialCompanyId?: string;
  items: ItemOption[];
  itemsEnabled: boolean;
  industries: IndustryOption[];
  currentUser: { id: string; role: string };
  /** `leads.assign` — may choose anybody as the salesperson. */
  canAssign: boolean;
  /** `contacts.view` — may add a person at the company from here. */
  canAddContact?: boolean;
  people: PersonOption[];
  /** The workspace's own lead fields (src/lib/custom-fields/server.ts `formSetup`). */
  customFields?: { fields: CustomFieldDef[]; values: CustomFieldFormValues; people: CustomFieldPerson[] };
  /** The team pipelines in use (src/lib/pipeline) — offered only when there is more than one. */
  pipelines?: { id: string; name: string }[];
  initialPipelineId?: string;
  /**
   * A lead made from a call on the business line by a number on nobody (owner, 26 Oct 2026 — src/lib/telephony):
   * its source and the number, already in — the number on the new person, so their next call is logged.
   */
  fromCall?: { phone: string; detail: string };
  /** A lead to win a renewal elsewhere (owner, 2 Nov 2026 — src/lib/customers/elsewhere.ts): its words, date and product in. */
  prefill?: { title: string; description: string; expectedCloseDate: string; requirements: { itemId: string; quantity: number; notes: string; renewalDate: string }[] };
}) {
  const router = useRouter();
  const w = useWording();
  const [serverError, setServerError] = useState<string | null>(null);
  /**
   * One lead per form, however many times "Create lead" is pressed. The button is disabled while the
   * save runs, but that alone let duplicates through twice over: a double-click lands its second
   * click before React has drawn the button disabled, and once the lead was saved the button came
   * back to life while the lead's page was still opening — a second press there made a second lead.
   * The ref turns every submit after the first away at once, and stays set once the lead exists;
   * `opening` keeps the button saying so until the lead's page replaces this one.
   */
  const submitting = useRef(false);
  const [opening, setOpening] = useState(false);
  /**
   * This form's token, made once when it opens and sent with every try: the server keeps it on the
   * lead it makes, so the same form sent again — from a second tab, or after an answer that never
   * arrived — gets that lead back rather than a second one (createLead).
   */
  const [requestId] = useState(() => crypto.randomUUID());
  const [custom, setCustom] = useState<CustomFieldFormValues>(customFields.values);
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const [localCompanies, setLocalCompanies] = useState<CompanyComboOption[]>(companies);
  const [createDialog, setCreateDialog] = useState<{ open: boolean; initialName: string }>({
    open: false,
    initialName: "",
  });
  const [contactDialog, setContactDialog] = useState(false);
  // DOM ids for the product rows — from useId, never from useFieldArray's row id, which is a fresh
  // uuid per render environment and breaks hydration (see check:address).
  const rowId = useId();
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateLeadInput>({
    resolver: zodResolver(createLeadSchema),
    defaultValues: {
      companyId: initialCompanyId ?? "",
      requirements: prefill?.requirements ?? [],
      title: prefill?.title ?? "",
      description: prefill?.description ?? "",
      expectedCloseDate: prefill?.expectedCloseDate ?? "",
      source: fromCall ? "CALLING" : "OTHER",
      sourceDetail: fromCall?.detail ?? "",
      ownerUserId: "",
      pipelineId: initialPipelineId ?? "",
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "requirements" });

  const selectedCompanyId = watch("companyId");
  const selectedCompany = localCompanies.find((c) => c.id === selectedCompanyId);

  /**
   * The people at each company picked, asked for once it is picked (owner, 30 Oct 2026: the page no longer sends every
   * customer's contacts). Kept per company, so going back to one shows its people at once.
   */
  const [contactsByCompany, setContactsByCompany] = useState<Record<string, ContactOption[]>>({});
  const [contactsFailed, setContactsFailed] = useState<string | null>(null);
  const [contactsTry, setContactsTry] = useState(0);
  const companyContacts = selectedCompanyId ? contactsByCompany[selectedCompanyId] : undefined;

  useEffect(() => {
    if (!selectedCompanyId) return;
    let live = true;
    companyContactOptions(selectedCompanyId)
      .then((rows) => {
        if (!live) return;
        setContactsFailed(null);
        // Anybody added here while the answer was on its way stays, whichever arrived first.
        setContactsByCompany((prev) => ({ ...prev, [selectedCompanyId]: withAdded(rows, prev[selectedCompanyId]) }));
      })
      .catch(() => live && setContactsFailed(selectedCompanyId));
    return () => {
      live = false;
    };
  }, [selectedCompanyId, contactsTry]);

  function handleCompanyCreated(company: QuickCreatedCompany) {
    setLocalCompanies((prev) => [...prev, company]);
    // Its person is known already — in place now, so the select below can hold them as chosen.
    setContactsByCompany((prev) => ({ ...prev, [company.id]: withAdded(company.contacts, prev[company.id]) }));
    setValue("companyId", company.id, { shouldValidate: true });
    // The person entered in the dialog is who this lead is with — selected, not left for a second trip.
    setValue("contactId", company.contacts[0]?.id ?? "");
    setCreateDialog({ open: false, initialName: "" });
  }

  /**
   * A new person at the company already chosen: added to that company's contacts here, so the
   * dropdown can show them, and selected — they are who this lead came from.
   */
  function handleContactCreated(contact: CreatedContact) {
    setContactsByCompany((prev) => ({ ...prev, [selectedCompanyId]: withAdded(prev[selectedCompanyId] ?? [], [contact]) }));
    setValue("contactId", contact.id, { shouldDirty: true });
    setContactDialog(false);
  }

  async function onSubmit(values: CreateLeadInput) {
    if (submitting.current) return;
    setServerError(null);
    const missing = missingRequired(customFields.fields, custom);
    setCustomErrors(missing);
    if (Object.keys(missing).length > 0) return;
    submitting.current = true;
    try {
      const result = await createLead({ ...values, customFields: custom, requestId });
      if (!result.ok) {
        setServerError(result.error);
        submitting.current = false;
        return;
      }
      setOpening(true);
      router.push(leadPath(result.data.leadSeq));
    } catch (error) {
      // A redirect from the action (a session that ran out) is Next's to follow, not a failure here.
      unstable_rethrow(error);
      // The request itself failed (the network dropped, the server didn't answer) — the lead may or may
      // not exist. Trying again is safe: it carries the same token, so a lead already made is opened.
      submitting.current = false;
      setServerError(slot(w, "Couldn't reach the server. Try again — if the lead was already saved, it will open instead of being added twice.", "lead", "Couldn't reach the server. Try again — if the {one:lower} was already saved, it will open instead of being added twice."));
      console.error(error);
    }
  }
  const busy = isSubmitting || opening;

  return (
    <Card>
      <CardContent className="pt-5">
        <form onSubmit={handleSubmit(onSubmit, (found) => setServerError(firstFormMessage(found) ?? FORM_REFUSED))} aria-busy={busy} className="space-y-4">
          {serverError && (
            <div className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</div>
          )}
          {fromCall && (
            <div className="rounded-md border border-line bg-surface-sunken px-3 py-2 text-sm text-muted">
              From a call by <span className="font-mono text-text">{fromCall.phone}</span>. Add the company and the person who rang — their number is filled in, so their next
              call is logged here.
            </div>
          )}

          {pipelines.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="pipelineId">Pipeline</Label>
              <Select id="pipelineId" {...register("pipelineId")}>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted">It starts at the pipeline&apos;s first stage.</p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="companyId">{slot(w, "Company *", "company", "{one} *")}</Label>
            <Controller
              name="companyId"
              control={control}
              render={({ field }) => (
                <CompanyCombobox
                  // The label above was already written as `htmlFor="companyId"` but pointed at
                  // nothing, since the combobox owns the input; forwarding the id joins the two.
                  id="companyId"
                  companies={localCompanies}
                  search={companySearch ? (query) => searchCompanyOptions(query, { side: "customer" }) : undefined}
                  value={field.value ?? ""}
                  onSelect={(company) => {
                    // A search result is not among those sent; kept with them, so the form can name it and add its people.
                    if (company && !localCompanies.some((c) => c.id === company.id)) setLocalCompanies((prev) => [...prev, company]);
                    field.onChange(company?.id ?? "");
                  }}
                  onCreateNew={(query) => setCreateDialog({ open: true, initialName: query })}
                />
              )}
            />
            {errors.companyId && <p className="text-xs text-danger">{errors.companyId.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="contactId">{slot(w, "Contact", "contact", "{one}")}</Label>
            <div className="flex gap-2">
              <SearchSelect id="contactId" className="flex-1" searchPlaceholder="Search contacts…" {...register("contactId")} disabled={!selectedCompany}>
                <option value="">
                  {selectedCompany && !companyContacts && contactsFailed !== selectedCompanyId
                    ? slot(w, "Loading contacts…", "contact", "Loading {many:lower}…")
                    : slot(w, "No specific contact", "contact", "No specific {one:lower}")}
                </option>
                {companyContacts?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.designation.replaceAll("_", " ")})
                  </option>
                ))}
              </SearchSelect>
              {canAddContact && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!selectedCompany}
                  onClick={() => setContactDialog(true)}
                  title={selectedCompany ? undefined : slot(w, "Choose the company first", "company", "Choose the {one:lower} first")}
                >
                  {slot(w, "+ New contact", "contact", "+ New {one:lower}")}
                </Button>
              )}
            </div>
            {selectedCompanyId && contactsFailed === selectedCompanyId && (
              <p className="text-xs text-danger">
                {slot(w, "Couldn't load the company's contacts.", "contact", "Couldn't load the company's {many:lower}.")}{" "}
                <button type="button" className="underline" onClick={() => setContactsTry((n) => n + 1)}>
                  Try again
                </button>
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="title">Title *</Label>
            <Input id="title" placeholder="e.g. Microsoft 365 renewal — 25 seats" {...register("title")} />
            {errors.title && <p className="text-xs text-danger">{errors.title.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">Requirement details</Label>
            <Textarea id="description" {...register("description")} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="estimatedValue">Estimated value ({baseSymbol()})</Label>
              <Input id="estimatedValue" type="number" step="0.01" {...register("estimatedValue")} />
              {errors.estimatedValue && <p className="text-xs text-danger">{errors.estimatedValue.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="expectedCloseDate">Expected close date</Label>
              <Input id="expectedCloseDate" type="date" {...register("expectedCloseDate")} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="source">Source</Label>
              <Select id="source" {...register("source")}>
                {LEAD_SOURCE_VALUES.map((s) => (
                  <option key={s} value={s}>
                    {LEAD_SOURCE_LABELS[s]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sourceDetail">Source detail</Label>
              <Input
                id="sourceDetail"
                placeholder="Which website or page, campaign, who referred them…"
                autoComplete="off"
                {...register("sourceDetail")}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ownerUserId">Salesperson</Label>
            {canAssign ? (
              <>
                <Controller
                  name="ownerUserId"
                  control={control}
                  render={({ field }) => (
                    <PersonCombobox
                      id="ownerUserId"
                      people={people}
                      value={field.value ?? ""}
                      onSelect={(person) => field.onChange(person?.id ?? "")}
                      placeholder="Search a salesperson — or leave empty to assign automatically"
                    />
                  )}
                />
                <p className="text-xs text-subtle">
                  Left empty, the assignment rules choose (Settings → Lead assignment).
                </p>
              </>
            ) : (
              // Without `leads.assign` there is no choice to offer — say where it will go instead.
              <p id="ownerUserId" className="text-sm text-muted">
                {currentUser.role === "SALES" ? slot(w, "This lead will be yours.", "lead", "This {one:lower} will be yours.") : "Assigned automatically by the lead assignment rules."}
              </p>
            )}
          </div>

          {itemsEnabled && (
            <div className="space-y-2 border-t border-line pt-4">
              <div className="flex items-center justify-between">
                <Label>Products required</Label>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => append({ itemId: "", quantity: 1, notes: "", renewalDate: "" })}
                  disabled={items.length === 0}
                >
                  + Add product
                </Button>
              </div>
              {items.length === 0 && (
                <p className="text-xs text-subtle">{slot(w, "No active items in the catalog yet.", "item", "No active {many:lower} in the catalog yet.")}</p>
              )}
              {fields.map((field, index) => {
                const selectedItemId = watch(`requirements.${index}.itemId`);
                const selectedItem = items.find((i) => i.id === selectedItemId);
                return (
                  <div key={field.id} className="space-y-2 rounded-md border border-line p-2.5">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        {/* Search, not a dropdown: the catalogue is long, and the name is what people know. */}
                        <Controller
                          name={`requirements.${index}.itemId` as const}
                          control={control}
                          render={({ field: itemField }) => (
                            <ItemCombobox
                              items={items}
                              value={itemField.value ?? ""}
                              onSelect={(item) => itemField.onChange(item?.id ?? "")}
                              ariaLabel={`Product ${index + 1}`}
                              showPrice
                            />
                          )}
                        />
                        {errors.requirements?.[index]?.quantity && <p className="text-xs text-danger">{errors.requirements[index]?.quantity?.message}</p>}
                        {errors.requirements?.[index]?.itemId && (
                          <p className="text-xs text-danger">{errors.requirements[index]?.itemId?.message}</p>
                        )}
                        {selectedItem && <p className="text-xs text-subtle">{selectedItem.type}</p>}
                      </div>
                      <div className="w-20">
                        <Input
                          type="number"
                          min={1}
                          placeholder="Qty"
                          aria-label={`Quantity for product ${index + 1}`}
                          {...register(`requirements.${index}.quantity` as const)}
                        />
                      </div>
                      <Button type="button" variant="ghost" size="sm" onClick={() => remove(index)}>
                        Remove
                      </Button>
                    </div>
                    {/* Both optional. The remarks are where the reference to an existing subscription goes,
                        so a renewal can be matched to the right tenant or VIP account later. */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[11rem_1fr]">
                      <div className="space-y-1">
                        <Label htmlFor={`${rowId}-${index}-renewal`} className="text-xs">
                          {slot(w, "Renewal date", "renewal", "{one} date")}
                        </Label>
                        <Input
                          id={`${rowId}-${index}-renewal`}
                          type="date"
                          {...register(`requirements.${index}.renewalDate` as const)}
                        />
                        {errors.requirements?.[index]?.renewalDate && (
                          <p className="text-xs text-danger">{errors.requirements[index]?.renewalDate?.message}</p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`${rowId}-${index}-remarks`} className="text-xs">
                          Remarks
                        </Label>
                        <Input
                          id={`${rowId}-${index}-remarks`}
                          placeholder="Contract ID, VIP number, subscription ID, tenant ID…"
                          autoComplete="off"
                          {...register(`requirements.${index}.notes` as const)}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {customFields.fields.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">More details</CardHeader>
              <CardContent>
                <CustomFieldInputs
                  fields={customFields.fields}
                  values={custom}
                  people={customFields.people}
                  errors={customErrors}
                  onChange={(key, value) => setCustom((c) => ({ ...c, [key]: value }))}
                />
              </CardContent>
            </Card>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => router.back()} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
              {opening
                ? slot(w, "Opening lead…", "lead", "Opening {one:lower}…")
                : isSubmitting
                  ? slot(w, "Creating lead…", "lead", "Creating {one:lower}…")
                  : slot(w, "Create lead", "lead", "Create {one:lower}")}
            </Button>
            <span role="status" className="sr-only">
              {opening ? slot(w, "Lead created. Opening it…", "lead", "{one} created. Opening it…") : isSubmitting ? slot(w, "Creating the lead…", "lead", "Creating the {one:lower}…") : ""}
            </span>
          </div>
        </form>
      </CardContent>

      <QuickCreateCompanyDialog
        open={createDialog.open}
        initialName={createDialog.initialName}
        industries={industries}
        canAddContact={canAddContact}
        initialContactPhone={fromCall?.phone}
        onClose={() => setCreateDialog({ open: false, initialName: "" })}
        onCreated={handleCompanyCreated}
      />
      {selectedCompany && canAddContact && (
        <NewContactDialog
          open={contactDialog}
          companyId={selectedCompany.id}
          companyName={selectedCompany.name}
          initialPhone={fromCall?.phone}
          onClose={() => setContactDialog(false)}
          onCreated={handleContactCreated}
        />
      )}
    </Card>
  );
}

/** A company's people with any added here that the list doesn't hold yet — once each. */
function withAdded(rows: ContactOption[], added: ContactOption[] | undefined): ContactOption[] {
  const extra = (added ?? []).filter((a) => !rows.some((r) => r.id === a.id));
  return extra.length ? [...rows, ...extra] : rows;
}
