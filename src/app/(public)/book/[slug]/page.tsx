import type { Metadata } from "next";
import { bookingTimes } from "@/actions/booking-public";
import { Card } from "@/components/ui/card";
import { BookingWidget } from "@/components/booking/booking-widget";

/**
 * A booking page (src/lib/booking), at /book/<slug> on the workspace's address: the times its hosts are
 * free, and booking one. Its address is a name chosen to be shared, not a secret, so it may be found.
 *
 * `?embed=1`: inside a website's pop-up (src/lib/booking/embed.ts) — no card around it, and the page told when it is
 * booked. `?email=` and `?name=`: what that website already asked, filled in (owner, 18 Nov 2026 — the hero's email box).
 * `?ref=`: a nurture email's link (src/lib/nurture/replies.ts) — booked on the lead it was for, not a new one.
 */

export const dynamic = "force-dynamic";

const given = (value: string | undefined, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : undefined);

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await bookingTimes(slug);
  return { title: page ? (page.ourName ? `${page.title} — ${page.ourName}` : page.title) : "Not available" };
}

export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ embed?: string; email?: string; name?: string; ref?: string }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const page = await bookingTimes(slug);
  if (!page) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This booking page isn&apos;t available</h1>
        <p className="mt-2 text-sm text-muted">It may have been switched off. Try the address it was linked from.</p>
      </Card>
    );
  }
  const email = given(query?.email, 254);
  return (
    <BookingWidget
      page={page}
      embedded={query?.embed === "1"}
      prefill={{ email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined, name: given(query?.name, 120), ref: given(query?.ref, 40) }}
    />
  );
}
