"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyPreset, previewPreset } from "@/actions/access";
import { toast } from "@/components/ui/toast";
import { acButton } from "@/components/access-control/ui";
import type { PresetChoice } from "@/components/access-control/roles/types";

type Preview = NonNullable<Awaited<ReturnType<typeof previewPreset>>>;

/**
 * The built-in profiles written for a role (src/lib/authz/presets.ts) — the real counterpart of the
 * design's templates. What applying one would grant and take away is shown before it is applied,
 * through `previewPreset` and `applyPreset` with their rules: nobody applies a profile holding more
 * than they do, Admin's are the super admin's, and menu sections are left alone.
 */
export function PresetPicker({ presets, labels, mayManage, onApplied }: { presets: PresetChoice[]; labels: Record<string, string>; mayManage: boolean; onApplied?: () => void }) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, start] = useTransition();

  if (presets.length === 0) return <p className="text-[13px] text-subtle">No built-in preset is written for this role.</p>;

  const show = (key: string) =>
    start(async () => {
      const diff = await previewPreset(key);
      if (!diff) toast.error("You can't apply presets.");
      setPreview(diff);
    });

  const apply = (key: string) =>
    start(async () => {
      const r = await applyPreset(key);
      setPreview(null);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`Applied: ${r.data.granted} granted, ${r.data.revoked} taken away.`);
      onApplied?.();
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-2">
      {presets.map((p) => (
        <div key={p.key} className="flex flex-wrap items-start gap-3 rounded-lg border border-line px-3 py-2.5">
          <div className="min-w-[200px] flex-1">
            <div className="font-semibold text-text">{p.label}</div>
            <div className="mt-0.5 text-xs leading-[1.45] text-muted">{p.description}</div>
          </div>
          {mayManage && (
            <button type="button" className={acButton.secondary} disabled={pending} onClick={() => show(p.key)}>
              Preview
            </button>
          )}
        </div>
      ))}
      {preview && (
        <div className="flex flex-col gap-3 rounded-lg border border-brand/30 bg-brand-subtle/40 p-3">
          <div>
            <div className="font-semibold text-text">Applying “{preview.preset.label}”</div>
            <div className="mt-0.5 text-xs text-muted">Afterwards the role holds exactly what the preset lists. Menu sections are left alone.</div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md bg-success-bg p-2.5 text-center">
              <div className="text-xl font-bold text-success">{preview.willGrant.length}</div>
              <div className="text-[11px] text-success">newly allowed</div>
            </div>
            <div className="rounded-md bg-danger-bg p-2.5 text-center">
              <div className="text-xl font-bold text-danger">{preview.willRevoke.length}</div>
              <div className="text-[11px] text-danger">taken away</div>
            </div>
            <div className="rounded-md bg-surface-sunken p-2.5 text-center">
              <div className="text-xl font-bold text-text/80">{preview.unchanged}</div>
              <div className="text-[11px] text-muted">unchanged</div>
            </div>
          </div>
          {preview.willGrant.length > 0 && <p className="text-xs leading-[1.5] text-success">+ {preview.willGrant.map((k) => labels[k] ?? k).join(", ")}</p>}
          {preview.willRevoke.length > 0 && <p className="text-xs leading-[1.5] text-danger">− {preview.willRevoke.map((k) => labels[k] ?? k).join(", ")}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={acButton.secondary} disabled={pending} onClick={() => setPreview(null)}>
              Cancel
            </button>
            <button type="button" className={acButton.primary} disabled={pending} onClick={() => apply(preview.preset.key)}>
              {pending ? "Applying…" : "Apply preset"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
