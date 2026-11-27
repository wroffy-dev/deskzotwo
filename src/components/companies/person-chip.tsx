import type { LucideIcon } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";

export type ChipPerson = { id: string; name: string; photoUpdatedAt?: Date | string | null };

/**
 * Who holds a role on a record — its account manager, renewal manager, caller — as their photo (initials without one),
 * the name on hover and read out (owner, 15 Nov 2026: "instead of name show photo, when hover show name"). Without
 * anybody: `empty` in words, so "Assign caller" still says what a click does.
 *
 * `person` faded (`standIn`): somebody filling the role for want of their own — the account manager on renewals.
 */
export function PersonChip({
  icon: Icon,
  title,
  person,
  empty,
  standIn = false,
  onClick,
  muted = false,
  label,
}: {
  /** The role in words beside the photo — "Account manager" — where the icon alone wouldn't say it (company header). */
  label?: string;
  icon: LucideIcon;
  /** The whole of it, for the tooltip and a screen reader: "Account manager: Sumit Sharma". */
  title: string;
  person: ChipPerson | null;
  empty: string;
  standIn?: boolean;
  onClick?: () => void;
  /** Shown to somebody who can't change it. */
  muted?: boolean;
}) {
  const body = (
    <>
      <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
      {label && person && <span className="text-muted">{label}</span>}
      {person ? (
        <Avatar user={person} size="sm" className={standIn ? "opacity-60" : undefined} />
      ) : (
        <span>{empty}</span>
      )}
    </>
  );
  // The height of the buttons beside it on the company page (owner, 15 Nov 2026: "increase the size").
  const shape = `inline-flex h-9 items-center gap-2 rounded-full bg-surface-sunken ${person ? "pl-3 pr-1" : "px-3.5"} text-sm font-medium`;
  if (!onClick) {
    return (
      <span className={`${shape} ${muted ? "text-muted" : "text-text"}`} title={title} aria-label={title} role="img">
        {body}
      </span>
    );
  }
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} className={`${shape} text-text transition-colors hover:bg-line`}>
      {body}
    </button>
  );
}
