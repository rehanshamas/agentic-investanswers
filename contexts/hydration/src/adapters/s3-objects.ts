// A thin S3 wrapper: the few operations the raw store needs, and nothing else.
//
// Points at MinIO locally via `endpoint` + `forcePathStyle`, and at real S3 on
// staging by leaving both unset (docs/architecture.md).

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface S3StoreConfig {
  readonly bucket: string;
  /** Set for MinIO, for example `http://127.0.0.1:9000`. Omit for real S3. */
  readonly endpoint?: string;
  readonly region?: string;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
}

export class S3ObjectError extends Error {}

export function createS3Client(config: S3StoreConfig): S3Client {
  return new S3Client({
    region: config.region ?? 'us-east-1',
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint, forcePathStyle: true }),
    ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
  });
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

/** True when a conditional write lost the race, or the object already existed. */
export function isPreconditionFailed(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'PreconditionFailed' || status === 412;
}

/**
 * Write only if the key does not exist.
 *
 * `IfNoneMatch: '*'` makes the check atomic in the store, so two writers
 * cannot both pass a read-then-write check and one silently win. Verified
 * against the local MinIO, which answers 412 PreconditionFailed on the second
 * write; real S3 has supported this since late 2024.
 *
 * Returns false when the object already existed.
 */
export async function putIfAbsent(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
): Promise<boolean> {
  try {
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, IfNoneMatch: '*' }),
    );
    return true;
  } catch (error) {
    if (isPreconditionFailed(error)) return false;
    throw error;
  }
}

/** Overwrite unconditionally. Never used for raw. */
export async function put(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
): Promise<void> {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

/** Read an object, or `undefined` when it does not exist. */
export async function get(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer | undefined> {
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (result.Body === undefined) {
      throw new S3ObjectError(`${key} returned no body`);
    }
    return Buffer.from(await result.Body.transformToByteArray());
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Whether an object exists, without transferring it. */
export async function exists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
