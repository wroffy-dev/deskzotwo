"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { consoleSetAlertEmails } from "@/actions/platform/console-alert-recipients";
import { DefinitionList } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ChangedBy, type SettingChange } from "@/components/console/settings/signup-settings";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Settings › Alerts: who the console's alerts are emailed to (`alerts.emails`, src/lib/platform/alert-notify.ts —
 * owner, 30 Oct 2026). Empty means every active owner. Owners change it; everyone else (`readOnly`) sees it.
 */
export function AlertRecipientsSetting({ emails, owners, change, readOnly = false }: { emails: string; owners: string[]; change: SettingChange | null; readOnly?: boolean }) {
  const action = useConsoleAction<{ emails: string[] }>();
  const [value, setValue] = useState(emails);
  const fallback = owners.length ? `Every owner: ${owners.join(", ")}` : "Nobody — there is no active owner";
  const never = "Never changed — every owner by default";

  if (readOnly) {
    return (
      <div className="space-y-4">
        <DefinitionList columns={1} items={[{ term: "Alerts are emailed to", value: emails || fallback }]} />
        <ChangedBy change={change} never={never} className="border-t border-line pt-3" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="max-w-xl space-y-1.5">
        <label htmlFor="alert-emails" className="text-sm font-medium text-text">
          Email the alerts to
        </label>
        <Input
          id="alert-emails"
          value={value}
          placeholder={fallback}
          onChange={(e) => {
            setValue(e.target.value);
            action.reset();
          }}
          disabled={action.pending}
        />
        <p className="text-xs text-subtle">
          Commas between addresses, ten at most. Left empty, every active owner gets them. New critical and warning alerts go out within a minute; one still open is
          sent again after 2 hours (critical) or a day (warning) until it&apos;s acknowledged; a cleared one is said once.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          onClick={() => !action.pending && action.run(() => consoleSetAlertEmails(value), { success: "Alert recipients saved." })}
          disabled={value.trim() === emails.trim()}
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
