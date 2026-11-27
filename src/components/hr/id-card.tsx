/* eslint-disable @next/next/no-img-element -- data URLs printed on paper; next/image has nothing to optimise here */
import type { CSSProperties } from "react";
import { CARD_H_MM, CARD_W_MM, defaultBackNote, inkOn, type IdCardData, type IdCardIssuer } from "@/lib/id-cards/design";

/**
 * One employee ID card, front or back (owner, 31 Oct 2026 — src/lib/id-cards), drawn in millimetres so it prints at
 * the real card's size. No hooks: the print page, the design page's preview and a check script all draw it the same.
 */

const card: CSSProperties = {
  width: `${CARD_W_MM}mm`,
  height: `${CARD_H_MM}mm`,
  boxSizing: "border-box",
  position: "relative",
  overflow: "hidden",
  background: "#ffffff",
  color: "#111111",
  fontFamily: "Inter, 'Segoe UI', Arial, sans-serif",
  borderRadius: "3mm",
  WebkitPrintColorAdjust: "exact",
  printColorAdjust: "exact",
};

export function IdCardFront({ data, issuer, outline = true }: { data: IdCardData; issuer: IdCardIssuer; outline?: boolean }) {
  const ink = inkOn(issuer.accent);
  return (
    <div style={{ ...card, border: outline ? "0.2mm solid #d4d4d8" : undefined }} className="id-card">
      <div style={{ background: issuer.accent, color: ink, height: "24mm", padding: "3mm 3.5mm 0", display: "flex", alignItems: "flex-start", gap: "2mm" }}>
        {issuer.logoDataUrl && (
          <div style={{ background: "#ffffff", borderRadius: "1.5mm", padding: "0.8mm", display: "flex", alignItems: "center", justifyContent: "center", height: "8mm", maxWidth: "20mm", flexShrink: 0 }}>
            <img src={issuer.logoDataUrl} alt="" style={{ maxHeight: "6.4mm", maxWidth: "18.4mm", objectFit: "contain" }} />
          </div>
        )}
        <div style={{ fontSize: "7.5pt", fontWeight: 700, lineHeight: 1.15, paddingTop: "0.6mm", overflow: "hidden", maxHeight: "8mm" }}>{issuer.company}</div>
      </div>
      <div style={{ position: "absolute", top: "13mm", left: 0, right: 0, display: "flex", justifyContent: "center" }}>
        <div style={{ width: "25mm", height: "29mm", borderRadius: "2.5mm", border: "0.8mm solid #ffffff", background: "#f4f4f5", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0.3mm 1mm rgba(0,0,0,0.15)" }}>
          {data.photoDataUrl ? (
            <img src={data.photoDataUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span style={{ fontSize: "16pt", fontWeight: 700, color: issuer.accent }}>{data.initials}</span>
          )}
        </div>
      </div>
      <div style={{ position: "absolute", top: "45mm", left: "3mm", right: "3mm", textAlign: "center" }}>
        <div style={{ fontSize: "10.5pt", fontWeight: 700, lineHeight: 1.15, maxHeight: "9.5mm", overflow: "hidden" }}>{data.name}</div>
        {data.designation && <div style={{ fontSize: "7.5pt", color: "#3f3f46", marginTop: "0.8mm", lineHeight: 1.2 }}>{data.designation}</div>}
        {data.department && <div style={{ fontSize: "6.5pt", color: "#71717a", marginTop: "0.4mm" }}>{data.department}</div>}
      </div>
      <div style={{ position: "absolute", bottom: "6mm", left: "3.5mm", right: "3.5mm", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "2mm" }}>
        <div>
          <div style={{ fontSize: "5.5pt", color: "#71717a", textTransform: "uppercase", letterSpacing: "0.3mm" }}>Employee ID</div>
          <div style={{ fontSize: "8.5pt", fontWeight: 700, fontFamily: "ui-monospace, Consolas, monospace" }}>{data.employeeCode ?? "—"}</div>
        </div>
        {data.bloodGroup && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: "5.5pt", color: "#71717a", textTransform: "uppercase", letterSpacing: "0.3mm" }}>Blood group</div>
            <div style={{ fontSize: "8.5pt", fontWeight: 700, color: "#b91c1c" }}>{data.bloodGroup}</div>
          </div>
        )}
      </div>
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "3mm", background: issuer.accent }} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginTop: "1.6mm" }}>
      <div style={{ fontSize: "5.5pt", color: "#71717a", textTransform: "uppercase", letterSpacing: "0.3mm" }}>{label}</div>
      <div style={{ fontSize: "7pt", fontWeight: 600, lineHeight: 1.2, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

export function IdCardBack({ data, issuer, backNote, outline = true }: { data: IdCardData; issuer: IdCardIssuer; backNote: string | null; outline?: boolean }) {
  const emergency = data.emergency ? [data.emergency.name, data.emergency.relation ? `(${data.emergency.relation})` : null, data.emergency.phone].filter(Boolean).join(" ") : null;
  return (
    <div style={{ ...card, border: outline ? "0.2mm solid #d4d4d8" : undefined, padding: "4mm 3.5mm" }} className="id-card">
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "2mm", background: issuer.accent }} />
      {emergency && <Row label="In an emergency, call" value={emergency} />}
      {data.joinedOn && <Row label="Joined on" value={data.joinedOn} />}
      {data.workPhone && <Row label="Phone" value={data.workPhone} />}
      {data.email && <Row label="Email" value={data.email} />}
      <div style={{ position: "absolute", top: "38mm", left: 0, right: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <img src={data.qrDataUrl} alt="" style={{ width: "17mm", height: "17mm" }} />
        <div style={{ fontSize: "5.5pt", color: "#71717a", marginTop: "0.6mm" }}>Scan to check this card</div>
      </div>
      <div style={{ position: "absolute", bottom: "4mm", left: "3.5mm", right: "3.5mm" }}>
        {issuer.signatureDataUrl && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginBottom: "1.5mm" }}>
            <img src={issuer.signatureDataUrl} alt="" style={{ maxHeight: "6mm", maxWidth: "22mm", objectFit: "contain" }} />
            <div style={{ fontSize: "5pt", color: "#71717a", borderTop: "0.2mm solid #a1a1aa", paddingTop: "0.3mm" }}>Authorised signatory</div>
          </div>
        )}
        <div style={{ fontSize: "5.5pt", color: "#3f3f46", lineHeight: 1.3 }}>{backNote ?? defaultBackNote(issuer.company)}</div>
        {issuer.address && <div style={{ fontSize: "5.5pt", fontWeight: 600, lineHeight: 1.3, marginTop: "0.6mm" }}>{issuer.address}</div>}
        {issuer.phone && <div style={{ fontSize: "5.5pt", color: "#3f3f46", marginTop: "0.3mm" }}>{issuer.phone}</div>}
      </div>
    </div>
  );
}

/** The space a card leaves where a sheet has none: keeps the backs behind their fronts. */
export function IdCardBlank() {
  return <div style={{ width: `${CARD_W_MM}mm`, height: `${CARD_H_MM}mm` }} />;
}
