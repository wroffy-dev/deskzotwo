"use server";

import { headers } from "next/headers";
import { callerKeyIp, clientIpFrom } from "@/lib/client-ip";
import { siteAllowance } from "@/lib/platform/find-workspaces";
import { DemoRefused, demoBusiness, demoDomain, demoProspects, demoTeam, type DemoBusiness, type DemoProspect, type DemoTeam } from "@/lib/platform/live-demo";
import { HOST_MISMATCH, classifyHost, requestHost } from "@/lib/tenancy/host";

/**
 * The live demo's three steps, as server actions — /api is closed on deskzo.com (src/proxy.ts), and these answer only
 * there. A website not read today costs a few model calls, so each caller may start five an hour, and the whole site
 * 150; one read today costs nothing and isn't counted. The steps after the first only reach what the first read.
 * A field named `confirm_url` is the trap a person never fills (`website` is the real field here).
 */

export type DemoResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function onTheSite(): Promise<{ ok: true; ip: string | null } | { ok: false; error: string }> {
  const h = await headers();
  const host = requestHost(h);
  if (!host || host === HOST_MISMATCH || classifyHost(host).kind !== "root") return { ok: false, error: "The live demo runs on deskzo.com." };
  return { ok: true, ip: clientIpFrom(h) };
}

async function run<T>(work: () => Promise<T>): Promise<DemoResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    if (err instanceof DemoRefused) return { ok: false, error: err.message };
    console.error("[live-demo]", err instanceof Error ? err.message : err);
    return { ok: false, error: "That didn't go through — try again in a moment." };
  }
}

/** Step 1: the website read. */
export async function liveDemoBusiness(input: { website?: unknown; confirm_url?: unknown }): Promise<DemoResult<DemoBusiness>> {
  const site = await onTheSite();
  if (!site.ok) return site;
  // A form a bot filled: answered as if it were checked, and nothing is read.
  if (typeof input?.confirm_url === "string" && input.confirm_url.trim()) return { ok: false, error: "Enter your website, like acmepumps.in." };
  const domain = demoDomain(input?.website);
  if (!domain) return { ok: false, error: "Enter your website, like acmepumps.in." };
  const own = site.ip ? [{ key: `platform|demo-caller:${callerKeyIp(site.ip)}`, max: 5 }] : [];
  if (!siteAllowance([...own, { key: "platform|demo:all", max: 150 }])) {
    return { ok: false, error: "Lots of people are trying the demo right now — try again in a little while, or start free below." };
  }
  return run(() => demoBusiness(domain));
}

/** Step 2: three prospects from the news. */
export async function liveDemoProspects(website: unknown): Promise<DemoResult<DemoProspect[]>> {
  const site = await onTheSite();
  if (!site.ok) return site;
  const domain = demoDomain(website);
  if (!domain) return { ok: false, error: "Start again from your website." };
  return run(() => demoProspects(domain));
}

/** Step 3: Tara's email and Arjun's quote. */
export async function liveDemoTeam(website: unknown): Promise<DemoResult<DemoTeam>> {
  const site = await onTheSite();
  if (!site.ok) return site;
  const domain = demoDomain(website);
  if (!domain) return { ok: false, error: "Start again from your website." };
  return run(() => demoTeam(domain));
}
