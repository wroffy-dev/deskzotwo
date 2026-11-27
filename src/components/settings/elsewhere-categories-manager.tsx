"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { createElsewhereCategory, deleteElsewhereCategory, renameElsewhereCategory, type ElsewhereCategoryRow } from "@/actions/elsewhere-category";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";

/** Settings › Lists › Installed elsewhere categories (src/actions/elsewhere-category.ts): add, rename, delete. */
function CategoryRow({ type, onDeleted }: { type: ElsewhereCategoryRow; onDeleted: (id: string) => void }) {
  const [name, setName] = useState(type.name);
  const [saved, setSaved] = useState(type.name);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== saved && name.trim().length >= 2;

  const save = () =>
    start(async () => {
      setError(null);
      const r = await renameElsewhereCategory(type.id, name);
      if (!r.ok) return setError(r.error);
      setSaved(name.trim());
    });

  const remove = async () => {
    const warning = type.used
      ? `Delete "${saved}"? ${type.used.toLocaleString("en-IN")} ${type.used === 1 ? "entry has" : "entries have"} it, and will be left with no category.`
      : `Delete "${saved}"?`;
    if (!(await confirmAction(warning))) return;
    start(async () => {
      setError(null);
      const r = await deleteElsewhereCategory(type.id);
      if (!r.ok) return setError(r.error);
      onDeleted(type.id);
    });
  };

  return (
    <div className="flex items-start gap-2 py-2">
      <div className="flex-1">
        <Input aria-label={`Rename ${type.name}`} value={name} onChange={(e) => setName(e.target.value)} />
        <p className="mt-1 text-xs text-subtle">{type.used ? `${type.used.toLocaleString("en-IN")} ${type.used === 1 ? "entry" : "entries"}` : "Not used yet"}</p>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
      <Button type="button" variant="secondary" size="sm" disabled={!dirty || pending} onClick={save}>
        {pending ? "Saving…" : "Save"}
      </Button>
      <button
        type="button"
        onClick={remove}
        disabled={pending}
        title={`Delete ${saved}`}
        aria-label={`Delete ${saved}`}
        className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-base text-subtle transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

export function ElsewhereCategoriesManager({ types }: { types: ElsewhereCategoryRow[] }) {
  const [list, setList] = useState(types);
  const [newName, setNewName] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const add = () =>
    start(async () => {
      setError(null);
      const r = await createElsewhereCategory(newName);
      if (!r.ok) return setError(r.error);
      setList((prev) => [...prev, r.data]);
      setNewName("");
    });

  return (
    <div>
      <div className="divide-y divide-line">
        {list.map((t) => (
          <CategoryRow key={t.id} type={t} onDeleted={(id) => setList((prev) => prev.filter((x) => x.id !== id))} />
        ))}
        {list.length === 0 && <p className="py-2 text-sm text-subtle">No categories — the installed-elsewhere form offers none.</p>}
      </div>
      <div className="mt-3 flex items-start gap-2 border-t border-line pt-3">
        <div className="flex-1">
          <Input aria-label="New category" placeholder="Add a category — Telephony, Printing, CCTV…" value={newName} onChange={(e) => setNewName(e.target.value)} />
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
        <Button type="button" size="sm" disabled={newName.trim().length < 2 || pending} onClick={add}>
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>
    </div>
  );
}
