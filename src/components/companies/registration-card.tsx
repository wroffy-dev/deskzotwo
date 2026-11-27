"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { setCompanyRegistration, type RegistrationInput } from "@/actions/company-registration";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { formatCalendarDay } from "@/lib/time/zone";
import { LICENCE_AUTHORITY_MAX, LICENCE_NUMBER_MAX, type LicenceStanding } from "@/lib/companies/registration-rules";

/**
 * A company's registration numbers in one place (owner, 20 Nov 2026 — src/lib/companies/registration-rules.ts).
 * India: PAN, CIN or LLPIN, and its GSTINs. UAE: its TRN and trade licence. A GSTIN or TRN is kept on each address
 * (invoices print it from there), so it is shown here and changed under Locations.
 */
export function RegistrationCard({
  companyId,
  india,
  canEdit,
  panEditable,
  pan,
  cin,
  licence,
  standing,
  taxNumbers,
  taxMasked,
}: {
  companyId: string;
  india: boolean;
  canEdit: boolean;
  /** Finance, with the PAN not masked for them. */
  panEditable: boolean;
  /** As this person may see it — masked where field access says. */
  pan: string | null;
  cin: string | null;
  licence: { number: string | null; authority: string | null; expiresOn: string | null };
  standing: LicenceStanding | null;
  taxNumbers: string[];
  taxMasked: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Required<RegistrationInput>>({ cin: "", panNumber: "", tradeLicenceNumber: "", tradeLicenceAuthority: "", tradeLicenceExpiresOn: "" });

  const taxLabel = india ? "GSTIN" : "TRN";
  const open = () => {
    setForm({
      cin: cin ?? "",
      panNumber: pan ?? "",
      tradeLicenceNumber: licence.number ?? "",
      tradeLicenceAuthority: licence.authority ?? "",
      tradeLicenceExpiresOn: licence.expiresOn ?? "",
    });
    setError(null);
    setEditing(true);
  };
  const save = () =>
    start(async () => {
      setError(null);
      const input: RegistrationInput = india
        ? { cin: form.cin, ...(panEditable ? { panNumber: form.panNumber } : {}) }
        : { tradeLicenceNumber: form.tradeLicenceNumber, tradeLicenceAuthority: form.tradeLicenceAuthority, tradeLicenceExpiresOn: form.tradeLicenceExpiresOn };
      const r = await setCompanyRegistration(companyId, input);
      if (!r.ok) return setError(r.error);
      setEditing(false);
      router.refresh();
    });
  const field = (key: keyof RegistrationInput) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const rows: { label: string; value: React.ReactNode }[] = india
    ? [
        { label: "PAN", value: pan },
        { label: "CIN / LLPIN", value: cin },
      ]
    : [
        { label: "Trade licence", value: licence.number },
        { label: "Issued by", value: licence.number ? licence.authority : null },
        {
          label: "Expires",
          value: licence.number && licence.expiresOn ? (
            <span className="inline-flex items-center gap-1.5">
              {formatCalendarDay(licence.expiresOn)}
              {standing === "expired" && <Badge tone="red">Expired</Badge>}
              {standing === "soon" && <Badge tone="amber">Expiring soon</Badge>}
            </span>
          ) : null,
        },
      ];

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Registration</span>
        {canEdit && !editing && (
          <button type="button" onClick={open} className="text-xs font-medium text-muted hover:text-text hover:underline">
            Edit
          </button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!editing && (
          <dl className="space-y-1.5">
            {rows.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-3">
                <dt className="text-muted">{r.label}</dt>
                <dd className={r.value ? "text-right font-mono text-text" : "text-right text-subtle"}>{r.value ?? "—"}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">{india ? (taxNumbers.length > 1 ? "GSTINs" : "GSTIN") : "TRN"}</dt>
              <dd className="text-right">
                {taxNumbers.length > 0 ? (
                  taxNumbers.map((n) => (
                    <span key={n} className="block font-mono text-text">
                      {n}
                    </span>
                  ))
                ) : (
                  <Link href="?tab=locations" className="text-xs text-muted hover:text-text hover:underline">
                    {taxMasked ? "—" : `Add on an address`}
                  </Link>
                )}
              </dd>
            </div>
          </dl>
        )}

        {editing && (
          <div className="space-y-3">
            {india ? (
              <>
                {panEditable && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`pan-${companyId}`} className="text-xs">PAN</Label>
                    <Input id={`pan-${companyId}`} {...field("panNumber")} placeholder="ABCDE1234F" className="font-mono uppercase" maxLength={10} />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor={`cin-${companyId}`} className="text-xs">CIN or LLPIN</Label>
                  <Input id={`cin-${companyId}`} {...field("cin")} placeholder="U72200DL2010PTC123456" className="font-mono uppercase" maxLength={30} />
                  <p className="text-xs text-subtle">On its certificate of incorporation, or the MCA site. Leave empty for a firm or proprietor.</p>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`licence-${companyId}`} className="text-xs">Trade licence number</Label>
                  <Input id={`licence-${companyId}`} {...field("tradeLicenceNumber")} className="font-mono uppercase" maxLength={LICENCE_NUMBER_MAX} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`authority-${companyId}`} className="text-xs">Issued by</Label>
                  <Input id={`authority-${companyId}`} {...field("tradeLicenceAuthority")} placeholder="DED Dubai, DMCC, ADGM…" maxLength={LICENCE_AUTHORITY_MAX} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`expiry-${companyId}`} className="text-xs">Expires on</Label>
                  <Input id={`expiry-${companyId}`} type="date" {...field("tradeLicenceExpiresOn")} />
                </div>
              </>
            )}
            <p className="text-xs text-subtle">
              Its {taxLabel} is kept on each address, as documents print it — change it under{" "}
              <Link href="?tab=locations" className="underline hover:text-text">Locations</Link>.
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={pending} onClick={save}>
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
