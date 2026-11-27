"use client";

import { useRouter } from "next/navigation";
import { Ellipsis } from "lucide-react";
import { Menu, MenuItem } from "@/components/ui/menu";

/**
 * The company header's "⋯" (owner, 15 Nov 2026 — the header redesign): what isn't needed on every visit — Edit, and
 * merging a duplicate in — out of the row of buttons.
 */
export function CompanyMoreMenu({ editHref, mergeHref, mergeLabel }: { editHref: string; mergeHref: string | null; mergeLabel: string }) {
  const router = useRouter();
  return (
    <Menu
      icon={Ellipsis}
      label="More actions"
      width={240}
      iconClassName="inline-grid h-9 w-9 shrink-0 place-items-center rounded-base border border-line-strong bg-surface text-muted shadow-sm transition-colors hover:bg-surface-sunken hover:text-text"
    >
      {(close) => (
        <>
          <MenuItem
            onClick={() => {
              close();
              router.push(editHref);
            }}
          >
            Edit details
          </MenuItem>
          {mergeHref && (
            <MenuItem
              onClick={() => {
                close();
                router.push(mergeHref);
              }}
            >
              {mergeLabel}
            </MenuItem>
          )}
        </>
      )}
    </Menu>
  );
}
