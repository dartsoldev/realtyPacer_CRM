import "server-only";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getStorageEnv } from "@/lib/env";
import { AppError } from "@/lib/http/errors";

/**
 * Private object storage. Buckets must block all public access; objects are
 * only reachable through presigned PUTs (uploads) and the app's authenticated
 * read route. Keys are random and never accepted from clients.
 */
export interface ObjectStorage {
  presignPut(key: string, contentType: string, size: number, expiresSeconds: number): Promise<{ url: string; headers: Record<string, string> }>;
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  getBytes(key: string, maxBytes: number): Promise<Buffer>;
  getStream(key: string): Promise<{ body: ReadableStream; size: number | null }>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
}

class S3Storage implements ObjectStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}
  async presignPut(key: string, contentType: string, size: number, expiresSeconds: number) {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: size });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: expiresSeconds, signableHeaders: new Set(["content-type", "content-length"]) });
    return { url, headers: { "Content-Type": contentType } };
  }
  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType ?? null };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }
  async getBytes(key: string, maxBytes: number) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${maxBytes - 1}` }));
    const bytes = await r.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  async getStream(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return { body: r.Body!.transformToWebStream(), size: r.ContentLength ?? null };
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** In-memory storage for automated tests (never used in production). */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  async presignPut(key: string, contentType: string) {
    return { url: `memory://${key}`, headers: { "Content-Type": contentType } };
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.body.length, contentType: o.contentType } : null;
  }
  async getBytes(key: string, maxBytes: number) {
    return (this.objects.get(key)?.body ?? Buffer.alloc(0)).subarray(0, maxBytes);
  }
  async getStream(key: string) {
    const body = this.objects.get(key)?.body ?? Buffer.alloc(0);
    return { body: new Blob([new Uint8Array(body)]).stream(), size: body.length };
  }
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
}

let override: ObjectStorage | null = null;
let cached: { key: string; storage: ObjectStorage } | null = null;

/** Tests only. */
export function setStorageForTests(s: ObjectStorage | null) {
  override = s;
}

/** The configured storage, or a 503 SETUP_REQUIRED error when it isn't configured. */
export function storage(): ObjectStorage {
  if (override) return override;
  const env = getStorageEnv();
  if (!env) throw new AppError(503, "STORAGE_NOT_CONFIGURED", "File storage isn't set up yet. An administrator must configure S3-compatible storage.");
  const key = `${env.S3_ENDPOINT ?? ""}|${env.S3_REGION}|${env.S3_BUCKET}|${env.S3_ACCESS_KEY_ID}`;
  if (!cached || cached.key !== key) {
    const client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    });
    cached = { key, storage: new S3Storage(client, env.S3_BUCKET) };
  }
  return cached.storage;
}

export function storageConfigured(): boolean {
  if (override) return true;
  try {
    return Boolean(getStorageEnv());
  } catch {
    return false;
  }
}
