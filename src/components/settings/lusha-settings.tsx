"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { connectLusha, disconnectLusha } from "@/actions/lusha";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { confirmAction } from "@/components/ui/confirm";
import { Input, Label } from "@/components/ui/input";
import type { LushaSetup } from "@/lib/lusha/server";

/** Settings › Lusha (src/lib/lusha): paste the key, tried with Lusha (spending nothing) before it's kept. */
export function LushaSettings({ setup }: { setup: LushaSetup }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const connect = () =>
    start(async () => {
      setError(null);
      setSaved(null);
      const r = await connectLusha(key);
      if (!r.ok) return setError(r.error);
      setKey("");
      setSaved(`Lusha accepted the key — it's saved, encrypted.${r.data.creditsLeft !== null ? ` ${r.data.creditsLeft.toLocaleString("en-US")} credits left.` : ""}`);
      router.refresh();
    });
  const disconnect = async () => {
    if (!(await confirmAction({ title: "Disconnect Lusha?", message: "Nobody can look anything up in Lusha until a key is added again. What was already filled stays.", confirmLabel: "Disconnect" }))) return;
    start(async () => {
      const r = await disconnectLusha();
      if (!r.ok) return setError(r.error);
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">{setup.connected ? "Connected" : "Connect your Lusha account"}</CardHeader>
      <CardContent className="space-y-3 text-sm">
        {setup.connected ? (
          <p className="text-muted">
            Lusha is connected{setup.checkedAt ? `, checked ${new Date(setup.checkedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}. A number on a
            do-not-call list is never written to a contact.
            {setup.error && <span className="block text-danger">Its last error: {setup.error}</span>}
          </p>
        ) : (
          <p className="text-muted">In Lusha, open the API page (an API plan is needed), copy your API key, and paste it here. Lusha bills your account&apos;s credits for each lookup.</p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="lusha-key">{setup.connected ? "Replace the API key" : "API key"}</Label>
          <Input id="lusha-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className="max-w-md font-mono" />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        {saved && !pending && <p className="text-xs text-success">{saved}</p>}
        <div className="flex gap-2">
          <Button size="sm" disabled={pending || !key.trim()} onClick={connect}>
            {pending ? "Checking with Lusha…" : setup.connected ? "Replace key" : "Connect"}
          </Button>
          {setup.connected && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={disconnect}>
              Disconnect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
