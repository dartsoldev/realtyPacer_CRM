import { ImageResponse } from "next/og";

export const alt = "RealtyPacer — CRM for cleaning and service businesses";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", padding: 80, background: "#FFFFFF", borderTop: "24px solid #DC2626" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div style={{ width: 96, height: 96, borderRadius: 24, background: "#DC2626", display: "flex", alignItems: "center", justifyContent: "center", color: "#FFFFFF", fontSize: 64, fontWeight: 700 }}>»</div>
          <div style={{ fontSize: 72, fontWeight: 700, color: "#111827", display: "flex" }}>
            Realty<span style={{ color: "#DC2626" }}>Pacer</span>
          </div>
        </div>
        <div style={{ marginTop: 40, fontSize: 40, color: "#374151" }}>CRM for cleaning and service businesses</div>
        <div style={{ marginTop: 16, fontSize: 28, color: "#64748B" }}>Customers · Scheduling · Payments · Reports</div>
      </div>
    ),
    size,
  );
}
