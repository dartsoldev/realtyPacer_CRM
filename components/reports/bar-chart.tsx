"use client";

/**
 * Minimal horizontal bar chart (SVG, no chart library). Loaded lazily; every
 * chart has the same numbers in a table next to it for screen readers and print.
 */
export default function BarChart({ rows, format }: { rows: { label: string; value: number }[]; format: (v: number) => string }) {
  const data = rows.slice(0, 12);
  const max = Math.max(1, ...data.map((r) => Math.abs(r.value)));
  const rowH = 26;
  const labelW = 130;
  const width = 520;
  return (
    <svg role="img" aria-hidden="true" viewBox={`0 0 ${width} ${data.length * rowH + 4}`} className="h-auto w-full max-w-xl">
      {data.map((r, i) => {
        const w = Math.max(2, (Math.abs(r.value) / max) * (width - labelW - 90));
        return (
          <g key={`${r.label}-${i}`} transform={`translate(0 ${i * rowH + 2})`}>
            <text x={labelW - 6} y={rowH / 2 + 4} textAnchor="end" className="fill-current text-[11px] text-muted">
              {r.label.length > 20 ? `${r.label.slice(0, 19)}…` : r.label}
            </text>
            <rect x={labelW} y={4} width={w} height={rowH - 10} rx={3} className={r.value < 0 ? "fill-danger/70" : "fill-brand/80"} />
            <text x={labelW + w + 6} y={rowH / 2 + 4} className="fill-current text-[11px]">
              {format(r.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
