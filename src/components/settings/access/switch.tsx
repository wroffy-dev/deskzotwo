"use client";

import { Switch as AppSwitch } from "@/components/ui/switch";

/**
 * An on/off switch for the access screens — the app's switch (src/components/ui/switch.tsx), small, and
 * named for whoever reads it with a screen reader.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return <AppSwitch size="sm" checked={checked} onChange={onChange} disabled={disabled} aria-label={label} />;
}
