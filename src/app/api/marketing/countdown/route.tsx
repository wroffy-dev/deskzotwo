import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { restoreInProgressFor } from "@/lib/backup/maintenance";
import { TenantHostMismatch, TenantNotFound, TenantNotResolved, currentTenant } from "@/lib/tenancy/resolve";
import { clockOfTenant } from "@/lib/time/workspace";

export const dynamic = "force-dynamic";

const DAY = 24 * 60 * 60 * 1000;
const notFound = () => new NextResponse("Not found.", { status: 404, headers: { "cache-control": "no-store" } });

/**
 * An email's countdown timer (owner, 1 Nov 2026 — src/lib/marketing/email-widgets.ts): the days, hours and minutes
 * left until `to`, read on the workspace's clock, drawn as a picture each time the email is opened — mail apps run
 * no scripts, so a fresh picture is how a timer ticks there. Public: an inbox fetches it with no session. It says
 * nothing but the time left, and refuses dates more than two years out.
 */
export async function GET(request: Request) {
  let clock;
  try {
    const tenant = await currentTenant();
    if (tenant.status !== "ACTIVE" || restoreInProgressFor(tenant)) return notFound();
    clock = clockOfTenant(tenant);
  } catch (err) {
    if (err instanceof TenantHostMismatch || err instanceof TenantNotFound || err instanceof TenantNotResolved) return notFound();
    throw err;
  }
  const query = new URL(request.url).searchParams;
  const target = clock.parseInput(String(query.get("to") ?? "").slice(0, 16));
  const now = Date.now();
  if (!target || Math.abs(target.getTime() - now) > 730 * DAY) return notFound();
  const label = String(query.get("l") ?? "").slice(0, 60).trim();

  const left = Math.max(0, target.getTime() - now);
  const parts = [
    { n: Math.floor(left / DAY), unit: "days" },
    { n: Math.floor((left % DAY) / 3_600_000), unit: "hours" },
    { n: Math.floor((left % 3_600_000) / 60_000), unit: "mins" },
  ];
  const ended = left === 0;
  const height = label ? 140 : 110;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#0f172a", color: "#ffffff", fontFamily: "sans-serif" }}>
        {label && <div style={{ fontSize: 20, color: "#cbd5e1", marginBottom: 8 }}>{label}</div>}
        {ended ? (
          <div style={{ fontSize: 36, fontWeight: 700 }}>It has ended</div>
        ) : (
          <div style={{ display: "flex", gap: 28 }}>
            {parts.map((p) => (
              <div key={p.unit} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ fontSize: 48, fontWeight: 700, lineHeight: 1 }}>{String(p.n).padStart(2, "0")}</div>
                <div style={{ fontSize: 14, color: "#94a3b8", marginTop: 4, textTransform: "uppercase", letterSpacing: 2 }}>{p.unit}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    ),
    { width: 480, height, headers: { "cache-control": "no-store, no-cache, max-age=0, must-revalidate" } },
  );
}
