"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setTeammateLookPhoto, setTeammateName } from "@/actions/platform/console-ai-teammates";
import { Panel } from "@/components/console/kit/panel";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { TEAMMATES, TEAMMATE_KEYS, TEAMMATE_NAME_MAX, TEAMMATE_PHOTO_MAX, type TeammateKey } from "@/lib/ai/teammates";
import { squarePhoto } from "@/lib/ai/square-photo";

/**
 * The console's AI teammates (owner, 23 Nov 2026 — src/lib/ai/teammate-looks.ts): a country, or every country, and each
 * teammate's name and photo there — what's set for it, else what it gets from under it (every country, then the
 * built-in default). Owners and admins change them; workspaces pick it up within a minute.
 */

export type LookCell = { name: string | null; photo: string | null };
export type ConsoleTeammatesData = {
  countries: { code: string; label: string }[];
  /** Rows set, by country then teammate. */
  rows: Record<string, Partial<Record<TeammateKey, LookCell>>>;
  defaultPhotos: Partial<Record<TeammateKey, string>>;
  canEdit: boolean;
};

const EVERY = "*";

export function ConsoleAiTeammates({ data }: { data: ConsoleTeammatesData }) {
  const [country, setCountry] = useState(EVERY);
  const label = data.countries.find((c) => c.code === country)?.label ?? country;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="teammate-country">Country</Label>
          <Select id="teammate-country" value={country} onChange={(e) => setCountry(e.target.value)} className="w-64">
            {data.countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
        <p className="max-w-xl text-xs text-muted">
          {country === EVERY
            ? "What every workspace sees, unless its country has its own. Left empty, a teammate keeps the built-in name and photo."
            : `What workspaces in ${label} see. Left empty, a teammate keeps what every country has.`}
        </p>
      </div>
      <Panel title={country === EVERY ? "Every country" : label} description="Each carries an AI mark wherever it shows, and always says it's AI. Use made-up faces — never a real person's photo.">
        <div className="grid gap-3 sm:grid-cols-2">
          {TEAMMATE_KEYS.map((key) => (
            <TeammateCard key={`${country}:${key}`} country={country} teammate={key} data={data} />
          ))}
        </div>
      </Panel>
    </div>
  );
}

function TeammateCard({ country, teammate, data }: { country: string; teammate: TeammateKey; data: ConsoleTeammatesData }) {
  const router = useRouter();
  const t = TEAMMATES[teammate];
  const own = data.rows[country]?.[teammate] ?? null;
  const every = country === EVERY ? null : (data.rows[EVERY]?.[teammate] ?? null);
  const underName = every?.name ?? t.defaultName;
  const underPhoto = every?.photo ?? data.defaultPhotos[teammate] ?? null;
  const shownPhoto = own?.photo ?? underPhoto;
  const [name, setName] = useState(own?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fromWhere = (mine: boolean) => (mine ? (country === EVERY ? "set for every country" : "set for this country") : every ? "from every country" : "built in");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      setError(null);
      setSaved(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "That didn't work.");
      setSaved(done);
      router.refresh();
    });

  async function choose(file: File) {
    setError(null);
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return setError("Choose a JPEG, PNG or WebP picture.");
    let value: string;
    try {
      value = await squarePhoto(file);
    } catch {
      return setError("That picture couldn't be read — try another.");
    }
    if (value.length > TEAMMATE_PHOTO_MAX) return setError("That picture is too large even when shrunk — try another.");
    run(() => setTeammateLookPhoto({ country, key: teammate, photo: value }), "Photo saved");
  }

  return (
    <div className="flex gap-3 rounded-md border border-line p-3">
      <div className="shrink-0">
        {teammate === "deskzo" ? (
          <div className="flex h-16 w-16 items-center justify-center rounded-full text-lg font-bold text-white" style={{ background: t.colour }}>
            AI
          </div>
        ) : shownPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data: picture chosen here or kept in the control plane.
          <img src={shownPhoto} alt={`${own?.name || underName}, AI ${t.role.toLowerCase()}`} className="h-16 w-16 rounded-full object-cover" style={{ boxShadow: `0 0 0 2px ${t.colour}` }} />
        ) : null}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <p className="text-sm font-semibold text-text">
            {own?.name || underName} <span className="font-normal text-muted">· {t.role}</span>
          </p>
          <p className="text-[11px] text-subtle">
            Name {fromWhere(!!own?.name)}
            {teammate !== "deskzo" && ` · photo ${fromWhere(!!own?.photo)}`}
          </p>
        </div>
        {data.canEdit && (
          <>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => setTeammateName({ country, key: teammate, name }), name.trim() ? "Name saved" : "Name taken away");
              }}
            >
              <Input aria-label={`${t.role}'s name`} value={name} placeholder={underName} maxLength={TEAMMATE_NAME_MAX} onChange={(e) => setName(e.target.value)} className="h-8 w-40 text-sm" />
              <Button type="submit" size="sm" variant="secondary" disabled={pending || name.trim() === (own?.name ?? "")}>
                Save name
              </Button>
            </form>
            {teammate !== "deskzo" && (
              <div className="flex flex-wrap items-center gap-2">
                <label className={`inline-flex h-8 cursor-pointer items-center rounded-base border border-line-strong bg-surface px-3 text-sm font-medium text-text hover:bg-surface-sunken ${pending ? "pointer-events-none opacity-50" : ""}`}>
                  {own?.photo ? "Change photo" : "Upload photo"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    disabled={pending}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void choose(file);
                    }}
                  />
                </label>
                {own?.photo && (
                  <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setTeammateLookPhoto({ country, key: teammate, photo: null }), "Photo taken away")}>
                    {country === EVERY ? "Back to the built-in photo" : "Back to every country's"}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
        {saved && <p className="text-xs text-success">{saved}</p>}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
