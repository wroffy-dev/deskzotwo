"use client";

import { workspacePack } from "@/lib/country-pack";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import type { ContactDesignation, ItemType, LeadAssignmentStrategy, LeadSource } from "@prisma/client";
import {
  deleteAssignmentRule,
  moveAssignmentRule,
  previewAssignment,
  saveAssignmentRule,
  type ScoreRow,
} from "@/actions/lead-assignment";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Select } from "@/components/ui/input";
import { OptionCombobox } from "@/components/ui/option-combobox";
import { INDIAN_STATES } from "@/lib/geo/india";
import { EMIRATES } from "@/lib/vat/rules";

/**
 * The regions a rule can name, by the workspace's country (owner, 14 Nov 2026): India's states, the UAE's emirates,
 * and elsewhere none to pick from — typed as the address has it.
 */
const regionsHere = (): string[] =>
  workspacePack().india ? INDIAN_STATES.map((s) => s.name) : workspacePack().country === "AE" ? [...EMIRATES] : [];
const regionWordHere = () => (workspacePack().india ? "State" : workspacePack().country === "AE" ? "Emirate" : "State or region");
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES } from "@/lib/leads/source";

type Rule = {
  id: string;
  name: string;
  priority: number;
  active: boolean;
  brandIds: string[];
  itemTypes: ItemType[];
  designations: ContactDesignation[];
  sources: LeadSource[];
  states: string[];
  countries: string[];
  cities: string[];
  pincodes: string[];
  customerCategoryIds: string[];
  itemIds: string[];
  responseHours: number | null;
  strategy: LeadAssignmentStrategy;
  userIds: string[];
  skipOnLeave: boolean;
  overflow: Overflow;
};
type Person = { id: string; name: string; email: string; role: string };
type Brand = { id: string; name: string };
type Category = { id: string; name: string; parentId: string | null };
type Item = { id: string; name: string; sku: string };

/**
 * What a rule does when everybody it gives leads to is at their lead limit (owner, 12 Nov 2026 — Phase 4 lead limits,
 * audit H.6.3; src/lib/leads/assign.ts `decideOwner`). One line each, said where the rule is chosen.
 */
type Overflow = "SKIP" | "REFUSE";
const OVERFLOW: Record<Overflow, { label: string; hint: string }> = {
  SKIP: { label: "Pass it on", hint: "Try the next rule; with nobody free anywhere, keep the lead unassigned and tell whoever hands out leads." },
  REFUSE: { label: "Refuse the lead", hint: "Turn the lead away with a reason — a form or the API is told it couldn't be taken. Nothing is created." },
};

const STRATEGY: Record<LeadAssignmentStrategy, { label: string; hint: string }> = {
  ROUND_ROBIN: { label: "Round robin", hint: "Each person in turn." },
  LEAST_LOADED: { label: "Fewest open leads", hint: "Whoever is carrying the fewest open leads right now." },
  PERFORMANCE: {
    label: "By performance",
    hint: "More leads to whoever closes more, answers faster and keeps at their leads — everyone still gets some. New people start in the middle.",
  },
  SPECIFIC_USER: { label: "A named person", hint: "Always the first person chosen who is available." },
  ACCOUNT_MANAGER: { label: "The account manager", hint: "The company's own account manager, if it has one — otherwise the next rule decides." },
};

/** "Mumbai, Thane" ⇄ ["Mumbai", "Thane"] — a typed list, any of which matches. */
function ListInput({ id, label, hint, value, onChange, placeholder }: { id: string; label: string; hint?: string; value: string[]; onChange: (next: string[]) => void; placeholder: string }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs font-medium text-muted">
        {label} <span className="font-normal text-subtle">{value.length ? `— ${value.length} chosen` : "— any"}</span>
      </Label>
      <Input
        id={id}
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        className="h-8"
        onChange={(e) => {
          setText(e.target.value);
          onChange(
            e.target.value
              .split(/[,\n]/)
              .map((v) => v.trim())
              .filter(Boolean),
          );
        }}
      />
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}
const ITEM_TYPES: { value: ItemType; label: string }[] = [
  { value: "SUBSCRIPTION", label: "Subscriptions" },
  { value: "GOOD", label: "Hardware" },
  { value: "SERVICE", label: "Services" },
];
const DESIGNATIONS: ContactDesignation[] = ["CEO", "CIO", "DIRECTOR", "IT_HEAD", "IT_MANAGER", "PURCHASE_MANAGER", "HR", "OTHER"];
const words = (s: string) => s.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
/** "25 min", "3 h", "2 days" — the middle answer time. */
const answerWords = (minutes: number) => (minutes < 90 ? `${Math.round(minutes)} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`);

