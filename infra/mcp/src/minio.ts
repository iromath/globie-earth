// Object storage for the photographs visitors contribute.
//
// The POST /contribute route is the only writer for a contribution, and its
// DELETE /contribute/:id sibling is the only eraser: contributing puts an
// accepted photo's bytes here and records the key, so the image never travels
// through Postgres; removing drops those bytes again so a withdrawn upload is
// not left fetchable. The /wiki route also writes here, re-hosting a
// freely-licensed Wikipedia lead image so a species page serves it from our own
// storage rather than hot-linking Wikimedia's CDN.
// MinIO speaks the S3 API, so the AWS SDK's S3 client talks to it with
// forcePathStyle (a MinIO endpoint is path-style, not virtual-hosted).
//
// The credential is server-side only - the browser holds a device id, never a
// bucket key. It is read per request, like deepseekConfig(), so an unset
// endpoint is a clear 503 from the route rather than a boot failure, and an env
// change needs no restart.
//
// The bucket is ensured - created if missing, and given a public-read policy -
// on the first accepted upload. Public-read is deliberate: an approved photo has
// to be loadable by an <img> from any device, and a contributed object's key is
// a random uuid, so the URL is not guessable while the row is still pending.

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface MinioConfig {
  /** The S3 API the container talks to, e.g. http://minio:9000. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** The origin a browser loads a stored photo from; falls back to the endpoint. */
  publicUrl: string;
}

/**
 * The storage configuration, or null when any of it is missing.
 *
 * All five values are required together: a half-configured store cannot store
 * anything, so a caller checks for null once rather than each field.
 */
export function minioConfig(): MinioConfig | null {
  const endpoint = process.env.MINIO_ENDPOINT?.trim().replace(/\/+$/, '');
  const accessKeyId = process.env.MINIO_ACCESS_KEY?.trim();
  const secretAccessKey = process.env.MINIO_SECRET_KEY?.trim();
  const bucket = process.env.MINIO_BUCKET?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;

  return {
    endpoint,
    region: process.env.MINIO_REGION?.trim() || 'us-east-1',
    accessKeyId,
    secretAccessKey,
    bucket,
    // The browser cannot reach the in-network endpoint, so a live deployment
    // sets MINIO_PUBLIC_URL to a domain pointed at MinIO. The fallback keeps
    // local development working while nothing displays a pending photo.
    publicUrl: process.env.MINIO_PUBLIC_URL?.trim().replace(/\/+$/, '') || `${endpoint}/${bucket}`,
  };
}

/** Whether storage is configured, and the bucket it writes to - for /health. */
export function minioHealth(): { configured: boolean; bucket: string | null } {
  const config = minioConfig();
  return { configured: config !== null, bucket: config?.bucket ?? null };
}

/**
 * The object key behind a URL this store handed out, or null when the URL is
 * not one of ours.
 *
 * A contribution records most media as its key, but a clip's poster still is
 * kept only as the URL putPhoto returned - so a withdrawal has to walk back
 * from that URL to the key before it can delete the bytes. Null means "leave it
 * alone": better to leave one object the caller cannot name than to delete a
 * key guessed from a foreign URL.
 */
export function keyForUrl(url: string): string | null {
  const config = minioConfig();
  if (!config) return null;
  const prefix = `${config.publicUrl}/`;
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  return key ? key : null;
}

// One client per endpoint+credential. A client pools connections, so building
// one per upload would leak sockets; the cache is keyed so a credential change
// is honoured without a restart.
let cached: { key: string; client: S3Client } | null = null;

function clientFor(config: MinioConfig): S3Client {
  const key = `${config.endpoint}|${config.accessKeyId}`;
  if (cached?.key === key) return cached.client;
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  cached = { key, client };
  return client;
}

/** The public-read policy: anyone may GET an object, only the server writes. */
function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}

// The bucket is ensured once per process; re-checking on every upload would add
// two round trips to each one for a fact that does not change.
let ensuredBucket: string | null = null;

async function ensureBucket(client: S3Client, config: MinioConfig): Promise<void> {
  if (ensuredBucket === config.bucket) return;

  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  } catch {
    // HeadBucket fails with a 404 when the bucket does not exist yet. Any other
    // failure (a bad credential, an unreachable endpoint) makes CreateBucket
    // fail too, so its error is the one that reaches the caller.
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  }
  await client.send(
    new PutBucketPolicyCommand({ Bucket: config.bucket, Policy: publicReadPolicy(config.bucket) }),
  );
  ensuredBucket = config.bucket;
}

/**
 * Whether an object already exists under `key`.
 *
 * Used to keep a re-hosted Wikipedia lead image from being downloaded and
 * uploaded again on every species-page lookup: the caller checks here first and
 * only fetches the upstream file on a miss.
 *
 * Throws when storage is not configured, like putPhoto and deletePhoto.
 */
export async function objectExists(key: string): Promise<boolean> {
  const config = minioConfig();
  if (!config) {
    throw new Error('Object storage is not configured (MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY).');
  }

  const client = clientFor(config);
  try {
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return true;
  } catch {
    // A missing object is a 404 here, which is the ordinary "not cached yet"
    // answer; any other failure also means the caller should just fetch anew.
    return false;
  }
}

/**
 * Stores the bytes under `key` and returns the URL a browser would load.
 *
 * Throws when storage is not configured; the route checks minioConfig() first
 * so this is a backstop, not the path a caller relies on.
 */
export async function putPhoto(key: string, body: Buffer, contentType: string): Promise<string> {
  const config = minioConfig();
  if (!config) {
    throw new Error('Object storage is not configured (MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY).');
  }

  const client = clientFor(config);
  await ensureBucket(client, config);
  await client.send(
    new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType }),
  );
  return `${config.publicUrl}/${key}`;
}

/**
 * Drops the bytes stored under `key`.
 *
 * A missing object is not an error: S3 answers a delete for an absent key with
 * 204, which is exactly the semantics a withdrawal wants - the desired end state
 * ("no object under this key") holds whether or not it was ever there, so
 * re-running a removal is safe.
 *
 * Throws when storage is not configured; the route checks minioConfig() first so
 * this is a backstop, like putPhoto.
 */
export async function deletePhoto(key: string): Promise<void> {
  const config = minioConfig();
  if (!config) {
    throw new Error('Object storage is not configured (MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY).');
  }

  const client = clientFor(config);
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}
