import type { Metadata } from "next";
import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { FieldRowActions, NewFieldButton } from "@/components/custom-fields/field-admin";
import { AccessDenied } from "@/components/shell/access";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPE_LABELS, type CustomFieldEntity } from "@/lib/domain/constants";
import { listDefinitions } from "@/modules/custom-fields/service";

export const metadata: Metadata = { title: "Custom fields" };

const ENTITY_LABELS: Record<CustomFieldEntity, string> = { customer: "Customers", booking: "Bookings", cleaner: "Cleaners" };

export default async function CustomFieldsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/custom-fields");
  if (!can(user, "customFields:manage")) return <AccessDenied />;
  const sp = await searchParams;
  const entity = (CUSTOM_FIELD_ENTITIES as readonly string[]).includes(String(sp.entity)) ? (sp.entity as CustomFieldEntity) : "customer";
  const defs = await listDefinitions(user, entity, true);
  const active = defs.filter((d) => !d.archived);
  const archived = defs.filter((d) => d.archived);

  return (
    <>
      <PageHeader
        title="Custom fields"
        description="Add your own fields to customers, bookings and cleaners. Fields can be renamed or archived without losing data."
        actions={<NewFieldButton entity={entity} />}
      />
      <nav aria-label="Record type" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {CUSTOM_FIELD_ENTITIES.map((e) => (
          <Link
            key={e}
            href={`/dashboard/custom-fields?entity=${e}`}
            aria-current={entity === e ? "page" : undefined}
            className={cn("whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", entity === e ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink")}
          >
            {ENTITY_LABELS[e]}
          </Link>
        ))}
      </nav>
      <Card>
        {defs.length === 0 ? (
          <EmptyState icon={SlidersHorizontal} title={`No custom fields for ${ENTITY_LABELS[entity].toLowerCase()} yet`}>
            Examples: number of pets, gate code, preferred day, carpet type.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="bg-canvas text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Field</th>
                  <th scope="col" className="px-4 py-2 font-medium">Type</th>
                  <th scope="col" className="px-4 py-2 font-medium">Settings</th>
                  <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {[...active, ...archived].map((d) => (
                  <tr key={d.id} className={d.archived ? "text-muted" : undefined}>
                    <td className="px-4 py-2">
                      <span className="font-medium">{d.label}</span>
                      <span className="block font-mono text-xs text-muted">{d.key}</span>
                    </td>
                    <td className="px-4 py-2">
                      {CUSTOM_FIELD_TYPE_LABELS[d.dataType]}
                      {d.options.length ? <span className="block text-xs text-muted">{d.options.filter((o) => !o.archived).map((o) => o.label).join(", ")}</span> : null}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {d.archived ? <Badge tone="slate">Archived</Badge> : null}
                        {d.required ? <Badge tone="pending">Required for new</Badge> : null}
                        {d.showInTable ? <Badge tone="info">List column</Badge> : null}
                        {d.filterable ? <Badge tone="teal">Filterable</Badge> : null}
                        {d.indexed ? <Badge tone="purple">Indexed</Badge> : null}
                        {entity === "booking" ? <Badge tone="slate">{d.visibility === "assigned_cleaners" ? "Visible to cleaners" : "Office only"}</Badge> : null}
                      </div>
                    </td>
                    <td className="px-4 py-2"><FieldRowActions def={d} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">Indexes for “Speed up filtering” are created by running <code>npm run db:indexes</code> during maintenance.</p>
    </>
  );
}
