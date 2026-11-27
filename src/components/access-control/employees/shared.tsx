import {
  BarChart3,
  BriefcaseBusiness,
  CircleDollarSign,
  ClipboardList,
  Contact,
  FileSpreadsheet,
  Headset,
  Laptop,
  Megaphone,
  Package,
  ReceiptText,
  Settings,
  ShoppingCart,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ModuleIcon, ModuleStanding } from "@/lib/staff/access-modules";
import { STAFF_STATUS_LABEL, type StaffStatus } from "@/lib/staff/status";
import { Pill, acToneOf, type PillTone } from "@/components/access-control/ui";
import { cn } from "@/lib/utils";

/**
 * The small pieces the employee list and the employee profile both draw: a role as a pill with its
 * colour, an account's status, a module's icon and standing. No hooks, so server pages and client
 * components share them.
 */

const MODULE_ICONS: Record<ModuleIcon, LucideIcon> = {
  crm: Contact,
  sales: ReceiptText,
  purchases: ShoppingCart,
  products: Package,
  projects: BriefcaseBusiness,
  finance: CircleDollarSign,
  support: Headset,
  marketing: Megaphone,
  hr: Users,
  performance: BarChart3,
  assets: Laptop,
  work: ClipboardList,
  data: FileSpreadsheet,
  settings: Settings,
};

export function ModuleGlyph({ icon, className }: { icon: ModuleIcon; className?: string }) {
  const Icon = MODULE_ICONS[icon];
  return <Icon className={cn("h-[18px] w-[18px] shrink-0", className)} aria-hidden />;
}

/** A role as the design draws it: a grey pill with the role's own colour as a small square. */
export function RolePill({ roleKey, name, superAdmin = false, className }: { roleKey: string; name: string; superAdmin?: boolean; className?: string }) {
  if (superAdmin) {
    return (
      <Pill tone="brand" className={cn("h-[22px] text-xs", className)}>
        Super Admin
      </Pill>
    );
  }
  return (
    <span className={cn("inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-full bg-surface-sunken px-2 text-xs font-semibold text-text", className)}>
      <span className={cn("h-2 w-2 rounded-[2px]", acToneOf(roleKey))} aria-hidden />
      {name}
    </span>
  );
}

const STATUS_DOT: Record<StaffStatus, string> = { active: "bg-success", invited: "bg-warning", off: "bg-danger" };
const STATUS_TEXT: Record<StaffStatus, string> = { active: "text-success", invited: "text-warning", off: "text-danger" };
const STATUS_TONE: Record<StaffStatus, PillTone> = { active: "green", invited: "amber", off: "red" };

/** Active, Invited or Switched off, as a dot and a word (the list) or a pill (the profile). */
export function StatusDot({ status }: { status: StaffStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium", STATUS_TEXT[status])}>
      <span className={cn("h-[7px] w-[7px] rounded-full", STATUS_DOT[status])} aria-hidden />
      {STAFF_STATUS_LABEL[status]}
    </span>
  );
}
export function StatusPill({ status }: { status: StaffStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{STAFF_STATUS_LABEL[status]}</Pill>;
}

const STANDING: Record<ModuleStanding, { tone: PillTone; text: string }> = {
  full: { tone: "green", text: "Full access" },
  limited: { tone: "amber", text: "Limited access" },
  none: { tone: "neutral", text: "No access" },
};

/** How much of a module somebody has: all of it, some, or none. */
export function StandingPill({ standing }: { standing: ModuleStanding }) {
  return <Pill tone={STANDING[standing].tone}>{STANDING[standing].text}</Pill>;
}

/** `yyyy-mm-dd` moved by whole days — for "in 7 days" from the workspace's today. */
export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/** Label and control stacked, as every dialog here lays its fields out. */
export function Field({ label, hint, htmlFor, children }: { label: string; hint?: React.ReactNode; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-semibold text-text/80">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11.5px] leading-[1.45] text-subtle">{hint}</p>}
    </div>
  );
}
