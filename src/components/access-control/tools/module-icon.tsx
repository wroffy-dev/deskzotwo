import { BarChart3, BriefcaseBusiness, CircleDollarSign, ClipboardList, Contact, FileSpreadsheet, Headset, Laptop, Megaphone, Package, ReceiptText, Settings, ShoppingCart, Users, type LucideIcon } from "lucide-react";
import type { ModuleIcon as ModuleIconKey } from "@/lib/staff/access-modules";

/** The access modules' icons by name: the server names one, and the simulator and the comparison draw it. */
const ICONS: Record<ModuleIconKey, LucideIcon> = {
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

export function ToolModuleIcon({ icon, className }: { icon: ModuleIconKey; className?: string }) {
  const Icon = ICONS[icon];
  return <Icon className={className} aria-hidden />;
}
