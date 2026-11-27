"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { DatabaseZap } from "lucide-react";
import { enrichContactFromApollo } from "@/actions/apollo";
import { enrichContactFromLusha } from "@/actions/lusha";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import type { EnrichProvider } from "@/components/companies/apollo-panel";

const NAME: Record<EnrichProvider, string> = { apollo: "Apollo", lusha: "Lusha" };

/**
 * Find one contact's email or mobile from Apollo or Lusha, on the contact's own row (owner, 15 Nov 2026) — the
 * company panel's contact lookup, a click nearer. What's typed is kept; a do-not-call number is never written.
 */
export function ContactEnrichButton({ contactId, name, providers, hasEmail, hasPhone }: { contactId: string; name: string; providers: EnrichProvider[]; hasEmail: boolean; hasPhone: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (providers.length === 0) return null;

  const run = (provider: EnrichProvider, mobile: boolean) =>
    start(async () => {
      const r = provider === "lusha" ? await enrichContactFromLusha(contactId, mobile) : await enrichContactFromApollo(contactId, mobile);
      if (!r.ok) return void toast.error(r.error);
      const d = r.data;
      const parts = [
        d.filled.length ? `filled ${d.filled.join(", ")}` : null,
        d.kept.email ? `${NAME[provider]} has another email, ${d.kept.email}` : null,
        d.mobile === "WAITING" ? "the mobile comes in a few minutes — you'll be told" : d.mobile === "KEPT" ? "a phone was found but one is already on file" : null,
        "doNotCall" in d && d.doNotCall ? "a number on a do-not-call list was left out" : null,
      ].filter(Boolean);
      toast.success(parts.length ? `${name}: ${parts.join("; ")}.` : d.found ? `${NAME[provider]} found ${name}, with nothing new.` : `${NAME[provider]} didn't find ${name}.`);
      router.refresh();
    });

  return (
    <Menu icon={DatabaseZap} label={`Find ${name}'s email or mobile`} width={250}>
      {(close) =>
        providers.map((p) => (
          <div key={p}>
            {providers.length > 1 && <MenuLabel>{NAME[p]}</MenuLabel>}
            <MenuItem
              disabled={pending}
              onClick={() => {
                close();
                run(p, false);
              }}
            >
              {hasEmail ? "Check email" : "Find email"}
              {providers.length > 1 ? "" : ` — ${NAME[p]}`} · 1 credit
            </MenuItem>
            <MenuItem
              disabled={pending}
              onClick={() => {
                close();
                run(p, true);
              }}
            >
              {hasPhone ? "Check email and mobile" : "Find email and mobile"} · {p === "lusha" ? 6 : 9} credits
            </MenuItem>
          </div>
        ))
      }
    </Menu>
  );
}
