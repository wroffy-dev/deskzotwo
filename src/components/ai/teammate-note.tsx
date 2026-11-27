"use client";

import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import type { TeammateKey } from "@/lib/ai/teammates";

/**
 * A note from an AI teammate, in the bell and the notifications list (owner, 19 Nov 2026 — phase 3): a notification the
 * teammate wrote in their own voice starts with their name and a colon — "Tara: I've drafted…" (`noteFrom`,
 * src/lib/ai/teammates.ts) — and gets their face beside it. Matched against the workspace's names for them as they are
 * now; anything else gets no face.
 */
export function TeammateNoteFace({ title, className = "" }: { title: string; className?: string }) {
  const names: [TeammateKey, string][] = [
    ["ved", useTeammate("ved").name],
    ["tara", useTeammate("tara").name],
    ["kabir", useTeammate("kabir").name],
    ["mira", useTeammate("mira").name],
  ];
  const from = names.find(([, name]) => title.startsWith(`${name}: `))?.[0];
  return from ? <TeammateAvatar teammate={from} size="xs" className={className} /> : null;
}
