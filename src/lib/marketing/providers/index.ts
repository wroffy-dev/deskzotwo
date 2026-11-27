import type { MessageClass, ProviderKind } from "@prisma/client";
import { EMAIL_PROVIDERS } from "@/lib/marketing/providers/email";
import { WHATSAPP_PROVIDERS } from "@/lib/marketing/providers/whatsapp";
import type { MessageProvider } from "@/lib/marketing/providers/types";
import { firstUndeliverable } from "@/lib/mail-address-gate";
import { allMailBlockFor, blockSentence } from "@/lib/mail-blocks";
import { releaseCustomerMail, reserveCustomerMail } from "@/lib/customer-mail-cap";

export * from "@/lib/marketing/providers/types";

/**
 * Every email that really goes out looks at its addresses first: one the workspace blocked from all mail
 * (src/lib/mail-blocks.ts), or one that can't receive mail — not an address, or a domain that takes none
 * (src/lib/mail-address-gate.ts) — is refused for good here rather than bounced by the provider, which costs the
 * account its reputation. The mock only records, so it skips the DNS look; its suites write to made-up domains.
 */
function gated(provider: MessageProvider): MessageProvider {
  if (provider.kind !== "EMAIL") return provider;
  return {
    ...provider,
    async send(message, config) {
      const recipients = [message.to, ...(message.moreTo ?? []).map((r) => r.email), ...(message.cc ?? []), ...(message.bcc ?? [])];
      // The workspace's own "never mail them" (src/lib/mail-blocks.ts) — every kind of mail, the mock's too.
      const block = await allMailBlockFor(recipients);
      if (block) return { ok: false, retryable: false, error: `Not sent: ${await blockSentence(block)}` };
      if (provider.key !== "mock") {
        const verdict = await firstUndeliverable(recipients);
        if (!verdict.ok) return { ok: false, retryable: false, error: `Not sent: ${verdict.detail}` };
      }
      // The most a customer gets in 24 hours (src/lib/customer-mail-cap.ts): counted on its to and copies, not its
      // blind copies, which are the sender's own. Nothing goes past it — the mock's sends count too.
      const reserved = await reserveCustomerMail([message.to, ...(message.moreTo ?? []).map((r) => r.email), ...(message.cc ?? [])], provider.key);
      if (!reserved.ok) return { ok: false, retryable: false, error: `Not sent: ${reserved.refusal.sentence}` };
      const result = await provider.send(message, config).catch(async (err: unknown) => {
        await releaseCustomerMail(reserved);
        throw err;
      });
      if (!result.ok) await releaseCustomerMail(reserved);
      return result;
    },
  };
}

export const PROVIDERS: MessageProvider[] = [...EMAIL_PROVIDERS, ...WHATSAPP_PROVIDERS].map(gated);

export const providerByKey: Record<string, MessageProvider> = Object.fromEntries(
  PROVIDERS.map((p) => [p.key, p]),
);

export function providersOfKind(kind: ProviderKind): MessageProvider[] {
  return PROVIDERS.filter((p) => p.kind === kind);
}

/** A row as the router sees it — no secret, because routing never needs one. */
export type RoutableProvider = {
  id: string;
  key: string;
  label: string;
  kind: ProviderKind;
  enabled: boolean;
  priority: number;
  classes: MessageClass[];
  fromEmail: string | null;
};

/**
 * Which provider carries this message, and which to fall back to.
 *
 * The ordering rule that matters: a provider only carries a class it was configured to carry. That
 * is what keeps bulk off the domain the invoices go out from — Microsoft 365 set to TRANSACTIONAL
 * only will never be picked up by a campaign, however many other providers are failing.
 *
 * The list is a failover chain, not alternatives. It is walked in order, and only a *retryable*
 * failure moves to the next one; a rejected address is a rejected address at every provider.
 */
export function routeFor(
  providers: RoutableProvider[],
  params: { kind: ProviderKind; messageClass: MessageClass },
): RoutableProvider[] {
  return providers
    .filter((p) => p.enabled && p.kind === params.kind && p.classes.includes(params.messageClass))
    .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

/**
 * Whether marketing is about to go out from the same domain as everything else.
 *
 * The single most consequential setting in the module. Bulk from the primary domain risks the
 * deliverability of quotes, invoices and password resets — the mail the business actually runs on —
 * and the damage arrives weeks later, as silence.
 */
export function sharesDomainWithTransactional(providers: RoutableProvider[]): boolean {
  const domainOf = (p: RoutableProvider) => p.fromEmail?.split("@")[1]?.trim().toLowerCase() ?? null;
  const marketing = new Set(
    providers.filter((p) => p.enabled && p.classes.includes("MARKETING")).map(domainOf).filter(Boolean),
  );
  const transactional = providers
    .filter((p) => p.enabled && p.classes.includes("TRANSACTIONAL"))
    .map(domainOf)
    .filter(Boolean);
  return transactional.some((d) => marketing.has(d));
}
