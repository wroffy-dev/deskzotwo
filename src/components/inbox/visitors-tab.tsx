"use client";

import { useEffect, useState, useTransition } from "react";
import { ArrowLeft, Globe, Laptop, MessageSquarePlus, Smartphone, Tablet } from "lucide-react";
import { inboxConversationActivity, inboxStartVisitorChat, inboxVisitorDetail, inboxVisitors } from "@/actions/inbox-visitors";
import { Facts, JourneyList, whereOf, type Journey, type VisitorFacts } from "@/components/inbox/web-activity";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { onSiteNow } from "@/lib/inbox/activity-rules";
import { cn } from "@/lib/utils";

/**
 * The Customer inbox's Visitors tab (owner, 7 Nov 2026, after tawk.to): who's on the website now, then who was — each
 * opened to how they were seen and their journey, with a chat to start while they're here. Only visitors who agreed to
 * being remembered are in it. And the same facts beside a chat.
 */

type Listed = Awaited<ReturnType<typeof inboxVisitors>>;
type Row = Listed["visitors"][number];

const ASK_EVERY_MS = 15_000;

function nameOf(v: { contact: { name: string } | null; conversation: { contact: { name: string } | null; customerName: string | null } | null }): string | null {
  return v.contact?.name ?? v.conversation?.contact?.name ?? v.conversation?.customerName ?? null;
}

function companyOf(v: { contact: { company: { name: string } } | null; conversation: { contact: { company: { name: string } } | null; customerCompany: string | null } | null }): string | null {
  return v.contact?.company.name ?? v.conversation?.contact?.company.name ?? v.conversation?.customerCompany ?? null;
}

function DeviceIcon({ kind }: { kind: string | null }) {
  const Icon = kind === "phone" ? Smartphone : kind === "tablet" ? Tablet : Laptop;
  return <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />;
}

