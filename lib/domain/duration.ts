/** Relationship length between two "YYYY-MM-DD" dates, e.g. "2 years, 3 months". */
export function relationshipDuration(fromKey: string | null, todayKeyValue: string): string {
  if (!fromKey) return "Not specified";
  const [fy, fm, fd] = fromKey.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = todayKeyValue.split("-").map(Number) as [number, number, number];
  let months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  if (months < 0) return "Starts in the future";
  if (months === 0) return "Less than a month";
  const years = Math.floor(months / 12);
  months %= 12;
  const parts = [];
  if (years) parts.push(`${years} year${years === 1 ? "" : "s"}`);
  if (months) parts.push(`${months} month${months === 1 ? "" : "s"}`);
  return parts.join(", ");
}

export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
