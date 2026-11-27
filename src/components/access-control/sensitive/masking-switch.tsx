"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setFieldMasking, type FieldMaskingState } from "@/actions/field-access";
import { Switch } from "@/components/ui/switch";
import { confirmAction } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";

/**
 * Field masking's master switch, as a row of the Global PII Masking panel: on, every role's and
 * person's masking rules apply; off, masked fields show in the clear for everybody and nothing needs
 * unmasking, while a field somebody may not see at all stays hidden. The rules are kept either way.
 * A super admin's to change — switching it off is confirmed first — and everybody else sees which way
 * it is.
 */
export function MaskingSwitchRow({ state }: { state: FieldMaskingState }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(state.enabled);
  const [pending, start] = useTransition();

  async function change(next: boolean) {
    if (
      !next &&
      !(await confirmAction({
        title: "Switch field masking off?",
        message: "Every masked field — emails, phone numbers and the rest — will show in the clear to everybody who can open a lead, until it is switched back on.",
        confirmLabel: "Switch off",
        danger: true,
      }))
    )
      return;
    setEnabled(next);
    start(async () => {
      const result = await setFieldMasking(next);
      if (!result.ok) {
        setEnabled(!next);
        toast.error(result.error);
        return;
      }
      toast.success(next ? "Field masking on — the masking rules apply" : "Field masking off — masked fields show in the clear");
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-3.5 border-b border-line/70 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div id="ac-masking-label" className="font-medium text-text">
          Enable field masking
        </div>
        <div id="ac-masking-help" className="text-xs leading-[1.45] text-muted">
          {enabled
            ? "The masking rules apply: a masked email or phone number shows as 98•••••210 until it is unmasked, within each person's daily limit."
            : "Switched off for the whole workspace: masked fields show in the clear and there is nothing to unmask. Fields somebody may not see at all stay hidden. The rules are kept and apply again when it is switched back on."}
        </div>
        {state.changedAtText && (
          <div className="mt-0.5 text-[11.5px] text-subtle">
            Last changed {state.changedBy ? `by ${state.changedBy}, ` : ""}
            {state.changedAtText}
          </div>
        )}
        {!state.mayChange && <div className="mt-0.5 text-[11.5px] text-subtle">Only a super admin can switch it.</div>}
      </div>
      <Switch
        size="sm"
        checked={enabled}
        onChange={change}
        disabled={!state.mayChange || pending}
        aria-labelledby="ac-masking-label"
        aria-describedby="ac-masking-help"
        aria-busy={pending || undefined}
      />
    </div>
  );
}
