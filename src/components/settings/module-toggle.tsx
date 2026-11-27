"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setModuleEnabled } from "@/actions/module";
import { Switch } from "@/components/ui/switch";

export function ModuleToggle({ moduleKey, enabled }: { moduleKey: string; enabled: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleToggle() {
    setError(null);
    startTransition(async () => {
      const result = await setModuleEnabled(moduleKey, !enabled);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Switch checked={enabled} disabled={isPending} onChange={handleToggle} />
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
