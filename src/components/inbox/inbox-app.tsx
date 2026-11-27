"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { ArrowLeft, Ban, Bot, Building2, Check, CheckCheck, Clock, Globe, Info, Languages, Link2, Mail, MapPin, MessageSquareMore, Monitor, Paperclip, Phone, Search, StickyNote, Ticket, UserPlus, X } from "lucide-react";
import {
  inboxAssign,
  inboxBlock,
  inboxConversation,
  inboxLinkCustomer,
  inboxList,
  inboxMakeLead,
  inboxMakeTicket,
  inboxNote,
  inboxReply,
  inboxSendFile,
  inboxSendTemplate,
  inboxPeek,
  inboxSetAvailability,
  inboxSetStatus,
  inboxSetTags,
  inboxTags,
  inboxTyping,
  inboxUnblock,
  inboxUnlinkCustomer,
} from "@/actions/inbox";
import { useChatLive } from "@/components/chat/chat-live";
import { ConversationActivity, VisitorDetail, VisitorList } from "@/components/inbox/visitors-tab";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { companyPath, ticketPath } from "@/lib/record-links";
import type { InboxDetail, InboxMessage, InboxPeek, InboxRow, InboxView } from "@/lib/inbox/server";
import type { SavedReply } from "@/lib/inbox/team";
import { SENDABLE_TYPES, TEAM_LIMITS, fillReply, matchReplies, normaliseTags } from "@/lib/inbox/team-rules";
import { cn } from "@/lib/utils";

/**
 * The Customer inbox's screen (src/lib/inbox): the conversations on the left — mine, nobody's yet, every
 * open one, or the closed — the one open in the middle with its reply box, and who the customer is, with
 * what can be done about them, on the right. On a phone, the list or the conversation.
 *
 * Live through team chat's connection (src/components/chat/chat-live.tsx), which says only which
 * conversation changed: the list and the open conversation are asked for again. Without it — chat
 * switched off for this person — every fifteen seconds instead.
 *
 * The team's tools (owner, 24 Oct 2026): a reply or a private note ("@Name" tells a colleague), "/" for a
 * saved reply, a file either way, tags, the customer's rating, whether you're taking conversations, a
 * warning when a colleague is replying to the same customer, and blocking a nuisance.
 */

/** What the file picker offers: the kinds anybody may send (src/lib/inbox/team-rules.ts). */
const FILE_ACCEPT = [...Object.keys(SENDABLE_TYPES), ...Object.values(SENDABLE_TYPES).map((e) => `.${e}`)].join(",");

type Channel = { id: string; name: string; kind: "WEB" | "WHATSAPP" };

const VIEWS: { value: InboxView; label: string }[] = [
  { value: "mine", label: "Mine" },
  { value: "unassigned", label: "Unassigned" },
  { value: "open", label: "All open" },
  { value: "closed", label: "Closed" },
];

/** "2nd", "3rd", "11th". */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** "Hindi (India)" — a browser's language tag in words. Kept here rather than imported: the visitor helpers carry the country table. */
function languageName(tag: string | null): string | null {
  if (!tag) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The time now where the visitor is, by their browser's time zone: "10:42 pm". */
function localTime(zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-IN", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date());
  } catch {
    return "—";
  }
}

/** "Priya Sharma" → "PS"; null without a name, so the channel's icon stands in. */
function initialsOf(name: string | null): string | null {
  const words = (name ?? "").trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  if (!words.length) return null;
  return (words[0]![0]! + (words.length > 1 ? words[words.length - 1]![0]! : "")).toUpperCase();
}

