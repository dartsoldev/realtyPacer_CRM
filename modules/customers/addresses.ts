import "server-only";
import { Types, type ClientSession } from "mongoose";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Customer } from "@/lib/db/models/customer";
import { ServiceAddress } from "@/lib/db/models/service-address";
import { normalizeCity, OBJECT_ID_RE } from "@/lib/domain/normalize";
import { googleMapsUrl } from "@/lib/domain/links";
import { Errors } from "@/lib/http/errors";
import { recordActivity } from "@/modules/activities/service";
import type { AddressInput } from "./schemas";

export type AddressDTO = {
  id: string;
  label: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  location: { lat: number; lng: number } | null;
  accessInstructions: string;
  isPrimary: boolean;
  links: { label: string; url: string }[];
  mapUrl: string | null;
  archived: boolean;
};

type AddressLike = {
  _id: Types.ObjectId;
  label?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  location?: { lat: number; lng: number } | null;
  accessInstructions?: string | null;
  isPrimary?: boolean | null;
  links?: { label: string; url: string }[] | null;
  archivedAt?: Date | null;
};

export function toAddressDTO(a: AddressLike): AddressDTO {
  const location = a.location && typeof a.location.lat === "number" ? { lat: a.location.lat, lng: a.location.lng } : null;
  return {
    id: String(a._id),
    label: a.label ?? "",
    line1: a.line1,
    line2: a.line2 ?? "",
    city: a.city,
    region: a.region ?? "",
    postalCode: a.postalCode ?? "",
    country: a.country ?? "",
    location,
    accessInstructions: a.accessInstructions ?? "",
    isPrimary: Boolean(a.isPrimary),
    links: (a.links ?? []).map((l) => ({ label: l.label, url: l.url })),
    mapUrl: googleMapsUrl({ ...a, location }),
    archived: Boolean(a.archivedAt),
  };
}

export function addressFieldsFromInput(input: AddressInput) {
  return {
    label: input.label,
    line1: input.line1,
    line2: input.line2,
    city: input.city,
    cityNormalized: normalizeCity(input.city),
    region: input.region,
    postalCode: input.postalCode.toUpperCase(),
    country: input.country,
    location: input.lat != null && input.lng != null ? { lat: input.lat, lng: input.lng } : null,
    accessInstructions: input.accessInstructions,
    links: input.links,
  };
}

/** Keeps the customer's denormalised city list and primary city in sync with active addresses. */
export async function refreshCustomerCities(organizationId: Types.ObjectId, customerId: Types.ObjectId, session?: ClientSession) {
  const active = await ServiceAddress.find({ organizationId, customerId, archivedAt: null })
    .select("city cityNormalized isPrimary createdAt")
    .sort({ isPrimary: -1, createdAt: 1 })
    .session(session ?? null)
    .lean();
  // Guarantee exactly one default among active addresses.
  if (active.length > 0 && !active.some((a) => a.isPrimary)) {
    await ServiceAddress.updateOne({ _id: active[0]!._id }, { $set: { isPrimary: true } }, { session });
    active[0]!.isPrimary = true;
  }
  await Customer.updateOne(
    { _id: customerId, organizationId },
    { $set: { addressCities: [...new Set(active.map((a) => a.cityNormalized))], primaryCity: active.find((a) => a.isPrimary)?.city ?? null } },
    { session },
  );
}

async function assertWritableCustomer(user: CurrentUser, customerId: string, session?: ClientSession) {
  if (!user.permissions.has("customers:write")) throw Errors.forbidden();
  if (!OBJECT_ID_RE.test(customerId)) throw Errors.notFound("Customer");
  const c = await Customer.findOne({ _id: customerId, organizationId: user.organizationId }).select("_id archivedAt").session(session ?? null).lean();
  if (!c) throw Errors.notFound("Customer");
  return c;
}

