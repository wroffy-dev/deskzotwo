"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { listAccessSettings, saveListAccess, type AccessSettings } from "@/actions/smart-list-team";

/**
 * Who may see a Smart List and fill it in (owner, 20 Nov 2026 — Smart Lists phase 4): everyone, or only chosen people
 * and departments; view-only for some; and each person changing only their own rows. The builder and whoever manages
 * every list always may. The server's rule is src/lib/smart-lists/access.ts.
 */
export function AccessButton({ workbookId }: { workbookId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Users className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Access
      </Button>
      {open && <AccessDialog workbookId={workbookId} onClose={() => setOpen(false)} />}
    </>
  );
}

type Member = AccessSettings["members"][number];

function AccessDialog({ workbookId, onClose }: { workbookId: string; onClose: () => void }) {
  const router = useRouter();
  const [s, setS] = useState<AccessSettings | null>(null);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    let live = true;
    void listAccessSettings(workbookId).then((r) => live && setS(r));
    return () => {
      live = false;
    };
  }, [workbookId]);

  const add = (key: string) => {
    if (!s || !key) return;
    const [kind, id] = key.split(":");
    if (s.members.some((m) => (kind === "u" ? m.userId === id : m.departmentId === id))) return;
    const name = kind === "u" ? (s.people.find((p) => p.id === id)?.name ?? "") : `${s.departments.find((d) => d.id === id)?.name ?? ""} (department)`;
    setS({ ...s, members: [...s.members, { userId: kind === "u" ? id! : null, departmentId: kind === "d" ? id! : null, name, role: "EDIT" }] });
    setAdding("");
  };
  const setMember = (m: Member, patch: Partial<Member> | null) => setS((x) => (x ? { ...x, members: patch ? x.members.map((y) => (y === m ? { ...y, ...patch } : y)) : x.members.filter((y) => y !== m) } : x));

  const save = () =>
    start(async () => {
      if (!s) return;
      setError(null);
      const r = await saveListAccess({ workbookId, audience: s.audience, everyoneRole: s.everyoneRole, rowRule: s.rowRule, ownerPropertyId: s.ownerPropertyId, members: s.members.map((m) => ({ userId: m.userId, departmentId: m.departmentId, role: m.role })) });
      if (!r.ok) return setError(r.error);
      toast.success("Access saved.");
      onClose();
      router.refresh();
    });

  return (
    <Dialog open onClose={onClose} title="Who can see and fill in this list" wide>
      {!s ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-5">
          {!s.shared && <p className="rounded-base bg-warning-bg px-3 py-2 text-sm text-warning">This list is private — only you and whoever manages every list see it. Make it shared under Edit for the choices below to apply.</p>}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-text">Who sees it</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="aud" checked={s.audience === "EVERYONE"} onChange={() => setS({ ...s, audience: "EVERYONE" })} />
              Everyone in the company
              {s.audience === "EVERYONE" && (
                <Select aria-label="What everyone may do" className="ml-1 h-8 w-44" value={s.everyoneRole} onChange={(e) => setS({ ...s, everyoneRole: e.target.value === "VIEW" ? "VIEW" : "EDIT" })}>
                  <option value="EDIT">can fill it in</option>
                  <option value="VIEW">can only look</option>
                </Select>
              )}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="aud" checked={s.audience === "CHOSEN"} onChange={() => setS({ ...s, audience: "CHOSEN" })} />
              Only the people and departments below
            </label>
          </fieldset>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-text">{s.audience === "CHOSEN" ? "People and departments" : "Exceptions to everyone"}</h3>
            <ul className="space-y-1">
              {s.members.map((m, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <Select aria-label={`What ${m.name} may do`} className="h-8 w-36" value={m.role} onChange={(e) => setMember(m, { role: e.target.value === "VIEW" ? "VIEW" : "EDIT" })}>
                    <option value="EDIT">can fill it in</option>
                    <option value="VIEW">can only look</option>
                  </Select>
                  <button type="button" aria-label={`Take ${m.name} off`} className="rounded p-1 text-subtle hover:text-danger" onClick={() => setMember(m, null)}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
              {s.members.length === 0 && <li className="text-xs text-subtle">Nobody chosen yet.</li>}
            </ul>
            <Select aria-label="Add a person or department" className="h-8" value={adding} onChange={(e) => add(e.target.value)}>
              <option value="">Add a person or department…</option>
              <optgroup label="Departments">
                {s.departments.map((d) => (
                  <option key={d.id} value={`d:${d.id}`}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="People">
                {s.people.map((p) => (
                  <option key={p.id} value={`u:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            </Select>
            <p className="text-xs text-subtle">You, and whoever manages every list, always see it and can change it.</p>
          </section>

          <section className="space-y-2 border-t border-line pt-4">
            <label className="flex items-center gap-2 text-sm font-medium text-text">
              <input type="checkbox" checked={s.rowRule === "OWN"} onChange={(e) => setS({ ...s, rowRule: e.target.checked ? "OWN" : "ANY" })} />
              Each person changes only their own rows
            </label>
            {s.rowRule === "OWN" && (
              <div className="flex items-center gap-2 pl-6 text-sm">
                <Label htmlFor="acc-owner">Their rows are</Label>
                <Select id="acc-owner" className="h-8 w-64" value={s.ownerPropertyId ?? ""} onChange={(e) => setS({ ...s, ownerPropertyId: e.target.value || null })}>
                  {s.own && <option value="">rows they added</option>}
                  {!s.own && !s.ownerPropertyId && <option value="">Choose a Person column…</option>}
                  {s.personColumns.map((p) => (
                    <option key={p.id} value={p.id}>
                      rows naming them in &ldquo;{p.name}&rdquo;
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </section>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
