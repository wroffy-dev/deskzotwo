"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { deleteTemplate, setTemplateActive } from "@/actions/marketing";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";

/**
 * Retire / Bring back and Delete on a template's row (owner, 1 Nov 2026) — shown to marketing.manage only.
 * Delete is refused for a template a campaign or journey uses; the refusal says which, and Retire is the
 * way out of the pickers for those.
 */
export function TemplateRowActions({ template }: { template: { id: string; name: string; active: boolean } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const retire = () =>
    start(async () => {
      setError(null);
      const result = await setTemplateActive(template.id, !template.active);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });

  const remove = async () => {
    const yes = await confirmAction({
      title: `Delete “${template.name}”?`,
      message: "It's removed for good. A template a campaign or journey uses can't be deleted — retire it instead.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!yes) return;
    start(async () => {
      setError(null);
      const result = await deleteTemplate(template.id);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={retire} disabled={pending} title={template.active ? "Keep it, but out of every picker" : "Back into the pickers"}>
          {template.active ? <Archive className="mr-1.5 h-3.5 w-3.5" aria-hidden /> : <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
          {template.active ? "Retire" : "Bring back"}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger" onClick={remove} disabled={pending}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Delete
        </Button>
      </div>
      {error && <p className="max-w-sm text-right text-xs text-danger">{error}</p>}
    </div>
  );
}
