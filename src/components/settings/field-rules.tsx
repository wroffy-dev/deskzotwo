"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { deleteFieldRuleAction, saveFieldRuleAction, type FieldRulesView } from "@/actions/field-rules";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import {
  CONDITION_OP_LABELS,
  KINDS_FOR,
  OPS_FOR,
  PATTERNS,
  PATTERN_LABELS,
  RULE_ENTITIES,
  RULE_ENTITY_LABELS,
  RULE_KIND_LABELS,
  opNeedsValue,
  type ConditionOp,
  type FieldRule,
  type PatternKind,
  type RuleEntity,
  type RuleField,
  type RuleKind,
} from "@/lib/field-rules/catalogue";
import { ruleRefusal, ruleWords } from "@/lib/field-rules/check";

type Draft = {
  id?: string;
  entity: RuleEntity;
  field: string;
  kind: RuleKind;
  min: string;
  max: string;
  pattern: PatternKind;
  patternValue: string;
  whenOn: boolean;
  whenField: string;
  whenOp: ConditionOp;
  whenValue: string;
  newOnly: boolean;
  message: string;
  active: boolean;
};

const toRule = (d: Draft): Omit<FieldRule, "id"> => ({
  entity: d.entity,
  field: d.field,
  kind: d.kind,
  min: d.min.trim() === "" ? null : Number(d.min),
  max: d.max.trim() === "" ? null : Number(d.max),
  pattern: d.kind === "PATTERN" ? d.pattern : null,
  patternValue: d.kind === "PATTERN" ? d.patternValue : null,
  when: d.whenOn && d.whenField ? { field: d.whenField, op: d.whenOp, value: opNeedsValue(d.whenOp) ? d.whenValue : null } : null,
  newOnly: d.newOnly,
  message: d.message.trim() || null,
  active: d.active,
});

/** "Only when Relationship is Client" — the rule's condition, in words. */
function whenWords(rule: FieldRule, fields: RuleField[]): string | null {
  if (!rule.when) return null;
  const on = fields.find((f) => f.key === rule.when!.field);
  if (!on) return null;
  const value = rule.when.value ? (on.options?.find((o) => o.value === rule.when!.value)?.label ?? rule.when.value) : "";
  return `Only when ${on.label} ${CONDITION_OP_LABELS[rule.when.op]}${value ? ` ${value}` : ""}`;
}

/**
 * Settings › Field rules (owner, 12 Nov 2026): a list of rules for each record type, and one rule's editor — the field,
 * what it must be, "only when", and the message people see.
 */
