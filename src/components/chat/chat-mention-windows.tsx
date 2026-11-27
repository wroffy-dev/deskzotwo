"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AtSign, CircleAlert, Maximize2, Minus, X } from "lucide-react";
import { ChatApp } from "@/components/chat/chat-app";
import { useChatEvents, useChatLive } from "@/components/chat/chat-live";
import { LAYER_CORNER } from "@/components/ui/layers";
import { cn } from "@/lib/utils";

/**
 * A chat that @mentions you opens by itself, in a window in the corner of whatever page you are on — as
 * Gmail opens a message being written (owner, 28 Oct 2026) — and so does a priority message, one starting
 * with "!", in a direct chat or a group (src/lib/chat/rules.ts isPriority). Any other message still just
 * counts and chimes (src/components/chat/chat-live.tsx).
 *
 * Not over the chat screen, which already shows the message in its list, and not for the chat already in
 * front of you. A window can be shrunk to its title, opened in Chat, or closed; a new mention in a shrunk
 * one opens it again. Up to three side by side — fewer where the screen is narrower — the oldest giving way.
 * A shrunk window shows no messages, so it marks nothing read.
 */

type ChatWindow = { chatId: string; messageId: string; title: string; minimized: boolean; why: "mention" | "priority" };

const MAX_WINDOWS = 3;

export function ChatMentionWindows() {
  const live = useChatLive();
  const router = useRouter();
  const pathname = usePathname();
  const [windows, setWindows] = useState<ChatWindow[]>([]);

  useChatEvents((event) => {
    if (event.type !== "message" || !(event.mentioned || event.priority) || !live) return;
    const why: ChatWindow["why"] = event.mentioned ? "mention" : "priority";
    const m = event.message;
    if (m.kind !== "TEXT" || m.senderId === live.meId) return;
    if (pathname === "/chat") return;
    const viewing = live.viewingChat();
    setWindows((list) => {
      const open = list.find((w) => w.chatId === m.chatId);
      // Already open: it shows the message as it arrives. Shrunk: opened again.
      if (open) return list.map((w) => (w.chatId === m.chatId ? { ...w, minimized: false, why } : w));
      // In front of you already, in the rail's panel.
      if (viewing === m.chatId) return list;
      const title = event.chatTitle || m.senderName || "Chat";
      return [...list, { chatId: m.chatId, messageId: m.id, title, minimized: false, why }].slice(-MAX_WINDOWS);
    });
  });

  if (!live || windows.length === 0 || pathname === "/chat") return null;

  const close = (chatId: string) => setWindows((list) => list.filter((w) => w.chatId !== chatId));
  const toggle = (chatId: string) => setWindows((list) => list.map((w) => (w.chatId === chatId ? { ...w, minimized: !w.minimized } : w)));
  const expand = (w: ChatWindow) => {
    close(w.chatId);
    router.push(`/chat?c=${encodeURIComponent(w.chatId)}&m=${encodeURIComponent(w.messageId)}`);
  };

  return (
    <div className={cn("pointer-events-none fixed inset-x-2 bottom-[var(--app-tab-bar,0px)] flex flex-row-reverse items-end gap-3 sm:inset-x-auto sm:right-4 md:bottom-0 xl:right-16", LAYER_CORNER)}>
      {[...windows].reverse().map((w, i) => {
        const controls = (
          <span className="flex shrink-0 items-center">
            <WindowButton label={w.minimized ? `Open ${w.title}` : `Shrink ${w.title}`} onClick={() => toggle(w.chatId)}>
              <Minus className="h-4 w-4" />
            </WindowButton>
            <WindowButton label="Open in Chat" onClick={() => expand(w)}>
              <Maximize2 className="h-3.5 w-3.5" />
            </WindowButton>
            <WindowButton label={`Close ${w.title}`} onClick={() => close(w.chatId)}>
              <X className="h-4 w-4" />
            </WindowButton>
          </span>
        );
        return (
          <section
            key={w.chatId}
            aria-label={`${w.title} — ${w.why === "mention" ? "you were mentioned" : "an important message"}`}
            className={cn(
              "pointer-events-auto flex w-full flex-col overflow-hidden rounded-t-xl border border-b-0 border-line bg-surface shadow-2xl sm:w-[360px]",
              // The newest first, from the right; the older ones only where there is room for them.
              i === 1 && "hidden md:flex",
              i === 2 && "hidden xl:flex",
              w.minimized ? "h-auto" : "h-[min(520px,calc(100dvh-5rem))]",
            )}
          >
            {w.minimized ? (
              <div className="flex h-11 items-center gap-2 bg-surface-sunken pl-3 pr-1">
                <button type="button" onClick={() => toggle(w.chatId)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  {w.why === "mention" ? <AtSign className="h-4 w-4 shrink-0 text-brand" /> : <CircleAlert className="h-4 w-4 shrink-0 text-danger" />}
                  <span className="truncate text-sm font-medium text-text">{w.title}</span>
                </button>
                {controls}
              </div>
            ) : (
              <ChatApp compact initialChatId={w.chatId} initialMessageId={w.messageId} controls={controls} />
            )}
          </section>
        );
      })}
    </div>
  );
}

function WindowButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="grid h-8 w-8 place-items-center rounded-base text-muted hover:bg-surface-sunken hover:text-text">
      {children}
    </button>
  );
}
