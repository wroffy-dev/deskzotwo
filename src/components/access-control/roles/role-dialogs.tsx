"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Info } from "lucide-react";
import { duplicateRole, updateRole } from "@/actions/role";
import { acPath } from "@/lib/access-control/nav";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { acButton, acInput } from "@/components/access-control/ui";
import { PresetPicker } from "@/components/access-control/roles/preset-picker";
import type { PresetChoice } from "@/components/access-control/roles/types";
import { cn } from "@/lib/utils";

/** The dialogs a role's row menu opens: rename, duplicate, and its built-in presets. */

const labelClass = "text-xs font-semibold text-text/80";

function DialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 flex justify-end gap-2 border-t border-line/70 pt-3">{children}</div>;
}

/** A role's name and description. Its key never changes, so renaming changes nothing anybody holds. */
export function RenameRoleDialog({ role, onClose }: { role: { key: string; name: string; description: string | null }; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setError(null);
      const r = await updateRole({ key: role.key, name, description });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(`Role ${name.trim()} saved`);
      onClose();
      router.refresh();
    });

  return (
    <Dialog open onClose={onClose} title={`Rename ${role.name}`}>
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-muted">
          Stays <code className="font-mono text-xs">{role.key}</code> underneath, so renaming changes nothing anyone holds.
        </p>
        <div className="flex flex-col gap-[5px]">
          <label htmlFor="ac-rename-name" className={labelClass}>
            Role name <span className="text-danger">*</span>
          </label>
          <input id="ac-rename-name" className={acInput} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-[5px]">
          <label htmlFor="ac-rename-description" className={labelClass}>
            Description
          </label>
          <textarea
            id="ac-rename-description"
            rows={3}
            className={cn(acInput, "h-auto resize-y py-2 leading-[1.5]")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this role is for, in one sentence"
          />
        </div>
        {error && <p className="text-xs font-medium text-danger">{error}</p>}
      </div>
      <DialogFooter>
        <button type="button" className={acButton.secondary} onClick={onClose} disabled={pending}>
          Cancel
        </button>
        <button type="button" className={acButton.primary} onClick={save} disabled={pending || name.trim().length < 2}>
          {pending ? "Saving…" : "Save"}
        </button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * A new role that starts as a copy of this one — what it grants, how far it reaches, its field access
 * and its daily unmask limit (`duplicateRole`, which refuses a copy holding more than the person
 * making it). The copy then opens in the wizard.
 */
export function DuplicateRoleDialog({ role, onClose }: { role: { key: string; name: string; description: string | null }; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(`${role.name} (copy)`);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const copy = () =>
    start(async () => {
      setError(null);
      const r = await duplicateRole({ from: role.key, name, description: role.description ?? undefined });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(`Duplicated as ${name.trim()}`);
      onClose();
      router.push(acPath.wizard(r.data.key));
      router.refresh();
    });

  return (
    <Dialog open onClose={onClose} title={`Duplicate ${role.name}`}>
      <div className="flex flex-col gap-3 text-[13px]">
        <div className="flex gap-2 rounded-md bg-brand-subtle px-3 py-2.5 text-[12.5px] leading-[1.5] text-brand">
          <Info className="mt-px h-[18px] w-[18px] shrink-0" aria-hidden />
          <span>A new role starting with everything this one grants, reaches and masks. Nobody is moved to it.</span>
        </div>
        <div className="flex flex-col gap-[5px]">
          <label htmlFor="ac-copy-name" className={labelClass}>
            New role&apos;s name <span className="text-danger">*</span>
          </label>
          <input id="ac-copy-name" className={acInput} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </div>
        {error && <p className="text-xs font-medium text-danger">{error}</p>}
      </div>
      <DialogFooter>
        <button type="button" className={acButton.secondary} onClick={onClose} disabled={pending}>
          Cancel
        </button>
        <button type="button" className={acButton.primary} onClick={copy} disabled={pending || name.trim().length < 2}>
          {pending ? "Copying…" : "Duplicate"}
        </button>
      </DialogFooter>
    </Dialog>
  );
}

/** The built-in presets written for a role, each previewed before it is applied. */
export function RolePresetsDialog({ role, presets, labels, onClose }: { role: { key: string; name: string }; presets: PresetChoice[]; labels: Record<string, string>; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={`Apply a preset · ${role.name}`} large>
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-muted">A preset states what the role holds: anything it doesn&apos;t list is switched off. People&apos;s own exceptions are not affected.</p>
        <PresetPicker presets={presets} labels={labels} mayManage />
      </div>
      <DialogFooter>
        <button type="button" className={acButton.secondary} onClick={onClose}>
          Close
        </button>
      </DialogFooter>
    </Dialog>
  );
}
