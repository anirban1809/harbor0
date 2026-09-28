import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  ListMultipartUploadsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { CompletedPart } from '@harbor/contracts';
export interface ObjectStorage {
  create(key: string): Promise<string>;
  signPart(key: string, uploadId: string, part: number, size: number): Promise<string>;
  parts(key: string, uploadId: string): Promise<CompletedPart[]>;
  complete(key: string, uploadId: string, parts: CompletedPart[]): Promise<void>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  abort(key: string, uploadId: string): Promise<void>;
  remove(key: string): Promise<void>;
  download(key: string, name: string): Promise<string>;
  readRange(key: string, offset: number, length: number): Promise<Uint8Array>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  writePart(
    key: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<CompletedPart>;
  cleanupArchive(prefix: string): Promise<void>;
}
export class R2Storage implements ObjectStorage {
  private client: S3Client;
  constructor(
    private bucket: string,
    endpoint: string,
    accessKeyId: string,
    secretAccessKey: string,
  ) {
    this.client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  async create(key: string) {
    const r = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: 'application/octet-stream',
      }),
    );
    return r.UploadId!;
  }
  async signPart(key: string, uploadId: string, part: number, size: number) {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: part,
        ContentLength: size,
      }),
      { expiresIn: 900 },
    );
  }
  async parts(key: string, uploadId: string) {
    const parts: CompletedPart[] = [];
    let marker: string | undefined;
    do {
      const r = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      parts.push(...(r.Parts ?? []).map((p) => ({ partNumber: p.PartNumber!, etag: p.ETag! })));
      marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }
  async complete(key: string, uploadId: string, parts: CompletedPart[]) {
    if (await this.head(key)) return;
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }
  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength!, etag: r.ETag ?? '' };
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode === 404)
        return null;
      throw e;
    }
  }
  async abort(key: string, uploadId: string) {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (e) {
      if ((e as { name: string }).name !== 'NoSuchUpload') throw e;
    }
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async download(key: string, name: string) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
        ResponseContentType: 'application/octet-stream',
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: 300 },
    );
  }
  async empty(key: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: new Uint8Array(),
        ContentType: 'application/octet-stream',
      }),
    );
  }
  async readRange(key: string, offset: number, length: number) {
    if (!length) return new Uint8Array();
    const r = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=${offset}-${offset + length - 1}`,
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    if (r.ContentLength !== length || !r.Body) throw new Error('The storage range is incomplete.');
    return r.Body.transformToByteArray();
  }
  async put(key: string, bytes: Uint8Array) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes }), {
      abortSignal: AbortSignal.timeout(30_000),
    });
  }
  async writePart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array) {
    const r = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: bytes,
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    return { partNumber, etag: r.ETag! };
  }
  async cleanupArchive(prefix: string) {
    if (!/^archives\/[a-zA-Z0-9-]+\/$/.test(prefix)) throw new Error('Invalid archive prefix.');
    // Also collect checkpoint objects and multipart uploads orphaned by a timeout
    // between a provider write and its metadata transaction.
    let cursor: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: cursor,
        }),
      );
      for (const object of page.Contents ?? []) await this.remove(object.Key!);
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
    let keyMarker: string | undefined;
    let uploadMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadMarker,
        }),
      );
      for (const upload of page.Uploads ?? []) await this.abort(upload.Key!, upload.UploadId!);
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      uploadMarker = page.NextUploadIdMarker;
    } while (keyMarker);
  }
}
export class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Uint8Array>();
  uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  async create(key: string) {
    const id = crypto.randomUUID();
    this.uploads.set(id, { key, parts: new Map() });
    return id;
  }
  async signPart(key: string, uploadId: string, part: number) {
    return `memory://${uploadId}/${part}`;
  }
  async parts(key: string, uploadId: string) {
    return [...(this.uploads.get(uploadId)?.parts ?? [])].map(([partNumber]) => ({
      partNumber,
      etag: `part-${partNumber}`,
    }));
  }
  async complete(key: string, uploadId: string, parts: CompletedPart[]) {
    if (this.objects.has(key)) return;
    const upload = this.uploads.get(uploadId)!;
    this.objects.set(
      key,
      Buffer.concat(parts.map((p) => Buffer.from(upload.parts.get(p.partNumber)!))),
    );
    this.uploads.delete(uploadId);
  }
  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.length, etag: 'test-etag' } : null;
  }
  async abort(key: string, uploadId: string) {
    this.uploads.delete(uploadId);
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  async download(key: string) {
    return `memory://objects/${key}`;
  }
  async readRange(key: string, offset: number, length: number) {
    const bytes = this.objects.get(key);
    if (!bytes || offset + length > bytes.length)
      throw new Error('The storage range is incomplete.');
    return bytes.slice(offset, offset + length);
  }
  async put(key: string, bytes: Uint8Array) {
    this.objects.set(key, bytes.slice());
  }
  async writePart(_key: string, uploadId: string, partNumber: number, bytes: Uint8Array) {
    this.uploads.get(uploadId)!.parts.set(partNumber, bytes.slice());
    return { partNumber, etag: `part-${partNumber}` };
  }
  async cleanupArchive(prefix: string) {
    for (const key of this.objects.keys()) if (key.startsWith(prefix)) this.objects.delete(key);
    for (const [id, upload] of this.uploads)
      if (upload.key.startsWith(prefix)) this.uploads.delete(id);
  }
}
