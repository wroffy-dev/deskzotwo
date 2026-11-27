"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { TeammateAvatar } from "@/components/ai/teammate-avatar";
import type { Teammate } from "@/lib/ai/teammates";
import type { TeammateStatus, TeamStatus } from "@/lib/ai/teammate-switches";
import { switchTeammate } from "@/actions/ai-teammates";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

/**
 * Settings › AI teammates (owner, 23 Nov 2026 — "shows whether each teammate is working here, with a switch per
 * teammate"): Deskzo AI and its credits on top, then each teammate — working, can't work (and why, with where to put it
 * right) or switched off — with what they finished this month and the credits it cost. Everybody sees it; only an admin
 * gets the switches. Their names and photos are Deskzo's, set by country in the console.
 */

const n = (v: number) => v.toLocaleString("en-IN");

const STATE: Record<TeammateStatus["state"], { label: string; className: string }> = {
  working: { label: "Working", className: "bg-success-bg text-success" },
  blocked: { label: "Can't work", className: "bg-warning-bg text-warning" },
  off: { label: "Switched off", className: "bg-surface-sunken text-muted" },
};

export function AiTeammatesSettings({
  team,
  teammates,
  waiting,
  canManage,
}: {
  team: TeamStatus;
  teammates: Teammate[];
  waiting: number;
  canManage: boolean;
}) {
  const [statuses, setStatuses] = useState(team.teammates);
  const [pending, start] = useTransition();
  const working = statuses.filter((s) => s.state === "working").length;

  function flip(t: Teammate, on: boolean) {
    const before = statuses;
    // Shown at once; put back if the server says no. Switching on shows "Working" until the page reloads with the reason, if any.
    setStatuses((all) => all.map((s) => (s.key === t.key ? { ...s, on, state: on ? (s.reason ? "blocked" : "working") : "off" } : s)));
    start(async () => {
      const r = await switchTeammate(t.key, on);
      if (!r.ok) {
        setStatuses(before);
        toast.error(r.error);
        return;
      }
      toast.success(`${t.name} switched ${on ? "on" : "off"}`);
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Deskzo AI" value={team.paused ? "Paused" : team.aiOn ? "On" : "Off"} tone={team.paused || !team.aiOn ? "warning" : "success"} />
        <Tile label="Credits left" value={team.creditsLeft === null ? "No limit" : n(team.creditsLeft)} />
        <Tile label="Used this month" value={n(team.creditsUsed)} />
        <Tile label="Working" value={`${working} of ${statuses.length}`} />
      </div>

      {waiting > 0 && (
        <Link href="/today" className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
          {waiting === 1 ? "1 draft is" : `${n(waiting)} drafts are`} waiting for you <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}

      <Card className="divide-y divide-line p-0">
        {teammates.map((t) => {
          const s = statuses.find((x) => x.key === t.key);
          if (!s) return null;
          const state = STATE[s.state];
          return (
            <div key={t.key} className="flex gap-4 p-4">
              <TeammateAvatar teammate={t.key} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold text-text">
                  {t.name}
                  <span className="text-sm font-normal text-muted">{t.role}</span>
                  <span className={cn("rounded-md px-2 py-0.5 text-xs font-medium", state.className)}>{state.label}</span>
                </p>
                <p className="mt-0.5 text-sm text-text">{t.job}</p>
                <p className="mt-1 text-xs text-subtle">
                  {s.state === "blocked" && s.reason ? (
                    <>
                      <span className="text-warning">{s.reason}.</span>{" "}
                      {s.fix && (
                        <Link href={s.fix.href} className="font-medium text-brand hover:underline">
                          {s.fix.label}
                        </Link>
                      )}
                    </>
                  ) : s.state === "off" ? (
                    "Switched off by an admin: no AI work for them here. Nothing they did before is lost."
                  ) : s.done || s.credits ? (
                    `This month: ${n(s.done)} ${s.done === 1 ? "job" : "jobs"} done · ${n(s.credits)} ${s.credits === 1 ? "credit" : "credits"}`
                  ) : (
                    `Nothing yet this month. Where you meet them: ${t.where}.`
                  )}
                </p>
              </div>
              {canManage && (
                <Switch
                  checked={s.on}
                  onChange={(on) => flip(t, on)}
                  disabled={pending}
                  aria-label={`${s.on ? "Switch off" : "Switch on"} ${t.name}`}
                  className="mt-1"
                />
              )}
            </div>
          );
        })}
      </Card>

      <p className="text-xs text-subtle">
        {canManage
          ? "Switching a teammate off stops all their AI work here at once. What they do on their own — Tara's follow-ups, Arjun's morning chase list — is set in Settings › Deskzo AI."
          : "Only an admin can switch a teammate on or off."}
      </p>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" }) {
  return (
    <div className="rounded-lg bg-surface-sunken px-3 py-2.5">
      <p className="text-xs text-muted">{label}</p>
      <p className={cn("mt-0.5 text-lg font-semibold text-text", tone === "success" && "text-success", tone === "warning" && "text-warning")}>{value}</p>
    </div>
  );
}
