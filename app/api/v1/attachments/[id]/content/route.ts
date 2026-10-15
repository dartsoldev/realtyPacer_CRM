import { requireApiUser } from "@/lib/auth/current-user";
import { errorResponse } from "@/lib/http/api";
import { openAttachment } from "@/modules/attachments/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated file stream. Authorization is re-checked on every request,
 * so a copied link or guessed id is useless without access. Files are never
 * cached by shared caches; documents always download instead of rendering.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser();
    const variant = new URL(req.url).searchParams.get("variant") === "thumb" ? "thumb" : "original";
    const file = await openAttachment(user, (await params).id, variant);
    const encoded = encodeURIComponent(file.fileName);
    const headers = new Headers({
      "Content-Type": file.mimeType,
      "Content-Disposition": `${file.isImage ? "inline" : "attachment"}; filename="${file.fileName.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encoded}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": variant === "thumb" ? "private, max-age=300" : "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
    if (file.size) headers.set("Content-Length", String(file.size));
    return new Response(file.body, { status: 200, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
