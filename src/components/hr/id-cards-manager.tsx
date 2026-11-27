"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Printer, Search } from "lucide-react";
import { previewIdCard, replaceIdCard, saveIdCardDesign } from "@/actions/id-cards";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { confirmAction } from "@/components/ui/confirm";
import { IdCardBack, IdCardFront } from "@/components/hr/id-card";
import { BACK_NOTE_MAX, MAX_CARDS, applyDesign, defaultBackNote, type IdCardData, type IdCardDesign, type IdCardIssuer } from "@/lib/id-cards/design";

type Person = { id: string; name: string; employeeCode: string | null; designation: string | null; departmentId: string | null; department: string | null; hasPhoto: boolean; missing: string[] };

const TOGGLES: { key: keyof IdCardDesign; label: string; side: string }[] = [
  { key: "showDepartment", label: "Department", side: "front" },
  { key: "showBloodGroup", label: "Blood group", side: "front" },
  { key: "showEmergencyContact", label: "Emergency contact", side: "back" },
  { key: "showJoinedOn", label: "Joining date", side: "back" },
  { key: "showWorkPhone", label: "Phone", side: "back" },
  { key: "showEmail", label: "Work email", side: "back" },
  { key: "showSignature", label: "Authorised signatory's signature", side: "back" },
];

/**
 * People › ID cards (owner, 31 Oct 2026 — src/lib/id-cards): the card's design with a live preview of a real person's
 * card, and everyone working here to tick and print — on A4 to cut out, or on an ID card printer.
 */
