"use client";

import { Printer } from "lucide-react";
import { Menu, MenuItem } from "@/components/ui/menu";

/**
 * Print the month on screen (owner, 26 Nov 2026 — "print the attendance of whole month of all employees or employee
 * wise"): everybody on one sheet, or a page for each person. Either keeps the filters, so a team or one person prints
 * the same way.
 */
export function AttendancePrintMenu({ query, onePerson }: { query: string; onePerson: boolean }) {
  const open = (layout: "sheet" | "each") => window.open(`/people/attendance/print?${query}${query ? "&" : ""}layout=${layout}`, "_blank", "noopener");
  return (
    <Menu label="Print" icon={Printer} iconClassName="inline-grid h-8 w-8 place-items-center rounded-base border border-line bg-surface text-muted transition-colors hover:text-brand">
      {(close) => (
        <>
          <MenuItem onClick={() => { close(); open("sheet"); }}>{onePerson ? "Month on one sheet" : "Everyone’s month on one sheet"}</MenuItem>
          <MenuItem onClick={() => { close(); open("each"); }}>{onePerson ? "Day by day, with times" : "A page for each employee, day by day"}</MenuItem>
        </>
      )}
    </Menu>
  );
}
