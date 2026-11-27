"use client";

import { useId, useState } from "react";
import type { z } from "zod";
import {
  useForm,
  type UseFormRegister,
  type FieldValues,
  type FieldErrors,
  type UseFormWatch,
  type UseFormSetValue,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import type { GstTreatment } from "@prisma/client";
import {
  addCompanyLocationSchema,
  updateCompanyLocationSchema,
  type AddCompanyLocationInput,
  type UpdateCompanyLocationInput,
} from "@/lib/validation/company-location";
import {
  addCompanyLocation,
  updateCompanyLocation,
  setPrimaryLocation,
  deleteCompanyLocation,
} from "@/actions/company-location";
import { Lock, Star, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input, Label, Select } from "@/components/ui/input";
import { AddressFields } from "@/components/ui/address-fields";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { gstTreatmentValues, gstTreatmentLabels } from "@/lib/gst";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";
import { GstinAssist } from "@/components/companies/gstin-assist";
import { workspacePack } from "@/lib/country-pack";
import { GstinBadge } from "@/components/companies/gstin-badge";
import { gstinNotes, normalizeGstin, type GstinCheckView } from "@/lib/gstin/notes";

export type Location = {
  id: string;
  label: string;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  pincode: string | null;
  gstNumber: string | null;
  gstTreatment: GstTreatment;
  isPrimary: boolean;
  isBilling: boolean;
  isShipping: boolean;
};

/**
 * Which of a location's parts field access hides from this person (owner, 5 Nov 2026 — Phase 3 masking fixes, audit
 * H.4.2, src/lib/companies/masking.ts): the address (street, city, state, PIN code) and the GSTIN. They arrive masked,
 * an edit leaves them out, and `updateCompanyLocation` keeps what is stored.
 */
export type HiddenLocationParts = { address: boolean; gstin: boolean };
const NOTHING_HIDDEN: HiddenLocationParts = { address: false, gstin: false };

/** A location's address on one line — a masked one's parts, each "********", said once rather than four times. */
function addressText(parts: (string | null)[]): string {
  return parts.filter((p): p is string => Boolean(p)).filter((p, i, all) => i === 0 || p !== all[i - 1]).join(", ");
}

function LocationFields({
  register,
  errors,
  watch,
  setValue,
  companyPan,
  gstinChecks,
  hidden = NOTHING_HIDDEN,
}: {
  register: UseFormRegister<FieldValues>;
  errors: FieldErrors<FieldValues>;
  /**
   * Country, state and city are pickers rather than text boxes, so they cannot be `register`ed —
   * the form has to hand their current values in and take the new ones back.
   */
  watch: UseFormWatch<FieldValues>;
  setValue: UseFormSetValue<FieldValues>;
  /** For the GSTIN's notes: the company's PAN on file, and what the GST system said about its GSTINs. */
  companyPan?: string | null;
  gstinChecks?: Record<string, GstinCheckView>;
  /** Parts masked for this person: left out of the form, and kept as stored when it's saved. */
  hidden?: HiddenLocationParts;
}) {
  // These fields already carry visible labels, so they are wired up with htmlFor rather than
  // aria-label — one source of truth for the wording, and the label text becomes a click target.
  // The prefix comes from useId because the add form and an open edit form render this component
  // side by side; a fixed id would appear twice and both labels would point at the first copy.
  const uid = useId();
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="col-span-2 space-y-1">
        <Label htmlFor={`${uid}-label`} className="text-xs">
          Label
        </Label>
        <Input id={`${uid}-label`} placeholder="e.g. Head Office — Maharashtra" {...register("label")} />
        {errors.label && <p className="text-xs text-danger">{String(errors.label.message)}</p>}
      </div>
      {!hidden.address && (
        <div className="col-span-2 space-y-1">
          <Label htmlFor={`${uid}-address`} className="text-xs">
            Address
          </Label>
          <Input id={`${uid}-address`} {...register("address")} />
        </div>
      )}
      {/**
        * The state here is what decides the tax on every document raised against this address, so
        * it is chosen from the GST table rather than typed. See `AddressFields`.
        */}
      {!hidden.address && (
        <div className="col-span-2">
          <AddressFields
            columns={2}
            country={String(watch("country") ?? "")}
            state={String(watch("state") ?? "")}
            city={String(watch("city") ?? "")}
            pincode={String(watch("pincode") ?? "")}
            onChange={(patch) => {
              for (const [key, value] of Object.entries(patch)) {
                // `shouldDirty` so the form knows something changed — without it the Save button on
                // the edit form stays disabled after picking a state and nothing can be saved.
                setValue(key, value, { shouldDirty: true, shouldValidate: true });
              }
            }}
          />
          {errors.pincode && <p className="mt-1 text-xs text-danger">{String(errors.pincode.message)}</p>}
        </div>
      )}
      {/* India's GST registration; another country's pack has none to ask for yet (src/lib/country-pack.ts). */}
      {workspacePack().india && !hidden.gstin && (
        <div className="space-y-1">
          <Label htmlFor={`${uid}-gstNumber`} className="text-xs">
            GST number
          </Label>
          <Input id={`${uid}-gstNumber`} className="font-mono uppercase" spellCheck={false} {...register("gstNumber")} />
        </div>
      )}
      {/* The UAE's TRN, kept where India keeps the GSTIN: it prints on their tax invoices (src/lib/vat/rules.ts). */}
      {workspacePack().country === "AE" && !hidden.gstin && (
        <div className="space-y-1">
          <Label htmlFor={`${uid}-gstNumber`} className="text-xs">
            TRN
          </Label>
          <Input id={`${uid}-gstNumber`} className="font-mono" inputMode="numeric" placeholder="15 digits, if VAT-registered" spellCheck={false} {...register("gstNumber")} />
          {errors.gstNumber && <p className="mt-1 text-xs text-danger">{String(errors.gstNumber.message)}</p>}
        </div>
      )}
      {/* What the GSTIN itself says as it's typed, and a check with the GST system that can fill the address. */}
      {workspacePack().india && !hidden.address && !hidden.gstin && (
        <div className="col-span-2">
          <GstinAssist
            gstin={String(watch("gstNumber") ?? "")}
            state={String(watch("state") ?? "")}
            companyPan={companyPan}
            treatment={String(watch("gstTreatment") ?? "")}
            saved={gstinChecks?.[normalizeGstin(String(watch("gstNumber") ?? ""))] ?? null}
            onUse={(found) => {
              const set = (key: string, value: string) => setValue(key, value, { shouldDirty: true, shouldValidate: true });
              if (found.address) set("address", found.address);
              if (found.state) {
                // Another state's city can't stay: the picker offers the new state's.
                if (found.state !== String(watch("state") ?? "")) set("city", "");
                set("country", "India");
                set("state", found.state);
              }
              if (found.pincode) set("pincode", found.pincode);
              if (found.treatment) set("gstTreatment", found.treatment);
            }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
        {/* Both, because most customers bill and ship to one place and making them record it
            twice is how the two drift apart. */}
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="h-4 w-4 rounded border-line-strong" {...register("isBilling")} />
          Bill to this address
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="h-4 w-4 rounded border-line-strong" {...register("isShipping")} />
          Ship to this address
        </label>
      </div>
      {workspacePack().india && (
        <div className="col-span-2 space-y-1">
          <Label htmlFor={`${uid}-gstTreatment`} className="text-xs">
            GST treatment
          </Label>
          <Select id={`${uid}-gstTreatment`} {...register("gstTreatment")}>
            {gstTreatmentValues.map((t) => (
              <option key={t} value={t}>
                {gstTreatmentLabels[t]}
              </option>
            ))}
          </Select>
        </div>
      )}
      {(hidden.address || hidden.gstin) && (
        <p className="col-span-2 flex items-center gap-1.5 text-xs text-warning">
          <Lock className="h-3 w-3 shrink-0" aria-hidden />
          {hidden.address && hidden.gstin ? "The address and GST number are" : hidden.address ? "The address is" : "The GST number is"} masked for you — saving keeps{" "}
          {hidden.address && hidden.gstin ? "them" : "it"} as {hidden.address && hidden.gstin ? "they are" : "it is"}.
        </p>
      )}
    </div>
  );
}

function EditLocationForm({
  location,
  onClose,
  companyPan,
  gstinChecks,
  hidden = NOTHING_HIDDEN,
}: {
  location: Location;
  onClose: () => void;
  companyPan?: string | null;
  gstinChecks?: Record<string, GstinCheckView>;
  hidden?: HiddenLocationParts;
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  type FormValues = z.input<typeof updateCompanyLocationSchema>;
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, UpdateCompanyLocationInput>({
    resolver: zodResolver(updateCompanyLocationSchema),
    defaultValues: {
      id: location.id,
      label: location.label,
      // A masked part starts blank and isn't shown: the save keeps what is stored (`updateCompanyLocation`).
      address: hidden.address ? "" : (location.address ?? ""),
      city: hidden.address ? "" : (location.city ?? ""),
      state: hidden.address ? "" : (location.state ?? ""),
      country: location.country ?? "",
      pincode: hidden.address ? "" : (location.pincode ?? ""),
      gstNumber: hidden.gstin ? "" : (location.gstNumber ?? ""),
      isBilling: location.isBilling,
      isShipping: location.isShipping,
      gstTreatment: location.gstTreatment,
    },
  });

  async function onSubmit(values: UpdateCompanyLocationInput) {
    setServerError(null);
    const result = await updateCompanyLocation(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 rounded-md border border-line bg-surface-sunken p-3">
      {serverError && <p className="text-xs text-danger">{serverError}</p>}
      <LocationFields
        register={register as unknown as UseFormRegister<FieldValues>}
        errors={errors}
        watch={watch as unknown as UseFormWatch<FieldValues>}
        setValue={setValue as unknown as UseFormSetValue<FieldValues>}
        companyPan={companyPan}
        gstinChecks={gstinChecks}
        hidden={hidden}
      />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function LocationsManager({
  companyId,
  locations,
  companyPan = null,
  gstinChecks = {},
  hidden = NOTHING_HIDDEN,
}: {
  companyId: string;
  locations: Location[];
  companyPan?: string | null;
  /** What the GST system said about these GSTINs when last checked, by GSTIN (src/lib/gstin/lookup.ts). */
  gstinChecks?: Record<string, GstinCheckView>;
  /** What field access masks for this person on the company's page — the same for each of its locations. */
  hidden?: HiddenLocationParts;
}) {
  const router = useRouter();
  const w = useWording();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const deleteTarget = locations.find((l) => l.id === deleteTargetId) ?? null;
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [addServerError, setAddServerError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  type AddFormValues = z.input<typeof addCompanyLocationSchema>;
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<AddFormValues, unknown, AddCompanyLocationInput>({
    resolver: zodResolver(addCompanyLocationSchema),
    defaultValues: { companyId, label: "", gstTreatment: "UNREGISTERED" },
  });

  async function onAddSubmit(values: AddCompanyLocationInput) {
    setAddServerError(null);
    const result = await addCompanyLocation(values);
    if (!result.ok) {
      setAddServerError(result.error);
      return;
    }
    reset({ companyId, label: "", address: "", city: "", state: "", country: "", pincode: "", gstNumber: "", gstTreatment: "UNREGISTERED" });
    setAddOpen(false);
    router.refresh();
  }

  function handleSetPrimary(id: string) {
    setPendingId(id);
    setPrimaryLocation(id).finally(() => {
      setPendingId(null);
      router.refresh();
    });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    setPendingId(deleteTarget.id);
    deleteCompanyLocation(deleteTarget.id).then((result) => {
      setPendingId(null);
      if (!result.ok) {
        setDeleteError(result.error);
        return;
      }
      setDeleteTargetId(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {locations.map((loc) =>
        editingId === loc.id ? (
          <EditLocationForm key={loc.id} location={loc} onClose={() => setEditingId(null)} companyPan={companyPan} gstinChecks={gstinChecks} hidden={hidden} />
        ) : (
          <div key={loc.id} className="flex items-start justify-between text-sm">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-text">{loc.label}</span>
                {loc.isPrimary && <Badge tone="blue">Primary</Badge>}
                {loc.isBilling && <Badge tone="green">Billing</Badge>}
                {loc.isShipping && <Badge tone="amber">Shipping</Badge>}
              </div>
              <div className="text-muted">
                {addressText([loc.address, loc.city, loc.state, loc.pincode, loc.country]) || "No address on file"}
              </div>
              {workspacePack().india && (
                <div className="flex flex-wrap items-center gap-1.5 text-muted">
                  GST: {loc.gstNumber ?? "—"} · {gstTreatmentLabels[loc.gstTreatment]}
                  {loc.gstNumber && !hidden.gstin && <GstinBadge check={gstinChecks[normalizeGstin(loc.gstNumber)] ?? null} />}
                </div>
              )}
              {workspacePack().country === "AE" && loc.gstNumber && <div className="text-muted">TRN: {loc.gstNumber}</div>}
              {/* A masked GSTIN or state would only be compared with stars. */}
              {(workspacePack().india && !hidden.address && !hidden.gstin ? gstinNotes({ gstin: loc.gstNumber, state: loc.state, companyPan, treatment: loc.gstTreatment }) : []).map((note) => (
                <p key={note} className="text-xs text-warning">
                  {note}
                </p>
              ))}
            </div>
            <RowActions className="shrink-0">
              {!loc.isPrimary && (
                <IconButton
                  icon={Star}
                  label="Make this the primary site"
                  disabled={pendingId === loc.id}
                  onClick={() => handleSetPrimary(loc.id)}
                />
              )}
              <IconButton icon={Pencil} label="Edit site" onClick={() => setEditingId(loc.id)} />
              {!loc.isPrimary && (
                <IconButton
                  icon={Trash2}
                  label="Delete site"
                  tone="danger"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteTargetId(loc.id);
                  }}
                />
              )}
            </RowActions>
          </div>
        ),
      )}

      {!addOpen ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
          + Add location
        </Button>
      ) : (
        <form onSubmit={handleSubmit(onAddSubmit)} className="space-y-2 rounded-md border border-line p-3">
          {addServerError && <p className="text-xs text-danger">{addServerError}</p>}
          <LocationFields
            register={register as unknown as UseFormRegister<FieldValues>}
            errors={errors}
            watch={watch as unknown as UseFormWatch<FieldValues>}
            setValue={setValue as unknown as UseFormSetValue<FieldValues>}
            companyPan={companyPan}
            gstinChecks={gstinChecks}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Adding…" : "Add location"}
            </Button>
          </div>
        </form>
      )}

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTargetId(null)} title="Delete location">
        <p className="text-sm text-muted">
          Delete <span className="font-medium text-text">{deleteTarget?.label}</span>? This can&apos;t be undone.{" "}
          {slot(w, "Locations with orders already attached to them can't be deleted.", "order", "Locations with {many:lower} already attached to them can't be deleted.")}
        </p>
        {deleteError && <p className="mt-2 text-xs text-danger">{deleteError}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteTargetId(null)} disabled={!!pendingId}>
            Cancel
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={confirmDelete} disabled={!!pendingId}>
            {pendingId === deleteTarget?.id ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
