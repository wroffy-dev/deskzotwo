"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Download, Info } from "lucide-react";
import { downloadForm140, saveTdsSettings, saveTdsStatementToken } from "@/actions/tds-statement";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { GST_STATE_OPTIONS } from "@/lib/gst-engine";
import { DEDUCTOR_TYPES } from "@/lib/tds/form140-format";
import type { Form140Summary, TdsSettingsValues } from "@/lib/tds/form140";

const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STATES = GST_STATE_OPTIONS.filter((s) => Number(s.code) < 90);

type Overview = {
  taxYear: number;
  quarter: number;
  summary: Form140Summary;
  problems: string[];
  warnings: string[];
  previous: { token: string; label: string } | null;
  generatedAt: string | null;
  tokenNumber: string | null;
  filedOn: string | null;
};

/**
 * The quarter's TDS statement on the TDS page (src/lib/tds/form140.ts): what it holds, what stops its file being
 * made, the file, and — once it's filed — the token number the next quarter's quotes. The details every statement
 * repeats (TAN, deductor category, the person responsible) are kept here; the company's own come from Settings ›
 * Organisation.
 */
export function TdsStatementCard({
  overview,
  settings,
  organisation,
  dueOn,
  today,
}: {
  overview: Overview;
  settings: TdsSettingsValues;
  organisation: string;
  dueOn: string;
  today: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ fileName: string; warnings: string[] } | null>(null);
  const missingDetails = !settings.tan || !settings.responsibleName || !settings.responsiblePan;
  const [editing, setEditing] = useState(missingDetails);
  const [details, setDetails] = useState(settings);
  const [previousToken, setPreviousToken] = useState("");
  const [token, setToken] = useState({ tokenNumber: overview.tokenNumber ?? "", filedOn: overview.filedOn ?? today });
  const { summary, problems, warnings } = overview;

  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) return setError(r.error);
      after?.();
      router.refresh();
    });

  const download = () =>
    start(async () => {
      setError(null);
      const r = await downloadForm140({ taxYear: overview.taxYear, quarter: overview.quarter, previousToken: previousToken || null });
      if (!r.ok) return setError(r.error);
      const url = URL.createObjectURL(new Blob([r.data.text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.data.fileName;
      a.click();
      URL.revokeObjectURL(url);
      setMade({ fileName: r.data.fileName, warnings: r.data.warnings });
      router.refresh();
    });

  const field = (key: keyof TdsSettingsValues, label: string, extra: { className?: string; placeholder?: string; maxLength?: number } = {}) => (
    <div className={`space-y-1 ${extra.className ?? ""}`}>
      <Label htmlFor={`tds-${key}`} className="text-xs">
        {label}
      </Label>
      <Input id={`tds-${key}`} value={details[key]} maxLength={extra.maxLength} placeholder={extra.placeholder} onChange={(e) => setDetails({ ...details, [key]: e.target.value })} />
    </div>
  );

  return (
    <Card className="mt-4 overflow-hidden p-0">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-text">Quarterly statement — Form 140 (was 26Q)</h2>
        <p className="mt-0.5 text-xs text-muted">
          {summary.label}: vendors&apos; TDS, due {dueOn}. Salary&apos;s goes on Form 138 (was 24Q), which isn&apos;t made here yet.
        </p>
      </div>

      <div className="space-y-3 px-4 py-3 text-sm">
        <p className="text-text">
          {summary.deductees === 0 ? (
            <span className="text-muted">No TDS deducted from vendors this quarter.</span>
          ) : (
            <>
              <span className="font-medium">{summary.deductees}</span> deduction(s) on <span className="font-medium">{summary.challans}</span> challan(s),{" "}
              <span className="font-medium tabular-nums">{money(summary.deducted)}</span> deducted.
            </>
          )}
          {overview.generatedAt && <span className="text-xs text-muted"> Its file was last made {overview.generatedAt.slice(0, 10)}.</span>}
        </p>

        {problems.length > 0 && (
          <div className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-xs text-danger">
            <p className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-3.5 w-3.5" />
              Before the file can be made
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {problems.slice(0, 15).map((p) => (
                <li key={p}>{p}</li>
              ))}
              {problems.length > 15 && <li>…and {problems.length - 15} more.</li>}
            </ul>
          </div>
        )}
        {warnings.length > 0 && (
          <div className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
            <p className="font-medium">Worth a look — these don&apos;t stop the file</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {warnings.slice(0, 10).map((w) => (
                <li key={w}>{w}</li>
              ))}
              {warnings.length > 10 && <li>…and {warnings.length - 10} more.</li>}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="tds-previous-token" className="text-xs">
              Last statement&apos;s token number
            </Label>
            <Input
              id="tds-previous-token"
              inputMode="numeric"
              maxLength={15}
              className="w-48 font-mono"
              placeholder={overview.previous ? overview.previous.token : "None filed yet"}
              value={previousToken}
              onChange={(e) => setPreviousToken(e.target.value)}
            />
          </div>
          <Button type="button" size="sm" disabled={pending || problems.length > 0} onClick={download}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Download Form 140 file
          </Button>
        </div>
        <p className="text-xs text-muted">
          {overview.previous
            ? `It quotes the token of ${overview.previous.label}, unless another is typed.`
            : "Once a Form 140 has been filed — here or elsewhere — the next one quotes its token number; type it if it was filed elsewhere."}
        </p>
        {error && <p className="text-xs text-danger">{error}</p>}
        {made && (
          <div className="flex gap-2 rounded-base border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              Saved as <span className="font-mono text-text">{made.fileName}</span>. Run it through the e-TDS/TCS FVU (version 1.2, from the TIN website) with the
              challans&apos; .csi file from Challan Status Inquiry; the FVU makes the .fvu that is filed. Then note the token number below.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <div className="space-y-1">
            <Label htmlFor="tds-token" className="text-xs">
              This quarter filed under token
            </Label>
            <Input id="tds-token" inputMode="numeric" maxLength={15} className="w-48 font-mono" value={token.tokenNumber} onChange={(e) => setToken({ ...token, tokenNumber: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tds-filed-on" className="text-xs">
              Filed on
            </Label>
            <Input id="tds-filed-on" type="date" max={today} value={token.filedOn} onChange={(e) => setToken({ ...token, filedOn: e.target.value })} />
          </div>
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => run(() => saveTdsStatementToken({ taxYear: overview.taxYear, quarter: overview.quarter, ...token }))}>
            Save
          </Button>
        </div>

        <div className="border-t border-line pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">
              <span className="font-medium text-text">Deductor:</span> {organisation}{" "}
              <Link href="/settings/organisation" className="text-brand hover:underline">
                Settings › Organisation
              </Link>
              {settings.tan && (
                <>
                  {" "}
                  · TAN <span className="font-mono">{settings.tan}</span>
                </>
              )}
              {settings.responsibleName && <> · responsible: {settings.responsibleName}</>}
            </p>
            {!editing && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Edit statement details
              </Button>
            )}
          </div>
          {editing && (
            <div className="mt-2 grid grid-cols-1 gap-2 rounded-base border border-line bg-surface-sunken p-3 sm:grid-cols-3">
              {field("tan", "TAN", { placeholder: "ABCD12345E", maxLength: 10 })}
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="tds-deductorType" className="text-xs">
                  The company is a
                </Label>
                <Select id="tds-deductorType" value={details.deductorType} onChange={(e) => setDetails({ ...details, deductorType: e.target.value })}>
                  {Object.entries(DEDUCTOR_TYPES).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </Select>
              </div>
              <p className="text-xs font-medium text-muted sm:col-span-3">The person responsible for deducting</p>
              {field("responsibleName", "Name")}
              {field("responsibleDesignation", "Designation", { maxLength: 20 })}
              {field("responsiblePan", "PAN", { maxLength: 10 })}
              {field("responsibleAddress", "Address", { className: "sm:col-span-3" })}
              {field("responsibleCity", "City or district")}
              <div className="space-y-1">
                <Label htmlFor="tds-responsibleState" className="text-xs">
                  State
                </Label>
                <Select id="tds-responsibleState" value={details.responsibleState} onChange={(e) => setDetails({ ...details, responsibleState: e.target.value })}>
                  <option value="">Choose…</option>
                  {STATES.map((s) => (
                    <option key={s.code} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              {field("responsiblePincode", "PIN code", { maxLength: 6 })}
              {field("responsibleEmail", "Email")}
              {field("responsiblePhone", "Mobile")}
              <div className="flex items-end justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" disabled={pending} onClick={() => run(() => saveTdsSettings(details), () => setEditing(false))}>
                  Save details
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
