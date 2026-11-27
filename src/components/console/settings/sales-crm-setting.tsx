"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { consoleSetSalesCrm } from "@/actions/platform/console-sales-crm";
import { DefinitionList } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ChangedBy, type SettingChange } from "@/components/console/settings/signup-settings";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Settings › Sales CRM (src/lib/platform/sales-crm.ts — owner, 18 Nov 2026): the workspace Deskzo's own sales team works
 * in. deskzo.com's contact-form messages, every new sign-up and each change in a workspace's billing standing go there as
 * leads and notes on them. Owners change it; everyone else (`readOnly`) sees it.
 */
export function SalesCrmSetting({ workspace, suffix, change, readOnly = false }: { workspace: string; suffix: string; change: SettingChange | null; readOnly?: boolean }) {
  const action = useConsoleAction<{ workspace: string | null }>();
  const [value, setValue] = useState(workspace);
  const never = "Never set — nothing goes to a CRM";

  if (readOnly) {
    return (
      <div className="space-y-4">
        <DefinitionList columns={1} items={[{ term: "Sales CRM", value: workspace ? `${workspace}${suffix}` : "None" }]} />
        <ChangedBy change={change} never={never} className="border-t border-line pt-3" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="max-w-xl space-y-1.5">
        <label htmlFor="sales-crm" className="text-sm font-medium text-text">
          Workspace
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="sales-crm"
            value={value}
            placeholder="deskzo"
            onChange={(e) => {
              setValue(e.target.value.trim().toLowerCase());
              action.reset();
            }}
            disabled={action.pending}
            className="max-w-48 font-mono"
          />
          <span className="text-sm text-muted">{suffix}</span>
        </div>
        <p className="text-xs text-subtle">
          Deskzo&apos;s own workspace. deskzo.com&apos;s contact-form messages and every new sign-up become leads there, given out by its own lead rules; each
          change in a sign-up&apos;s billing — trial, paying, past due, cancelled, lapsed — is a note on its lead. Only the sign-up&apos;s contact and plan go
          across, never anything inside their workspace. Demo bookings come from the CMS&apos;s Demo booking setting. Empty: nothing goes across.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          onClick={() => !action.pending && action.run(() => consoleSetSalesCrm(value), { success: "Sales CRM saved." })}
          disabled={value.trim() === workspace.trim()}
          aria-disabled={action.pending || undefined}
          aria-busy={action.pending || undefined}
        >
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save
        </Button>
        <ChangedBy change={change} never={never} />
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} className="empty:hidden" />
    </div>
  );
}
