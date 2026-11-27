"use client";

import { baseCurrency } from "@/lib/currency";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { addInsuranceMembers, archivePolicy, saveInsuranceMember, saveMyDependents, savePolicy, type MemberView, type MyCover, type PolicyView } from "@/actions/insurance";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { RELATIONS, type Dependent } from "@/lib/hr/insurance-rules";

type Result = { ok: true } | { ok: false; error: string };
function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<Result>, after?: () => void) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) return setError(r.error);
      after?.();
      router.refresh();
    });
  };
  return { pending, error, run };
}

const day = (iso: string) => formatCalendarDay(new Date(`${iso}T00:00:00Z`));
const KIND_WORDS: Record<PolicyView["kind"], string> = { HEALTH: "Health", ACCIDENT: "Personal accident", LIFE: "Term life", OTHER: "Other" };
const STATE: Record<PolicyView["state"], { label: string; tone: "green" | "blue" | "default" }> = {
  ACTIVE: { label: "In force", tone: "green" },
  UPCOMING: { label: "Starts later", tone: "blue" },
  EXPIRED: { label: "Ended", tone: "default" },
};
const relationLabel = (r: string) => RELATIONS.find((x) => x.value === r)?.label ?? r;

function FamilyEditor({ initial, onSave, pending }: { initial: Dependent[]; onSave: (d: Dependent[]) => void; pending: boolean }) {
  const [rows, setRows] = useState<Dependent[]>(initial);
  const set = (i: number, patch: Partial<Dependent>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Full name" className="w-48" aria-label="Name" />
          <Select value={r.relation} onChange={(e) => set(i, { relation: e.target.value as Dependent["relation"] })} className="w-40" aria-label="Relation">
            {RELATIONS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </Select>
          <Input type="date" value={r.dateOfBirth ?? ""} onChange={(e) => set(i, { dateOfBirth: e.target.value || null })} className="w-40" aria-label="Date of birth" />
          <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => setRows([...rows, { name: "", relation: "SPOUSE", dateOfBirth: null }])}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add a family member
        </Button>
        <Button size="sm" disabled={pending} onClick={() => onSave(rows)}>
          Save family
        </Button>
      </div>
    </div>
  );
}

/** One's own cover: the policy, the number, who to call, and the family on it. */
export function MyCoverCard({ cover }: { cover: MyCover }) {
  const { pending, error, run } = useAct();
  const [editing, setEditing] = useState(false);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text">{cover.name}</p>
          <p className="text-xs text-muted">
            {KIND_WORDS[cover.kind]} · {cover.insurer} · policy {cover.policyNumber}
          </p>
        </div>
        <Badge tone={STATE[cover.state].tone}>{STATE[cover.state].label}</Badge>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Your member number</dt>
          <dd className="font-mono text-text">{cover.memberNumber ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Cover</dt>
          <dd className="text-text">{cover.cover != null ? formatCurrency(cover.cover) : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Runs</dt>
          <dd className="text-text">
            {day(cover.validFrom)} – {day(cover.validTo)}
          </dd>
        </div>
        {cover.helpline && (
          <div>
            <dt className="text-xs text-muted">Claims helpline</dt>
            <dd className="text-text">{cover.helpline}</dd>
          </div>
        )}
      </dl>
      {cover.notes && <p className="whitespace-pre-line text-xs text-muted">{cover.notes}</p>}
      <div>
        <p className="text-xs font-medium text-muted">Family covered</p>
        {editing ? (
          <FamilyEditor initial={cover.dependents} pending={pending} onSave={(d) => run(() => saveMyDependents({ memberId: cover.memberId, dependents: d }), () => setEditing(false))} />
        ) : (
          <>
            {cover.dependents.length === 0 ? (
              <p className="text-sm text-muted">Just you.</p>
            ) : (
              <ul className="text-sm text-text">
                {cover.dependents.map((d, i) => (
                  <li key={i}>
                    {d.name} · {relationLabel(d.relation)}
                    {d.dateOfBirth ? ` · born ${day(d.dateOfBirth)}` : ""}
                  </li>
                ))}
              </ul>
            )}
            {cover.canEditFamily && (
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => setEditing(true)}>
                Change family
              </Button>
            )}
          </>
        )}
        {error && <p className="mt-1 text-sm text-danger">{error}</p>}
      </div>
    </Card>
  );
}

