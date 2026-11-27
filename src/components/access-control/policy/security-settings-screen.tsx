"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, Bot, Camera, ChevronRight, ClipboardX, Download, Fingerprint, KeyRound, Lock, Users } from "lucide-react";
import { updateSecurityPolicy } from "@/actions/security-policy";
import { updateSignInPolicy } from "@/actions/security";
import type { SecurityPolicyShape } from "@/lib/security/policy";
import { sayEither } from "@/lib/workplace/providers";
import { acPath } from "@/lib/access-control/nav";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { AcPage, HintNote, Panel, Pill, acButton, panelLinkClass } from "@/components/access-control/ui";
import { cn } from "@/lib/utils";

export type SignInPolicy = { enforceTwoFactor: boolean; enforceSso: boolean };

type BoolKey = { [K in keyof SecurityPolicyShape]: SecurityPolicyShape[K] extends boolean ? K : never }[keyof SecurityPolicyShape];
type NumKey = { [K in keyof SecurityPolicyShape]: SecurityPolicyShape[K] extends number ? K : never }[keyof SecurityPolicyShape];

/** The limits the server holds each number to (src/lib/validation/security-policy.ts), said here first and in words. */
const NUMBER_RULES: Record<NumKey, { label: string; min: number; max: number }> = {
  exportRowLimit: { label: "Export row limit", min: 0, max: 1_000_000 },
  bulkReadThreshold: { label: "Unusual read volume", min: 0, max: 100_000 },
  bulkReadWindowMinutes: { label: "The read-volume window", min: 1, max: 1440 },
  retentionDays: { label: "Activity log retention", min: 30, max: 3650 },
  screenshotLimitPerDay: { label: "Screenshots allowed per day", min: -1, max: 50 },
  watermarkOpacity: { label: "Watermark strength", min: 3, max: 25 },
};

const samePolicy = (a: SecurityPolicyShape, b: SecurityPolicyShape) =>
  JSON.stringify({ ...a, exemptRoles: [...a.exemptRoles].sort() }) === JSON.stringify({ ...b, exemptRoles: [...b.exemptRoles].sort() });

/**
 * Security Settings: the workspace's sign-in policy and its data-loss-prevention policy, as the
 * design's sectioned cards of switches, selects and numbers.
 *
 * Edits are a local draft; Discard and Save settings in the header light up once something differs,
 * and Save sends each part through the action that always saved it (`updateSignInPolicy`,
 * `updateSecurityPolicy`) with its own checks. Both parts are the holder of "Change the security and
 * DLP policy"'s to see and change — null here means the person looking isn't one, and the cards are
 * not drawn. Sensitive data is a summary: masking and the daily limit are edited on their own screens.
 *
 * Every card says which kind of control it holds, because the two are not equally strong: enforced on
 * the server, or a deterrent in the browser.
 */