export async function createAddress(user: CurrentUser, customerId: string, input: AddressInput, session?: ClientSession) {
  await connectDb();
  const customer = await assertWritableCustomer(user, customerId, session);
  const orgId = new Types.ObjectId(user.organizationId);
  if (input.isPrimary) await ServiceAddress.updateMany({ organizationId: orgId, customerId: customer._id }, { $set: { isPrimary: false } }, { session });
  const [created] = await ServiceAddress.create(
    [{ organizationId: orgId, customerId: customer._id, ...addressFieldsFromInput(input), isPrimary: input.isPrimary }],
    { session },
  );
  await refreshCustomerCities(orgId, customer._id, session);
  await recordActivity(
    { organizationId: orgId, actorId: user.id, type: "address.added", customerId: customer._id, metadata: { label: input.label || input.line1, city: input.city } },
    session,
  );
  const fresh = await ServiceAddress.findById(created!._id).session(session ?? null).lean();
  return toAddressDTO(fresh!);
}

/**
 * Updates a current address. Existing bookings keep their own snapshot;
 * only future bookings created (or explicitly refreshed) afterwards use it.
 */
export async function updateAddress(user: CurrentUser, customerId: string, addressId: string, input: AddressInput) {
  await connectDb();
  const customer = await assertWritableCustomer(user, customerId);
  if (!OBJECT_ID_RE.test(addressId)) throw Errors.notFound("Address");
  const orgId = new Types.ObjectId(user.organizationId);
  const existing = await ServiceAddress.findOne({ _id: addressId, organizationId: orgId, customerId: customer._id, archivedAt: null }).lean();
  if (!existing) throw Errors.notFound("Address");
  if (input.isPrimary) await ServiceAddress.updateMany({ organizationId: orgId, customerId: customer._id, _id: { $ne: existing._id } }, { $set: { isPrimary: false } });
  await ServiceAddress.updateOne(
    { _id: existing._id },
    { $set: { ...addressFieldsFromInput(input), isPrimary: input.isPrimary } },
  );
  // If the default was unticked, refreshCustomerCities promotes another active address.
  await refreshCustomerCities(orgId, customer._id);
  await recordActivity({ organizationId: orgId, actorId: user.id, type: "address.updated", customerId: customer._id, metadata: { label: input.label || input.line1 } });
  return toAddressDTO((await ServiceAddress.findById(existing._id).lean())!);
}

/** Soft-archives an address. Bookings referencing it keep their snapshot. */
export async function archiveAddress(user: CurrentUser, customerId: string, addressId: string) {
  await connectDb();
  const customer = await assertWritableCustomer(user, customerId);
  if (!OBJECT_ID_RE.test(addressId)) throw Errors.notFound("Address");
  const orgId = new Types.ObjectId(user.organizationId);
  const res = await ServiceAddress.findOneAndUpdate(
    { _id: addressId, organizationId: orgId, customerId: customer._id, archivedAt: null },
    { $set: { archivedAt: new Date(), isPrimary: false } },
  ).lean();
  if (!res) throw Errors.notFound("Address");
  await refreshCustomerCities(orgId, customer._id);
  await recordActivity({ organizationId: orgId, actorId: user.id, type: "address.archived", customerId: customer._id, metadata: { label: res.label || res.line1 } });
  return { id: String(res._id), archived: true };
}

export async function listAddresses(user: CurrentUser, customerId: string, includeArchived = false): Promise<AddressDTO[]> {
  if (!user.permissions.has("customers:read")) throw Errors.forbidden();
  if (!OBJECT_ID_RE.test(customerId)) throw Errors.notFound("Customer");
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  if (!(await Customer.exists({ _id: customerId, organizationId: orgId }))) throw Errors.notFound("Customer");
  const rows = await ServiceAddress.find({ organizationId: orgId, customerId, ...(includeArchived ? {} : { archivedAt: null }) })
    .sort({ archivedAt: 1, isPrimary: -1, createdAt: 1 })
    .limit(100)
    .lean();
  return rows.map(toAddressDTO);
}
