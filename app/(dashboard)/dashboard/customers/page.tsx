import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowUp, Plus, Search, Users, X } from "lucide-react";
import { ColumnPicker } from "@/components/ops/column-picker";
import { PhoneLink } from "@/components/ops/contact";
import { AccessDenied } from "@/components/shell/access";
import { plural } from "@/components/shell/nav-config";
import { Badge } from "@/components/ui/badge";
import { buttonClasses, LinkButton } from "@/components/ui/button";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Pagination } from "@/components/ui/pagination";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { CUSTOMER_TYPE_LABELS } from "@/lib/domain/constants";
import { formatDate } from "@/lib/domain/time";
import { CUSTOMER_COLUMNS, customerListQuery, DEFAULT_CUSTOMER_COLUMNS, type CustomerColumn } from "@/modules/customers/schemas";
import { listCustomers } from "@/modules/customers/service";
import { formatCustomValue } from "@/components/custom-fields/values";
import { formatCents } from "@/lib/domain/money";
import { customFieldDefsFor } from "@/modules/custom-fields/service";
import { decodeDefinition, OPERATOR_LABELS, type Operator } from "@/modules/reports/definition";
import { fieldsWithOptions } from "@/modules/reports/filters";

export const metadata: Metadata = { title: "Customers" };

