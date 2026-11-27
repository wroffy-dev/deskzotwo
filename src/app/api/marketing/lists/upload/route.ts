import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import type { MarketingTopic } from "@prisma/client";
import { recordAudit } from "@/lib/audit";
import { TOPICS } from "@/lib/marketing/topics";
import { importMarketingList, previewMarketingList } from "@/lib/marketing/list-import";
import { checkUploadRequest } from "@/lib/marketing/upload-request";
import { readFormWithin } from "@/lib/http/body";

/**
 * Upload a list of people for a mass mail, as a CSV. Every row becomes a contact before anybody is
 * mailed — see src/lib/marketing/list-import.ts — and nothing happens without the uploader saying
 * how these people agreed to hear from us.
 *
 * Two steps (owner, 1 Nov 2026): `mode=preview` checks the list — every address, who is already in
 * Deskzo, who bounced or unsubscribed — and writes nothing; the import then brings in what the
 * preview showed, leaving existing customers out when `leaveOutCustomers=yes`.
 */

export const dynamic = "force-dynamic";

const MAX_CSV_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  const limit = MAX_CSV_BYTES + 64 * 1024;
  const gate = await checkUploadRequest(request, limit);
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });

  // Read within the same ceiling, the bytes counted as they arrive (security audit round three, 14 Nov 2026 — low;
  // SEC-27): `formData()` alone buffered whatever was sent, whatever Content-Length had said.
  let form: FormData | null;
  try {
    form = await readFormWithin(request, limit);
  } catch {
    return NextResponse.json({ ok: false, error: "That upload didn't arrive whole — try again." }, { status: 400 });
  }
  if (!form) return NextResponse.json({ ok: false, error: "That upload is too large." }, { status: 413 });
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "Choose a .csv file." }, { status: 400 });
  if (file.size > MAX_CSV_BYTES) return NextResponse.json({ ok: false, error: "That CSV is over 5 MB — split it into smaller lists." }, { status: 413 });
  if (!/\.(csv|txt)$/i.test(file.name)) return NextResponse.json({ ok: false, error: "Upload the list as a .csv — Excel can save one with File › Save As." }, { status: 400 });

  const topics = form.getAll("topics").map(String).filter((t): t is MarketingTopic => TOPICS.some((x) => x.key === t));
  if (form.get("mode") === "preview") {
    if (topics.length === 0) return NextResponse.json({ ok: false, error: "Pick what they agreed to hear about." }, { status: 400 });
    const preview = await previewMarketingList({ csvText: await file.text(), topics });
    return NextResponse.json(preview, { status: preview.ok ? 200 : 422 });
  }

  const name = String(form.get("name") ?? "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "Give the list a name." }, { status: 400 });
  // Consent is the uploader's statement, and the send is refused without it. DPDP asks for the
  // artefact, not a tick: the words become the evidence on every consent row.
  if (form.get("confirmed") !== "yes") return NextResponse.json({ ok: false, error: "Confirm that these people agreed to hear from us." }, { status: 400 });
  const consentNote = String(form.get("consentNote") ?? "").trim();
  if (consentNote.length < 10) return NextResponse.json({ ok: false, error: "Say how they agreed — for example “signed up at our Pune roundtable on 12 Sep”." }, { status: 400 });
  if (topics.length === 0) return NextResponse.json({ ok: false, error: "Pick what they agreed to hear about." }, { status: 400 });

  const imported = await importMarketingList({
    userId: gate.userId,
    name: name.slice(0, 120),
    fileName: file.name.slice(0, 200),
    csvText: await file.text(),
    consentNote: consentNote.slice(0, 500),
    topics,
    leaveOutCustomers: form.get("leaveOutCustomers") === "yes",
  });
  if (!imported.ok) return NextResponse.json(imported, { status: 422 });

  await recordAudit({
    userId: gate.userId,
    action: "CREATE",
    entityType: "MarketingList",
    entityId: imported.data.listId,
    entityLabel: `${name} — ${imported.data.imported} people from ${file.name} (${imported.data.createdContacts} new contacts; ${Object.values(imported.data.rejected).reduce((a, b) => a + b, 0)} left out, ${imported.data.suppressed} suppressed as not working)`,
  });
  revalidatePath("/marketing/send");
  revalidatePath("/marketing/lists");
  revalidatePath("/marketing/suppressions");
  return NextResponse.json(imported);
}
