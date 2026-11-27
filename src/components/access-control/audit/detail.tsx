import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The "Entry details" drawer's parts, shared by both logs: a label beside its value, and the row of
 * small links the drawer ends with. Nothing here is editable — an audit entry is only ever read.
 */

/** One fact of an entry. Empty values draw a dash, so every entry lists the same facts in the same place. */
export function DetailRow({ label, mono, children }: { label: string; mono?: boolean; children?: React.ReactNode }) {
  const empty = children === null || children === undefined || children === "" || children === false;
  return (
    <div className="grid grid-cols-[112px_1fr] gap-2 text-[12.5px]">
      <dt className="text-subtle">{label}</dt>
      <dd className={cn("min-w-0 break-words text-text", mono && !empty && "font-mono text-[11.5px]")}>{empty ? <span className="text-subtle">—</span> : children}</dd>
    </div>
  );
}

export function DetailList({ children }: { children: React.ReactNode }) {
  return <dl className="flex flex-col gap-2.5">{children}</dl>;
}

/** The drawer's closing row: where to go from this entry. */
export function DetailLinks({ children }: { children: React.ReactNode }) {
  return <div className="mt-3.5 flex flex-wrap gap-1.5 border-t border-line/70 pt-3.5">{children}</div>;
}

/** `onClick` closes the drawer: a link to this same page filtered would otherwise leave it open over the new list. */
export function DetailLink({ href, onClick, children }: { href: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <Link href={href} onClick={onClick} className="inline-flex h-7 items-center rounded-md border border-line-strong bg-surface px-2.5 text-xs font-semibold text-text transition-colors hover:bg-surface-sunken">
      {children}
    </Link>
  );
}

/** Rows open their entry on a click anywhere; this is the same thing for the keyboard, drawn as the row's time. */
export const rowOpenButtonClass = "rounded-sm text-left text-text/80 outline-none hover:text-brand focus-visible:ring-2 focus-visible:ring-brand";
export const selectedRowClass = "bg-brand-subtle/40";
