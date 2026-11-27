"use client";

import { useRouter } from "next/navigation";
import { Shield, User } from "lucide-react";
import { confirmAction } from "@/components/ui/confirm";
import { acInput } from "@/components/access-control/ui";
import type { Subject } from "@/components/access-control/scope/reach";
import { cn } from "@/lib/utils";

export type RoleOption = { key: string; name: string };
export type PersonOption = { id: string; name: string; roleKey: string; roleName: string };

/**
 * Who the screen is about: Role or Employee, then which one — the design's subject strip.
 *
 * The subject lives in the URL (`?role=` / `?user=`), so the page reads that subject's real answers
 * on the server; switching while changes are staged asks before dropping them.
 */
export function SubjectBar({
  subject,
  roles,
  people,
  hrefFor,
  staged,
  meta,
  children,
}: {
  subject: Subject;
  roles: RoleOption[];
  people: PersonOption[];
  hrefFor: (subject: { role?: string; user?: string }) => string;
  /** Changes staged on the screen, dropped by switching. */
  staged: number;
  /** A line about the subject, beside the picker. */
  meta?: string;
  /** The legend, pushed right. */
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const isRole = subject.type === "role";

  const go = async (href: string) => {
    if (staged > 0) {
      const ok = await confirmAction({
        title: "Discard staged changes?",
        message: `${staged} unsaved change${staged === 1 ? "" : "s"} on this screen will be dropped.`,
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    router.push(href);
  };

  const toRole = () => {
    if (isRole) return;
    void go(hrefFor({ role: subject.roleKey }));
  };
  const toEmployee = () => {
    if (!isRole) return;
    // Somebody who holds the role being looked at, where there is one.
    const first = people.find((p) => p.roleKey === subject.key) ?? people[0];
    if (first) void go(hrefFor({ user: first.id }));
  };

  const seg = (on: boolean) => cn("inline-flex h-[30px] items-center gap-1.5 px-2.5 text-xs font-semibold transition-colors", on ? "bg-brand-subtle text-brand" : "bg-surface text-text/80 hover:bg-surface-sunken");

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="inline-flex overflow-hidden rounded-md border border-line-strong" role="group" aria-label="Subject type">
        <button type="button" className={seg(isRole)} aria-pressed={isRole} onClick={toRole}>
          <Shield className="h-4 w-4" aria-hidden />
          Role
        </button>
        <button type="button" className={cn(seg(!isRole), "border-l border-line-strong")} aria-pressed={!isRole} onClick={toEmployee} disabled={people.length === 0}>
          <User className="h-4 w-4" aria-hidden />
          Employee
        </button>
      </div>
      <select
        aria-label={isRole ? "Role" : "Employee"}
        className={cn(acInput, "min-w-[200px] px-2 font-semibold")}
        value={isRole ? subject.key : subject.id}
        onChange={(e) => void go(hrefFor(isRole ? { role: e.target.value } : { user: e.target.value }))}
      >
        {isRole
          ? roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))
          : people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.roleName}
              </option>
            ))}
      </select>
      {meta && <span className="text-xs text-muted">{meta}</span>}
      <div className="flex-1" />
      {children}
    </div>
  );
}