export function IdCardsManager({
  design: saved,
  issuer,
  brandColor,
  signatureOnFile,
  people,
  sample,
}: {
  design: IdCardDesign;
  /** The issuer as saved; its accent and signature follow the form below while it is edited. */
  issuer: IdCardIssuer;
  brandColor: string;
  signatureOnFile: string | null;
  people: Person[];
  sample: IdCardData | null;
}) {
  const router = useRouter();
  const [design, setDesign] = useState(saved);
  const [preview, setPreview] = useState(sample);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [team, setTeam] = useState("");
  const [saving, startSaving] = useTransition();
  const [loading, startLoading] = useTransition();
  const dirty = JSON.stringify(design) !== JSON.stringify(saved);

  const liveIssuer: IdCardIssuer = { ...issuer, accent: design.accentColor ?? brandColor, signatureDataUrl: design.showSignature ? signatureOnFile : null };
  const teams = useMemo(() => [...new Map(people.filter((p) => p.departmentId).map((p) => [p.departmentId!, p.department!])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [people]);
  const shown = people.filter(
    (p) => (!team || p.departmentId === team) && (!search.trim() || [p.name, p.employeeCode, p.designation].some((v) => v?.toLowerCase().includes(search.trim().toLowerCase()))),
  );
  const allShownPicked = shown.length > 0 && shown.every((p) => picked.has(p.id));

  function set<K extends keyof IdCardDesign>(key: K, value: IdCardDesign[K]) {
    setDesign((d) => ({ ...d, [key]: value }));
  }

  function save() {
    startSaving(async () => {
      const done = await saveIdCardDesign(design);
      if (!done.ok) return void toast.error(done.error);
      toast.success("ID card design saved");
      router.refresh();
    });
  }

  function showPreview(id: string) {
    startLoading(async () => {
      const card = await previewIdCard(id);
      if (card) setPreview(card);
    });
  }

  // A lost card: a new one to print, and the old one's QR stops checking out (security audit SEC-66).
  function replaceCard() {
    if (!preview) return;
    const { userId: id, name } = preview;
    startLoading(async () => {
      if (!(await confirmAction(`Replace ${name}'s card? The card they have now will stop checking out as valid, and they'll need the new one printed.`))) return;
      const done = await replaceIdCard(id);
      if (!done.ok) return void toast.error(done.error);
      const card = await previewIdCard(id);
      if (card) setPreview(card);
      toast.success("New card ready to print — the old one no longer checks out");
    });
  }

  function toggle(id: string) {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function print(paper: "a4" | "card") {
    const ids = people.filter((p) => picked.has(p.id)).map((p) => p.id);
    window.open(`/id-cards/print?${new URLSearchParams({ ids: ids.join(","), paper }).toString()}`, "_blank", "noopener");
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
        <Card className="space-y-4 p-4">
          <div>
            <h2 className="text-sm font-semibold text-text">Design</h2>
            <p className="text-xs text-muted">The same for everyone. The name, photo, employee ID and designation always show; the rest is yours to pick.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted">Colour</span>
            <input
              type="color"
              aria-label="Card colour"
              value={design.accentColor ?? brandColor}
              onChange={(e) => set("accentColor", e.target.value)}
              className="h-8 w-12 cursor-pointer rounded border border-line-strong bg-surface"
            />
            <label className="flex items-center gap-1.5 text-sm text-muted">
              <input type="checkbox" checked={design.accentColor === null} onChange={(e) => set("accentColor", e.target.checked ? null : brandColor)} />
              Use the brand colour
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {TOGGLES.map((t) => (
              <label key={t.key} className="flex items-center justify-between gap-3 rounded-base border border-line px-3 py-2 text-sm">
                <span>
                  {t.label} <span className="text-xs text-subtle">· {t.side}</span>
                </span>
                <Switch size="sm" checked={design[t.key] as boolean} onChange={(v) => set(t.key, v as never)} aria-label={t.label} />
              </label>
            ))}
          </div>
          {design.showSignature && !signatureOnFile && <p className="text-xs text-warning">No signature on file yet — add one in Settings › Organisation and it will print on the back.</p>}
          <div className="space-y-1">
            <label htmlFor="id-back-note" className="text-sm text-muted">
              Line on the back
            </label>
            <textarea
              id="id-back-note"
              rows={2}
              maxLength={BACK_NOTE_MAX}
              value={design.backNote ?? ""}
              placeholder={defaultBackNote(issuer.company)}
              onChange={(e) => set("backNote", e.target.value || null)}
              className="w-full rounded-base border border-line-strong bg-surface px-3 py-2 text-sm"
            />
            <p className="text-xs text-subtle">The company&apos;s address and phone print under it, from Settings › Organisation.</p>
          </div>
          <div className="flex justify-end gap-2">
            {dirty && (
              <Button type="button" variant="ghost" onClick={() => setDesign(saved)} disabled={saving}>
                Undo changes
              </Button>
            )}
            <Button type="button" onClick={save} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save design"}
            </Button>
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-3 text-sm font-semibold text-text">
            Preview{preview ? ` — ${preview.name}` : ""}
            {loading && <span className="ml-2 text-xs font-normal text-subtle">Loading…</span>}
          </div>
          {preview ? (
            <div className="flex flex-wrap justify-center gap-4">
              <IdCardFront data={applyDesign(preview, design)} issuer={liveIssuer} />
              <IdCardBack data={applyDesign(preview, design)} issuer={liveIssuer} backNote={design.backNote} />
              <div className="w-full text-center">
                <Button type="button" variant="ghost" size="sm" onClick={replaceCard} disabled={loading}>
                  Card lost? Replace it
                </Button>
              </div>
            </div>
          ) : (
            <p className="max-w-xs text-sm text-muted">Nobody to show yet — add people in Staff &amp; roles.</p>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code or designation" aria-label="Search people" className="h-8 w-56 pl-8 text-sm" />
            </div>
            {teams.length > 0 && (
              <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team" className="h-8 rounded-base border border-line-strong bg-surface px-2 text-sm">
                <option value="">Every team</option>
                {teams.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">{picked.size} picked</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => print("card")} disabled={picked.size === 0 || picked.size > MAX_CARDS}>
              ID card printer
            </Button>
            <Button type="button" size="sm" onClick={() => print("a4")} disabled={picked.size === 0 || picked.size > MAX_CARDS}>
              <Printer className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Print on A4
            </Button>
          </div>
        </div>
        {picked.size > MAX_CARDS && <p className="mt-2 text-xs text-warning">Up to {MAX_CARDS} cards at a time — print them in batches.</p>}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-subtle">
                <th className="w-8 py-2">
                  <input
                    type="checkbox"
                    aria-label="Pick everyone shown"
                    checked={allShownPicked}
                    onChange={() =>
                      setPicked((s) => {
                        const next = new Set(s);
                        for (const p of shown) {
                          if (allShownPicked) next.delete(p.id);
                          else next.add(p.id);
                        }
                        return next;
                      })
                    }
                  />
                </th>
                <th className="py-2">Name</th>
                <th className="py-2">Employee ID</th>
                <th className="py-2">Designation</th>
                <th className="py-2">Missing on the card</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0">
                  <td className="py-2">
                    <input type="checkbox" aria-label={`Pick ${p.name}`} checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                  </td>
                  <td className="py-2 font-medium text-text">
                    {p.name}
                    {p.department && <span className="ml-1.5 text-xs font-normal text-subtle">{p.department}</span>}
                  </td>
                  <td className="py-2 font-mono text-xs">{p.employeeCode ?? "—"}</td>
                  <td className="py-2 text-muted">{p.designation ?? "—"}</td>
                  <td className="py-2 text-xs">{p.missing.length ? <span className="text-warning">{p.missing.join(", ")}</span> : <span className="text-success">Complete</span>}</td>
                  <td className="py-2 text-right">
                    <button type="button" onClick={() => showPreview(p.id)} className="text-xs text-brand hover:underline">
                      Preview
                    </button>
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-sm text-muted">
                    Nobody matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