/** A row of toggle chips — "any of these", empty meaning any. */
function Chips<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
}) {
  const [filter, setFilter] = useState("");
  /**
   * A long list — a catalogue's thousand brands — gets a box to narrow it. What is already chosen
   * stays in view whatever is typed, so narrowing never hides a choice somebody has made.
   */
  const searchable = options.length > 24;
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? options.filter((o) => selected.includes(o.value) || o.label.toLowerCase().includes(needle))
    : options;
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium text-muted">
        {label} <span className="font-normal text-subtle">{selected.length ? `— ${selected.length} chosen` : "— any"}</span>
      </legend>
      {searchable && (
        <Input
          aria-label={`Filter ${label.toLowerCase()}`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Type to find a ${label.toLowerCase()}…`}
          className="h-8"
        />
      )}
      <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
        {shown.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-brand bg-brand text-brand-contrast" : "border-line-strong text-muted hover:bg-surface-sunken"}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

const EMPTY: Omit<Rule, "id" | "priority"> & { id?: string } = {
  name: "",
  active: true,
  brandIds: [],
  itemTypes: [],
  designations: [],
  sources: [],
  states: [],
  countries: [],
  cities: [],
  pincodes: [],
  customerCategoryIds: [],
  itemIds: [],
  responseHours: null,
  strategy: "ROUND_ROBIN",
  userIds: [],
  skipOnLeave: true,
  overflow: "SKIP",
};

export function LeadAssignmentManager({
  rules,
  brands,
  people,
  categories = [],
  items = [],
  scores = [],
}: {
  rules: Rule[];
  brands: Brand[];
  people: Person[];
  categories?: Category[];
  items?: Item[];
  scores?: ScoreRow[];
}) {
  const regions = regionsHere();
  const regionWord = regionWordHere();
  const postalWord = workspacePack().india ? "PIN code" : "Postal code";
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<typeof EMPTY | null>(null);
  const [test, setTest] = useState({ brandId: "", itemType: "", designation: "", source: "WEBSITE", state: "", country: "", city: "", pincode: "", customerCategoryId: "", itemId: "" });
  const [testResult, setTestResult] = useState<string | null>(null);

  const personName = (id: string) => people.find((p) => p.id === id)?.name ?? "someone no longer active";
  const brandName = (id: string) => brands.find((b) => b.id === id)?.name ?? "a removed brand";
  // "Corporate › Large" — a sub-category with the category it's under.
  const categoryName = (id: string) => {
    const c = categories.find((x) => x.id === id);
    if (!c) return "a removed category";
    const parent = c.parentId ? categories.find((x) => x.id === c.parentId) : null;
    return parent ? `${parent.name} › ${c.name}` : c.name;
  };
  const itemName = (id: string) => items.find((i) => i.id === id)?.name ?? "a removed product";
  const categoryOptions = categories.map((c) => ({ value: c.id, label: categoryName(c.id) })).sort((a, b) => a.label.localeCompare(b.label));

  function describe(r: Rule): string {
    const parts = [
      r.brandIds.length && `brand ${r.brandIds.map(brandName).join(" or ")}`,
      r.itemTypes.length && `${r.itemTypes.map((t) => ITEM_TYPES.find((i) => i.value === t)?.label.toLowerCase()).join(" or ")}`,
      r.itemIds.length && `product ${r.itemIds.map(itemName).join(" or ")}`,
      r.customerCategoryIds.length && `customer is ${r.customerCategoryIds.map(categoryName).join(" or ")}`,
      r.designations.length && `contact is ${r.designations.map(words).join(" or ")}`,
      r.sources.length && `from ${r.sources.map((s) => LEAD_SOURCE_LABELS[s]).join(" or ")}`,
      r.countries.length && `in ${r.countries.join(" or ")}`,
      r.states.length && `in ${r.states.join(" or ")}`,
      r.cities.length && `in ${r.cities.join(" or ")}`,
      r.pincodes.length && `PIN ${r.pincodes.map((p) => (p.length < 6 ? `${p}…` : p)).join(" or ")}`,
    ].filter(Boolean);
    return parts.length ? `When ${parts.join(", ")}` : "Every lead";
  }

  function run(action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      after?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

      <Card>
        <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
          <span>Rules — tried top to bottom, the first that fits decides</span>
          <Button type="button" size="sm" onClick={() => setEditing({ ...EMPTY })}>
            + Add rule
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {rules.length === 0 ? (
            <div className="space-y-2 text-muted">
              <p>No rules yet, so a lead nobody assigns — including every website lead — arrives unassigned.</p>
              <p>
                A good start: an <span className="font-medium text-text">Account manager</span> rule first, so existing customers stay
                with the person who knows them, then a rule with no conditions that round-robins the rest across your sales team.
              </p>
            </div>
          ) : (
            <ol className="space-y-2">
              {rules.map((r, i) => (
                <li key={r.id} className={`rounded-md border border-line p-3 ${r.active ? "" : "opacity-60"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs tabular-nums text-subtle">{i + 1}.</span>
                        <span className="font-medium text-text">{r.name}</span>
                        {!r.active && <Badge>Off</Badge>}
                      </div>
                      <p className="text-muted">{describe(r)}</p>
                      <p className="text-muted">
                        → <span className="text-text">{STRATEGY[r.strategy].label}</span>
                        {r.strategy !== "ACCOUNT_MANAGER" && <>: {r.userIds.map(personName).join(", ")}</>}
                        {r.skipOnLeave && <span className="text-subtle"> · skipping anyone on leave</span>}
                      </p>
                      {r.overflow === "REFUSE" && <p className="text-muted">Everybody at their lead limit → the lead is refused</p>}
                      {r.responseHours && (
                        <p className="text-muted">
                          No response in {r.responseHours} office hour{r.responseHours === 1 ? "" : "s"} → the next person
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <IconButton icon={ArrowUp} label="Move up" disabled={i === 0 || pending} onClick={() => run(() => moveAssignmentRule(r.id, "up"))} />
                      <IconButton icon={ArrowDown} label="Move down" disabled={i === rules.length - 1 || pending} onClick={() => run(() => moveAssignmentRule(r.id, "down"))} />
                      <IconButton icon={Pencil} label="Edit rule" onClick={() => setEditing({ ...r })} />
                      <IconButton icon={Trash2} label="Delete rule" tone="danger" disabled={pending} onClick={() => run(() => deleteAssignmentRule(r.id))} />
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Test a lead</CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted">Who would a lead like this go to? Nothing is assigned, and nobody&apos;s turn is used up.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <OptionCombobox
              listLabel="Brands"
              options={brands.map((b) => ({ id: b.id, name: b.name }))}
              value={test.brandId}
              onSelect={(b) => setTest({ ...test, brandId: b?.id ?? "" })}
              placeholder="Any brand"
            />
            <Select aria-label="Product type" value={test.itemType} onChange={(e) => setTest({ ...test, itemType: e.target.value })}>
              <option value="">Any product type</option>
              {ITEM_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
            <Select aria-label="Designation" value={test.designation} onChange={(e) => setTest({ ...test, designation: e.target.value })}>
              <option value="">No contact</option>
              {DESIGNATIONS.map((d) => (
                <option key={d} value={d}>
                  {words(d)}
                </option>
              ))}
            </Select>
            <Select aria-label="Source" value={test.source} onChange={(e) => setTest({ ...test, source: e.target.value })}>
              {LEAD_SOURCE_VALUES.map((s) => (
                <option key={s} value={s}>
                  {LEAD_SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
            <Select aria-label={regionWord} value={test.state} onChange={(e) => setTest({ ...test, state: e.target.value })}>
              <option value="">Any {regionWord.toLowerCase()}</option>
              {regions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <OptionCombobox
              listLabel="Products"
              options={items.map((i) => ({ id: i.id, name: i.name }))}
              value={test.itemId}
              onSelect={(i) => setTest({ ...test, itemId: i?.id ?? "" })}
              placeholder="Any product"
            />
            <Select aria-label="Customer category" value={test.customerCategoryId} onChange={(e) => setTest({ ...test, customerCategoryId: e.target.value })}>
              <option value="">Any customer category</option>
              {categoryOptions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
            <Input aria-label="Country" value={test.country} onChange={(e) => setTest({ ...test, country: e.target.value })} placeholder={`Country — ${workspacePack().countryName}`} />
            <Input aria-label="City" value={test.city} onChange={(e) => setTest({ ...test, city: e.target.value })} placeholder="City" />
            <Input aria-label={postalWord} value={test.pincode} onChange={(e) => setTest({ ...test, pincode: e.target.value })} placeholder={postalWord} inputMode="numeric" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await previewAssignment({
                    brandIds: test.brandId ? [test.brandId] : [],
                    itemTypes: test.itemType ? [test.itemType] : [],
                    designation: test.designation,
                    source: test.source,
                    state: test.state,
                    country: test.country,
                    city: test.city,
                    pincode: test.pincode,
                    customerCategoryId: test.customerCategoryId,
                    itemId: test.itemId,
                  });
                  setTestResult(
                    !result.ok
                      ? result.error
                      : result.data.person
                        ? `→ ${result.data.person}, by ${result.data.rule}`
                        : result.data.refused
                          ? `→ Refused — ${result.data.refused}`
                          : result.data.full
                            ? `→ Unassigned — ${result.data.full}. Whoever hands out leads would be told.`
                            : "→ Unassigned — no rule fits a lead like this.",
                  );
                })
              }
            >
              Who would get it?
            </Button>
            {testResult && <span className="text-text">{testResult}</span>}
          </div>
        </CardContent>
      </Card>

      {scores.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">How people score for &quot;By performance&quot;</CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted">
              Closing counts half, answering fast three tenths, and keeping at their leads a fifth — each against the best here. Too little history and that part is the team&apos;s
              average. Higher scores get more of the leads; everybody gets some.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="py-2 pr-3">Person</th>
                    <th scope="col" className="px-3 py-2 text-right">Score</th>
                    <th scope="col" className="px-3 py-2 text-right">Won (90 days)</th>
                    <th scope="col" className="px-3 py-2 text-right">Answers in</th>
                    <th scope="col" className="px-3 py-2 text-right">Activity a lead</th>
                    <th scope="col" className="py-2 pl-3 text-right">Given (30 days)</th>
                  </tr>
                </thead>
                <tbody>
                  {scores.map((s) => (
                    <tr key={s.userId} className="border-b border-line last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-medium text-text">{s.name}</th>
                      <td className="px-3 py-2 text-right tabular-nums text-text">{Math.round(s.score * 100)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">
                        {s.closeRate === null ? `${s.won} of ${s.decided} — too few` : `${Math.round(s.closeRate * 100)}% (${s.won} of ${s.decided})`}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{s.answerMinutes === null ? "too few" : answerWords(s.answerMinutes)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{s.activity === null ? "—" : s.activity.toFixed(1)}</td>
                      <td className="py-2 pl-3 text-right tabular-nums text-muted">{s.givenRecently}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit rule" : "New rule"}>
        {editing && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => saveAssignmentRule(editing), () => setEditing(null));
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="rule-name">Name</Label>
              <Input
                id="rule-name"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="Microsoft leads — north"
                autoComplete="off"
              />
            </div>

            <div className="space-y-3 rounded-md border border-line p-3">
              <p className="text-xs text-subtle">Applies when every chosen condition fits. Leave a condition empty to match anything.</p>
              <Chips label="Brand" options={brands.map((b) => ({ value: b.id, label: b.name }))} selected={editing.brandIds} onChange={(v) => setEditing({ ...editing, brandIds: v })} />
              <Chips label="Product type" options={ITEM_TYPES} selected={editing.itemTypes} onChange={(v) => setEditing({ ...editing, itemTypes: v })} />
              <Chips label="Contact's designation" options={DESIGNATIONS.map((d) => ({ value: d, label: words(d) }))} selected={editing.designations} onChange={(v) => setEditing({ ...editing, designations: v })} />
              <Chips label="Source" options={LEAD_SOURCE_VALUES.map((s) => ({ value: s, label: LEAD_SOURCE_LABELS[s] }))} selected={editing.sources} onChange={(v) => setEditing({ ...editing, sources: v })} />
              <Chips label="Product" options={items.map((i) => ({ value: i.id, label: `${i.name} (${i.sku})` }))} selected={editing.itemIds} onChange={(v) => setEditing({ ...editing, itemIds: v })} />
              <Chips label="Customer category" options={categoryOptions} selected={editing.customerCategoryIds} onChange={(v) => setEditing({ ...editing, customerCategoryIds: v })} />
            </div>

            <div className="space-y-3 rounded-md border border-line p-3">
              <p className="text-xs text-subtle">Where the customer is — the company&apos;s main address. Each filled one has to fit.</p>
              <ListInput id="rule-countries" label="Country" value={editing.countries} onChange={(v) => setEditing({ ...editing, countries: v })} placeholder="India, United Arab Emirates" />
              {regions.length > 0 ? (
                <Chips label={regionWord} options={regions.map((name) => ({ value: name, label: name }))} selected={editing.states} onChange={(v) => setEditing({ ...editing, states: v })} />
              ) : (
                <ListInput id="rule-states" label={regionWord} value={editing.states} onChange={(v) => setEditing({ ...editing, states: v })} placeholder="As written in the customer's address" />
              )}
              <ListInput id="rule-cities" label="City" value={editing.cities} onChange={(v) => setEditing({ ...editing, cities: v })} placeholder="Mumbai, Thane, Navi Mumbai" />
              <ListInput
                id="rule-pincodes"
                label={postalWord}
                hint={workspacePack().india ? "Whole PIN codes, or their first digits for a run — 4000 is every PIN starting 4000." : "Whole postal codes, or their first characters for a run."}
                value={editing.pincodes}
                onChange={(v) => setEditing({ ...editing, pincodes: v })}
                placeholder="400001, 4000, 4111"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rule-strategy">Assign by</Label>
              <Select id="rule-strategy" value={editing.strategy} onChange={(e) => setEditing({ ...editing, strategy: e.target.value as LeadAssignmentStrategy })}>
                {(Object.keys(STRATEGY) as LeadAssignmentStrategy[]).map((s) => (
                  <option key={s} value={s}>
                    {STRATEGY[s].label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-subtle">{STRATEGY[editing.strategy].hint}</p>
            </div>

            {editing.strategy !== "ACCOUNT_MANAGER" && (
              <Chips
                label="Between these people"
                options={people.map((p) => ({ value: p.id, label: p.name }))}
                selected={editing.userIds}
                onChange={(v) => setEditing({ ...editing, userIds: v })}
              />
            )}

            {editing.strategy !== "ACCOUNT_MANAGER" && (
              <div className="space-y-1.5">
                <Label htmlFor="rule-response">If nothing is done with the lead within</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="rule-response"
                    type="number"
                    min={1}
                    max={240}
                    className="w-24"
                    value={editing.responseHours ?? ""}
                    onChange={(e) => setEditing({ ...editing, responseHours: e.target.value ? Math.round(Number(e.target.value)) : null })}
                    placeholder="—"
                  />
                  <span className="text-sm text-muted">office hours, it moves to the next person by this rule</span>
                </div>
                <p className="text-xs text-subtle">
                  A call, a note, an activity or any edit counts. Office hours are Settings › Attendance&apos;s, Sundays and holidays off. They&apos;re told, and so is their
                  manager; nobody left to take it, and the manager is told instead. Empty: it stays with them.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="rule-overflow">When everybody is at their lead limit</Label>
              <Select id="rule-overflow" value={editing.overflow} onChange={(e) => setEditing({ ...editing, overflow: e.target.value as Overflow })}>
                {(Object.keys(OVERFLOW) as Overflow[]).map((o) => (
                  <option key={o} value={o}>
                    {OVERFLOW[o].label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-subtle">{OVERFLOW[editing.overflow].hint} Limits are set on a role or a person, under Roles &amp; Permissions and Users › Business Rules.</p>
            </div>

            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={editing.skipOnLeave} onChange={(e) => setEditing({ ...editing, skipOnLeave: e.target.checked })} />
                Skip anyone on approved leave that day
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                Rule is on
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving…" : "Save rule"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
