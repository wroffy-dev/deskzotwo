"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { referCandidate } from "@/actions/referrals";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

/** Refer somebody: their details and why they'd be good — they land in Hiring with your name on them. */
export function ReferForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const blank = { name: "", email: "", phone: "", designation: "", note: "" };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-semibold text-text">Refer somebody</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="rf-name">Their name</Label>
          <Input id="rf-name" value={f.name} onChange={set("name")} />
        </div>
        <div>
          <Label htmlFor="rf-email">Email</Label>
          <Input id="rf-email" type="email" value={f.email} onChange={set("email")} />
        </div>
        <div>
          <Label htmlFor="rf-phone">Phone (optional)</Label>
          <Input id="rf-phone" value={f.phone} onChange={set("phone")} />
        </div>
        <div>
          <Label htmlFor="rf-role">For the role of (optional)</Label>
          <Input id="rf-role" value={f.designation} onChange={set("designation")} placeholder="Sales executive" />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="rf-note">Why they&apos;d be good</Label>
          <Textarea id="rf-note" rows={3} value={f.note} onChange={set("note")} placeholder="How you know them, what they're good at" />
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {done && <p className="text-sm text-success">{done}</p>}
      <Button
        disabled={pending}
        onClick={() => {
          setError(null);
          setDone(null);
          start(async () => {
            const r = await referCandidate(f);
            if (!r.ok) return setError(r.error);
            setDone(`Thanks — ${f.name} is with HR now.`);
            setF(blank);
            router.refresh();
          });
        }}
      >
        Send the referral
      </Button>
    </Card>
  );
}
