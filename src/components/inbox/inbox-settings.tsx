"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Copy, Globe, Phone, Plus, Trash2 } from "lucide-react";
import {
  deleteInboxChannel,
  deleteInboxSavedReply,
  newInboxVerifyToken,
  readInboxPages,
  removeInboxBlock,
  saveInboxChannel,
  saveInboxSavedReply,
  saveInboxWhatsApp,
  setInboxChannelActive,
} from "@/actions/inbox-admin";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { botReply, type BotState, type Known } from "@/lib/inbox/bot";
import {
  DETAIL_FIELDS,
  DETAIL_LABELS,
  INBOX_LIMITS,
  WEEKDAYS,
  defaultChannelSettings,
  needsText,
  widgetSnippet,
  type ChannelSettings,
  type DetailNeeds,
  type FieldRule,
  type InboxKind,
  type Weekday,
} from "@/lib/inbox/settings";
import type { BlockRow, SavedReply } from "@/lib/inbox/team";
import { TEAM_LIMITS } from "@/lib/inbox/team-rules";
import { cn } from "@/lib/utils";
import { PhoneInput } from "@/components/ui/phone-input";
import { WhatsAppSetupGuide } from "@/components/inbox/whatsapp-setup-guide";
import { useTeammate } from "@/components/ai/teammate-avatar";

/**
 * Settings › Customer inbox's form (src/actions/inbox-admin.ts): a card for each website bubble and
 * WhatsApp number, opened to edit; the WhatsApp credentials and the webhook to give Meta; and, on each
 * channel, a box to try its bot — the very code that answers customers (src/lib/inbox/bot.ts), run here.
 * Then the team's saved replies ("/" in the inbox), and everybody blocked, to let back in.
 */

type ReplyDraft = { id: string | null; shortcut: string; title: string; body: string };

type ChannelView = {
  id: string;
  kind: InboxKind;
  name: string;
  active: boolean;
  publicKey: string | null;
  phoneNumberId: string | null;
  displayPhone: string | null;
  ownerUserId: string | null;
  settings: ChannelSettings;
  conversations: number;
  /** Whom Deskzo AI's answers on this channel are charged as, by name, while they're on. */
  aiChargedTo: string | null;
  /** WEB: what its AI has read of the website (src/lib/inbox/knowledge.ts); null where nothing could be asked. */
  pagesRead: { pages: number; fetchedAt: string | null; failed: { url: string; error: string }[] } | null;
};

/** A sitemap brings at most this many pages (src/lib/inbox/knowledge.ts KNOWLEDGE_LIMITS.pages). */
const KNOWLEDGE_PAGES = 100;

const DAY_NAMES: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

type Draft = { id: string | null; kind: InboxKind; name: string; phoneNumberId: string; displayPhone: string; ownerUserId: string; sites: string; settings: ChannelSettings };

const draftOf = (c: ChannelView): Draft => ({
  id: c.id,
  kind: c.kind,
  name: c.name,
  phoneNumberId: c.phoneNumberId ?? "",
  displayPhone: c.displayPhone ?? "",
  ownerUserId: c.ownerUserId ?? "",
  sites: c.settings.allowedSites.join("\n"),
  settings: c.settings,
});

const newDraft = (kind: InboxKind): Draft => ({
  id: null,
  kind,
  name: kind === "WEB" ? "Website chat" : "WhatsApp",
  phoneNumberId: "",
  displayPhone: "",
  ownerUserId: "",
  sites: "",
  settings: defaultChannelSettings(kind),
});

