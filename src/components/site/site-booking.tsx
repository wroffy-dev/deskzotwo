import Script from "next/script";
import { SITE_BOOKING_LINKS, bookingIsOn, type SiteBooking } from "@/lib/platform/site-booking";
import { protocolFor } from "@/lib/tenancy/host";

/**
 * Demo booking on every page of the public site (src/lib/platform/site-booking.ts): the booking pop-up's script from the
 * workspace named in the CMS's settings, on the platform's domain — the address is made here, never stored. The site's
 * "Book a demo" links and anything marked data-deskzo-book open the page over the site; nothing at all when the setting
 * is empty, and those links go to the contact page as before.
 */
export function SiteBookingScript({ booking, workspaceSuffix }: { booking: SiteBooking | undefined; workspaceSuffix: string }) {
  if (!bookingIsOn(booking)) return null;
  const host = `${booking.workspace}${workspaceSuffix}`;
  return <Script id="site-booking" src={`${protocolFor(host)}://${host}/api/booking/public/book.js`} data-page={booking.page} data-links={SITE_BOOKING_LINKS} strategy="afterInteractive" />;
}
