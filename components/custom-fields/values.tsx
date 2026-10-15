import { isSafeHttpUrl } from "@/lib/domain/links";
import { formatDate } from "@/lib/domain/time";
import type { CustomFieldDef } from "@/modules/custom-fields/service";

export function formatCustomValue(d: CustomFieldDef, v: unknown, timezone: string): string {
  if (v === null || v === undefined || v === "") return "—";
  switch (d.dataType) {
    case "boolean":
      return v ? "Yes" : "No";
    case "date":
      return typeof v === "string" ? formatDate(`${v}T12:00:00Z`, "UTC") : "—";
    case "single_select":
      return d.options.find((o) => o.value === v)?.label ?? "—";
    case "multi_select":
      return Array.isArray(v) ? v.map((x) => d.options.find((o) => o.value === x)?.label ?? "").filter(Boolean).join(", ") || "—" : "—";
    default:
      return void timezone, String(v);
  }
}

/** Read-only list of the values the server already filtered for this viewer. */
export function CustomFieldValues({ defs, values, timezone }: { defs: CustomFieldDef[]; values: Record<string, unknown> | null | undefined; timezone: string }) {
  const shown = defs.filter((d) => !d.archived && values && d.key in values);
  if (shown.length === 0) return <p className="px-5 py-4 text-sm text-muted">No additional details recorded.</p>;
  return (
    <dl className="grid gap-x-6 gap-y-2 px-5 py-4 text-sm sm:grid-cols-[auto_1fr]">
      {shown.map((d) => {
        const v = values![d.key];
        return (
          <div key={d.key} className="contents">
            <dt className="text-muted">{d.label}</dt>
            <dd className="whitespace-pre-wrap break-words">
              {d.dataType === "url" && typeof v === "string" && isSafeHttpUrl(v) ? (
                <a href={v} target="_blank" rel="noopener noreferrer nofollow" className="text-brand underline-offset-4 hover:underline">{v}</a>
              ) : (
                formatCustomValue(d, v, timezone)
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
