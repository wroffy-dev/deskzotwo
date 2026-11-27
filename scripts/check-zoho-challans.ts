/**
 * check:zoho-challans — Zoho's delivery challans, brought to the archive (owner, 16 Nov 2026: "delivery challans not
 * fetched from zoho books"; src/lib/zoho/pull.ts, rows.ts, src/lib/migration/archive.ts, upload.ts).
 *
 *   · the pull asks for them, optionally (an organisation without challans doesn't fail the pull), files them as
 *     Delivery_Challan.csv, hands them to no step, and fetches their PDFs as it does the others';
 *   · a challan from Zoho's API as rows: a row a line, its number, date, customer, type, status, total;
 *   · the file is recognised as challans, and every challan becomes an archived "Delivery challan" — open or
 *     delivered, this year or earlier — with its lines.
 *
 *   npm run check:zoho-challans
 */
import "dotenv/config";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

async function main() {
  const pull = await import("../src/lib/zoho/pull");
  const mod = pull.MODULES.find((m) => m.key === "deliverychallans");
  ok("the pull asks Zoho for delivery challans, optionally", mod?.path === "/deliverychallans" && mod.listKey === "deliverychallans" && mod.optional === true, mod);
  ok("  their files go to no step of the switch — the archive", JSON.stringify(pull.MODULE_STEPS.deliverychallans) === "[]");

  const rows = await import("../src/lib/zoho/rows");
  const zoho = {
    deliverychallan_id: "4600000012345",
    deliverychallan_number: "DC-00042",
    date: "2025-08-14",
    status: "delivered",
    challan_type: "job work",
    customer_id: "4600000000777",
    customer_name: "Sunrise Engineering Pvt Ltd",
    reference_number: "SO-00019",
    currency_code: "INR",
    total: 23600,
    line_items: [
      { name: "Laptop", quantity: 2, rate: 10000, tax_percentage: 18, item_total: 20000 },
      { name: "Bag", quantity: 2, rate: 0, item_total: 0, description: "Free with laptop" },
    ],
  };
  const written = rows.challanRows(zoho);
  ok("a challan with two lines is two rows", written.length === 2);
  ok(
    "  each with its number, date, customer, type, status and total",
    written.every((r) => r["Delivery Challan Number"] === "DC-00042" && r["Challan Date"] === "2025-08-14" && r["Customer Name"] === "Sunrise Engineering Pvt Ltd" && r["Challan Type"] === "job work" && r.Status === "delivered" && r.Total === "23600"),
    written[0],
  );
  ok("  and its lines' quantity and rate", written[0]!["Item Name"] === "Laptop" && written[0]!.Quantity === "2" && written[0]!["Item Price"] === "10000");

  const archive = await import("../src/lib/migration/archive");
  ok("the file is recognised as Zoho's challans, an invoice file isn't", archive.isZohoChallans(written) && !archive.isZohoChallans([{ "Invoice ID": "1", "Invoice Number": "INV-1" }]));
  const open = rows.challanRows({ ...zoho, deliverychallan_id: "4600000012346", deliverychallan_number: "DC-00043", date: "2026-11-02", status: "open", line_items: [] });
  const { documents, undated } = archive.archiveChallans([...written, ...open]);
  const dc42 = documents.find((d) => d.number === "DC-00042");
  ok("every challan is archived — delivered last year and open this year alike", documents.length === 2 && undated === 0 && documents.every((d) => d.kind === "DELIVERY_CHALLAN"), documents.map((d) => d.number));
  ok(
    "  with its customer, status, total, reference and Zoho's id",
    dc42?.partyName === "Sunrise Engineering Pvt Ltd" && dc42.status === "delivered" && Number(dc42.total) === 23600 && dc42.reference === "SO-00019" && dc42.oldId === "4600000012345" && dc42.year === "2025-26",
    dc42,
  );
  ok("  and its two lines", Array.isArray(dc42?.lines) && (dc42!.lines as unknown[]).length === 2);
  ok("it reads as a delivery challan", archive.ARCHIVE_LABELS.DELIVERY_CHALLAN === "Delivery challan");
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