export function FieldRulesSettings({ view }: { view: FieldRulesView }) {
  const [entity, setEntity] = useState<RuleEntity>("COMPANY");
  const [editing, setEditing] = useState<Draft | null>(null);
  const { fields, rules } = view[entity];
  const ruleable = fields.filter((f) => !f.conditionOnly);
  const blank = (): Draft => ({ entity, field: ruleable[0]?.key ?? "", kind: "REQUIRED", min: "", max: "", pattern: "DIGITS", patternValue: "", whenOn: false, whenField: "", whenOp: "EQUALS", whenValue: "", newOnly: false, message: "", active: true });
  const open = (r: FieldRule): Draft => ({
    id: r.id,
    entity: r.entity,
    field: r.field,
    kind: r.kind,
    min: r.min == null ? "" : String(r.min),
    max: r.max == null ? "" : String(r.max),
    pattern: r.pattern ?? "DIGITS",
    patternValue: r.patternValue ?? "",
    whenOn: !!r.when,
    whenField: r.when?.field ?? "",
    whenOp: r.when?.op ?? "EQUALS",
    whenValue: r.when?.value ?? "",
    newOnly: !!r.newOnly,
    message: r.message ?? "",
    active: r.active,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {RULE_ENTITIES.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => setEntity(e)}
            aria-pressed={entity === e}
            className={`rounded-full border px-3 py-1 text-sm transition-colors ${entity === e ? "border-brand bg-brand/10 font-medium text-brand" : "border-line-strong text-muted hover:text-text"}`}
          >
            {RULE_ENTITY_LABELS[e]} <span className="text-xs text-subtle">{view[e].rules.length}</span>
          </button>
        ))}
        <Button className="ml-auto" onClick={() => setEditing(blank())} disabled={ruleable.length === 0}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New rule
        </Button>
      </div>

      <Card className="overflow-hidden">
        {rules.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">No rules on {RULE_ENTITY_LABELS[entity].toLowerCase()} yet — anything the form allows is saved.</p>
        ) : (
          <ul>
            {rules.map((r) => {
              const field = fields.find((f) => f.key === r.field);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm font-medium ${r.active ? "text-text" : "text-subtle line-through"}`}>
                      {field?.label ?? `${r.field} (removed)`} — {RULE_KIND_LABELS[r.kind].toLowerCase()}
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      “{ruleWords(r, field?.label ?? r.field)}”
                      {whenWords(r, fields) && <span className="ml-2 text-subtle">· {whenWords(r, fields)}</span>}
                      {r.newOnly && <span className="ml-2 text-subtle">· New records only</span>}
                      {!r.active && <span className="ml-2 text-subtle">· Switched off</span>}
                    </div>
                  </div>
                  <Button variant="secondary" onClick={() => setEditing(open(r))}>
                    Edit
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <p className="text-xs text-subtle">
        A rule is checked when somebody saves — on the forms, in the phone app, through the API and in imports. Editing a record is checked only on the
        fields that save changes, so an older record missing something isn&apos;t stopped from other changes. Leads that come in on their own, from a
        website form or the chat, are never stopped by a rule.
      </p>
      {editing && <Editor draft={editing} fields={view[editing.entity].fields} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Editor({ draft, fields, onClose }: { draft: Draft; fields: RuleField[]; onClose: () => void }) {
  const router = useRouter();
  const [d, setD] = useState<Draft>(draft);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((prev) => ({ ...prev, [key]: value }));
  const field = fields.find((f) => f.key === d.field);
  const kinds = field ? KINDS_FOR[field.kind] : [];
  const whenField = fields.find((f) => f.key === d.whenField);
  const refusal = ruleRefusal(toRule(d), fields);
  const preview = field && !refusal ? ruleWords({ ...toRule(d), id: "", active: true }, field.label) : null;

  const pickField = (key: string) => {
    const next = fields.find((f) => f.key === key);
    setD((prev) => ({ ...prev, field: key, kind: next && KINDS_FOR[next.kind].includes(prev.kind) ? prev.kind : "REQUIRED" }));
  };
  const pickWhenField = (key: string) => {
    const next = fields.find((f) => f.key === key);
    setD((prev) => ({ ...prev, whenField: key, whenOp: next ? (OPS_FOR[next.kind].includes(prev.whenOp) ? prev.whenOp : OPS_FOR[next.kind][0]!) : prev.whenOp, whenValue: "" }));
  };
  const save = () =>
    start(async () => {
      setError(null);
      const r = toRule(d);
      const result = await saveFieldRuleAction({ id: d.id, entity: r.entity, field: r.field, kind: r.kind, min: r.min, max: r.max, pattern: r.pattern, patternValue: r.patternValue, when: r.when, newOnly: r.newOnly, message: r.message, active: r.active });
      if (!result.ok) return setError(result.error);
      onClose();
      router.refresh();
    });
  const remove = () =>
    start(async () => {
      if (!d.id) return;
      await deleteFieldRuleAction(d.id);
      onClose();
      router.refresh();
    });

  return (
    <Dialog open onClose={onClose} title={d.id ? "Edit rule" : `New rule on ${RULE_ENTITY_LABELS[d.entity].toLowerCase()}`}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="frField">Field</Label>
            <Select id="frField" value={d.field} onChange={(e) => pickField(e.target.value)}>
              {fields
                .filter((f) => !f.conditionOnly)
                .map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                    {f.key.startsWith("cf.") ? " (your field)" : ""}
                  </option>
                ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="frKind">Rule</Label>
            <Select id="frKind" value={d.kind} onChange={(e) => set("kind", e.target.value as RuleKind)}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {RULE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {(d.kind === "LENGTH" || d.kind === "RANGE") && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="frMin">{d.kind === "LENGTH" ? "At least (characters)" : "At least"}</Label>
              <Input id="frMin" inputMode="decimal" value={d.min} onChange={(e) => set("min", e.target.value)} placeholder="Leave empty for no lower limit" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="frMax">{d.kind === "LENGTH" ? "At most (characters)" : "At most"}</Label>
              <Input id="frMax" inputMode="decimal" value={d.max} onChange={(e) => set("max", e.target.value)} placeholder="Leave empty for no upper limit" />
            </div>
          </div>
        )}

        {d.kind === "PATTERN" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="frPattern">Format</Label>
              <Select id="frPattern" value={d.pattern} onChange={(e) => set("pattern", e.target.value as PatternKind)}>
                {PATTERNS.map((p) => (
                  <option key={p} value={p}>
                    {PATTERN_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
            {(d.pattern === "STARTS_WITH" || d.pattern === "ENDS_WITH" || d.pattern === "CUSTOM") && (
              <div className="space-y-1.5">
                <Label htmlFor="frPatternValue">{d.pattern === "CUSTOM" ? "Pattern" : d.pattern === "STARTS_WITH" ? "Starts with" : "Ends with"}</Label>
                <Input id="frPatternValue" value={d.patternValue} onChange={(e) => set("patternValue", e.target.value)} placeholder={d.pattern === "CUSTOM" ? "[A-Z]{3}-[0-9]{4}" : "PO-"} />
              </div>
            )}
          </div>
        )}

        <div className="space-y-2 rounded-base border border-line p-3">
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={d.whenOn} onChange={(e) => set("whenOn", e.target.checked)} />
            Only when…
          </label>
          {d.whenOn && (
            <div className="grid gap-2 sm:grid-cols-3">
              <Select value={d.whenField} onChange={(e) => pickWhenField(e.target.value)} aria-label="Only when this field">
                <option value="">Pick a field</option>
                {fields
                  .filter((f) => f.key !== d.field)
                  .map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
              </Select>
              <Select value={d.whenOp} onChange={(e) => set("whenOp", e.target.value as ConditionOp)} aria-label="Condition" disabled={!whenField}>
                {(whenField ? OPS_FOR[whenField.kind] : []).map((op) => (
                  <option key={op} value={op}>
                    {CONDITION_OP_LABELS[op]}
                  </option>
                ))}
              </Select>
              {opNeedsValue(d.whenOp) &&
                (whenField?.options ? (
                  <Select value={d.whenValue} onChange={(e) => set("whenValue", e.target.value)} aria-label="Value">
                    <option value="">Pick one</option>
                    {whenField.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input value={d.whenValue} onChange={(e) => set("whenValue", e.target.value)} aria-label="Value" placeholder={whenField?.kind === "number" ? "500000" : "Value"} />
                ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="frMessage">Message people see (optional)</Label>
          <Input id="frMessage" value={d.message} onChange={(e) => set("message", e.target.value)} placeholder={preview ?? "Write your own words, or leave it to Deskzo"} />
        </div>

        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={d.newOnly} onChange={(e) => set("newOnly", e.target.checked)} />
          New records only — don&apos;t hold records already here to it when they&apos;re edited
        </label>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={d.active} onChange={(e) => set("active", e.target.checked)} />
          Switched on
        </label>

        {preview && !error && (
          <p className="rounded-base bg-surface-sunken px-3 py-2 text-xs text-muted">
            People will see: “{d.message.trim() || preview}”
          </p>
        )}
        {(error ?? refusal) && <p className="text-sm text-danger">{error ?? refusal}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending || !!refusal} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {d.id && (
            <Button variant="ghost" className="ml-auto text-danger" disabled={pending} onClick={remove}>
              Delete
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
