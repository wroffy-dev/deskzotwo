"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setRoleLeadReach } from "@/actions/access-levels";
import { setPersonLeadReach } from "@/actions/person-access";
import { LEAD_REACH_KEYS, LEAD_REACH_LABEL, type LeadReachKey, type LeadReachView } from "@/lib/authz/lead-reach-words";
import type { Subject } from "@/components/access-control/scope/reach";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const MEANS: Record<LeadReachKey, string> = {
  owned: "And their team's, even on a customer they can't see.",
  made: "And their team's, after handing them on.",
};

/**
 * Under Leads "as the account" (owner, 26 Nov 2026): whether the role's people — or this person — also see and work the
 * leads they own and the leads they made (src/lib/authz/lead-reach.ts). Saved as it is ticked; for a person, a tick is
 * their own over their role's, and "Follow role" takes it away.
 */
export function LeadReachBox({ subject, view, locked }: { subject: Subject; view: LeadReachView; locked: boolean }) {
  const router = useRouter();
  const [saving, start] = useTransition();
  const [shown, setShown] = useState(view.effective);
  const isUser = subject.type === "user";

  const save = (key: LeadReachKey, value: boolean | null) =>
    start(async () => {
      const next = { ...shown, [key]: value ?? view.role[key] };
      setShown(next);
      const result =
        subject.type === "role"
          ? await setRoleLeadReach(subject.key, { owned: next.owned, made: next.made })
          : await setPersonLeadReach(subject.id, { owned: view.own?.owned ?? null, made: view.own?.made ?? null, [key]: value });
      if (!result.ok) {
        setShown(view.effective);
        toast.error(result.error);
        return;
      }
      toast.success(`${LEAD_REACH_LABEL[key]} ${next[key] ? "on" : "off"}${isUser ? ` for ${subject.name}` : ""}`);
      router.refresh();
    });

  return (
    <div className="mx-[18px] mb-4 rounded-lg border border-brand/40 bg-brand-subtle/50 px-3.5 py-3" role="group" aria-label="With As the account, also show">
      <div className="mb-2 text-[13px] font-semibold text-text">With &ldquo;As the account&rdquo;, also show</div>
      {LEAD_REACH_KEYS.map((key) => {
        const own = view.own?.[key] ?? null;
        return (
          <label key={key} className={cn("mb-2 flex items-start gap-2.5 text-[13px] last-of-type:mb-0", locked ? "cursor-not-allowed" : "cursor-pointer")}>
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
              checked={shown[key]}
              disabled={locked || saving}
              onChange={(e) => save(key, e.target.checked)}
            />
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-text">{LEAD_REACH_LABEL[key]}</span>
              {isUser && (
                <span className="ml-1.5 text-[11.5px] text-subtle">
                  {own === null ? "· from role" : "· their own"}
                  {own !== null && !locked && (
                    <button
                      type="button"
                      className="ml-1.5 font-medium text-brand hover:underline"
                      disabled={saving}
                      onClick={(e) => {
                        e.preventDefault();
                        save(key, null);
                      }}
                    >
                      Follow role ({view.role[key] ? "on" : "off"})
                    </button>
                  )}
                </span>
              )}
              <span className="block text-xs text-muted">{MEANS[key]}</span>
            </span>
          </label>
        );
      })}
      <p className="mt-2.5 border-t border-line/70 pt-2 text-[11.5px] text-muted">
        Applies to View and Edit. Delete and Assign stay with the customer&apos;s team. Both are on unless unticked.
      </p>
    </div>
  );
}
