import type { Metadata } from "next";
import { managedBookingFor } from "@/actions/booking-public";
import { Card } from "@/components/ui/card";
import { ManageBooking } from "@/components/booking/manage-booking";

/**
 * The guest's own link to their booking (src/lib/booking/manage.ts): see it, move it, cancel it, invite a colleague.
 * The address is the secret, so it is never indexed and never listed.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false } };

export default async function ManageBookingPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams?: Promise<{ move?: string; cancel?: string }> }) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const booking = await managedBookingFor(token);
  if (!booking) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This link doesn&apos;t open a booking</h1>
        <p className="mt-2 text-sm text-muted">Check it against the invitation, or reply to the invitation to change the meeting.</p>
      </Card>
    );
  }
  return <ManageBooking token={token} booking={booking} start={query?.move === "1" ? "move" : query?.cancel === "1" ? "cancel" : null} />;
}