/** The list on the left, asked for again every 15 seconds while the tab is showing. */
export function VisitorList({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const clock = useClock();
  const [knownOnly, setKnownOnly] = useState(false);
  const [listed, setListed] = useState<Listed | null>(null);

  useEffect(() => {
    let live = true;
    const ask = () => {
      if (document.visibilityState !== "visible") return;
      void inboxVisitors({ knownOnly }).then((next) => {
        if (live) setListed(next);
      });
    };
    ask();
    const t = setInterval(ask, ASK_EVERY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [knownOnly]);

  const rows: Row[] = listed?.visitors ?? [];
  const here = rows.filter((v) => onSiteNow(v.lastSeenAt)).length;
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 pb-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", here ? "bg-success" : "bg-line-strong")} />
          {here} on the site now
        </span>
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={knownOnly} onChange={(e) => setKnownOnly(e.target.checked)} />
          Known only{listed ? ` (${listed.identified})` : ""}
        </label>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {listed && rows.length === 0 && (
          <li className="px-4 py-10 text-center text-sm text-muted">
            {knownOnly ? "Nobody known yet: they become known when they chat, send a form or click a campaign email." : "No visitors yet. Switch on Website activity on a website channel in the inbox's settings."}
          </li>
        )}
        {rows.map((v) => {
          const online = onSiteNow(v.lastSeenAt);
          const name = nameOf(v);
          const company = companyOf(v);
          return (
            <li key={v.id}>
              <button type="button" onClick={() => onSelect(v.id)} aria-current={selected === v.id ? "true" : undefined} className={cn("block w-full border-b border-line px-3 py-2.5 text-left hover:bg-surface-sunken", selected === v.id && "bg-brand-subtle")}>
                <span className="flex items-center gap-2">
                  <span aria-label={online ? "On the site now" : "Left"} className={cn("h-2 w-2 shrink-0 rounded-full", online ? "bg-success" : "bg-line-strong")} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{name ?? "Anonymous visitor"}</span>
                  <DeviceIcon kind={v.deviceKind} />
                </span>
                {company && <span className="ml-4 block truncate text-xs text-muted">{company}</span>}
                <span className="ml-4 block truncate text-xs text-muted">{[v.lastPath, whereOf(v)].filter(Boolean).join(" · ")}</span>
                <span className="ml-4 block text-[11px] text-subtle" suppressHydrationWarning>
                  {online ? "On the site now" : clock.dateTimeShort(v.lastSeenAt)} · {v.visits} visit{v.visits === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

type Detail = NonNullable<Awaited<ReturnType<typeof inboxVisitorDetail>>>;

/** The middle of the screen: one visitor, their journey, and a chat to start while they're here. */
export function VisitorDetail({ visitorId, onBack, onOpenChat }: { visitorId: string | null; onBack: () => void; onOpenChat: (conversationId: string) => void }) {
  const clock = useClock();
  const [shown, setShown] = useState<Detail | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!visitorId) return;
    let live = true;
    const ask = () => {
      if (document.visibilityState !== "visible") return;
      void inboxVisitorDetail(visitorId).then((next) => {
        if (live) setShown(next);
      });
    };
    ask();
    const t = setInterval(ask, ASK_EVERY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [visitorId]);

  if (!visitorId || !shown || shown.id !== visitorId) {
    return (
      <section className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted md:flex">
        <Globe aria-hidden="true" className="h-8 w-8 text-subtle" />
        <p>{visitorId ? "Loading…" : "Choose a visitor."}</p>
      </section>
    );
  }

  const online = onSiteNow(shown.lastSeenAt);
  const send = () =>
    start(async () => {
      setError(null);
      const result = await inboxStartVisitorChat(shown.id, draft);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft("");
      onOpenChat(result.data.id);
    });

  return (
    <section aria-label="Visitor" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <button type="button" onClick={onBack} aria-label="Back to the visitors" className="rounded p-1 text-muted hover:text-text md:hidden">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-text">{nameOf(shown) ?? "Anonymous visitor"}</h2>
          <p className="truncate text-xs text-muted" suppressHydrationWarning>
            {[companyOf(shown), online ? "On the site now" : `Last seen ${clock.dateTimeShort(shown.lastSeenAt)}`, `${shown.visits} visit${shown.visits === 1 ? "" : "s"}`, `${shown.pageCount} page${shown.pageCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
          </p>
        </div>
        {shown.conversationId && (
          <Button type="button" size="sm" variant="secondary" onClick={() => onOpenChat(shown.conversationId!)}>
            Their chat
          </Button>
        )}
      </div>
      <div className="space-y-4 p-4">
        {online ? (
          <div className="space-y-2 rounded-base border border-line p-3">
            <p className="text-xs font-medium text-text">Start a chat</p>
            <Textarea rows={2} maxLength={1000} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Hi! Can I help you with anything?" aria-label="Your first message" />
            <p className="text-[11px] text-muted">It appears beside the chat bubble on their screen within about 20 seconds, for them to open or dismiss.</p>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" disabled={pending || !draft.trim()} onClick={send}>
                <MessageSquarePlus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                {pending ? "Sending…" : "Start a chat"}
              </Button>
              {error && <p className="text-xs text-danger">{error}</p>}
            </div>
          </div>
        ) : (
          <p className="rounded-base bg-surface-sunken px-3 py-2 text-xs text-muted">They&apos;ve left the website. A chat can be started while they&apos;re on it.</p>
        )}
        <Facts v={shown as VisitorFacts} />
        <JourneyList journey={shown.journey as Journey} clock={clock} />
        <p className="text-[11px] text-subtle">
          Network and ISP are a best guess from the address, and a browser can&apos;t tell a laptop from a desktop. IP to ASN data by{" "}
          <a href="https://db-ip.com" target="_blank" rel="noreferrer" className="hover:underline">
            DB-IP
          </a>
          .
        </p>
      </div>
    </section>
  );
}

/** Beside a chat: how they were seen and where they went, when they agreed to being remembered. Nothing otherwise. */
export function ConversationActivity({ conversationId, heading }: { conversationId: string; heading: string }) {
  const clock = useClock();
  const [loaded, setLoaded] = useState<{ id: string; activity: Awaited<ReturnType<typeof inboxConversationActivity>> } | null>(null);

  useEffect(() => {
    let live = true;
    void inboxConversationActivity(conversationId).then((activity) => {
      if (live) setLoaded({ id: conversationId, activity });
    });
    return () => {
      live = false;
    };
  }, [conversationId]);

  const activity = loaded?.id === conversationId ? loaded.activity : null;
  if (!activity) return null;
  return (
    <div className="space-y-3 p-4">
      <h3 className={heading}>Website activity</h3>
      <Facts v={activity as VisitorFacts} oneColumn />
      <JourneyList journey={activity.journey as Journey} clock={clock} />
    </div>
  );
}
