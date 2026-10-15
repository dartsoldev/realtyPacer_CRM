import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { completeUpload } from "@/modules/attachments/service";

export const runtime = "nodejs";

/** Verifies the uploaded object (size, file signature, image decode) before attaching it. */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await completeUpload(user, (await params).id));
});