export function SecuritySettingsScreen({
  policy,
  signIn,
  signInWith,
  exemptChoices,
  masking,
  unmaskDefault,
  devicesLink,
  children,
}: {
  policy: SecurityPolicyShape | null;
  signIn: SignInPolicy | null;
  /** The sign-ins switched on, by name ("Microsoft", "Google"). */
  signInWith: string[];
  /** The roles the deterrents can be lifted for. Admin never appears: admins are always exempt. */
  exemptChoices: { key: string; name: string }[];
  masking: { enabled: boolean; changedAtText: string | null; changedBy: string | null };
  unmaskDefault: { dailyLimit: number | null; changedAtText: string | null; changedBy: string | null };
  /** Whether Devices, networks & sign-ins would open for the person looking. */
  devicesLink: boolean;
  /** The sign-in providers and support access, which save on their own. */
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [policyDraft, setPolicyDraft] = useState<SecurityPolicyShape | null>(null);
  const [signInDraft, setSignInDraft] = useState<SignInPolicy | null>(null);
  const [saving, start] = useTransition();

  const p = policyDraft ?? policy;
  const s = signInDraft ?? signIn;
  const policyDirty = policy !== null && policyDraft !== null && !samePolicy(policyDraft, policy);
  const signInDirty = signIn !== null && signInDraft !== null && (signInDraft.enforceTwoFactor !== signIn.enforceTwoFactor || signInDraft.enforceSso !== signIn.enforceSso);
  const clean = !policyDirty && !signInDirty;
  const editable = policy !== null || signIn !== null;

  const set = <K extends keyof SecurityPolicyShape>(key: K, value: SecurityPolicyShape[K]) => {
    if (!policy) return;
    setPolicyDraft((d) => ({ ...(d ?? policy), [key]: value }));
  };
  const setSignIn = <K extends keyof SignInPolicy>(key: K, value: boolean) => {
    if (!signIn) return;
    setSignInDraft((d) => ({ ...(d ?? signIn), [key]: value }));
  };

  const discard = () => {
    setPolicyDraft(null);
    setSignInDraft(null);
  };

  const save = () => {
    if (clean || saving) return;
    if (policyDirty && policyDraft) {
      for (const key of Object.keys(NUMBER_RULES) as NumKey[]) {
        const rule = NUMBER_RULES[key];
        const n = policyDraft[key];
        if (!Number.isInteger(n) || n < rule.min || n > rule.max) {
          toast.error(`${rule.label} is a whole number from ${rule.min.toLocaleString("en-IN")} to ${rule.max.toLocaleString("en-IN")}.`);
          return;
        }
      }
    }
    start(async () => {
      let signInSaved = !signInDirty;
      let policySaved = !policyDirty;
      if (signInDirty && signInDraft) {
        const r = await updateSignInPolicy(signInDraft);
        if (r.ok) signInSaved = true;
        else toast.error(r.error);
      }
      if (policyDirty && policyDraft) {
        const r = await updateSecurityPolicy(policyDraft);
        if (r.ok) policySaved = true;
        else toast.error(r.error);
      }
      if (signInSaved && policySaved) toast.success("Security settings saved");
      // Together with the re-read, so a saved part goes from the draft straight to what is stored.
      start(() => {
        router.refresh();
        if (signInSaved) setSignInDraft(null);
        if (policySaved) setPolicyDraft(null);
      });
    });
  };

  const toggle = (key: BoolKey, label: string, desc?: React.ReactNode, disabled = false) =>
    p && (
      <Row key={key} label={label} desc={desc}>
        <Switch size="sm" aria-label={label} checked={p[key]} disabled={saving || disabled} onChange={(on) => set(key, on)} />
      </Row>
    );
  const number = (key: NumKey, label: string, desc: React.ReactNode, unit: string, disabled = false) =>
    p && (
      <Row key={key} label={label} desc={desc}>
        <span className="flex shrink-0 items-center gap-1.5">
          <input
            type="number"
            aria-label={label}
            min={NUMBER_RULES[key].min}
            max={NUMBER_RULES[key].max}
            step={1}
            value={Number.isNaN(p[key]) ? "" : p[key]}
            disabled={saving || disabled}
            onChange={(e) => set(key, e.target.value === "" ? Number.NaN : Number(e.target.value))}
            className="h-[30px] w-20 rounded-md border border-line-strong bg-surface px-2 text-right text-xs text-text outline-none focus:border-brand disabled:opacity-50"
          />
          <span className="whitespace-nowrap text-xs text-muted">{unit}</span>
        </span>
      </Row>
    );

  return (
    <AcPage
      crumb="Security Settings"
      title="Security Settings"
      description="Who gets in, what they can take out, and what is recorded either way."
      actions={
        editable ? (
          <>
            <button type="button" className={acButton.secondary} disabled={clean || saving} onClick={discard}>
              Discard
            </button>
            <button type="button" className={acButton.primary} disabled={clean || saving} onClick={save}>
              {saving ? "Saving…" : "Save settings"}
            </button>
          </>
        ) : undefined
      }
    >
      <div className="flex max-w-[1200px] flex-col gap-4">
        {!editable && (
          <Panel className="flex items-start gap-3 px-4 py-3.5">
            <Lock className="mt-0.5 h-[18px] w-[18px] shrink-0 text-subtle" aria-hidden />
            <div>
              <div className="font-semibold text-text">The sign-in and data-protection settings aren&apos;t yours to see</div>
              <p className="mt-0.5 text-xs leading-[1.5] text-muted">
                They belong to whoever holds &ldquo;Change the security and DLP policy&rdquo;, which only a super admin holds or grants. How sensitive data is protected is summarised below.
              </p>
            </div>
          </Panel>
        )}

        {p && (
          <HintNote>
            <strong>Two kinds of control on this page, and they are not equally strong.</strong> <strong>Enforced</strong> settings run on the server and hold whatever the browser does — export limits,
            read-volume alerts and crawler blocking. <strong>Deterrent</strong> settings run in the user&rsquo;s browser and can be switched off by anyone who opens developer tools. They stop the careless
            copy and they create a record of the deliberate one, which is genuinely worth having — but no web application can stop a screenshot, a phone camera, or somebody who is determined. Turn them
            on knowing which you are getting.
          </HintNote>
        )}

        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[repeat(auto-fit,minmax(380px,1fr))]">
          {s && (
            <Section icon={KeyRound} title="Sign-in" kind="enforced">
              <Row
                label="Require two-factor authentication for password sign-in"
                desc="Everyone who signs in with a password (except break-glass admin access) must set up an authenticator app before they can use the rest of the app. Signing in with Microsoft, Google or Zoho is checked by them — turn on multi-factor there — so it never asks."
              >
                <Switch size="sm" aria-label="Require two-factor authentication for password sign-in" checked={s.enforceTwoFactor} disabled={saving} onChange={(on) => setSignIn("enforceTwoFactor", on)} />
              </Row>
              <Row
                label="Require single sign-on"
                desc={
                  signInWith.length > 0
                    ? `Everyone signs in with ${sayEither(signInWith)}; password sign-in is off for everyone except admins, who keep it as a fallback.`
                    : "Turn on sign-in with Microsoft, Google or Zoho below first. Then password sign-in can be switched off for everyone except admins."
                }
              >
                <Switch size="sm" aria-label="Require single sign-on" checked={s.enforceSso} disabled={saving} onChange={(on) => setSignIn("enforceSso", on)} />
              </Row>
            </Section>
          )}

          {devicesLink && (
            <Link href="/settings/security/access" className="group block">
              <Panel className="flex items-center gap-3 px-4 py-3.5 transition-colors group-hover:border-line-strong">
                <Fingerprint className="h-[18px] w-[18px] shrink-0 text-brand" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-text">Devices, networks &amp; sign-ins</span>
                  <span className="mt-0.5 block text-xs leading-[1.45] text-muted">Which devices and networks each role may use, devices waiting for approval, and where everybody signed in from.</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
              </Panel>
            </Link>
          )}

          {p && (
            <>
              <Section icon={Download} title="Export controls" kind="enforced">
                {number(
                  "exportRowLimit",
                  "Export row limit",
                  "The largest file anyone can download in one go. 0 removes the cap. Applied where the rows are fetched, so it holds however the request was made.",
                  "rows",
                )}
                <Row label="Who may export" desc="Each data area's export and import is a permission of its own, answered role by role.">
                  <Link href={acPath.importExport()} className={cn(panelLinkClass, "shrink-0")}>
                    Import &amp; Export
                  </Link>
                </Row>
              </Section>

              <Section
                icon={Activity}
                title="Read volume & activity log"
                kind="enforced"
                action={
                  <Link href="/activity" className={panelLinkClass}>
                    See the activity log
                  </Link>
                }
              >
                {number(
                  "bulkReadThreshold",
                  "Unusual read volume",
                  "Records read within the window before admins are told; 0 switches the alert off. This is the one control a browser extension cannot get around — whatever is collecting the data still has to ask the server for it. It alerts rather than blocks, because a month-end reconciliation looks identical.",
                  "records",
                )}
                {number("bulkReadWindowMinutes", "…within this many minutes", "The window the reads are counted over.", "minutes")}
                {toggle("logPageViews", "Log every page view", "Off by default: it is a row per navigation and rarely the row you want. Record views, exports and refusals are always logged regardless.")}
                {number(
                  "retentionDays",
                  "Keep activity logs for",
                  "Minimum 30. Short enough to lose last month’s incident is not a retention policy, and the DPDP Act expects you to be able to show what happened to personal data. This is how long they stay here: Deskzo separately keeps a sealed copy of sign-ins and activity for a year, as Indian law (CERT-In) requires of service providers — out of the app, and not shortened by this setting.",
                  "days",
                )}
              </Section>

              <Section icon={Bot} title="Crawlers & scrapers" kind="enforced">
                {toggle(
                  "blockBots",
                  "Block crawlers and scrapers",
                  "Turns away search engine crawlers, SEO tools, and scripts like curl and headless browsers. Uptime monitors are always allowed so alerting does not break.",
                )}
                {toggle(
                  "blockAiCrawlers",
                  "Block AI and LLM crawlers",
                  "GPTBot, ClaudeBot, CCBot, Google-Extended, PerplexityBot, Bytespider and the rest, plus a robots.txt that names them. These ones identify themselves honestly and obey what they are told — which is exactly why naming them works.",
                )}
                <Row label="When a crawler is recognised" desc="Log-only is for finding out what is actually hitting the site before you start turning things away.">
                  <select
                    aria-label="When a crawler is recognised"
                    value={p.botMode}
                    disabled={saving}
                    onChange={(e) => set("botMode", e.target.value === "LOG" ? "LOG" : "BLOCK")}
                    className="h-[30px] max-w-[220px] shrink-0 rounded-md border border-line-strong bg-surface px-2 text-xs text-text outline-none focus:border-brand disabled:opacity-50"
                  >
                    <option value="BLOCK">Refuse the request and log it</option>
                    <option value="LOG">Let it through, but log it</option>
                  </select>
                </Row>
              </Section>

              <Section icon={ClipboardX} title="Copying & printing" kind="deterrent">
                {toggle("blockCopy", "Block copying", "The one worth having: copying out of the app is how data usually leaves. Every refusal is logged.")}
                {toggle("blockCut", "Block cutting")}
                {toggle(
                  "blockPaste",
                  "Block pasting",
                  "Worth knowing before you switch this on: pasting brings data in, so it does little for leakage and mostly inconveniences your own staff. Pasting into a form field stays allowed regardless, or nobody could paste an order number into a search box.",
                )}
                {toggle("blockTextSelection", "Block selecting text", "Fields you type in stay selectable.")}
                {toggle("blockContextMenu", "Block the right-click menu")}
                {toggle("blockPrint", "Block printing", "Invoices and other documents under the print views still print — this covers the app screens.")}
                {toggle(
                  "blockDevTools",
                  "Report developer tools",
                  "Cannot actually prevent them — nothing in a browser can. It notices the window geometry changing and logs it, and it gives false positives on an undocked panel or a zoom change.",
                )}
                {toggle("blurOnBlur", "Hide the screen when the window is not in front", "Aimed at screen sharing and shoulder surfing rather than at attackers.")}
              </Section>

              <Section icon={Camera} title="Screenshots & watermark" kind="deterrent">
                {number(
                  "screenshotLimitPerDay",
                  "Screenshots allowed per day",
                  "-1 unlimited, 0 none. Be clear about what this does: the PrintScreen key and the macOS shortcuts are detected and counted, and the clipboard is wiped straight afterwards. Windows Win+Shift+S, the Snipping Tool and a phone camera never reach the page at all. Treat the number as “attempts we saw” and rely on the watermark below for the rest.",
                  "per day",
                )}
                {toggle("screenshotNotifyAdmins", "Tell admins about every screenshot", "Not only the ones over the limit. Throttled to one notification per person per hour.")}
                {toggle(
                  "watermarkEnabled",
                  "Watermark the screen with the viewer's name",
                  "The only measure here that survives a photograph of the monitor — it does not stop the capture, it makes the capture name its own source. If you switch on one thing on this page, this is a good candidate. It can’t wait for a screenshot: no browser is told one is being taken, so it shows while the page is open.",
                )}
                <Row
                  label="Where it shows"
                  desc="Customer details: companies, leads, contacts, orders, documents, tickets, visits, renewals, vendors, payments and reports. Left off the dashboard, settings and your own tasks and notes."
                >
                  <select
                    aria-label="Where the watermark shows"
                    value={p.watermarkScope}
                    disabled={saving || !p.watermarkEnabled}
                    onChange={(e) => set("watermarkScope", e.target.value === "EVERY_PAGE" ? "EVERY_PAGE" : "CUSTOMER_DATA")}
                    className="h-[30px] max-w-[220px] shrink-0 rounded-md border border-line-strong bg-surface px-2 text-xs text-text outline-none focus:border-brand disabled:opacity-50"
                  >
                    <option value="CUSTOMER_DATA">Pages with customer details</option>
                    <option value="EVERY_PAGE">Every page</option>
                  </select>
                </Row>
                {number("watermarkOpacity", "Watermark strength", "7% is legible in a photo and easy to read past. Above 15 people start asking to turn it off.", "%", !p.watermarkEnabled)}
              </Section>

              <Section icon={Users} title="Who the deterrents apply to" kind="deterrent">
                <div className="px-4 py-3">
                  <div className="font-medium text-text">Exempt roles</div>
                  <p className="mt-0.5 text-xs leading-[1.45] text-muted">
                    Everyone except admins and the roles ticked here. Admins are always exempt and cannot be added — an admin who blocked their own clipboard could not paste a client secret into the
                    field that turns it off again, and a control you can lock yourself out of is one that ends up disabled for everybody.
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-1">
                    {exemptChoices.map((r) => {
                      const on = p.exemptRoles.includes(r.key);
                      return (
                        <button
                          key={r.key}
                          type="button"
                          aria-pressed={on}
                          disabled={saving}
                          onClick={() => set("exemptRoles", on ? p.exemptRoles.filter((x) => x !== r.key) : [...p.exemptRoles, r.key])}
                          className={cn(
                            "h-6 rounded-full border px-2.5 text-xs font-semibold transition-colors disabled:opacity-50",
                            on ? "border-brand bg-brand-subtle text-brand" : "border-line-strong bg-surface text-text/80 hover:bg-surface-sunken",
                          )}
                        >
                          {r.name}
                          {on && " — exempt"}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </Section>
            </>
          )}

          <Section
            icon={Lock}
            title="Sensitive data"
            action={
              <Link href={acPath.sensitive()} className={panelLinkClass}>
                Sensitive Data
              </Link>
            }
          >
            <Row
              label="Global PII Masking"
              desc={
                <>
                  {masking.enabled
                    ? "On: each role's masking rules apply to emails, phones and the other sensitive fields."
                    : "Off: masked fields show in the clear for everybody; the rules themselves are kept."}
                  {masking.changedAtText && (
                    <span className="block text-subtle">
                      Last changed {masking.changedBy ? `by ${masking.changedBy}, ` : ""}
                      {masking.changedAtText}
                    </span>
                  )}
                </>
              }
            >
              <span className="flex shrink-0 items-center gap-2.5">
                <Pill tone={masking.enabled ? "green" : "amber"}>{masking.enabled ? "On" : "Off"}</Pill>
                <Link href={acPath.masking()} className={panelLinkClass}>
                  Manage
                </Link>
              </span>
            </Row>
            <Row
              label="Default daily unmasking limit"
              desc={
                <>
                  For anybody who may unmask a field and has no daily limit of their own or their role&apos;s. Each lead or contact shown counts once a day.
                  {unmaskDefault.changedAtText && (
                    <span className="block text-subtle">
                      Last changed {unmaskDefault.changedBy ? `by ${unmaskDefault.changedBy}, ` : ""}
                      {unmaskDefault.changedAtText}
                    </span>
                  )}
                </>
              }
            >
              <span className="flex shrink-0 items-center gap-2.5">
                <Pill tone={unmaskDefault.dailyLimit === null ? "amber" : "neutral"}>{unmaskDefault.dailyLimit === null ? "No limit" : `${unmaskDefault.dailyLimit} a day`}</Pill>
                <Link href={acPath.limits()} className={panelLinkClass}>
                  Manage
                </Link>
              </span>
            </Row>
          </Section>
        </div>

        {children}
      </div>
    </AcPage>
  );
}

/** One settings card: the design's icon and title, and which kind of control it holds. */
function Section({
  icon: Icon,
  title,
  kind,
  action,
  children,
}: {
  icon: typeof Lock;
  title: string;
  kind?: "enforced" | "deterrent";
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Panel>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Icon className="h-[18px] w-[18px] shrink-0 text-brand" aria-hidden />
        <span className="font-semibold text-text">{title}</span>
        {kind === "enforced" && <Pill tone="green">Enforced on the server</Pill>}
        {kind === "deterrent" && <Pill tone="amber">Deterrent, in the browser</Pill>}
        <div className="flex-1" />
        {action}
      </div>
      <div className="flex flex-col [&>*:last-child]:border-b-0">{children}</div>
    </Panel>
  );
}

/** One setting: what it is and what it does on the left, its control on the right. */
function Row({ label, desc, children }: { label: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-line/70 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-text">{label}</div>
        {desc && <div className="mt-0.5 text-xs leading-[1.45] text-muted">{desc}</div>}
      </div>
      {children}
    </div>
  );
}
