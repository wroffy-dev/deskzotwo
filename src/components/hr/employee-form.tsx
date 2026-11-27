"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { getPerson } from "@/actions/hr";
import { saveEmployeeProfile } from "@/actions/hr";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { AddressFields } from "@/components/ui/address-fields";
import { employmentTypeLabels, employmentTypeValues, genderValues } from "@/lib/validation/hr";
import { toKey } from "@/lib/hr/calendar";
import { PhoneInput } from "@/components/ui/phone-input";
import { workspacePack } from "@/lib/country-pack";

type Person = NonNullable<Awaited<ReturnType<typeof getPerson>>>;

const GENDER_LABELS: Record<string, string> = {
  FEMALE: "Female",
  MALE: "Male",
  OTHER: "Other",
  UNDISCLOSED: "Prefer not to say",
};

/**
 * The employee record form.
 *
 * Employment terms are shown read-only to somebody editing their own record — people should be able
 * to keep their own address and emergency contact current without an HR ticket, but not award
 * themselves a designation, nor change what their pay is worked out from (SEC-20). The server
 * enforces the same split; this only stops the UI offering fields that would be refused.
 */
export function EmployeeForm({
  person,
  canManage,
  onDone,
}: {
  person: Person;
  canManage: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const p = person.employeeProfile;
  // PAN, Aadhaar, UAN, PF, ESIC and IFSC are India's numbers (owner, 30 Oct 2026): outside India the
  // fields are not offered, though whatever a record already holds is kept and sent back untouched.
  const pack = workspacePack();

  const [form, setForm] = useState({
    employeeCode: p?.employeeCode ?? "",
    designation: p?.designation ?? "",
    employmentType: p?.employmentType ?? "FULL_TIME",
    workLocation: p?.workLocation ?? "",
    workPhone: person.phone ?? "",
    // The day each @db.Date holds. String() of a Date is "Fri Oct 02 2026 …": the inputs showed nothing,
    // and saving untouched stored 2001.
    joinedOn: p?.joinedOn ? toKey(p.joinedOn) : "",
    probationEndsOn: p?.probationEndsOn ? toKey(p.probationEndsOn) : "",
    confirmedOn: p?.confirmedOn ? toKey(p.confirmedOn) : "",
    dateOfBirth: p?.dateOfBirth ? toKey(p.dateOfBirth) : "",
    gender: p?.gender ?? "",
    bloodGroup: p?.bloodGroup ?? "",
    maritalStatus: p?.maritalStatus ?? "",
    personalEmail: p?.personalEmail ?? "",
    personalPhone: p?.personalPhone ?? "",
    addressLine1: p?.addressLine1 ?? "",
    addressLine2: p?.addressLine2 ?? "",
    city: p?.city ?? "",
    state: p?.state ?? "",
    pincode: p?.pincode ?? "",
    emergencyContactName: p?.emergencyContactName ?? "",
    emergencyContactPhone: p?.emergencyContactPhone ?? "",
    emergencyContactRelation: p?.emergencyContactRelation ?? "",
    panNumber: p?.panNumber ?? "",
    aadhaarLast4: p?.aadhaarLast4 ?? "",
    uanNumber: p?.uanNumber ?? "",
    pfNumber: p?.pfNumber ?? "",
    esicNumber: p?.esicNumber ?? "",
    bankName: p?.bankName ?? "",
    bankAccountNumber: p?.bankAccountNumber ?? "",
    bankIfsc: p?.bankIfsc ?? "",
  });

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  // Security audit, 11 Nov 2026 (SEC-20): on your own record, what feeds pay — date of birth, gender, the state, the
  // statutory numbers and the bank — is shown, not edited; HR changes it. Only the contact details are sent.
  const locked = !canManage;
  const PAY_HINT = "Ask HR to change this.";
  const SELF_KEYS = [
    "bloodGroup", "maritalStatus", "personalEmail", "personalPhone", "addressLine1", "addressLine2", "city", "pincode",
    "emergencyContactName", "emergencyContactPhone", "emergencyContactRelation",
  ] as const;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const fields = locked ? Object.fromEntries(SELF_KEYS.map((key) => [key, form[key]])) : form;
      const result = await saveEmployeeProfile({ userId: person.id, ...fields });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {canManage && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Employment</CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Employee code">
              {(id) => <Input id={id} value={form.employeeCode} onChange={set("employeeCode")} placeholder="WRF-014" />}
            </Field>
            <Field label="Designation">
              {(id) => (
                <Input id={id} value={form.designation} onChange={set("designation")} placeholder="Senior Sales Executive" />
              )}
            </Field>
            <Field label="Employment type">
              {(id) => (
                <Select id={id} value={form.employmentType} onChange={set("employmentType")}>
                  {employmentTypeValues.map((t) => (
                    <option key={t} value={t}>
                      {employmentTypeLabels[t]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Work location">
              {(id) => <Input id={id} value={form.workLocation} onChange={set("workLocation")} placeholder="Noida" />}
            </Field>
            <Field label="Work phone" hint="The number quotes, their digital card and email signature show.">
              {(id) => <PhoneInput id={id} value={form.workPhone} onChange={(v) => set("workPhone")({ target: { value: v } })} placeholder="98765 43210" />}
            </Field>
            <Field label="Joined on">
              {(id) => <Input id={id} type="date" value={form.joinedOn} onChange={set("joinedOn")} />}
            </Field>
            <Field label="Probation ends">
              {(id) => <Input id={id} type="date" value={form.probationEndsOn} onChange={set("probationEndsOn")} />}
            </Field>
            <Field label="Confirmed on">
              {(id) => <Input id={id} type="date" value={form.confirmedOn} onChange={set("confirmedOn")} />}
            </Field>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm font-medium text-text">Personal</CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Date of birth" hint={locked ? PAY_HINT : undefined}>
            {(id) => <Input id={id} type="date" value={form.dateOfBirth} onChange={set("dateOfBirth")} disabled={locked} />}
          </Field>
          <Field label="Gender" hint={locked ? PAY_HINT : undefined}>
            {(id) => (
              <Select id={id} value={form.gender} onChange={set("gender")} disabled={locked}>
                <option value="">—</option>
                {genderValues.map((g) => (
                  <option key={g} value={g}>
                    {GENDER_LABELS[g]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Blood group">
            {(id) => <Input id={id} value={form.bloodGroup} onChange={set("bloodGroup")} placeholder="O+" />}
          </Field>
          <Field label="Marital status">
            {(id) => <Input id={id} value={form.maritalStatus} onChange={set("maritalStatus")} placeholder="Single" />}
          </Field>
          <Field label="Personal email">
            {(id) => <Input id={id} type="email" value={form.personalEmail} onChange={set("personalEmail")} />}
          </Field>
          <Field label="Personal phone">
            {(id) => <PhoneInput id={id} value={form.personalPhone} onChange={(v) => set("personalPhone")({ target: { value: v } })} />}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Address</CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Address line 1" className="sm:col-span-2">
            {(id) => <Input id={id} value={form.addressLine1} onChange={set("addressLine1")} />}
          </Field>
          <Field label="Address line 2">
            {(id) => <Input id={id} value={form.addressLine2} onChange={set("addressLine2")} />}
          </Field>
          {/**
            * The state is not a label here either — it sets the professional-tax slab on every
            * payslip, so a typed spelling is the wrong deduction rather than an untidy record.
            * Outside India the address is in the workspace's own country, its states and cities
            * from the world lists — there is no country column on the record to pick another.
            */}
          {locked ? (
            <>
              <Field label="State" hint={PAY_HINT}>
                {(id) => <Input id={id} value={form.state} disabled readOnly />}
              </Field>
              <Field label="City">
                {(id) => <Input id={id} value={form.city} onChange={set("city")} />}
              </Field>
              <Field label={pack.india ? "PIN code" : "Postal code"}>
                {(id) => <Input id={id} value={form.pincode} onChange={set("pincode")} />}
              </Field>
            </>
          ) : (
            <div className="sm:col-span-2">
              <AddressFields
                columns={3}
                showCountry={false}
                country={pack.india ? "India" : pack.countryName}
                state={form.state}
                city={form.city}
                pincode={form.pincode}
                onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">In an emergency</CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Name">
            {(id) => <Input id={id} value={form.emergencyContactName} onChange={set("emergencyContactName")} />}
          </Field>
          <Field label="Phone">
            {(id) => <PhoneInput id={id} value={form.emergencyContactPhone} onChange={(v) => set("emergencyContactPhone")({ target: { value: v } })} />}
          </Field>
          <Field label="Relationship">
            {(id) => (
              <Input
                id={id}
                value={form.emergencyContactRelation}
                onChange={set("emergencyContactRelation")}
                placeholder="Spouse"
              />
            )}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">{pack.india ? <>Statutory &amp; bank</> : "Bank"}</CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {locked && <p className="text-xs text-subtle sm:col-span-2 lg:col-span-3">These feed your pay. {PAY_HINT}</p>}
          {pack.india && (
            <>
              <Field label="PAN">
                {(id) => (
                  <Input
                    id={id}
                    value={form.panNumber}
                    onChange={set("panNumber")}
                    placeholder="ABCDE1234F"
                    className="uppercase"
                    disabled={locked}
                  />
                )}
              </Field>
              <Field label="Aadhaar — last 4 only" hint="The whole number is never stored here.">
                {(id) => (
                  <Input id={id} value={form.aadhaarLast4} onChange={set("aadhaarLast4")} maxLength={4} placeholder="1234" disabled={locked} />
                )}
              </Field>
              <Field label="UAN">
                {(id) => <Input id={id} value={form.uanNumber} onChange={set("uanNumber")} disabled={locked} />}
              </Field>
              <Field label="PF number">
                {(id) => <Input id={id} value={form.pfNumber} onChange={set("pfNumber")} disabled={locked} />}
              </Field>
              <Field label="ESIC number">
                {(id) => <Input id={id} value={form.esicNumber} onChange={set("esicNumber")} disabled={locked} />}
              </Field>
            </>
          )}
          <Field label="Bank">
            {(id) => <Input id={id} value={form.bankName} onChange={set("bankName")} disabled={locked} />}
          </Field>
          <Field label="Account number">
            {(id) => <Input id={id} value={form.bankAccountNumber} onChange={set("bankAccountNumber")} disabled={locked} />}
          </Field>
          {pack.india && (
            <Field label="IFSC">
              {(id) => (
                <Input
                  id={id}
                  value={form.bankIfsc}
                  onChange={set("bankIfsc")}
                  placeholder="HDFC0001234"
                  className="uppercase"
                  disabled={locked}
                />
              )}
            </Field>
          )}
        </CardContent>
      </Card>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save record"}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * A field and the label that names it.
 *
 * `children` is a function taking the id rather than plain nodes, so the `<Label htmlFor>` and the
 * control it points at cannot drift apart — a caption sitting above an unnamed input looks exactly
 * like a real label and is announced as nothing at all. Forcing the id through the signature means
 * the next field added here is named whether or not anybody remembered to think about it.
 *
 * `useId` rather than a hand-written string because this form opens in a dialog and a second copy
 * of it on the same page would otherwise emit duplicate ids, pointing every label at the first.
 */
function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}
