"use client";

import { createContext, useContext, type ReactNode } from "react";
import { TeammateFace } from "@/components/ai/teammate-face";
import { teammatesWith, type Teammate, type TeammateKey } from "@/lib/ai/teammates";

/**
 * The AI teammates as people meet them (owner, 19 Nov 2026 — src/lib/ai/teammates.ts): the photo the workspace gave
 * them, else a drawn face in their colour — either way with an "AI" mark, so nobody takes one for a person; and their name
 * and role.
 * The workspace's own names come from the dashboard layout (`TeammatesProvider`); without one, the defaults.
 */

const TeammatesContext = createContext<Record<TeammateKey, Teammate> | null>(null);

export function TeammatesProvider({ teammates, children }: { teammates: Record<TeammateKey, Teammate>; children: ReactNode }) {
  return <TeammatesContext.Provider value={teammates}>{children}</TeammatesContext.Provider>;
}

const DEFAULTS = teammatesWith();

export function useTeammate(key: TeammateKey): Teammate {
  return (useContext(TeammatesContext) ?? DEFAULTS)[key];
}

const SIZES = { xs: 20, sm: 28, md: 36, lg: 48 } as const;

/** A teammate's face, with the "AI" mark from sm up. */
export function TeammateAvatar({ teammate: key, size = "sm", className = "" }: { teammate: TeammateKey; size?: keyof typeof SIZES; className?: string }) {
  const t = useTeammate(key);
  const px = SIZES[size];
  return (
    <span className={`relative inline-flex shrink-0 ${className}`} style={{ width: px, height: px }} title={`${t.name} — ${t.role} (AI)`}>
      {t.photo ? (
        // The workspace's own picture, from its address (src/app/api/teammates/[key]/photo) — checked on the way in.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={t.photo} alt={`${t.name}, AI ${t.role.toLowerCase()}`} width={px} height={px} className="rounded-full object-cover" style={{ boxShadow: `0 0 0 2px ${t.colour}` }} />
      ) : (
        <svg viewBox="0 0 40 40" width={px} height={px} role="img" aria-label={`${t.name}, AI ${t.role.toLowerCase()}`} className="overflow-hidden rounded-full">
          <circle cx="20" cy="20" r="20" fill={t.colour} />
          <TeammateFace look={t.look} />
        </svg>
      )}
      {size !== "xs" && (
        <span
          aria-hidden="true"
          className="absolute -bottom-0.5 -right-1 rounded-full border border-surface bg-text px-1 text-[8px] font-bold leading-[12px] tracking-wide text-surface"
        >
          AI
        </span>
      )}
    </span>
  );
}

/** Face, name and role in a line — the header of whatever the teammate did. */
export function TeammateChip({ teammate: key, size = "sm", showRole = true, className = "" }: { teammate: TeammateKey; size?: "xs" | "sm" | "md"; showRole?: boolean; className?: string }) {
  const t = useTeammate(key);
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      <TeammateAvatar teammate={key} size={size} />
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-semibold text-text">{t.name}</span>
        {showRole && <span className="block truncate text-xs text-muted">{t.role}</span>}
      </span>
    </span>
  );
}