export function InboxSettings({
  origin,
  people,
  ai,
  channels,
  whatsapp,
  savedReplies,
  blocks,
  knowledgeForCustomers,
}: {
  origin: string;
  people: { id: string; name: string }[];
  /** Where Deskzo AI's answers would go — null until staff set up the feature. */
  ai: { model: string; residency: string; noTraining: boolean } | null;
  channels: ChannelView[];
  whatsapp: { webhookUrl: string; verifyToken: string; hasAppSecret: boolean; hasToken: boolean; providerToken: boolean; language: string };
  savedReplies: SavedReply[];
  blocks: BlockRow[];
  /**
   * How many AI Knowledge files are ticked "Website chat may use this" — the only ones the bot answers customers
   * from (security audit, 11 Nov 2026 — SEC-46). Null while the workspace's database can't say yet.
   */
  knowledgeForCustomers: number | null;
}) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reply, setReply] = useState<ReplyDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creds, setCreds] = useState({ accessToken: "", appSecret: "", language: whatsapp.language });
  const [trial, setTrial] = useState<{ channel: string; text: string; log: { from: "you" | "bot"; text: string }[]; state: BotState | null; known: Known }>({
    channel: "",
    text: "",
    log: [],
    state: null,
    known: { name: null, email: null, phone: null },
  });

  function run(work: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string, after?: () => void) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const r = await work();
      if (!r.ok) return setError(r.error);
      after?.();
      setNotice(success);
      router.refresh();
    });
  }

  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => setNotice("Copied."));
  /** What a channel's AI has read of its website, for the line beside "Read the pages now". */
  const pagesLine = (state: ChannelView["pagesRead"]) =>
    state?.pages
      ? `${state.pages} page${state.pages === 1 ? "" : "s"} read${state.fetchedAt ? `, ${clock.dateTime(state.fetchedAt)}` : ""}${state.failed.length ? ` · ${state.failed.length} couldn't be` : ""}. Save first if you've changed the list.`
      : "Nothing read yet — save, then read the pages.";
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setS = (patch: Partial<ChannelSettings>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));
  // Unnamed, the bot answers as Kabir, the front desk (src/lib/ai/teammates.ts).
  const kabir = useTeammate("kabir");
  const setBot = (patch: Partial<ChannelSettings["bot"]>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, bot: { ...d.settings.bot, ...patch } } } : d));
  const setAi = (patch: Partial<ChannelSettings["bot"]["ai"]>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, bot: { ...d.settings.bot, ai: { ...d.settings.bot.ai, ...patch } } } } : d));
  const setHours = (patch: Partial<ChannelSettings["hours"]>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, hours: { ...d.settings.hours, ...patch } } } : d));
  const setDay = (day: Weekday, span: ChannelSettings["hours"]["days"][Weekday]) =>
    setDraft((d) => (d ? { ...d, settings: { ...d.settings, hours: { ...d.settings.hours, days: { ...d.settings.hours.days, [day]: span } } } } : d));
  const setAssign = (patch: Partial<ChannelSettings["assign"]>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, assign: { ...d.settings.assign, ...patch } } } : d));
  const setProactive = (rules: ChannelSettings["proactive"]) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, proactive: rules } } : d));

  /** What needs come to in practice: on WhatsApp the number is always there, so it isn't one to wait for. */
  const asked = (needs: DetailNeeds, kind: InboxKind): DetailNeeds => (kind === "WHATSAPP" ? { ...needs, phone: false, either: false, email: needs.email && !needs.either } : needs);

  /**
   * Ticks for a customer's details, and — with both email and phone ticked — "either will do". On WhatsApp
   * there's no phone tick (the number comes with every message); "Email" there means one is asked for too.
   */
  const needsPicker = (needs: DetailNeeds, change: (next: DetailNeeds) => void, whatsapp: boolean) => (
    <div className="ml-6 mt-1.5 space-y-1.5">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {DETAIL_FIELDS.filter((f) => !(whatsapp && f === "phone")).map((f) => (
          <label key={f} className="flex items-center gap-1.5 text-sm text-text">
            <input
              type="checkbox"
              checked={whatsapp && f === "email" ? needs.email && !needs.either : needs[f]}
              onChange={(e) => change(whatsapp && f === "email" ? { ...needs, email: e.target.checked, either: false } : { ...needs, [f]: e.target.checked })}
            />
            {DETAIL_LABELS[f]}
          </label>
        ))}
        {whatsapp && <span className="text-xs text-subtle">The number comes with every WhatsApp message.</span>}
      </div>
      {!whatsapp && needs.email && needs.phone && (
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={needs.either} onChange={(e) => change({ ...needs, either: e.target.checked })} />
          Either a phone number or an email is enough
        </label>
      )}
    </div>
  );
  const day = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: clock.zone, day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

  function save() {
    if (!draft) return;
    const settings = { ...draft.settings, allowedSites: draft.sites.split(/\n|,/).map((s) => s.trim()).filter(Boolean) };
    run(
      () => saveInboxChannel({ id: draft.id, kind: draft.kind, name: draft.name, settings, phoneNumberId: draft.phoneNumberId, displayPhone: draft.displayPhone, ownerUserId: draft.ownerUserId || null }),
      draft.id ? "Saved." : "Added.",
      () => setDraft(null),
    );
  }

  function tryBot(c: ChannelView) {
    const text = trial.text.trim();
    if (!text) return;
    const raw = botReply({ text, settings: c.settings, state: trial.channel === c.id ? trial.state : null, known: trial.channel === c.id ? trial.known : { name: null, email: null, phone: null }, kind: c.kind });
    // Trying it here never spends AI credits: where Deskzo AI would step in, it says so.
    const turn =
      raw.reason === "unknown" && c.settings.bot.ai.on
        ? { ...raw, replies: ["(Deskzo AI answers this from your notes — or hands over if it can't.)"], handover: false, state: { step: "chatting" as const } }
        : raw;
    const earlier = trial.channel === c.id ? trial.log : [];
    const greeting = earlier.length === 0 && c.kind === "WHATSAPP" && c.settings.bot.on ? [{ from: "bot" as const, text: c.settings.greeting }] : [];
    setTrial({
      channel: c.id,
      text: "",
      log: [...earlier, { from: "you", text }, ...greeting, ...turn.replies.map((r) => ({ from: "bot" as const, text: r })), ...(turn.handover ? [{ from: "bot" as const, text: "— handed to a person —" }] : [])],
      state: turn.handover ? null : turn.state,
      known: { ...(trial.channel === c.id ? trial.known : { name: null, email: null, phone: null }), ...turn.learned },
    });
  }

  // ─── The form for one channel ──────────────────────────────────────────────────────────────────
  const form = (d: Draft) => (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="ch-name">Name, for your team</Label>
          <Input id="ch-name" className="mt-1" value={d.name} maxLength={INBOX_LIMITS.channelName} onChange={(e) => set({ name: e.target.value })} />
        </div>
        {d.kind === "WEB" ? (
          <div>
            <Label htmlFor="ch-title">Title on the bubble</Label>
            <Input id="ch-title" className="mt-1" value={d.settings.look.title} maxLength={INBOX_LIMITS.title} onChange={(e) => setS({ look: { ...d.settings.look, title: e.target.value } })} />
          </div>
        ) : (
          <div>
            <Label htmlFor="ch-owner">Whose number</Label>
            <SearchSelect id="ch-owner" className="mt-1" value={d.ownerUserId} onChange={(e) => set({ ownerUserId: e.target.value })} searchPlaceholder="Search people…">
              <option value="">Shared — the whole team answers</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}&apos;s own
                </option>
              ))}
            </SearchSelect>
          </div>
        )}
      </div>

      {d.kind === "WHATSAPP" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ch-pnid">Phone number ID</Label>
            <Input id="ch-pnid" className="mt-1" inputMode="numeric" value={d.phoneNumberId} onChange={(e) => set({ phoneNumberId: e.target.value })} placeholder="From Meta › WhatsApp › API setup" />
          </div>
          <div>
            <Label htmlFor="ch-phone">The number, as people dial it</Label>
            <PhoneInput id="ch-phone" className="mt-1" value={d.displayPhone} onChange={(v) => set({ displayPhone: v })} placeholder="98765 43210" />
          </div>
        </div>
      )}

      {d.kind === "WEB" && (
        <div className="grid gap-3 sm:grid-cols-[8rem_10rem_1fr]">
          <div>
            <Label htmlFor="ch-colour">Colour</Label>
            <Input id="ch-colour" type="color" className="mt-1 h-9 p-1" value={d.settings.look.colour} onChange={(e) => setS({ look: { ...d.settings.look, colour: e.target.value } })} />
          </div>
          <div>
            <Label htmlFor="ch-side">Corner</Label>
            <Select id="ch-side" className="mt-1" value={d.settings.look.position} onChange={(e) => setS({ look: { ...d.settings.look, position: e.target.value === "left" ? "left" : "right" } })}>
              <option value="right">Bottom right</option>
              <option value="left">Bottom left</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="ch-sites">Sites that may show it, one a line</Label>
            <Textarea id="ch-sites" className="mt-1 min-h-0" rows={2} value={d.sites} onChange={(e) => set({ sites: e.target.value })} placeholder="Blank: any site. Or example.com" />
          </div>
        </div>
      )}

      <div>
        <Label htmlFor="ch-greeting">Greeting</Label>
        <Textarea id="ch-greeting" className="mt-1 min-h-0" rows={2} maxLength={INBOX_LIMITS.greeting} value={d.settings.greeting} onChange={(e) => setS({ greeting: e.target.value })} />
      </div>

      <fieldset className="space-y-3 rounded-base border border-line p-3">
        <legend className="px-1 text-sm font-medium text-text">The bot</legend>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={d.settings.bot.on} onChange={(e) => setBot({ on: e.target.checked })} />
          Answer first, from the set answers below, and hand over to a person when it can&apos;t
        </label>
        <div>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={d.settings.bot.askDetails} onChange={(e) => setBot({ askDetails: e.target.checked })} />
            Before handing over to a person, ask for:
          </label>
          {d.settings.bot.askDetails && needsPicker(d.settings.bot.ask, (ask) => setBot({ ask }), d.kind === "WHATSAPP")}
          {d.settings.bot.askDetails && (
            <p className="ml-6 mt-1 text-xs text-muted">
              Only what it doesn&apos;t know yet — {needsText(asked(d.settings.bot.ask, d.kind))}: the name and a way to reach them in one message, anything else after. Each is asked twice at most; then it hands over anyway.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-xs text-muted">
            Each answer is given when a message has one of its words or phrases (comma-separated) — in their everyday forms too (&quot;price&quot; finds &quot;prices&quot;, &quot;pricing&quot;, &quot;cost&quot;, &quot;kitna&quot;). The one matching most wins. With Deskzo AI on, one short word in a long question is left for the AI to read.
          </p>
          {d.settings.bot.answers.map((a, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[14rem_1fr_auto]">
              <Input aria-label={`Answer ${i + 1}: its words`} value={a.keywords} maxLength={INBOX_LIMITS.keywords} placeholder="price, pricing, cost" onChange={(e) => setBot({ answers: d.settings.bot.answers.map((x, j) => (j === i ? { ...x, keywords: e.target.value } : x)) })} />
              <Textarea aria-label={`Answer ${i + 1}: what the bot says`} rows={2} className="min-h-0" value={a.answer} maxLength={INBOX_LIMITS.answer} onChange={(e) => setBot({ answers: d.settings.bot.answers.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove answer ${i + 1}`} onClick={() => setBot({ answers: d.settings.bot.answers.filter((_, j) => j !== i) })}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {d.settings.bot.answers.length < INBOX_LIMITS.answers && (
            <Button type="button" size="sm" variant="secondary" onClick={() => setBot({ answers: [...d.settings.bot.answers, { keywords: "", answer: "" }] })}>
              <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Add an answer
            </Button>
          )}
        </div>
        {d.kind === "WEB" && (
          <div className="space-y-2">
            <Label>Suggested questions (optional)</Label>
            <p className="text-xs text-muted">Buttons under the welcome until the visitor writes — a tap sends it as their message, and the bot answers it like any other.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {Array.from({ length: INBOX_LIMITS.suggestions }, (_, i) => (
                <Input
                  key={i}
                  aria-label={`Suggested question ${i + 1}`}
                  value={d.settings.bot.suggestions[i] ?? ""}
                  maxLength={INBOX_LIMITS.suggestion}
                  placeholder={["What does it cost?", "Book a demo", "Talk to sales", "What can it do?"][i]}
                  onChange={(e) => {
                    const next = Array.from({ length: INBOX_LIMITS.suggestions }, (_, j) => (j === i ? e.target.value : (d.settings.bot.suggestions[j] ?? "")));
                    // Kept in place while typing; the blanks are dropped when it's saved.
                    setBot({ suggestions: next });
                  }}
                />
              ))}
            </div>
          </div>
        )}
        <div>
          <Label htmlFor="ch-handover">When it hands over, it says</Label>
          <Input id="ch-handover" className="mt-1" value={d.settings.bot.handover} maxLength={INBOX_LIMITS.handover} onChange={(e) => setBot({ handover: e.target.value })} />
          <p className="mt-1 text-xs text-muted">{"{name}"} becomes the customer&apos;s first name — or is left out, comma and all, when the bot doesn&apos;t know it. The away message takes it too.</p>
        </div>
        <div>
          <Label htmlFor="ch-assistant">The assistant&apos;s name (optional)</Label>
          <Input id="ch-assistant" className="mt-1 sm:w-64" value={d.settings.bot.name} maxLength={INBOX_LIMITS.assistantName} onChange={(e) => setBot({ name: e.target.value })} placeholder={kabir.name} />
          <p className="mt-1 text-xs text-muted">Left empty, it answers as {kabir.name}, your AI front desk. Shown on its messages. It chats like a person on your team, but asked whether it&apos;s a person, it always says it&apos;s the virtual assistant and offers someone from the team.</p>
        </div>
        <div className="space-y-2 border-t border-line pt-3">
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={d.settings.bot.ai.on} onChange={(e) => setAi({ on: e.target.checked })} />
            Let Deskzo AI answer what the set answers don&apos;t — it hands over whenever it isn&apos;t sure
          </label>
          {d.settings.bot.ai.on && (
            <div>
              <Label htmlFor="ch-about">What the AI may tell customers about your business</Label>
              <Textarea
                id="ch-about"
                className="mt-1"
                rows={4}
                maxLength={INBOX_LIMITS.about}
                value={d.settings.bot.ai.about}
                onChange={(e) => setAi({ about: e.target.value })}
                placeholder="What you sell, where you deliver, your timings, how to book a demo… The AI says nothing that isn't here or in the set answers."
              />
              <p className="mt-1 text-xs text-muted">
                {ai
                  ? `Each answer uses your Deskzo AI credits, charged as ${channels.find((c) => c.id === d.id)?.aiChargedTo ?? "you"}. The AI sees only the conversation and what's written here — ${ai.model}, ${ai.residency}${ai.noTraining ? ", nothing kept for training" : ""}.`
                  : "Deskzo AI isn't set up for this yet. Until it is, the bot hands over instead of answering."}
              </p>
            </div>
          )}
          {d.settings.bot.ai.on && (
            <div>
              <label className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={d.settings.bot.ai.knowledge} onChange={(e) => setAi({ knowledge: e.target.checked })} />
                Use AI Knowledge
              </label>
              <p className="ml-6 mt-1 text-xs text-muted">
                Before each answer, the AI is given the 3 pieces of your{" "}
                <Link href="/settings/ai-knowledge" className="text-brand hover:underline">
                  AI Knowledge
                </Link>{" "}
                files that best match the question. Only files marked “Website chat may use this” there are used
                {knowledgeForCustomers === null
                  ? " — none can be marked yet while this workspace is being updated, so none are used. Try again in a few minutes."
                  : knowledgeForCustomers === 0
                    ? " — none are marked yet, so the bot has no file to answer from."
                    : ` — ${knowledgeForCustomers.toLocaleString("en-IN")} ${knowledgeForCustomers === 1 ? "file is" : "files are"} marked now.`}
              </p>
            </div>
          )}
          {d.settings.bot.ai.on && d.kind === "WEB" && (
            <div>
              <Label htmlFor="ch-pages">Pages of your website it may answer from (optional)</Label>
              <Textarea
                id="ch-pages"
                className="mt-1"
                rows={3}
                value={d.settings.bot.ai.pages.join("\n")}
                onChange={(e) => setAi({ pages: e.target.value.split("\n") })}
                placeholder={"https://example.com/sitemap.xml\nhttps://example.com/pricing"}
              />
              <p className="mt-1 text-xs text-muted">
                One address a line — a page, or your sitemap.xml to take every page it lists (up to {KNOWLEDGE_PAGES}). Public pages only{d.sites.trim() ? ", on the sites allowed above" : ""}. The AI is given the few passages that match each question, and may link the page.
              </p>
              {d.id && (
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                      setError(null);
                      setNotice(null);
                      startTransition(async () => {
                        const r = await readInboxPages(d.id!);
                        if (!r.ok) return setError(r.error);
                        const failed = r.data.failed.length ? ` ${r.data.failed.length} couldn't be read — ${r.data.failed[0]!.url}: ${r.data.failed[0]!.error}.` : "";
                        const skipped = r.data.skipped.length ? ` ${r.data.skipped.length} left out: not on the allowed sites.` : "";
                        setNotice(`Read ${r.data.read} page${r.data.read === 1 ? "" : "s"}.${failed}${skipped}`);
                        router.refresh();
                      });
                    }}
                  >
                    {pending ? "Reading…" : "Read the pages now"}
                  </Button>
                  <span className="text-muted">{pagesLine(channels.find((c) => c.id === d.id)?.pagesRead ?? null)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </fieldset>

      <div>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={d.settings.autoLead} onChange={(e) => setS({ autoLead: e.target.checked })} />
          Make a lead from a new customer automatically, once we have:
        </label>
        {d.settings.autoLead && needsPicker(d.settings.leadNeeds, (leadNeeds) => setS({ leadNeeds }), d.kind === "WHATSAPP")}
        {d.settings.autoLead && (
          <p className="ml-6 mt-1 text-xs text-muted">
            {d.kind === "WHATSAPP" && needsText(asked(d.settings.leadNeeds, d.kind)) === "nothing"
              ? "A lead from a new number's first message."
              : `A lead as soon as there's ${needsText(asked(d.settings.leadNeeds, d.kind))} — from the form, the bot, or the chat.`}{" "}
            It goes on the company they name, or on their own name without one. Customers already on file link to their record instead.
          </p>
        )}
      </div>

      {d.kind === "WEB" && (
        <div>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={d.settings.peek} onChange={(e) => setS({ peek: e.target.checked })} />
            Show the team what a visitor is typing, before they send it
          </label>
          <p className="ml-6 mt-0.5 text-xs text-muted">Never saved — it disappears the moment they send or stop typing. Off: the team just sees that they&apos;re typing.</p>
        </div>
      )}

      {d.kind === "WEB" && (
        <div>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={d.settings.prechat.on} onChange={(e) => setS({ prechat: { ...d.settings.prechat, on: e.target.checked } })} />
            Show a short form before the chat starts
          </label>
          {d.settings.prechat.on && (
            <div className="ml-6 mt-1.5 grid gap-2 sm:grid-cols-2">
              {DETAIL_FIELDS.map((f) => (
                <div key={f}>
                  <Label htmlFor={`pc-${f}`} className="text-xs">
                    {DETAIL_LABELS[f]}
                  </Label>
                  <Select
                    id={`pc-${f}`}
                    className="mt-1 h-8 text-sm"
                    value={d.settings.prechat.fields[f]}
                    onChange={(e) => setS({ prechat: { ...d.settings.prechat, fields: { ...d.settings.prechat.fields, [f]: e.target.value as FieldRule } } })}
                  >
                    <option value="required">Required</option>
                    <option value="optional">Optional</option>
                    <option value="off">Don&apos;t ask</option>
                  </Select>
                </div>
              ))}
            </div>
          )}
          <p className="ml-6 mt-0.5 text-xs text-muted">Fewer people start a chat when they must fill something in first — but every one comes with what you asked for. The bot never asks again for what the form took.</p>
        </div>
      )}

      {d.kind === "WEB" && (
        <div>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={d.settings.emailFollowUp} onChange={(e) => setS({ emailFollowUp: e.target.checked })} />
            Email a reply to a visitor who has left the website, when they gave an email
          </label>
          <p className="ml-6 mt-0.5 text-xs text-muted">At most one email a quarter of an hour, through your mail server (Settings › Messaging) — or Deskzo&apos;s, within its daily limit.</p>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={d.settings.csat} onChange={(e) => setS({ csat: e.target.checked })} />
        Ask “How did we do?” when the team closes a conversation it answered
      </label>

      <fieldset className="space-y-1.5 rounded-base border border-line p-3">
        <legend className="px-1 text-sm font-medium text-text">Files</legend>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={d.settings.files.customers} onChange={(e) => setS({ files: { ...d.settings.files, customers: e.target.checked } })} />
          Customers can send photos and documents
        </label>
        <p className="ml-6 text-xs text-muted">
          {d.kind === "WEB"
            ? "Off: the chat bubble has no attach button, and files are refused."
            : "Off: WhatsApp still lets customers send them, but they aren't kept — the team sees only that a file came, with any words sent with it."}
        </p>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={d.settings.files.team} onChange={(e) => setS({ files: { ...d.settings.files, team: e.target.checked } })} />
          The team can send photos and documents
        </label>
        <p className="ml-6 text-xs text-muted">Up to 5 MB each: photos, PDFs, and Word, Excel or text files — never programs or web pages.</p>
      </fieldset>

      {/* Website activity (owner, 6 Nov 2026; src/lib/inbox/activity.ts). */}
      {d.kind === "WEB" && (
        <fieldset className="space-y-2 rounded-base border border-line p-3">
          <legend className="px-1 text-sm font-medium text-text">Website activity</legend>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={d.settings.activity.on} onChange={(e) => setS({ activity: { ...d.settings.activity, on: e.target.checked } })} />
            Remember visitors who agree: the pages they open, and their device, browser, location, network and IP address
          </label>
          <p className="ml-6 text-xs text-muted">
            They stay anonymous until they chat, send a form or click a campaign email; then their visits show on their lead. Your website&apos;s privacy notice should say so too.
          </p>
          {d.settings.activity.on && (
            <div className="ml-6 space-y-3">
              <div className="space-y-1">
                <Label htmlFor="activity-consent">How visitors agree</Label>
                <Select id="activity-consent" value={d.settings.activity.consent} onChange={(e) => setS({ activity: { ...d.settings.activity, consent: e.target.value === "site" ? "site" : "notice" } })}>
                  <option value="notice">The bubble asks them, in a small notice</option>
                  <option value="site">My website&apos;s own cookie banner asks them</option>
                </Select>
              </div>
              {d.settings.activity.consent === "notice" ? (
                <div className="space-y-1">
                  <Label htmlFor="activity-notice">What the notice says</Label>
                  <Textarea id="activity-notice" rows={3} maxLength={300} value={d.settings.activity.notice} onChange={(e) => setS({ activity: { ...d.settings.activity, notice: e.target.value } })} />
                </div>
              ) : (
                <p className="text-xs text-muted">
                  When a visitor accepts, your banner calls <code>DeskzoChat.consent(true)</code>; when they decline, <code>DeskzoChat.consent(false)</code>. Nothing is recorded until it says yes.
                </p>
              )}
              <div className="space-y-1">
                <Label htmlFor="activity-keys">Key pages</Label>
                <Input id="activity-keys" value={d.settings.activity.keyPages.join(", ")} placeholder="/pricing, /demo" onChange={(e) => setS({ activity: { ...d.settings.activity, keyPages: e.target.value.split(",").map((p) => p.trimStart()) } })} />
                <p className="text-xs text-muted">When somebody known opens one of these, whoever has their lead or account is told — at most twice a day for one person.</p>
              </div>
              <p className="text-xs text-muted">
                A form on your website joins the visit to the enquiry when it sends <code>visitor_id</code> to the lead capture API: an input named <code>visitor_id</code> is filled in for you.
              </p>
            </div>
          )}
        </fieldset>
      )}

      {d.kind === "WEB" && (
        <fieldset className="space-y-2 rounded-base border border-line p-3">
          <legend className="px-1 text-sm font-medium text-text">Say hello first</legend>
          <p className="text-xs text-muted">
            A message beside the bubble after a visitor has been on a page a while — once a visit, only to somebody who hasn&apos;t started a chat. “/pricing” is that page and those under it; “*” is every page.
          </p>
          {d.settings.proactive.map((r, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[9rem_6rem_1fr_auto] sm:items-start">
              <Input aria-label={`Message ${i + 1}: the page`} value={r.path} maxLength={200} placeholder="/pricing" onChange={(e) => setProactive(d.settings.proactive.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
              <div className="flex items-center gap-1">
                <Input
                  aria-label={`Message ${i + 1}: after how many seconds`}
                  type="number"
                  min={3}
                  max={600}
                  value={r.delay}
                  onChange={(e) => setProactive(d.settings.proactive.map((x, j) => (j === i ? { ...x, delay: Number(e.target.value) || 30 } : x)))}
                />
                <span className="text-xs text-muted">s</span>
              </div>
              <Textarea
                aria-label={`Message ${i + 1}: what it says`}
                rows={2}
                className="min-h-0"
                value={r.message}
                maxLength={INBOX_LIMITS.proactiveMessage}
                placeholder="Questions about our plans? I'm happy to help."
                onChange={(e) => setProactive(d.settings.proactive.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))}
              />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove message ${i + 1}`} onClick={() => setProactive(d.settings.proactive.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {d.settings.proactive.length < INBOX_LIMITS.proactive && (
            <Button type="button" size="sm" variant="secondary" onClick={() => setProactive([...d.settings.proactive, { path: "/pricing", delay: 30, message: "" }])}>
              <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Add a message
            </Button>
          )}
        </fieldset>
      )}

      <fieldset className="space-y-3 rounded-base border border-line p-3">
        <legend className="px-1 text-sm font-medium text-text">Office hours</legend>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={d.settings.hours.on} onChange={(e) => setHours({ on: e.target.checked })} />
          Outside these hours, tell customers waiting for a person when you&apos;ll be back
        </label>
        {d.settings.hours.on && (
          <>
            <div className="space-y-1.5">
              {WEEKDAYS.map((w) => {
                const span = d.settings.hours.days[w];
                return (
                  <div key={w} className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="flex w-32 items-center gap-2 text-text">
                      <input type="checkbox" checked={!!span} onChange={(e) => setDay(w, e.target.checked ? { from: "09:00", to: "18:00" } : null)} />
                      {DAY_NAMES[w]}
                    </label>
                    {span ? (
                      <>
                        <Input type="time" aria-label={`${DAY_NAMES[w]} opens`} className="h-8 w-28" value={span.from} onChange={(e) => setDay(w, { ...span, from: e.target.value })} />
                        <span className="text-muted">to</span>
                        <Input type="time" aria-label={`${DAY_NAMES[w]} closes`} className="h-8 w-28" value={span.to} onChange={(e) => setDay(w, { ...span, to: e.target.value })} />
                      </>
                    ) : (
                      <span className="text-xs text-subtle">Closed</span>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted">In the workspace&apos;s time zone (Settings › Company).</p>
            <div>
              <Label htmlFor="ch-away">Away message</Label>
              <Textarea id="ch-away" className="mt-1 min-h-0" rows={2} maxLength={INBOX_LIMITS.away} value={d.settings.hours.away} onChange={(e) => setHours({ away: e.target.value })} />
            </div>
          </>
        )}
      </fieldset>

      {(d.kind === "WEB" || !d.ownerUserId) && (
        <fieldset className="space-y-3 rounded-base border border-line p-3">
          <legend className="px-1 text-sm font-medium text-text">Who gets a conversation that needs a person</legend>
          <Select aria-label="Who gets it" value={d.settings.assign.mode} onChange={(e) => setAssign({ mode: e.target.value === "rotate" ? "rotate" : "queue" })}>
            <option value="queue">The queue — whoever takes it first</option>
            <option value="rotate">Each person in turn (round-robin)</option>
          </Select>
          {d.settings.assign.mode === "rotate" && (
            <div>
              <p className="text-xs text-muted">Who takes turns — leave every box empty for everybody who answers customers.</p>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {people.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm text-text">
                    <input
                      type="checkbox"
                      checked={d.settings.assign.people.includes(p.id)}
                      onChange={(e) => setAssign({ people: e.target.checked ? [...d.settings.assign.people, p.id] : d.settings.assign.people.filter((x) => x !== p.id) })}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>
          )}
        </fieldset>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {d.id ? "Save" : "Add"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );

  // ─── One channel's card ────────────────────────────────────────────────────────────────────────
  const card = (c: ChannelView) => {
    const editing = draft?.id === c.id;
    return (
      <li key={c.id} className={cn("rounded-base border border-line p-4", !c.active && "opacity-70")}>
        <div className="flex flex-wrap items-center gap-2">
          {c.kind === "WEB" ? <Globe aria-hidden="true" className="h-4 w-4 text-info" /> : <Phone aria-hidden="true" className="h-4 w-4 text-success" />}
          <p className="font-medium text-text">{c.name}</p>
          <span className="text-xs text-muted">
            {c.kind === "WHATSAPP" ? `${c.displayPhone ?? c.phoneNumberId} · ${c.ownerUserId ? `${people.find((p) => p.id === c.ownerUserId)?.name ?? "A rep"}'s own` : "shared"}` : c.settings.allowedSites.length ? c.settings.allowedSites.join(", ") : "any site"}
            {` · bot ${c.settings.bot.on ? `on, ${c.settings.bot.answers.length} answers${c.settings.bot.ai.on ? " and Deskzo AI" : ""}` : "off"}`}
            {c.settings.hours.on ? " · office hours" : ""}
            {c.settings.assign.mode === "rotate" && !c.ownerUserId ? " · round-robin" : ""}
            {!c.settings.files.customers && !c.settings.files.team ? " · no files" : !c.settings.files.customers ? " · no files from customers" : !c.settings.files.team ? " · team can't send files" : ""}
            {c.active ? "" : " · switched off"}
          </span>
          <span className="ml-auto flex gap-1">
            {!editing && (
              <Button size="sm" variant="secondary" onClick={() => setDraft(draftOf(c))}>
                Edit
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setInboxChannelActive(c.id, !c.active), c.active ? "Switched off." : "Switched on.")}>
              {c.active ? "Switch off" : "Switch on"}
            </Button>
            {c.conversations === 0 && (
              <Button size="sm" variant="ghost" aria-label={`Remove ${c.name}`} disabled={pending} onClick={() => run(() => deleteInboxChannel(c.id), "Removed.")}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </span>
        </div>
        {c.kind === "WEB" && c.publicKey && (
          <div className="mt-3">
            <p className="text-xs text-muted">Paste this before &lt;/body&gt; on every page of your site:</p>
            <div className="mt-1 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-base bg-surface-sunken px-2 py-1.5 text-xs text-text">{widgetSnippet(origin, c.publicKey)}</code>
              <Button size="sm" variant="secondary" aria-label="Copy the snippet" onClick={() => copy(widgetSnippet(origin, c.publicKey!))}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
        {editing && draft && <div className="mt-4 border-t border-line pt-4">{form(draft)}</div>}
        {!editing && c.settings.bot.on && (
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              tryBot(c);
            }}
          >
            {trial.channel === c.id && trial.log.length > 0 && (
              <ol className="max-h-48 space-y-1 overflow-y-auto rounded-base bg-surface-sunken p-2 text-xs">
                {trial.log.map((m, i) => (
                  <li key={i} className={m.from === "you" ? "text-right text-text" : "text-muted"}>
                    {m.from === "bot" && <Bot aria-hidden="true" className="mr-1 inline h-3 w-3" />}
                    {m.text}
                  </li>
                ))}
              </ol>
            )}
            <div className="flex gap-2">
              <Input aria-label={`Try ${c.name}'s bot`} placeholder="Try the bot: type what a customer might" value={trial.channel === c.id || !trial.channel ? trial.text : ""} onChange={(e) => setTrial((t) => ({ ...t, ...(t.channel !== c.id ? { channel: c.id, log: [], state: null, known: { name: null, email: null, phone: null } } : {}), text: e.target.value }))} className="h-8 text-sm" />
              <Button size="sm" variant="secondary" type="submit">
                Try
              </Button>
            </div>
          </form>
        )}
      </li>
    );
  };

  const web = channels.filter((c) => c.kind === "WEB");
  const numbers = channels.filter((c) => c.kind === "WHATSAPP");

  return (
    <div className="space-y-6">
      {(error || notice) && (
        <p role={error ? "alert" : "status"} className={cn("rounded-base px-3 py-2 text-sm", error ? "bg-danger-bg text-danger" : "bg-success-bg text-success")}>
          {error ?? notice}
        </p>
      )}

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-text">Website chat</h2>
          <p className="mt-0.5 text-xs text-muted">A chat bubble on your website. Visitors type; the bot answers or hands over; your team replies from the inbox.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="space-y-3">{web.map(card)}</ul>
          {draft && !draft.id && draft.kind === "WEB" ? (
            <div className="rounded-base border border-line p-4">{form(draft)}</div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setDraft(newDraft("WEB"))}>
              <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Add a website
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-text">WhatsApp</h2>
          <p className="mt-0.5 text-xs text-muted">
            Through Meta&apos;s WhatsApp Cloud API: a shared number the team answers, and reps&apos; own. Each number needs to be in your WhatsApp Business account; a
            template must be approved by Meta before it can be sent.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <WhatsAppSetupGuide webhookUrl={whatsapp.webhookUrl} hasToken={whatsapp.hasToken || whatsapp.providerToken} hasAppSecret={whatsapp.hasAppSecret} numbers={numbers.length} />
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => saveInboxWhatsApp(creds), "Saved.", () => setCreds((c) => ({ ...c, accessToken: "", appSecret: "" })));
            }}
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem]">
              <div>
                <Label htmlFor="wa-token">Access token</Label>
                <Input
                  id="wa-token"
                  type="password"
                  autoComplete="off"
                  className="mt-1"
                  value={creds.accessToken}
                  onChange={(e) => setCreds((c) => ({ ...c, accessToken: e.target.value }))}
                  placeholder={whatsapp.hasToken ? "Saved — leave blank to keep" : whatsapp.providerToken ? "Using Mail & messaging's" : "A permanent system-user token"}
                />
              </div>
              <div>
                <Label htmlFor="wa-secret">Meta app secret</Label>
                <Input id="wa-secret" type="password" autoComplete="off" className="mt-1" value={creds.appSecret} onChange={(e) => setCreds((c) => ({ ...c, appSecret: e.target.value }))} placeholder={whatsapp.hasAppSecret ? "Saved — leave blank to keep" : "From the app's Basic settings"} />
              </div>
              <div>
                <Label htmlFor="wa-lang">Template language</Label>
                <Input id="wa-lang" className="mt-1" value={creds.language} onChange={(e) => setCreds((c) => ({ ...c, language: e.target.value }))} placeholder="en" />
              </div>
            </div>
            <Button type="submit" size="sm" disabled={pending}>
              Save WhatsApp settings
            </Button>
          </form>

          <div className="space-y-2 rounded-base bg-surface-sunken p-3 text-xs">
            <p className="font-medium text-text">Webhook — give Meta these, in the app&apos;s WhatsApp › Configuration, and subscribe to “messages”:</p>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-muted">Callback URL</span>
              <code className="min-w-0 flex-1 break-all text-text">{whatsapp.webhookUrl}</code>
              <Button size="sm" variant="ghost" aria-label="Copy the callback URL" onClick={() => copy(whatsapp.webhookUrl)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-muted">Verify token</span>
              <code className="min-w-0 flex-1 break-all text-text">{whatsapp.verifyToken}</code>
              <Button size="sm" variant="ghost" aria-label="Copy the verify token" onClick={() => copy(whatsapp.verifyToken)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => newInboxVerifyToken(), "A new verify token is ready — give it to Meta.")}>
                New
              </Button>
            </div>
            {!whatsapp.hasAppSecret && <p className="text-danger">Messages can&apos;t come in until the app secret is saved: every call Meta makes is checked against it.</p>}
          </div>

          <ul className="space-y-3">{numbers.map(card)}</ul>
          {draft && !draft.id && draft.kind === "WHATSAPP" ? (
            <div className="rounded-base border border-line p-4">{form(draft)}</div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setDraft(newDraft("WHATSAPP"))}>
              <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Add a WhatsApp number
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-text">Saved replies</h2>
          <p className="mt-0.5 text-xs text-muted">
            Answers the team gives often. In the inbox, type “/” and the shortcut to drop one in, then change what you like before sending. {"{name}"} becomes the customer&apos;s first name, {"{agent}"} yours.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {savedReplies.length > 0 && (
            <ul className="divide-y divide-line rounded-base border border-line">
              {savedReplies.map((r) =>
                reply?.id === r.id ? null : (
                  <li key={r.id} className="flex items-start gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-text">
                        <span className="font-mono font-medium">/{r.shortcut}</span> <span className="text-muted">· {r.title}</span>
                      </p>
                      <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-muted">{r.body}</p>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => setReply({ id: r.id, shortcut: r.shortcut, title: r.title, body: r.body })}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Remove /${r.shortcut}`} disabled={pending} onClick={() => run(() => deleteInboxSavedReply(r.id), "Removed.")}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ),
              )}
            </ul>
          )}
          {reply ? (
            <form
              className="space-y-3 rounded-base border border-line p-3"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => saveInboxSavedReply(reply), reply.id ? "Saved." : "Added.", () => setReply(null));
              }}
            >
              <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                <div>
                  <Label htmlFor="sr-shortcut">Shortcut</Label>
                  <div className="mt-1 flex items-center gap-1">
                    <span className="text-muted">/</span>
                    <Input id="sr-shortcut" value={reply.shortcut} maxLength={TEAM_LIMITS.shortcut} placeholder="pricing" onChange={(e) => setReply({ ...reply, shortcut: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} />
                  </div>
                </div>
                <div>
                  <Label htmlFor="sr-title">What it&apos;s for</Label>
                  <Input id="sr-title" className="mt-1" value={reply.title} maxLength={TEAM_LIMITS.replyTitle} placeholder="Our plans and prices" onChange={(e) => setReply({ ...reply, title: e.target.value })} />
                </div>
              </div>
              <div>
                <Label htmlFor="sr-body">The reply</Label>
                <Textarea id="sr-body" className="mt-1" rows={4} value={reply.body} maxLength={TEAM_LIMITS.replyBody} placeholder="Hi {name}, our plans start at…" onChange={(e) => setReply({ ...reply, body: e.target.value })} />
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={pending || !reply.shortcut || !reply.title.trim() || !reply.body.trim()}>
                  {reply.id ? "Save" : "Add"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setReply(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            savedReplies.length < TEAM_LIMITS.replies && (
              <Button size="sm" variant="secondary" onClick={() => setReply({ id: null, shortcut: "", title: "", body: "" })}>
                <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                Add a saved reply
              </Button>
            )
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium text-text">Blocked</h2>
          <p className="mt-0.5 text-xs text-muted">Website visitors and WhatsApp numbers the team blocked from a conversation. Nothing they send comes in.</p>
        </CardHeader>
        <CardContent>
          {blocks.length === 0 ? (
            <p className="text-sm text-muted">Nobody is blocked.</p>
          ) : (
            <ul className="divide-y divide-line rounded-base border border-line">
              {blocks.map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  {b.kind === "WEB" ? <Globe aria-hidden="true" className="h-4 w-4 shrink-0 text-info" /> : <Phone aria-hidden="true" className="h-4 w-4 shrink-0 text-success" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-text">{b.label ?? (b.kind === "WEB" ? "A website visitor" : "A WhatsApp number")}</p>
                    <p className="truncate text-xs text-muted">
                      {b.reason ? `${b.reason} · ` : ""}
                      {b.by ? `by ${b.by}, ` : ""}
                      {day(b.createdAt)}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => removeInboxBlock(b.id), "Unblocked.")}>
                    Unblock
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