const COLUMN_LABELS: Record<CustomerColumn, string> = {
  phone: "Phone",
  email: "Email",
  city: "City (current default address)",
  tags: "Tags",
  type: "Type",
  since: "Customer since",
  created: "Added",
};

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CustomersPage({ searchParams }: { searchParams: SP }) {
  const user = await requirePageUser("/dashboard/customers");
  if (!can(user, "customers:read")) return <AccessDenied />;
  const raw = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v)) as Record<string, string>;
  const parsed = customerListQuery.safeParse(raw);
  const query = parsed.success ? parsed.data : customerListQuery.parse({});
  const cols: CustomerColumn[] = raw.cols ? (raw.cols.split(",").filter((c) => (CUSTOMER_COLUMNS as readonly string[]).includes(c)) as CustomerColumn[]) : DEFAULT_CUSTOMER_COLUMNS;
  const [result, cfDefs, filterFields] = await Promise.all([
    listCustomers(user, query),
    customFieldDefsFor(user.organizationId, "customer").then((d) => d.filter((x) => x.showInTable && !x.archived)),
    query.f ? fieldsWithOptions(user, "customer_list") : Promise.resolve([]),
  ]);
  let advanced: string[] = [];
  if (query.f) {
    try {
      const conds = decodeDefinition(query.f) as { field: string; op: Operator; value?: unknown }[];
      const byKey = new Map(filterFields.map((f) => [f.key, f]));
      advanced = (Array.isArray(conds) ? conds : []).map((c) => {
        const f = byKey.get(c.field);
        const v = c.value === undefined ? "" : f?.type === "money" && typeof c.value === "number" ? formatCents(c.value, user.organization.currency) : Array.isArray(c.value) ? c.value.map((x) => f?.options?.find((o) => o.value === x)?.label ?? String(x)).join(" or ") : (f?.options?.find((o) => o.value === c.value)?.label ?? String(c.value));
        return `${f?.label ?? "Unavailable field"} ${OPERATOR_LABELS[c.op] ?? ""} ${v}`.trim();
      });
    } catch {
      advanced = ["Advanced filter"];
    }
  }
  const label = plural(user.organization.terminology.customer);
  const tz = user.organization.timezone;

  const keep = { q: query.q, city: query.city, tag: query.tag, status: query.status !== "active" ? query.status : undefined, sort: query.sort !== "name" ? query.sort : undefined, dir: query.dir !== "asc" ? query.dir : undefined, cols: raw.cols, f: query.f };
  const active = [
    query.q ? { key: "q", text: `Search: “${query.q}”` } : null,
    query.city ? { key: "city", text: `City: ${query.city}` } : null,
    query.tag ? { key: "tag", text: `Tag: ${query.tag}` } : null,
    query.status !== "active" ? { key: "status", text: query.status === "archived" ? "Archived only" : "Active and archived" } : null,
    query.f ? { key: "f", text: advanced.join(" AND ") || "Advanced filter" } : null,
  ].filter(Boolean) as { key: string; text: string }[];
  const hrefWithout = (key: string) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(keep)) if (v && k !== key) sp.set(k, v);
    return `/dashboard/customers${sp.size ? `?${sp}` : ""}`;
  };
  const sortHref = (sort: string) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(keep)) if (v && k !== "sort" && k !== "dir") sp.set(k, v);
    sp.set("sort", sort);
    sp.set("dir", query.sort === sort && query.dir === "asc" ? "desc" : "asc");
    return `/dashboard/customers?${sp}`;
  };
  const SortIcon = query.dir === "asc" ? ArrowUp : ArrowDown;

  return (
    <>
      <PageHeader
        title={label}
        description="Search by name, phone (any format) or email. City filters use each customer’s current service addresses."
        actions={can(user, "customers:write") ? <LinkButton href="/dashboard/customers/new"><Plus className="size-4" aria-hidden /> Add {user.organization.terminology.customer.toLowerCase()}</LinkButton> : null}
      />
      <Card>
        <form method="get" role="search" aria-label={`Filter ${label.toLowerCase()}`} className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          {raw.cols ? <input type="hidden" name="cols" value={raw.cols} /> : null}
          <label className="min-w-52 flex-1 text-sm">
            <span className="mb-1 block font-medium">Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <input name="q" defaultValue={query.q ?? ""} maxLength={100} placeholder="Name, phone or email" className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-base sm:text-sm" />
            </span>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">City</span>
            <input name="city" defaultValue={query.city ?? ""} maxLength={100} className="h-10 w-36 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Tag</span>
            <input name="tag" defaultValue={query.tag ?? ""} maxLength={30} className="h-10 w-28 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Status</span>
            <select name="status" defaultValue={query.status} className="h-10 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm">
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
          </label>
          <button type="submit" className={buttonClasses("secondary", "sm", "h-10")}>Apply</button>
          <div className="ml-auto">
            <ColumnPicker options={CUSTOMER_COLUMNS.map((k) => ({ key: k, label: COLUMN_LABELS[k] }))} selected={cols} />
          </div>
        </form>

        {active.length ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm" aria-label="Active filters">
            <span className="text-muted">Filters:</span>
            {active.map((f) => (
              <Link key={f.key} href={hrefWithout(f.key)} className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand hover:underline" aria-label={`Remove filter ${f.text}`}>
                {f.text} <X className="size-3" aria-hidden />
              </Link>
            ))}
            <Link href={raw.cols ? `/dashboard/customers?cols=${encodeURIComponent(raw.cols)}` : "/dashboard/customers"} className="text-xs font-medium text-muted underline">
              Reset all
            </Link>
          </div>
        ) : null}

        {result.warnings.length ? <p className="border-b border-line px-4 py-2 text-sm text-pending">{result.warnings.join(" ")}</p> : null}
        {result.items.length === 0 ? (
          <EmptyState icon={Users} title={active.length ? `No ${label.toLowerCase()} match these filters` : `No ${label.toLowerCase()} yet`}>
            {active.length ? "Try different filters or reset them." : can(user, "customers:write") ? "Add your first customer to start booking jobs." : "Customers added by your team will appear here."}
          </EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-line md:hidden" aria-label={label}>
              {result.items.map((c) => (
                <li key={c.id} className="space-y-1 px-4 py-3 text-sm">
                  <Link href={`/dashboard/customers/${c.id}`} className="font-medium text-ink underline-offset-4 hover:underline">
                    {c.name}
                  </Link>
                  {c.archived ? <Badge tone="slate" className="ml-2">Archived</Badge> : null}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
                    <PhoneLink e164={c.phone} display={c.phoneDisplay} />
                    {c.primaryCity ? <span>{c.primaryCity}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{label}</caption>
                <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="px-5 py-3 font-semibold" aria-sort={query.sort === "name" ? (query.dir === "asc" ? "ascending" : "descending") : undefined}>
                      <Link href={sortHref("name")} className="inline-flex items-center gap-1 hover:text-ink">
                        Name {query.sort === "name" ? <SortIcon className="size-3" aria-hidden /> : null}
                      </Link>
                    </th>
                    {cols.includes("phone") ? <th scope="col" className="px-3 py-3 font-semibold">Phone</th> : null}
                    {cols.includes("email") ? <th scope="col" className="px-3 py-3 font-semibold">Email</th> : null}
                    {cols.includes("city") ? <th scope="col" className="px-3 py-3 font-semibold">City</th> : null}
                    {cols.includes("tags") ? <th scope="col" className="px-3 py-3 font-semibold">Tags</th> : null}
                    {cols.includes("type") ? <th scope="col" className="px-3 py-3 font-semibold">Type</th> : null}
                    {cols.includes("since") ? (
                      <th scope="col" className="px-3 py-3 font-semibold">
                        <Link href={sortHref("relationshipStartedAt")} className="inline-flex items-center gap-1 hover:text-ink">
                          Customer since {query.sort === "relationshipStartedAt" ? <SortIcon className="size-3" aria-hidden /> : null}
                        </Link>
                      </th>
                    ) : null}
                    {cfDefs.map((d) => <th key={d.key} scope="col" className="px-3 py-3 font-semibold">{d.label}</th>)}
                    {cols.includes("created") ? (
                      <th scope="col" className="px-3 py-3 font-semibold">
                        <Link href={sortHref("createdAt")} className="inline-flex items-center gap-1 hover:text-ink">
                          Added {query.sort === "createdAt" ? <SortIcon className="size-3" aria-hidden /> : null}
                        </Link>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.items.map((c) => (
                    <tr key={c.id}>
                      <td className="px-5 py-3">
                        <Link href={`/dashboard/customers/${c.id}`} className="font-medium text-ink underline-offset-4 hover:underline">
                          {c.name}
                        </Link>
                        {c.archived ? <Badge tone="slate" className="ml-2">Archived</Badge> : null}
                      </td>
                      {cols.includes("phone") ? <td className="px-3 py-3">{c.phone ? <PhoneLink e164={c.phone} display={c.phoneDisplay} /> : <span className="text-muted">—</span>}</td> : null}
                      {cols.includes("email") ? <td className="break-all px-3 py-3 text-muted">{c.email ?? "—"}</td> : null}
                      {cols.includes("city") ? <td className="px-3 py-3 text-muted">{c.primaryCity ?? "—"}</td> : null}
                      {cols.includes("tags") ? (
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">
                            {c.tags.length ? c.tags.map((t) => <Badge key={t} tone="purple">{t}</Badge>) : <span className="text-muted">—</span>}
                          </div>
                        </td>
                      ) : null}
                      {cols.includes("type") ? <td className="px-3 py-3 text-muted">{CUSTOMER_TYPE_LABELS[c.customerType]}</td> : null}
                      {cols.includes("since") ? <td className="px-3 py-3 text-muted">{c.relationshipStartedAt ? formatDate(`${c.relationshipStartedAt}T12:00:00Z`, "UTC") : "Not specified"}</td> : null}
                      {cfDefs.map((d) => <td key={d.key} className="px-3 py-3 text-muted">{formatCustomValue(d, c.customFields?.[d.key], tz)}</td>)}
                      {cols.includes("created") ? <td className="px-3 py-3 text-muted">{formatDate(c.createdAt, tz)}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <Pagination page={result.page} totalPages={result.totalPages} total={result.total} basePath="/dashboard/customers" params={keep} />
      </Card>
    </>
  );
}