export function PolicyForm({ policy, onDone }: { policy?: PolicyView; onDone?: () => void }) {
  const { pending, error, run } = useAct();
  const [open, setOpen] = useState(!!policy);
  const blank = { name: "", kind: "HEALTH", insurer: "", policyNumber: "", sumInsured: "", validFrom: "", validTo: "", helpline: "", notes: "" };
  const [f, setF] = useState(
    policy
      ? { ...blank, ...policy, sumInsured: policy.sumInsured != null ? String(policy.sumInsured) : "", helpline: policy.helpline ?? "", notes: policy.notes ?? "" }
      : blank,
  );
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const close = () => (onDone ? onDone() : setOpen(false));
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add a policy
      </Button>
    );
  }
  return (
    <Card className="space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Name</Label>
          <Input value={f.name} onChange={set("name")} placeholder="Group health 2026–27" />
        </div>
        <div>
          <Label>Covers</Label>
          <Select value={f.kind} onChange={set("kind")}>
            {Object.entries(KIND_WORDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Insurer</Label>
          <Input value={f.insurer} onChange={set("insurer")} />
        </div>
        <div>
          <Label>Policy number</Label>
          <Input value={f.policyNumber} onChange={set("policyNumber")} />
        </div>
        <div>
          <Label>Cover per person ({baseCurrency()}, optional)</Label>
          <Input type="number" min={0} value={f.sumInsured} onChange={set("sumInsured")} />
        </div>
        <div>
          <Label>Claims helpline (optional)</Label>
          <Input value={f.helpline} onChange={set("helpline")} placeholder="TPA name and number" />
        </div>
        <div>
          <Label>Runs from</Label>
          <Input type="date" value={f.validFrom} onChange={set("validFrom")} />
        </div>
        <div>
          <Label>to</Label>
          <Input type="date" value={f.validTo} onChange={set("validTo")} />
        </div>
        <div className="sm:col-span-2">
          <Label>Notes for members (optional)</Label>
          <Textarea rows={2} value={f.notes} onChange={set("notes")} placeholder="What's covered, the hospitals, how to claim" />
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending} onClick={() => run(() => savePolicy({ id: policy?.id, ...f, sumInsured: f.sumInsured === "" ? null : Number(f.sumInsured) }), close)}>
          Save policy
        </Button>
        <Button variant="ghost" disabled={pending} onClick={close}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function MemberRow({ m }: { m: MemberView }) {
  const { pending, error, run } = useAct();
  const [open, setOpen] = useState(false);
  const [num, setNum] = useState(m.memberNumber ?? "");
  const [sum, setSum] = useState(m.sumInsured != null ? String(m.sumInsured) : "");
  return (
    <li className="border-t border-line py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-medium text-text">{m.name}</span>
          <span className="text-xs text-muted">
            {" "}
            · {m.memberNumber ?? "no member number"} · {m.dependents.length} family
            {m.sumInsured != null ? ` · ${formatCurrency(m.sumInsured)}` : ""}
          </span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Edit"}
        </Button>
      </div>
      {open && (
        <div className="mt-2 space-y-3 rounded-base bg-surface-sunken p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label>Member number</Label>
              <Input value={num} onChange={(e) => setNum(e.target.value)} className="w-44" />
            </div>
            <div>
              <Label>Own cover ({baseCurrency()}, optional)</Label>
              <Input type="number" value={sum} onChange={(e) => setSum(e.target.value)} className="w-40" />
            </div>
            <Button size="sm" disabled={pending} onClick={() => run(() => saveInsuranceMember({ id: m.id, memberNumber: num, sumInsured: sum === "" ? null : Number(sum) }))}>
              Save
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => saveInsuranceMember({ id: m.id, remove: true }))}>
              Take off the policy
            </Button>
          </div>
          <FamilyEditor initial={m.dependents} pending={pending} onSave={(d) => run(() => saveInsuranceMember({ id: m.id, memberNumber: num, sumInsured: sum === "" ? null : Number(sum), dependents: d }))} />
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </li>
  );
}

export function PolicyCard({ policy, people }: { policy: PolicyView & { members: MemberView[] }; people: { id: string; name: string }[] }) {
  const { pending, error, run } = useAct();
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState("");
  const onIt = new Set(policy.members.map((m) => m.userId));
  if (editing) return <PolicyForm policy={policy} onDone={() => setEditing(false)} />;
  return (
    <Card className={`space-y-2 p-4 ${policy.archived ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-text">
            {policy.name} {policy.archived && <Badge>Archived</Badge>}
          </p>
          <p className="text-xs text-muted">
            {KIND_WORDS[policy.kind]} · {policy.insurer} · {policy.policyNumber} · {day(policy.validFrom)} – {day(policy.validTo)}
            {policy.sumInsured != null ? ` · ${formatCurrency(policy.sumInsured)} each` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Badge tone={STATE[policy.state].tone}>{STATE[policy.state].label}</Badge>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => archivePolicy(policy.id, !policy.archived))}>
            {policy.archived ? "Bring back" : "Archive"}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={pick} onChange={(e) => setPick(e.target.value)} className="w-56" aria-label="Person to add">
          <option value="">Add somebody…</option>
          {people
            .filter((p) => !onIt.has(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </Select>
        <Button size="sm" variant="secondary" disabled={pending || !pick} onClick={() => run(() => addInsuranceMembers({ policyId: policy.id, userIds: [pick] }), () => setPick(""))}>
          Add
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => addInsuranceMembers({ policyId: policy.id, everyone: true }))}>
          Add everybody working
        </Button>
        <span className="text-xs text-muted">{policy.members.length} covered</span>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {policy.members.length > 0 && (
        <ul>
          {policy.members.map((m) => (
            <MemberRow key={m.id} m={m} />
          ))}
        </ul>
      )}
    </Card>
  );
}
