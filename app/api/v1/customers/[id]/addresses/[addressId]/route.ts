import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, route } from "@/lib/http/api";
import { archiveAddress, updateAddress } from "@/modules/customers/addresses";
import { addressInputSchema } from "@/modules/customers/schemas";

export const runtime = "nodejs";

type P = { id: string; addressId: string };

/** Existing bookings keep their address snapshot; only future bookings use the edit. */
export const PATCH = route<P>(async (req, { params }) => {
  const user = await requireApiUser("customers:write");
  const { id, addressId } = await params;
  return ok(await updateAddress(user, id, addressId, await parseBody(req, addressInputSchema)));
});

/** Soft archive (bookings keep their snapshot). */
export const DELETE = route<P>(async (_req, { params }) => {
  const user = await requireApiUser("customers:write");
  const { id, addressId } = await params;
  return ok(await archiveAddress(user, id, addressId));
});
