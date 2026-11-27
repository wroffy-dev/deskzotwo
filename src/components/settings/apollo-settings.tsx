"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { connectApollo, disconnectApollo } from "@/actions/apollo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { confirmAction } from "@/components/ui/confirm";
import { Input, Label } from "@/components/ui/input";
import type { ApolloSetup } from "@/lib/apollo/server";

/** Settings › Apollo (src/lib/apollo): paste the key, tried with Apollo before it's kept; the webhook address for mobiles. */
export function ApolloSettings({ setup, origin }: { setup: ApolloSetup; origin: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const connect = () =>
    start(async () => {
      setError(null);
      setSaved(false);
      const r = await connectApollo(key);
      if (!r.ok) return setError(r.error);
      setKey("");
      setSaved(true);
      router.refresh();
    });
  const disconnect = async () => {
    if (!(await confirmAction({ title: "Disconnect Apollo?", message: "Nobody can look anything up in Apollo until a key is added again. What was already filled stays.", confirmLabel: "Disconnect" }))) return;
    start(async () => {
      const r = await disconnectApollo();
      if (!r.ok) return setError(r.error);
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="text-sm font-medium text-text">{setup.connected ? "Connected" : "Connect your Apollo account"}</CardHeader>
        <CardContent className="space-y-3 text-sm">
          {setup.connected ? (
            <p className="text-muted">
              Apollo is connected{setup.checkedAt ? `, checked ${new Date(setup.checkedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}.
              {setup.error && <span className="block text-danger">Its last error: {setup.error}</span>}
            </p>
          ) : (
            <p className="text-muted">
              In Apollo, open Settings › Integrations › API, create a key (a master key, or one that includes organization enrichment, people enrichment and
              people search), and paste it here. Apollo bills your account&apos;s credits for each lookup.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="apollo-key">{setup.connected ? "Replace the API key" : "API key"}</Label>
            <Input id="apollo-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className="max-w-md font-mono" />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          {saved && !pending && <p className="text-xs text-success">Apollo accepted the key — it&apos;s saved, encrypted.</p>}
          <div className="flex gap-2">
            <Button size="sm" disabled={pending || !key.trim()} onClick={connect}>
              {pending ? "Checking with Apollo…" : setup.connected ? "Replace key" : "Connect"}
            </Button>
            {setup.connected && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={disconnect}>
                Disconnect
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      {setup.connected && setup.webhookPath && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Mobile numbers</CardHeader>
          <CardContent className="space-y-2 text-sm text-muted">
            <p>
              Apollo sends a contact&apos;s mobile a few minutes after it&apos;s asked for, to this workspace&apos;s own address — Deskzo gives it to Apollo with each request,
              so there&apos;s nothing to set up in Apollo. It fills the contact&apos;s phone when it&apos;s blank, and whoever asked is told.
            </p>
            <p className="break-all font-mono text-xs text-subtle">{`${origin}${setup.webhookPath.replace(/[^/]+$/, "••••••")}`}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
