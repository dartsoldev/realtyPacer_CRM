"use client";

import { Filter } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { encodeDefinition } from "@/modules/reports/definition";

type Option = { value: string; label: string };

/** Dashboard shortcut: City AND Service → the full customer & service filter. */
export function QuickCustomerFilter({ cities, services }: { cities: Option[]; services: Option[] }) {
  const router = useRouter();
  const [city, setCity] = useState("");
  const [service, setService] = useState("");
  const go = () => {
    const conditions = [...(city ? [{ field: "city", op: "eq", value: city }] : []), ...(service ? [{ field: "service", op: "eq", value: service }] : [])];
    router.push(`/dashboard/customer-filter${conditions.length ? `?f=${encodeDefinition(conditions)}` : ""}`);
  };
  const select = "h-11 w-full rounded-lg border border-line bg-surface px-3 text-base sm:text-sm";
  return (
    <form className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); go(); }}>
      <label className="text-sm">
        <span className="mb-1 block font-medium">Service city</span>
        <select className={select} value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="">Any city</option>
          {cities.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
      <span className="hidden pb-3 text-xs font-semibold text-muted sm:block">AND</span>
      <label className="text-sm">
        <span className="mb-1 block font-medium">Service</span>
        <select className={select} value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">Any service</option>
          {services.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </label>
      <Button type="submit"><Filter className="size-4" aria-hidden /> Show customers</Button>
    </form>
  );
}
