"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { createCompanyType, deleteCompanyType, renameCompanyType, type CompanyTypeRow } from "@/actions/company-type";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";

/** Settings › Lists › Company types (src/actions/company-type.ts): add, rename, delete. */
function TypeRow({ type, onDeleted }: { type: CompanyTypeRow; onDeleted: (id: string) => void }) {
  const [name, setName] = useState(type.name);
  const [saved, setSaved] = useState(type.name);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== saved && name.trim().length >= 2;

  const save = () =>
    start(async () => {
      setError(null);
      const r = await renameCompanyType(type.id, name);
      if (!r.ok) return setError(r.error);
      setSaved(name.trim());
    });

  const remove = async () => {
    const warning = type.used
      ? `Delete "${saved}"? ${type.used.toLocaleString("en-IN")} ${type.used === 1 ? "company has" : "companies have"} it, and will be left with no type.`
      : `Delete "${saved}"?`;
    if (!(await confirmAction(warning))) return;
    start(async () => {
      setError(null);
      const r = await deleteCompanyType(type.id);
      if (!r.ok) return setError(r.error);
      onDeleted(type.id);
    });
  };

  return (
    <div className="flex items-start gap-2 py-2">
      <div className="flex-1">
        <Input aria-label={`Rename ${type.name}`} value={name} onChange={(e) => setName(e.target.value)} />
        <p className="mt-1 text-xs text-subtle">{type.used ? `${type.used.toLocaleString("en-IN")} ${type.used === 1 ? "company" : "companies"}` : "Not used yet"}</p>
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

export function CompanyTypesManager({ types }: { types: CompanyTypeRow[] }) {
  const [list, setList] = useState(types);
  const [newName, setNewName] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const add = () =>
    start(async () => {
      setError(null);
      const r = await createCompanyType(newName);
      if (!r.ok) return setError(r.error);
      setList((prev) => [...prev, r.data]);
      setNewName("");
    });

  return (
    <div>
      <div className="divide-y divide-line">
        {list.map((t) => (
          <TypeRow key={t.id} type={t} onDeleted={(id) => setList((prev) => prev.filter((x) => x.id !== id))} />
        ))}
        {list.length === 0 && <p className="py-2 text-sm text-subtle">No company types — the company form offers none.</p>}
      </div>
      <div className="mt-3 flex items-start gap-2 border-t border-line pt-3">
        <div className="flex-1">
          <Input aria-label="New company type" placeholder="Add a company type — Trust, Society, Section 8…" value={newName} onChange={(e) => setNewName(e.target.value)} />
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
        <Button type="button" size="sm" disabled={newName.trim().length < 2 || pending} onClick={add}>
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>
    </div>
  );
}
