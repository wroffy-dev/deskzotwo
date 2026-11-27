"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Eye, EyeOff, Trash2 } from "lucide-react";
import { addAssetType, deleteAssetType, moveAssetType, updateAssetType, type AssetTypeSetting } from "@/actions/asset-types";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { confirmAction } from "@/components/ui/confirm";

/**
 * The workspace's asset types (owner, 18 Nov 2026 — src/lib/assets/types.ts): renamed in place, moved up or down, hidden or
 * shown; one of its own added, switched between physical and not, or deleted while nothing has it.
 */
export function AssetTypesManager({ types }: { types: AssetTypeSetting[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [physical, setPhysical] = useState("yes");
  const [names, setNames] = useState<Record<string, string>>({});

  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) return setError(r.error);
      after?.();
      router.refresh();
    });

  const rename = (t: AssetTypeSetting) => {
    const next = (names[t.id] ?? t.name).trim();
    if (next === t.name) return;
    run(() => updateAssetType({ id: t.id, name: next }));
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <div className="text-sm font-medium text-text">Add a type</div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="asset-type-name">Name</Label>
              <Input id="asset-type-name" value={name} maxLength={60} placeholder="UPS, CCTV camera, projector…" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-type-physical">Is it a thing you can hold?</Label>
              <Select id="asset-type-physical" value={physical} onChange={(e) => setPhysical(e.target.value)}>
                <option value="yes">Physical — it has a site and moves</option>
                <option value="no">Not physical — a licence or subscription</option>
              </Select>
            </div>
            <Button type="button" disabled={pending || !name.trim()} onClick={() => run(() => addAssetType({ name, physical: physical === "yes" }), () => setName(""))}>
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <Card className="overflow-hidden p-0">
        <ul className="divide-y divide-line">
          {types.map((t, i) => (
            <li key={t.id} className={`flex flex-wrap items-center gap-2 px-4 py-2.5 ${t.hidden ? "bg-surface-sunken" : ""}`}>
              <div className="flex shrink-0 flex-col">
                <button type="button" className="text-muted hover:text-text disabled:opacity-30" disabled={pending || i === 0} onClick={() => run(() => moveAssetType(t.id, "up"))} aria-label={`Move ${t.name} up`}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button type="button" className="text-muted hover:text-text disabled:opacity-30" disabled={pending || i === types.length - 1} onClick={() => run(() => moveAssetType(t.id, "down"))} aria-label={`Move ${t.name} down`}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
              <Input
                aria-label={`Name of ${t.name}`}
                className={`h-8 w-56 ${t.hidden ? "text-muted" : ""}`}
                value={names[t.id] ?? t.name}
                maxLength={60}
                onChange={(e) => setNames({ ...names, [t.id]: e.target.value })}
                onBlur={() => rename(t)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
              {t.builtIn ? <Badge tone="default">Deskzo&apos;s</Badge> : <Badge tone="blue">Yours</Badge>}
              {!t.physical && <Badge tone="default">Not physical</Badge>}
              {t.hidden && <Badge tone="amber">Hidden</Badge>}
              <span className="text-xs text-muted">
                {t.assets.toLocaleString("en-IN")} asset{t.assets === 1 ? "" : "s"}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {!t.builtIn && (
                  <Select
                    aria-label={`Is ${t.name} physical?`}
                    className="h-8 w-40 text-xs"
                    value={t.physical ? "yes" : "no"}
                    disabled={pending}
                    onChange={(e) => run(() => updateAssetType({ id: t.id, physical: e.target.value === "yes" }))}
                  >
                    <option value="yes">Physical</option>
                    <option value="no">Not physical</option>
                  </Select>
                )}
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => updateAssetType({ id: t.id, hidden: !t.hidden }))} title={t.hidden ? "Show it in the list again" : "Hide it from the list — assets that have it keep it"}>
                  {t.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  {t.hidden ? "Show" : "Hide"}
                </Button>
                {!t.builtIn && t.assets === 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    aria-label={`Delete ${t.name}`}
                    onClick={async () => {
                      if (await confirmAction({ title: `Delete ${t.name}?`, message: "No asset has it. It leaves the list for good.", confirmLabel: "Delete" })) run(() => deleteAssetType(t.id));
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
