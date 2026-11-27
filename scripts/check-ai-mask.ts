/**
 * check:ai-mask — what Deskzo AI masks before a provider sees it, and what it leaves alone (src/lib/ai/mask.ts).
 * Pure: no database, no network. Made-up names and numbers only.
 */
import { Masker, type NamedEntry } from "../src/lib/ai/mask";
import type { Turn } from "../src/lib/copilot/types";

const names: NamedEntry[] = [
  { value: "Acme Industries Pvt Ltd", kind: "COMPANY" },
  { value: "Rahul Verma", kind: "PERSON" },
  { value: "Purchase Team", kind: "PERSON" },
  { value: "Will Smith", kind: "PERSON" },
  { value: "Bisleri Pvt Ltd", kind: "COMPANY" },
  { value: "Bisleri LLP", kind: "COMPANY" },
  { value: "Microsoft Support", kind: "PERSON" },
  { value: "Amit R. Shah", kind: "PERSON" },
];
let bad = 0;
const fail = (n: string, x: unknown) => {
  bad++;
  console.log("FAIL", n, x);
};
const hide: [string, string, string][] = [
  ["company", "Show Acme Industries Pvt Ltd invoices", "Acme"],
  ["person", "Call Rahul Verma", "Rahul"],
  ["first", "Call Rahul today", "Rahul"],
  ["first lower", "call rahul", "rahul"],
  ["last", "Mr Shah called", "Shah"],
  ["shared short", "What does Bisleri owe?", "Bisleri"],
  ["unknown legal", "Met Zenkraft Labs Pvt Ltd today", "Zenkraft"],
  ["unknown llp", "for Om Sai & Sons LLP", "Om Sai"],
  ["email", "mail raj@zen.in", "raj@"],
  ["mob", "ring +91 98765 43210", "98765"],
  ["mob2", "ring 9876543210", "98765"],
  ["land", "ring 022-27654321", "27654321"],
  ["land2", "ring (022) 2765 4321", "2765"],
  ["land3", "ring +91 22 27654321", "27654321"],
  ["abroad", "ring +1 415 555 2671", "555"],
  ["abroad2", "ring +971501234567", "50123"],
  ["gstin lower", "gst 27aapfu0939f1zv", "aapfu"],
  ["pan lower", "pan aapfu0939f", "aapfu"],
  ["ifsc lower", "hdfc0001234", "hdfc000"],
  ["aadhaar", "2345 6789 0123", "6789"],
  ["acct", "A/c 50100234567890", "50100"],
  ["card", "4111 1111 1111 1111", "1111"],
  ["addr", "Flat 4B, 12 MG Road, Pune 411001", "MG Road"],
  ["addr2", "deliver to 12 mg road", "mg road"],
  ["addr3", "at 45/2, Linking Rd Mumbai", "Linking"],
  ["addr4", "Plot No. 7, MIDC Phase 2, Bhosari 411 026", "MIDC"],
];
for (const [n, t, leak] of hide) {
  const m = new Masker("t1", names);
  const o = m.mask(t);
  if (o.includes(leak)) fail(n, o);
  const again = m.mask(o);
  if (again !== o) fail(n + " idempotent", again);
  if (m.unmask(o).toLowerCase() !== t.toLowerCase() && n !== "company") fail(n + " roundtrip", m.unmask(o));
}
const keep = [
  "Will you mark the bill as done?",
  "Show 10 leads in Gandhi Nagar",
  "5 orders for the road project",
  "Invoice INV-000123 of ₹4,11,001 due 12 May 2026",
  "Microsoft 365 renewal for 50 users",
  "COM-000123 and LEAD-000045",
  "amount 411001 on 2026-11-24",
  "Total 12,50,000.00 in 2025-26",
  "purchase team report",
  "3 tasks for next week",
  "What is limited by the plan? The offer is Limited",
  "top 10 customers 2024 2025",
  "0.18 tax 1000 units",
  "margin +15% and +20 units",
  "ring 100 of 2000 2000",
];
for (const t of keep) {
  const o = new Masker("t1", names).mask(t);
  if (o !== t) fail("kept", t + " => " + o);
}
// tool output
const m = new Masker("t1", []);
const out = JSON.stringify({ rows: Array.from({ length: 30 }, (_, i) => ({ company: "Zedco" + i, contact: "Nila Rao" + i, billingAddress: "Shed " + i + "\nOpp Lake, Thane" })) });
const cut = out.slice(0, 900) + "… (cut short — narrow the question)";
const h = m.maskHistory([{ role: "tool", results: [{ id: "a", name: "x", output: cut }] }] as Turn[]);
const txt = (h[0] as Extract<Turn, { role: "tool" }>).results[0]!.output;
if (/Zedco|Opp Lake|Nila/.test(txt)) fail("cut tool output", txt);
// old vs marked native, files
const th = [
  { type: "thinking", thinking: "Rahul Verma owes", signature: "s" },
  { type: "text", text: "Rahul Verma" },
];
const h2 = new Masker("t1", names).maskHistory([
  { role: "assistant", text: "Rahul Verma", toolCalls: [], native: { provider: "ANTHROPIC", model: "m", content: th } },
  { role: "assistant", text: "x", toolCalls: [], native: { provider: "ANTHROPIC", model: "m", content: [{ type: "thinking", thinking: "PERSON_AAAAA", signature: "s" }], masked: true } },
  { role: "user", text: "q", files: [{ name: "Acme.pdf", mediaType: "application/pdf", data: "QUJD" }] },
] as Turn[]);
if (JSON.stringify(h2).includes("Rahul") || (h2[0] as { native?: unknown }).native) fail("old native", h2[0]);
if (!(h2[1] as { native?: unknown }).native) fail("marked native kept", h2[1]);
if ((h2[2] as { files?: unknown }).files) fail("files", h2[2]);
// stream
{
  const m = new Masker("t1", names);
  const a = m.mask("Flat 4B, 12 MG Road, Pune 411001 for Rahul");
  let s = "";
  const st = m.streaming((d) => (s += d));
  for (const c of a) st.push(c);
  st.end();
  if (s !== "Flat 4B, 12 MG Road, Pune 411001 for Rahul") fail("stream", s);
}
// speed
const big: NamedEntry[] = [];
for (let i = 0; i < 30000; i++) {
  big.push(
    { value: "Company " + i.toString(36) + "x Traders Pvt Ltd", kind: "COMPANY" },
    { value: "Fn" + i.toString(36).replace(/\d/g, "q") + " Ln" + (i % 999).toString(36).replace(/\d/g, "z"), kind: "PERSON" },
  );
}
let t0 = Date.now();
const bm = new Masker("t", big);
if (Date.now() - t0 > 5000) fail("60,000 names took too long", Date.now() - t0);
t0 = Date.now();
bm.mask("Company 5x Traders owes 12,000 and 12 MG Road. ".repeat(800));
if (Date.now() - t0 > 2000) fail("38KB took too long", Date.now() - t0);
t0 = Date.now();
new Masker("t", []).mask("Flat a" + " b,c".repeat(20000));
new Masker("t", []).mask(("12 " + "abc ".repeat(8)).repeat(4000));
new Masker("t", []).mask("Aa ".repeat(20000));
if (Date.now() - t0 > 5000) fail("awkward text took too long", Date.now() - t0);
console.log(bad ? `${bad} check(s) FAILED` : `All masking checks passed (${hide.length} hidden, ${keep.length} left alone).`);
process.exit(bad ? 1 : 0);
