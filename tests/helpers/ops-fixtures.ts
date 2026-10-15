import { randomUUID } from "node:crypto";
import type { Types } from "mongoose";
import { resolveUser, type CurrentUser } from "@/lib/auth/current-user";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Service } from "@/lib/db/models/service";
import { createAddress } from "@/modules/customers/addresses";
import { createCustomer } from "@/modules/customers/service";
import { createOrg, createUser } from "./fixtures";

/** Synthetic data only (example.test domains, 555 numbers). */
export async function actorFor(user: { _id: Types.ObjectId; organizationId: Types.ObjectId; sessionVersion: number }): Promise<CurrentUser> {
  const r = await resolveUser({ userId: String(user._id), organizationId: String(user.organizationId), sessionVersion: user.sessionVersion });
  if (!r.user) throw new Error("fixture user not active");
  return r.user;
}

export async function opsWorld() {
  const org = await createOrg("Sparkle Test Co");
  const adminDoc = await createUser(org._id, { role: "ADMIN" });
  const admin = await actorFor(adminDoc);
  const sofa = await Service.create({ organizationId: org._id, name: "Sofa cleaning", searchName: "sofa cleaning", defaultPriceCents: 12000, currency: "CAD", durationMinutes: 90, unitLabel: "sofa" });
  const carpet = await Service.create({ organizationId: org._id, name: "Carpet cleaning", searchName: "carpet cleaning", defaultPriceCents: 4500, currency: "CAD", durationMinutes: 30, unitLabel: "room" });
  const ana = await Cleaner.create({ organizationId: org._id, name: "Ana Test", searchName: "ana test", phone: "+15145550101" });
  const ben = await Cleaner.create({ organizationId: org._id, name: "Ben Test", searchName: "ben test", phone: "+15145550102" });
  return { org, adminDoc, admin, sofa, carpet, ana, ben };
}

export async function customerWithAddress(actor: CurrentUser, overrides: Record<string, unknown> = {}) {
  const customer = await createCustomer(actor, {
    firstName: "Casey",
    lastName: `Client ${randomUUID().slice(0, 6)}`,
    phone: "(514) 555-0199",
    confirmDuplicate: true,
    primaryAddress: { label: "Home", line1: "100 Test Street", city: "Montreal", region: "QC", postalCode: "H2X 1Y4", country: "Canada" },
    ...overrides,
  });
  const { listAddresses } = await import("@/modules/customers/addresses");
  const [address] = await listAddresses(actor, customer.id);
  return { customer, address: address! };
}

export function bookingBody(p: { customerId: string; addressId: string; serviceId: string; date: string; startTime: string; durationMinutes?: number; cleanerIds?: string[]; quantity?: number }) {
  return {
    idempotencyKey: randomUUID(),
    customerId: p.customerId,
    addressId: p.addressId,
    date: p.date,
    startTime: p.startTime,
    durationMinutes: p.durationMinutes ?? 60,
    lineItems: [{ serviceId: p.serviceId, quantity: p.quantity ?? 1 }],
    cleanerIds: p.cleanerIds ?? [],
  };
}

export { createAddress };
