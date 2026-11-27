import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { resolveAction } from "@/components/site/links";
import { LiveDemoRun } from "@/components/site/live-demo-run";
import { demoDomain } from "@/lib/platform/live-demo";
import { getSiteSettings, siteStatus } from "@/lib/platform/site-content";

/**
 * The live demo's own page (owner, 22 Nov 2026 — "it should open in a new window just like explee.com"): deskzo.com/try/
 * <their website>, opened from the home page's box. Never indexed: it is one visitor's, and costs a model's time.
 */
export async function generateMetadata({ params }: PageProps<"/platform-site/try/[site]">): Promise<Metadata> {
  const domain = demoDomain(decodeURIComponent((await params).site));
  return { title: domain ? `Deskzo for ${domain}` : "Try Deskzo", robots: { index: false, follow: false } };
}

export default async function TryPage({ params }: PageProps<"/platform-site/try/[site]">) {
  const domain = demoDomain(decodeURIComponent((await params).site));
  if (!domain) notFound();
  const [settings, status] = await Promise.all([getSiteSettings(), siteStatus()]);
  const signup = resolveAction({ kind: "signup" }, { settings, signupOpen: status.signupOpen, trialDays: status.trialDays });
  return <LiveDemoRun website={domain} signup={signup} />;
}
