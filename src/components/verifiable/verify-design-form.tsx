"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { saveVerifiableDesign, type VerifiableDesignInput } from "@/actions/verifiable";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { VerifyFrame, VerifyResult, VerifySearchForm } from "@/components/verifiable/verify-page";
import { ACCREDITATIONS_MAX, LOGO_MAX_CHARS, VERIFY_TEMPLATES, VERIFY_TEMPLATE_WORDS, verifyDesign, type Accreditation, type VerifyTemplate } from "@/lib/verifiable/design";

/** Settings for how the public pages look, beside a live preview drawn by the same components the pages use. */
export function VerifyDesignForm({ start, issuer, brandLogo, brandColor, nameSet }: { start: VerifiableDesignInput; issuer: string; brandLogo: string | null; brandColor: string | null; nameSet: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState(start);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, run] = useTransition();
  const set = <K extends keyof VerifiableDesignInput>(key: K, value: VerifiableDesignInput[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };
  const design = useMemo(() => verifyDesign({ ...form, issuer, brandLogo, brandColor }), [form, issuer, brandLogo, brandColor]);

  const addLogo = (index: number, file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const logo = String(reader.result ?? "");
      if (logo.length > LOGO_MAX_CHARS) return setError("That picture is too big. Use one under 150 KB.");
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(logo)) return setError("Use a PNG, JPEG or WebP picture.");
      setError(null);
      set("accreditations", form.accreditations.map((a, i) => (i === index ? { ...a, logo } : a)));
    };
    reader.readAsDataURL(file);
  };
  const change = (index: number, patch: Partial<Accreditation>) => set("accreditations", form.accreditations.map((a, i) => (i === index ? { ...a, ...patch } : a)));

  const save = () =>
    run(async () => {
      setError(null);
      const r = await saveVerifiableDesign(form);
      if (!r.ok) return setError(r.error);
      setSaved(true);
      router.refresh();
    });

  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
      <Card className="h-fit space-y-3 px-4 py-4 text-sm">
        <div className="font-medium text-text">How the pages look</div>
        {!nameSet && <p className="rounded-base bg-warning-bg px-3 py-2 text-xs text-warning">Your company name isn&apos;t set in Settings › Organisation, so the pages say &ldquo;{issuer}&rdquo;. Set it before you publish: a wrong name makes a real certificate look fake.</p>}
        <div className="space-y-1">
          <Label htmlFor="vd-template">Template</Label>
          <Select id="vd-template" value={form.template} onChange={(e) => set("template", e.target.value as VerifyTemplate)}>
            {VERIFY_TEMPLATES.map((t) => (
              <option key={t} value={t}>
                {VERIFY_TEMPLATE_WORDS[t].name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-subtle">{VERIFY_TEMPLATE_WORDS[form.template].about}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="vd-heading">Heading</Label>
          <Input id="vd-heading" maxLength={80} placeholder="Certificate verification" value={form.heading} onChange={(e) => set("heading", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="vd-intro">Short introduction</Label>
          <Textarea id="vd-intro" rows={2} maxLength={240} placeholder={`Check a document issued by ${issuer}.`} value={form.intro} onChange={(e) => set("intro", e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="vd-accent">Colour</Label>
          <div className="flex items-center gap-2">
            <input id="vd-accent" type="color" className="h-9 w-12 rounded-base border border-line bg-surface" value={design.accent} onChange={(e) => set("accent", e.target.value)} />
            {form.accent && (
              <Button size="sm" variant="ghost" onClick={() => set("accent", "")}>
                Use my branding colour
              </Button>
            )}
          </div>
          <p className="text-xs text-subtle">Your logo comes from Settings › Branding. Status colours stay green, amber and red.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="vd-email">Contact email</Label>
          <Input id="vd-email" type="email" maxLength={200} value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} />
          <p className="text-xs text-subtle">Reports of fake certificates come here.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="vd-phone">Contact phone</Label>
          <Input id="vd-phone" maxLength={40} value={form.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Accreditations</Label>
          {form.accreditations.map((a, i) => (
            <div key={i} className="space-y-1 rounded-base border border-line p-2">
              <div className="flex items-center gap-2">
                <Input aria-label="Accreditation body" placeholder="IAF" maxLength={60} value={a.name} onChange={(e) => change(i, { name: e.target.value })} />
                <button type="button" aria-label={`Remove ${a.name || "this accreditation"}`} className="text-muted hover:text-danger" onClick={() => set("accreditations", form.accreditations.filter((_, n) => n !== i))}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <input type="file" aria-label={`Logo for ${a.name || "this accreditation"}`} accept="image/png,image/jpeg,image/webp" className="w-full text-xs" onChange={(e) => addLogo(i, e.target.files?.[0])} />
            </div>
          ))}
          {form.accreditations.length < ACCREDITATIONS_MAX && (
            <Button size="sm" variant="secondary" onClick={() => set("accreditations", [...form.accreditations, { name: "", logo: null }])}>
              Add an accreditation
            </Button>
          )}
          <p className="text-xs text-subtle">Only show accreditations you hold, and check their rules on using their logos.</p>
        </div>
        {error && <p className="text-danger">{error}</p>}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </Button>
          {saved && <span className="text-xs text-success">Saved. Your public pages have changed.</span>}
        </div>
      </Card>
      <div className="min-w-0 rounded-2xl border border-line bg-bg p-4">
        <p className="mb-3 text-xs text-subtle">Preview, with an example certificate</p>
        <VerifyFrame design={design}>
          <VerifySearchForm design={design} placeholder="Certificate number" disabled />
          <VerifyResult issuer={design.issuer} facts={{ standing: "VALID", docType: "Certificate", number: "ABC-123456", title: "ISO 9001:2015", holderName: "Example Industries Pvt Ltd", scope: null, issuedOn: "2026-02-01", expiresOn: "2029-01-31", withdrawnOn: null }} />
        </VerifyFrame>
      </div>
    </div>
  );
}