/** "https://www.example.com/pricing?x=1" → "example.com/pricing": enough to tell the page. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

function KindIcon({ kind, className }: { kind: "WEB" | "WHATSAPP"; className?: string }) {
  return kind === "WHATSAPP" ? <Phone aria-hidden="true" className={className} /> : <Globe aria-hidden="true" className={className} />;
}

export function InboxApp({
  meId,
  meName,
  savedReplies,
  initialTags,
  initialAvailability,
  canManageSettings,
  canSeeVisitors,
  initialTab,
  channels,
  people,
  initialRows,
  initialView,
  initialDetail,
  canMakeLead,
  canMakeTicket,
}: {
  meId: string;
  meName: string | null;
  savedReplies: SavedReply[];
  initialTags: string[];
  initialAvailability: "ONLINE" | "AWAY";
  canManageSettings: boolean;
  /** "See website activity": the Visitors tab, and their journey beside a chat (owner, 7 Nov 2026). */
  canSeeVisitors: boolean;
  initialTab: "conversations" | "visitors";
  channels: Channel[];
  people: { id: string; name: string }[];
  initialRows: InboxRow[];
  initialView: InboxView;
  initialDetail: InboxDetail | null;
  canMakeLead: boolean;
  canMakeTicket: boolean;
}) {
  const clock = useClock();
  const live = useChatLive();
  const [view, setView] = useState<InboxView>(initialView);
  /** The Visitors tab replaces the list and the conversation; everything else about the inbox stays as it was left. */
  const [tab, setTab] = useState<"conversations" | "visitors">(initialTab);
  const [visitorId, setVisitorId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState("");
  const [tag, setTag] = useState("");
  const [knownTags, setKnownTags] = useState<string[]>(initialTags);
  const [availability, setAvailability] = useState(initialAvailability);
  const [q, setQ] = useState("");
  /** Writing to the customer, or a note to colleagues. */
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [pickIndex, setPickIndex] = useState(0);
  const [tagDraft, setTagDraft] = useState("");
  const [blockReason, setBlockReason] = useState<string | null>(null);
  /** Below a wide screen, the customer's details open over the conversation. */
  const [showDetails, setShowDetails] = useState(false);
  /** Colleagues with this conversation open now, and whether they're replying. */
  const [others, setOthers] = useState<InboxPeek["others"]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<InboxRow[]>(initialRows);
  const [detail, setDetail] = useState<InboxDetail | null>(initialDetail);
  const [selected, setSelected] = useState<string | null>(initialDetail?.id ?? null);
  const [draft, setDraft] = useState("");
  const [template, setTemplate] = useState({ name: "", values: "" });
  const [ticketTitle, setTicketTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const threadEnd = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  /** What the website visitor is typing now, where the channel lets the team peek (src/lib/inbox/server.ts visitorPeek). */
  const [peek, setPeek] = useState<{ typing: boolean; text: string | null } | null>(null);
  const filters = useRef({ view, channelId, q, tag });
  const selectedRef = useRef(selected);
  useEffect(() => {
    filters.current = { view, channelId, q, tag };
    selectedRef.current = selected;
  });

  const time = useMemo(() => {
    const hm = new Intl.DateTimeFormat("en-IN", { timeZone: clock.zone, hour: "numeric", minute: "2-digit" });
    const day = new Intl.DateTimeFormat("en-IN", { timeZone: clock.zone, day: "numeric", month: "short" });
    return (iso: string) => {
      const at = new Date(iso);
      return clock.dateKey(at) === clock.today() ? hm.format(at) : `${day.format(at)}, ${hm.format(at)}`;
    };
  }, [clock]);

  const reloadList = useCallback(async () => {
    const f = filters.current;
    setRows(await inboxList({ view: f.view, channelId: f.channelId || null, q: f.q || null, tag: f.tag || null }));
  }, []);
  const reloadDetail = useCallback(async (id: string | null = selectedRef.current) => {
    if (!id) return;
    const next = await inboxConversation(id);
    if (selectedRef.current === id) setDetail(next);
  }, []);

  // Filters changed: the list again, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => void reloadList(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [view, channelId, q, tag, reloadList]);

  /** What's happening in the open conversation besides its messages: the visitor typing, colleagues there. */
  const lookAround = useCallback((id: string) => {
    void inboxPeek(id).then((p) => {
      if (selectedRef.current !== id) return;
      setPeek(p.typing ? p : null);
      setOthers(p.others);
    });
  }, []);

  // While a conversation is open, this person is there — said every ten seconds, and who else is, asked.
  useEffect(() => {
    if (!selected) return;
    lookAround(selected);
    const t = setInterval(() => document.visibilityState === "visible" && lookAround(selected), 10_000);
    return () => {
      clearInterval(t);
      setOthers([]);
    };
  }, [selected, lookAround]);

  // Live: whichever conversation changed, the list — and the open one, if it was that. A visitor typing in
  // the open one: what they're typing, asked for as this person (no more than twice a second), gone when they stop.
  useEffect(() => {
    if (!live) return;
    let asking: ReturnType<typeof setTimeout> | null = null;
    let fade: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = live.subscribe((event) => {
      if (event.type === "inbox-typing") {
        if (event.conversationId !== selectedRef.current || asking) return;
        asking = setTimeout(() => {
          asking = null;
          const id = selectedRef.current;
          if (!id) return;
          void inboxPeek(id).then((p) => {
            if (selectedRef.current !== id) return;
            setPeek(p.typing ? p : null);
            setOthers(p.others);
            if (fade) clearTimeout(fade);
            fade = setTimeout(() => setPeek(null), 9_000);
          });
        }, 500);
        return;
      }
      if (event.type !== "inbox") return;
      void reloadList();
      if (event.conversationId === selectedRef.current) {
        setPeek(null);
        void reloadDetail(event.conversationId);
      }
    });
    return () => {
      unsubscribe();
      if (asking) clearTimeout(asking);
      if (fade) clearTimeout(fade);
    };
  }, [live, reloadList, reloadDetail]);
  useEffect(() => {
    const every = live?.connected ? 60_000 : 15_000;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void reloadList();
      void reloadDetail();
    }, every);
    return () => clearInterval(t);
  }, [live?.connected, reloadList, reloadDetail]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "end" });
  }, [detail?.id, detail?.messages.length]);

  function open(id: string) {
    setSelected(id);
    setPeek(null);
    setOthers([]);
    setError(null);
    setNotice(null);
    setTicketTitle(null);
    setBlockReason(null);
    setTagDraft("");
    setMode("reply");
    setDraft("");
    startTransition(async () => {
      const next = await inboxConversation(id);
      setDetail(next);
      window.history.replaceState(null, "", next ? `/inbox?c=${next.ref}` : "/inbox");
      void reloadList();
    });
  }

  /** Runs a change, then shows the conversation and the list as they now are. */
  function act(work: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void, success?: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
      if (success) setNotice(success);
      await Promise.all([reloadDetail(), reloadList()]);
    });
  }

  const id = detail?.id ?? null;
  const send = () => {
    if (!id || !draft.trim()) return;
    if (mode === "note") {
      act(
        async () => inboxNote(id, draft),
        () => {
          setDraft("");
          setMode("reply");
        },
      );
      return;
    }
    act(() => inboxReply(id, draft), () => setDraft(""));
  };

  // "/word" at the start of a reply: the saved replies it matches. "@na" at the end of a note: the colleagues.
  const slash = mode === "reply" && /^\/\S*$/.test(draft) ? matchReplies(savedReplies, draft.slice(1)) : [];
  const mention = mode === "note" ? /(^|\s)@([^@\n]{0,30})$/.exec(draft) : null;
  const mentionable = mention ? people.filter((p) => p.id !== meId && p.name.toLowerCase().startsWith(mention[2]!.toLowerCase())).slice(0, 6) : [];
  const picks: { key: string; label: string; hint: string; use: () => void }[] = slash.length
    ? slash.map((r) => ({ key: r.id, label: `/${r.shortcut}`, hint: r.title, use: () => setDraft(fillReply(r.body, { customer: detail?.customerName ?? null, agent: meName })) }))
    : mentionable.map((p) => ({ key: p.id, label: p.name, hint: "", use: () => setDraft(draft.slice(0, draft.length - mention![2]!.length) + `${p.name} `) }));
  const pick = Math.min(pickIndex, Math.max(0, picks.length - 1));

  function sendFile(file: File) {
    if (!id) return;
    if (file.size > TEAM_LIMITS.file) {
      setError("Files can be up to 5 MB.");
      return;
    }
    const form = new FormData();
    form.set("id", id);
    form.set("file", file);
    // What's typed goes with it, as a caption.
    if (draft.trim()) form.set("caption", draft.trim());
    act(() => inboxSendFile(form), () => setDraft(""));
  }

  function saveTags(next: string[]) {
    if (!id) return;
    act(
      async () => inboxSetTags(id, next),
      () => {
        setTagDraft("");
        void inboxTags().then(setKnownTags);
      },
    );
  }
  const sendTemplate = () =>
    id &&
    act(
      () => inboxSendTemplate(id, { name: template.name, variables: template.values.split("\n").map((v) => v.trim()).filter(Boolean) }),
      () => setTemplate({ name: "", values: "" }),
    );

  // ─── The list ──────────────────────────────────────────────────────────────────────────────────
  const list = (
    <section aria-label="Conversations" className={cn("flex min-h-0 flex-col border-line md:w-80 md:shrink-0 md:border-r", (tab === "visitors" ? visitorId : detail) && "hidden md:flex")}>
      <div className="space-y-2 border-b border-line p-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            aria-pressed={availability === "ONLINE"}
            disabled={pending}
            title={availability === "ONLINE" ? "New conversations can come to you in turn. Click to go away." : "Round-robin passes you over. Click when you're back."}
            onClick={() => {
              const next = availability === "ONLINE" ? "AWAY" : "ONLINE";
              act(
                () => inboxSetAvailability(next),
                () => setAvailability(next),
              );
            }}
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-text hover:bg-surface-sunken"
          >
            <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", availability === "ONLINE" ? "bg-success" : "bg-warning")} />
            {availability === "ONLINE" ? "Available" : "Away"}
          </button>
          {canManageSettings && (
            <Link href="/settings/inbox" className="text-xs text-muted hover:text-text">
              Settings
            </Link>
          )}
        </div>
        <div role="tablist" aria-label="Which conversations" className="flex gap-0.5 overflow-x-auto rounded-base bg-surface-sunken p-1">
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="tab"
              aria-selected={tab === "conversations" && view === v.value}
              onClick={() => {
                setTab("conversations");
                setView(v.value);
              }}
              className={cn("flex-auto whitespace-nowrap rounded px-1 py-1 text-xs font-medium", tab === "conversations" && view === v.value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
            >
              {v.label}
            </button>
          ))}
          {canSeeVisitors && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "visitors"}
              onClick={() => setTab("visitors")}
              className={cn("flex-auto whitespace-nowrap rounded px-1 py-1 text-xs font-medium", tab === "visitors" ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
            >
              Visitors
            </button>
          )}
        </div>
        {tab === "conversations" && <div className="flex flex-wrap gap-2">
          <div className="relative min-w-36 flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <Input aria-label="Search by name, phone or email" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8 text-sm" />
          </div>
          {channels.length > 1 && (
            <Select aria-label="Channel" value={channelId} onChange={(e) => setChannelId(e.target.value)} className="h-8 w-32 text-sm">
              <option value="">Every channel</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
          {(knownTags.length > 0 || tag) && (
            <Select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)} className="h-8 w-32 text-sm">
              <option value="">Any tag</option>
              {[...new Set([...(tag ? [tag] : []), ...knownTags])].map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </Select>
          )}
        </div>}
      </div>
      {tab === "visitors" ? <VisitorList selected={visitorId} onSelect={setVisitorId} /> : <ul className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && <li className="px-4 py-10 text-center text-sm text-muted">{view === "mine" ? "Nothing of yours waiting." : view === "unassigned" ? "Nothing in the queue." : "No conversations here."}</li>}
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => open(r.id)}
              aria-current={selected === r.id ? "true" : undefined}
              className={cn("flex w-full gap-3 border-b border-line px-3 py-2.5 text-left hover:bg-surface-sunken", selected === r.id && "bg-brand-subtle")}
            >
              <span className={cn("relative mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full", r.kind === "WHATSAPP" ? "bg-success-bg text-success" : "bg-info-bg text-info")}>
                <KindIcon kind={r.kind} className="h-4 w-4" />
                {r.online && <span aria-label="Online now" className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-success" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate text-sm", r.unread ? "font-semibold text-text" : "font-medium text-text")}>{r.customer}</span>
                  <span className="shrink-0 text-[11px] text-subtle">{time(r.lastMessageAt)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  {r.unread && <span aria-label="Unread" className="h-2 w-2 shrink-0 rounded-full bg-brand" />}
                  <span className={cn("truncate text-xs", r.unread ? "text-text" : "text-muted")}>
                    {r.lastFrom === "AGENT" ? "You: " : r.lastFrom === "BOT" ? "Bot: " : ""}
                    {r.preview}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-subtle">
                  {r.channelName}
                  {r.botActive ? " · with the bot" : r.assignedTo ? ` · ${r.assignedTo.id === meId ? "you" : r.assignedTo.name}` : " · nobody yet"}
                  {r.rating && <span aria-label={r.rating === "GOOD" ? "Rated good" : "Rated not good"}> · {r.rating === "GOOD" ? "👍" : "👎"}</span>}
                </span>
                {r.tags.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {r.tags.slice(0, 3).map((t) => (
                      <span key={t} className="rounded bg-surface-sunken px-1.5 py-px text-[10px] font-medium text-muted">
                        #{t}
                      </span>
                    ))}
                    {r.tags.length > 3 && <span className="text-[10px] text-subtle">+{r.tags.length - 3}</span>}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>}
    </section>
  );

  // ─── A customer's file: fetched from WhatsApp the first time it's opened, then kept ──────────────
  const media = (messageId: string, file: NonNullable<InboxMessage["media"]>) => {
    const src = `/api/inbox/files/${encodeURIComponent(messageId)}`;
    const mime = file.mime ?? "";
    if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) {
      return (
        <a href={src} target="_blank" rel="noopener" className="mt-1.5 block">
          {/* eslint-disable-next-line @next/next/no-img-element -- a private file behind the inbox's own checks, not an optimisable image */}
          <img src={src} alt={file.name ?? "A photo"} loading="lazy" className="max-h-56 rounded-lg" />
        </a>
      );
    }
    if (mime.startsWith("audio/")) return <audio controls preload="none" src={src} className="mt-1.5 w-56 max-w-full" />;
    if (mime === "video/mp4" || mime === "video/3gpp") return <video controls preload="none" src={src} className="mt-1.5 max-h-56 max-w-full rounded-lg" />;
    return (
      <a href={`${src}?download=1`} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2">
        Save {file.name ?? "the file"}
      </a>
    );
  };

  // ─── A message ─────────────────────────────────────────────────────────────────────────────────
  const message = (m: InboxMessage) => {
    if (m.author === "SYSTEM") {
      return (
        <li key={m.id} className="text-center text-[11px] text-subtle">
          {m.body} · {time(m.at)}
        </li>
      );
    }
    if (m.author === "NOTE") {
      return (
        <li key={m.id} className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-text">
            <span className="mb-0.5 flex items-center gap-1 text-[11px] text-warning">
              <StickyNote aria-hidden="true" className="h-3 w-3" />
              Note · {m.userName ?? "Somebody"} · only the team sees this
            </span>
            <p className="whitespace-pre-wrap break-words">{m.body}</p>
            <span className="mt-0.5 block text-right text-[10px] text-subtle">{time(m.at)}</span>
          </div>
        </li>
      );
    }
    const ours = m.author !== "CUSTOMER";
    return (
      <li key={m.id} className={cn("flex", ours ? "justify-end" : "justify-start")}>
        <div className={cn("max-w-[80%] rounded-2xl px-3 py-2 text-sm", ours ? (m.author === "BOT" ? "bg-surface-sunken text-text" : "bg-brand text-brand-contrast") : "border border-line bg-surface text-text")}>
          {ours && (
            <span className={cn("mb-0.5 flex items-center gap-1 text-[11px]", m.author === "BOT" ? "text-muted" : "text-brand-contrast/80")}>
              {m.author === "BOT" ? <Bot aria-hidden="true" className="h-3 w-3" /> : null}
              {m.author === "BOT" ? (detail?.channel.assistantName ?? "Bot") : (m.userName ?? "Us")}
            </span>
          )}
          <p className="whitespace-pre-wrap break-words">{m.body}</p>
          {m.media && media(m.id, m.media)}
          <span className={cn("mt-0.5 flex items-center justify-end gap-1 text-[10px]", ours && m.author !== "BOT" ? "text-brand-contrast/70" : "text-subtle")}>
            {time(m.at)}
            {ours && m.delivery === "SENT" && <Check aria-label="Sent" className="h-3 w-3" />}
            {ours && m.delivery === "DELIVERED" && <CheckCheck aria-label="Delivered" className="h-3 w-3" />}
            {ours && m.delivery === "READ" && <CheckCheck aria-label="Read" className="h-3 w-3 text-sky-300" />}
          </span>
          {m.delivery === "FAILED" && <span className="mt-1 block text-[11px] font-medium text-danger">Not delivered{m.error ? `: ${m.error}` : ""}</span>}
        </div>
      </li>
    );
  };

  // ─── The conversation ──────────────────────────────────────────────────────────────────────────
  const thread = detail ? (
    <section aria-label={`Conversation with ${detail.customer}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <button type="button" className="rounded p-1 text-muted hover:text-text md:hidden" aria-label="Back to the list" onClick={() => setDetail(null)}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <KindIcon kind={detail.kind} className="h-4 w-4 text-muted" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-text">{detail.customer}</h2>
          <p className="truncate text-xs text-muted">
            {detail.ref} · {detail.channelName}
            {detail.status === "CLOSED" ? " · closed" : ""}
          </p>
        </div>
        <button
          type="button"
          className="rounded p-1.5 text-muted hover:bg-surface-sunken hover:text-text lg:hidden"
          aria-label="About this customer"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((on) => !on)}
        >
          <Info aria-hidden="true" className="h-4 w-4" />
        </button>
        {detail.status === "OPEN" ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => inboxSetStatus(detail.id, "CLOSED"))}>
            Close
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => inboxSetStatus(detail.id, "OPEN"))}>
            Reopen
          </Button>
        )}
      </header>
      {others.length > 0 && (
        <p role="status" className="border-b border-line bg-warning-bg px-3 py-1.5 text-xs font-medium text-warning">
          {(() => {
            const replying = others.filter((o) => o.replying).map((o) => o.name);
            const names = (list: string[]) => (list.length <= 2 ? list.join(" and ") : `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`);
            if (replying.length) return `${names(replying)} ${replying.length === 1 ? "is" : "are"} already replying — check before you answer.`;
            const looking = others.map((o) => o.name);
            return `${names(looking)} ${looking.length === 1 ? "has" : "have"} this open too.`;
          })()}
        </p>
      )}
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-surface-sunken/40 px-3 py-4">
        {detail.messages.map(message)}
        {peek?.typing && (
          <li className="flex justify-start" aria-live="polite">
            <div className="max-w-[80%] rounded-2xl border border-dashed border-line-strong bg-surface px-3 py-2 text-sm italic text-muted">
              <span className="mb-0.5 block text-[11px] not-italic text-subtle">{peek.text ? "Typing — not sent yet" : "Typing…"}</span>
              {peek.text && <p className="whitespace-pre-wrap break-words">{peek.text}</p>}
            </div>
          </li>
        )}
        <div ref={threadEnd} />
      </ol>
      {(error || notice) && (
        <p role={error ? "alert" : "status"} className={cn("border-t border-line px-3 py-2 text-xs", error ? "bg-danger-bg text-danger" : "bg-success-bg text-success")}>
          {error ?? notice}
        </p>
      )}
      {detail.botActive && mode === "reply" && <p className="border-t border-line bg-info-bg px-3 py-1.5 text-xs text-info">The bot is answering. Reply and it steps aside.</p>}
      {detail.blocked && (
        <p className="flex items-center justify-between gap-2 border-t border-line bg-danger-bg px-3 py-1.5 text-xs text-danger">
          <span>Blocked — nothing they send comes in.</span>
          <button type="button" className="font-medium underline underline-offset-2" disabled={pending} onClick={() => act(() => inboxUnblock(detail.id))}>
            Unblock
          </button>
        </p>
      )}
      <div role="tablist" aria-label="Write" className="flex gap-1 border-t border-line px-3 pt-2">
        {(
          [
            ["reply", "Reply"],
            ["note", "Note"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => {
              setMode(value);
              setPickIndex(0);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium",
              mode === value ? (value === "note" ? "bg-warning-bg text-warning" : "bg-brand-subtle text-brand") : "text-muted hover:text-text",
            )}
          >
            {value === "note" && <StickyNote aria-hidden="true" className="h-3 w-3" />}
            {label}
          </button>
        ))}
      </div>
      {mode === "note" || detail.windowOpen ? (
        <form
          className="relative flex items-end gap-2 p-3 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          {picks.length > 0 && (
            <ul role="listbox" aria-label={slash.length ? "Saved replies" : "Colleagues"} className="absolute bottom-full left-3 right-3 z-10 mb-1 max-h-56 overflow-y-auto rounded-base border border-line bg-surface py-1 shadow-lg">
              {picks.map((p, i) => (
                <li key={p.key} role="option" aria-selected={i === pick}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      p.use();
                      setPickIndex(0);
                    }}
                    className={cn("flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm", i === pick ? "bg-brand-subtle" : "hover:bg-surface-sunken")}
                  >
                    <span className="font-medium text-text">{p.label}</span>
                    {p.hint && <span className="truncate text-xs text-muted">{p.hint}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {mode === "reply" && detail.channel.files.team && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept={FILE_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) sendFile(file);
                }}
              />
              <Button type="button" variant="ghost" size="sm" disabled={pending} aria-label="Send a photo or file" title="Send a photo or file (up to 5 MB) — what you've typed goes with it" onClick={() => fileInput.current?.click()}>
                <Paperclip aria-hidden="true" className="h-4 w-4" />
              </Button>
            </>
          )}
          <Textarea
            aria-label={mode === "note" ? "Note for the team" : "Reply"}
            rows={2}
            value={draft}
            maxLength={mode === "note" ? TEAM_LIMITS.note : 2000}
            placeholder={
              mode === "note"
                ? "A note only your team sees — type @ and a name to tell them"
                : `${detail.kind === "WHATSAPP" ? "Reply on WhatsApp" : "Reply in the website chat"}${savedReplies.length ? " — type / for a saved reply" : ""}`
            }
            onChange={(e) => {
              setDraft(e.target.value);
              setPickIndex(0);
              // The customer sees "typing…" — told no more than every three seconds while the keys move. Never for a note.
              const now = Date.now();
              if (mode === "reply" && e.target.value.trim() && !e.target.value.startsWith("/") && now - lastTyping.current > 3_000) {
                lastTyping.current = now;
                void inboxTyping(detail.id).catch(() => {});
              }
            }}
            onKeyDown={(e) => {
              if (picks.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setPickIndex((i) => (i + (e.key === "ArrowDown" ? 1 : picks.length - 1)) % picks.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  picks[pick]!.use();
                  setPickIndex(0);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            className={cn("min-h-0 flex-1 resize-none", mode === "note" && "bg-warning-bg/40")}
          />
          <Button type="submit" disabled={pending || !draft.trim()}>
            {mode === "note" ? "Add note" : "Send"}
          </Button>
        </form>
      ) : (
        <form
          className="space-y-2 p-3 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            sendTemplate();
          }}
        >
          <p className="text-xs text-muted">It&apos;s over 24 hours since they last wrote, so WhatsApp only takes an approved template now.</p>
          <div className="grid gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
            <div>
              <Label htmlFor="inbox-template">Template name</Label>
              <Input id="inbox-template" className="mt-1" value={template.name} onChange={(e) => setTemplate((t) => ({ ...t, name: e.target.value }))} placeholder="order_update" />
            </div>
            <div>
              <Label htmlFor="inbox-template-values">Its values, one a line</Label>
              <Textarea id="inbox-template-values" className="mt-1 min-h-0" rows={2} value={template.values} onChange={(e) => setTemplate((t) => ({ ...t, values: e.target.value }))} />
            </div>
            <Button type="submit" disabled={pending || !template.name.trim()}>
              Send template
            </Button>
          </div>
        </form>
      )}
    </section>
  ) : (
    <section className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted md:flex">
      <MessageSquareMore aria-hidden="true" className="h-8 w-8 text-subtle" />
      <p>Choose a conversation.</p>
    </section>
  );

  // ─── Who they are ──────────────────────────────────────────────────────────────────────────────
  // Who they are first, then who has it and what to do, then what's known; the rarely used at the foot.
  // Beside the conversation on a wide screen; below that, opened over it from the header's ⓘ.
  const assignedId = detail?.assignedTo?.id ?? "";
  const heading = "mb-2 text-[11px] font-semibold uppercase tracking-wider text-subtle";
  const fact = (Icon: typeof Globe, label: string, value: ReactNode, extra?: string) => (
    <div className="flex items-start gap-2">
      <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
      <dt className="sr-only">{label}</dt>
      <dd className={cn("min-w-0 break-words text-text", extra)}>{value}</dd>
    </div>
  );
  const details = detail && (
    <aside
      aria-label="About this customer"
      className={cn(
        "flex-col divide-y divide-line overflow-y-auto border-l border-line bg-surface text-sm",
        showDetails ? "absolute inset-y-0 right-0 z-20 flex w-80 max-w-[90%] shadow-xl" : "hidden",
        "lg:static lg:z-auto lg:flex lg:w-72 lg:max-w-none lg:shrink-0 lg:shadow-none",
      )}
    >
      <div className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <span className={cn("relative grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold", detail.kind === "WHATSAPP" ? "bg-success-bg text-success" : "bg-info-bg text-info")}>
            {initialsOf(detail.customerName) ?? <KindIcon kind={detail.kind} className="h-4 w-4" />}
            {detail.online && <span aria-label="Online now" className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface bg-success" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-text" title={detail.customer}>
              {detail.customer}
            </p>
            <p className="truncate text-xs text-muted">
              {detail.channel.kind === "WHATSAPP" ? `WhatsApp${detail.channel.displayPhone ? ` · ${detail.channel.displayPhone}` : ""}` : detail.channel.name}
            </p>
          </div>
          <button type="button" className="rounded p-1 text-muted hover:text-text lg:hidden" aria-label="Close the details" onClick={() => setShowDetails(false)}>
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", detail.isNew ? "bg-info-bg text-info" : "bg-surface-sunken text-text")}>
            {detail.isNew ? "New visitor" : detail.visits > 1 ? `Returning · ${ordinal(detail.visits)} visit` : "Returning"}
          </span>
          {detail.previousConversations > 0 && (
            <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-text">
              {detail.previousConversations} earlier {detail.previousConversations === 1 ? "chat" : "chats"}
            </span>
          )}
          {detail.company && <span className="rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-medium text-success">Known customer</span>}
          {detail.rating && (
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", detail.rating === "GOOD" ? "bg-success-bg text-success" : "bg-danger-bg text-danger")} title={detail.ratingComment ? `“${detail.ratingComment}”` : undefined}>
              {detail.rating === "GOOD" ? "👍 Rated good" : "👎 Rated not good"}
            </span>
          )}
          {detail.blocked && <span className="rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-medium text-danger">Blocked</span>}
        </div>
        {detail.rating && detail.ratingComment && <p className="rounded-base bg-surface-sunken px-2.5 py-1.5 text-xs italic text-muted">“{detail.ratingComment}”</p>}
        {((canMakeLead && !detail.lead) || (canMakeTicket && !detail.ticket && ticketTitle === null)) && (
          <div className="grid grid-cols-2 gap-2">
            {canMakeLead && !detail.lead && (
              <Button size="sm" variant="secondary" className="w-full px-2" disabled={pending} onClick={() => act(async () => inboxMakeLead(detail.id), undefined, "Lead made.")}>
                <UserPlus aria-hidden="true" className="mr-1 h-3.5 w-3.5 shrink-0" />
                Make lead
              </Button>
            )}
            {canMakeTicket && !detail.ticket && ticketTitle === null && (
              <Button size="sm" variant="secondary" className="w-full px-2" disabled={pending} onClick={() => setTicketTitle(detail.messages.find((m) => m.author === "CUSTOMER")?.body.slice(0, 80) ?? "")}>
                <Ticket aria-hidden="true" className="mr-1 h-3.5 w-3.5 shrink-0" />
                Make ticket
              </Button>
            )}
          </div>
        )}
        {ticketTitle !== null && (
          <form
            className="space-y-2 rounded-base border border-line p-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(async () => inboxMakeTicket(detail.id, ticketTitle), () => setTicketTitle(null), "Ticket made.");
            }}
          >
            <Label htmlFor="inbox-ticket-title">Ticket title</Label>
            <Input id="inbox-ticket-title" value={ticketTitle} maxLength={200} onChange={(e) => setTicketTitle(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={pending || ticketTitle.trim().length < 2}>
                Make the ticket
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setTicketTitle(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>

      <div className="p-4">
        <h3 className={heading}>Who has it</h3>
        <div className="flex gap-2">
          <SearchSelect aria-label="Who has it" value={assignedId} disabled={pending} onChange={(e) => act(() => inboxAssign(detail.id, e.target.value || null))} className="h-8 min-w-0 flex-1 text-sm" searchPlaceholder="Search people…">
            <option value="">In the queue</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === meId ? `${p.name} (you)` : p.name}
              </option>
            ))}
          </SearchSelect>
          {assignedId !== meId && (
            <Button size="sm" variant="subtle" className="shrink-0" disabled={pending} onClick={() => act(() => inboxAssign(detail.id, meId))}>
              Take it
            </Button>
          )}
        </div>
      </div>

      {(detail.customerPhone || detail.customerEmail || detail.customerCompany || detail.pageUrl) && (
        <div className="p-4">
          <h3 className={heading}>Contact</h3>
          <dl className="space-y-1.5 text-xs">
            {detail.customerCompany && fact(Building2, "Company", detail.customerCompany, "font-medium")}
            {/* Masked for this person (owner, 5 Nov 2026 — src/lib/inbox/server.ts `customerAsSeen`): text, nothing to call or write to. */}
            {detail.customerPhone &&
              fact(
                Phone,
                "Phone",
                detail.customerMasked?.phone ? (
                  <span>{detail.customerPhone}</span>
                ) : (
                  <a href={`tel:${detail.customerPhone.replace(/[^\d+]/g, "")}`} className="hover:text-brand hover:underline">
                    {detail.customerPhone}
                  </a>
                ),
              )}
            {detail.customerEmail &&
              fact(
                Mail,
                "Email",
                detail.customerMasked?.email ? (
                  <span className="break-all">{detail.customerEmail}</span>
                ) : (
                  <a href={`mailto:${detail.customerEmail}`} className="break-all hover:text-brand hover:underline">
                    {detail.customerEmail}
                  </a>
                ),
              )}
            {detail.pageUrl &&
              fact(
                Link2,
                "Started on",
                <span title={detail.pageUrl}>
                  <span className="text-muted">Started on </span>
                  {shortUrl(detail.pageUrl)}
                </span>,
              )}
          </dl>
        </div>
      )}

      {detail.visitor && (
        <div className="p-4">
          <h3 className={heading}>{detail.kind === "WEB" ? "Visitor" : "Where"}</h3>
          <dl className="space-y-1.5 text-xs">
            {detail.kind === "WEB" && (
              <div className="flex items-start gap-2">
                <span aria-hidden="true" className="grid h-3.5 w-3.5 shrink-0 place-items-center pt-0.5">
                  <span className={cn("h-2 w-2 rounded-full", detail.visitor.online ? "bg-success" : "bg-line-strong")} />
                </span>
                <dt className="sr-only">Online</dt>
                <dd className="min-w-0 text-text">
                  {detail.visitor.online ? "Online now" : detail.visitor.lastSeenAt ? `Last seen ${time(detail.visitor.lastSeenAt)}` : "Not seen since they wrote"}
                  {detail.visitor.online && detail.visitor.currentPage && <span className="text-muted"> · on {detail.visitor.currentPage}</span>}
                </dd>
              </div>
            )}
            {detail.visitor.place && fact(MapPin, "Where", detail.visitor.place)}
            {detail.visitor.timezone &&
              fact(
                Clock,
                "Their time",
                <span suppressHydrationWarning>
                  {localTime(detail.visitor.timezone)} <span className="text-muted">their time</span>
                </span>,
              )}
            {detail.visitor.device && fact(Monitor, "Device", detail.visitor.device)}
            {detail.visitor.language && fact(Languages, "Language", languageName(detail.visitor.language))}
          </dl>
          {detail.visitor.pages.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] font-medium text-subtle">Pages they were on</p>
              <ol className="relative ml-1 space-y-1.5 border-l border-line pl-3 text-xs">
                {detail.visitor.pages.map((p, i) => (
                  <li key={`${p.path}-${i}`} className="relative flex justify-between gap-2">
                    <span aria-hidden="true" className={cn("absolute -left-[16.5px] top-1.5 h-2 w-2 rounded-full border-2 border-surface", i === 0 ? "bg-brand" : "bg-line-strong")} />
                    <span className="truncate text-text" title={p.path}>
                      {p.path}
                    </span>
                    <span className="shrink-0 text-subtle">{time(p.at)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {canSeeVisitors && detail.kind === "WEB" && <ConversationActivity conversationId={detail.id} heading={heading} />}

      <div className="p-4">
        <h3 className={heading}>Tags</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {detail.tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-0.5 rounded-full bg-brand-subtle py-0.5 pl-2 pr-0.5 text-xs font-medium text-brand">
              #{t}
              <button type="button" aria-label={`Remove ${t}`} disabled={pending} className="rounded-full p-0.5 opacity-70 hover:bg-surface hover:opacity-100" onClick={() => saveTags(detail.tags.filter((x) => x !== t))}>
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          ))}
          {detail.tags.length < TEAM_LIMITS.tags && (
            <form
              className="min-w-[7rem] flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                const added = normaliseTags([...detail.tags, ...tagDraft.split(",")]);
                if (added.length !== detail.tags.length) saveTags(added);
              }}
            >
              <input
                aria-label="Add a tag — press Enter"
                list="inbox-known-tags"
                placeholder={detail.tags.length ? "+ Add" : "+ Add a tag"}
                value={tagDraft}
                maxLength={TEAM_LIMITS.tag}
                disabled={pending}
                onChange={(e) => setTagDraft(e.target.value)}
                className="h-7 w-full rounded-full border border-dashed border-line-strong bg-transparent px-2.5 text-xs text-text placeholder:text-subtle focus:border-solid focus:border-brand focus:outline-none"
              />
              <datalist id="inbox-known-tags">
                {knownTags
                  .filter((t) => !detail.tags.includes(t))
                  .map((t) => (
                    <option key={t} value={t} />
                  ))}
              </datalist>
            </form>
          )}
        </div>
      </div>

      <div className="p-4">
        <h3 className={heading}>On file</h3>
        {detail.couldBe.length > 0 && (
          <div className="mb-2 space-y-1.5 rounded-base border border-warning/40 bg-warning-bg p-2.5 text-xs">
            <p className="text-text">
              {/* Security audit, 11 Nov 2026 (SEC-47): typed details are never linked on their own — the team confirms. */}
              Their {detail.customerEmail ? "email or number" : "number"} is on file for {detail.couldBe.length === 1 ? "a customer" : `${detail.couldBe.length} customers`}
              {detail.kind === "WEB" ? " — as they typed it, not checked" : ""}. {detail.couldBe.length === 1 ? "Is it them?" : "Which is it?"}
            </p>
            <ul className="space-y-1">
              {detail.couldBe.map((o) => (
                <li key={o.contactId} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-text" title={`${o.contactName} · ${o.companyName}`}>
                    <span className="font-medium">{o.companyName}</span>
                    <span className="text-muted"> · {o.contactName}</span>
                  </span>
                  <Button size="sm" variant="secondary" className="h-7 shrink-0 px-2 text-xs" disabled={pending} onClick={() => act(() => inboxLinkCustomer(detail.id, o.contactId), undefined, `Linked to ${o.companyName}.`)}>
                    This one
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-muted">No lead is made until you choose — or make one for somebody new.</p>
          </div>
        )}
        {detail.company || detail.lead || detail.ticket ? (
          <ul className="space-y-1.5 text-xs">
            {detail.company && (
              <li className="flex items-start justify-between gap-2">
                <CompanyLink href={companyPath(detail.company.companySeq)} className="min-w-0 font-medium text-brand hover:underline">
                  {detail.contact ? `${detail.contact.name} · ` : ""}
                  {detail.company.name}
                </CompanyLink>
                <button
                  type="button"
                  className="shrink-0 text-[11px] text-muted underline-offset-2 hover:text-text hover:underline"
                  disabled={pending}
                  title="Not this customer? Undo the link — the lead stays in Leads."
                  onClick={() => act(() => inboxUnlinkCustomer(detail.id), undefined, "Unlinked.")}
                >
                  Not them?
                </button>
              </li>
            )}
            {detail.lead && (
              <li>
                <Link href={`/leads/${detail.lead.reference}`} className="font-medium text-brand hover:underline">
                  Lead {detail.lead.reference}
                </Link>
              </li>
            )}
            {detail.ticket && (
              <li>
                <Link href={ticketPath(detail.ticket.ticketSeq)} className="font-medium text-brand hover:underline">
                  Its ticket
                </Link>
              </li>
            )}
          </ul>
        ) : (
          !detail.couldBe.length && (
            <p className="text-xs text-muted">
              {detail.kind === "WHATSAPP" ? "Not linked yet — it links itself once their number is on file." : "Not linked yet — once what they typed matches a customer on file, you'll be asked to confirm it."}
            </p>
          )
        )}
      </div>

      <div className="space-y-3 p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-subtle">Started</dt>
          <dd className="text-text">{time(detail.createdAt)}</dd>
          {detail.firstResponseAt && (
            <>
              <dt className="text-subtle">First reply</dt>
              <dd className="text-text">{time(detail.firstResponseAt)}</dd>
            </>
          )}
          <dt className="text-subtle">Channel</dt>
          <dd className="text-text">{detail.channel.shared ? "Shared" : "A rep's own number"}</dd>
        </dl>
        {detail.blocked ? (
          <button type="button" className="text-xs font-medium text-muted underline-offset-2 hover:text-text hover:underline" disabled={pending} onClick={() => act(() => inboxUnblock(detail.id), undefined, "Unblocked.")}>
            Unblock them
          </button>
        ) : blockReason === null ? (
          <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-danger/80 hover:text-danger" disabled={pending} onClick={() => setBlockReason("")}>
            <Ban aria-hidden="true" className="h-3.5 w-3.5" />
            Block {detail.kind === "WHATSAPP" ? "this number" : "this visitor"}
          </button>
        ) : (
          <form
            className="space-y-2 rounded-base border border-danger/40 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => inboxBlock(detail.id, blockReason), () => setBlockReason(null), "Blocked. Their messages won't come in, and it's closed.");
            }}
          >
            <p className="text-xs text-muted">
              {detail.kind === "WHATSAPP"
                ? "Messages from this number won't come in any more, and this conversation closes."
                : "This visitor's chat stops working on their browser, and this conversation closes. Somebody who clears their browser can start again."}
            </p>
            <Label htmlFor="inbox-block-reason">Why (for the team)</Label>
            <Input id="inbox-block-reason" value={blockReason} maxLength={TEAM_LIMITS.blockReason} placeholder="Spam" onChange={(e) => setBlockReason(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" type="submit" variant="danger" disabled={pending}>
                Block
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setBlockReason(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </aside>
  );

  return (
    <div className="relative flex h-[calc(100dvh-7.5rem)] min-h-[28rem] overflow-hidden rounded-xl border border-line bg-surface">
      {list}
      {tab === "visitors" ? (
        <VisitorDetail
          visitorId={visitorId}
          onBack={() => setVisitorId(null)}
          onOpenChat={(id) => {
            setTab("conversations");
            setVisitorId(null);
            setView("mine");
            open(id);
          }}
        />
      ) : (
        <>
          {thread}
          {details}
        </>
      )}
    </div>
  );
}
