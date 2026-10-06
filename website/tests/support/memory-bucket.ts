// An in-memory stand-in for the FILES R2 bucket, with only the calls the
// download and publish code make. Nothing leaves the test process.
type Bytes = Uint8Array<ArrayBuffer>;
type Stored = {
  bytes: Bytes;
  etag: string;
  customMetadata: Record<string, string>;
};
type Upload = {
  key: string;
  customMetadata: Record<string, string>;
  parts: Map<number, Bytes>;
};

const describe = ({ bytes, etag, customMetadata }: Stored) => ({
  size: bytes.length,
  httpEtag: etag,
  customMetadata,
});

export class MemoryBucket {
  readonly objects = new Map<string, Stored>();
  readonly uploads = new Map<string, Upload>();
  // Every key the code looked up, so tests can tell whether it touched the bucket.
  readonly lookups: string[] = [];
  #count = 0;

  get binding() {
    return this as unknown as R2Bucket;
  }

  store(key: string, bytes: Bytes, customMetadata = {}) {
    this.objects.set(key, {
      bytes,
      etag: `"etag-${++this.#count}"`,
      customMetadata,
    });
  }

  async head(key: string) {
    this.lookups.push(key);
    const stored = this.objects.get(key);
    return stored ? describe(stored) : null;
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ) {
    this.lookups.push(key);
    const stored = this.objects.get(key);
    if (!stored) return null;
    const { offset, length } = options?.range ?? {
      offset: 0,
      length: stored.bytes.length,
    };
    const body = new Blob([stored.bytes.slice(offset, offset + length)]);
    return { ...describe(stored), body: body.stream() };
  }

  async createMultipartUpload(
    key: string,
    options?: { customMetadata?: Record<string, string> },
  ) {
    this.lookups.push(key);
    const uploadId = `upload-${++this.#count}`;
    const customMetadata = { ...options?.customMetadata };
    this.uploads.set(uploadId, { key, customMetadata, parts: new Map() });
    return { key, uploadId };
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const upload = () => {
      const found = this.uploads.get(uploadId);
      if (!found || found.key !== key)
        throw new Error(`No upload ${uploadId} for ${key}`);
      return found;
    };
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, body: ReadableStream) => {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        upload().parts.set(partNumber, bytes);
        return { partNumber, etag: `part-${partNumber}` };
      },
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        const { parts: uploaded, customMetadata } = upload();
        const chunks = parts.map(({ partNumber, etag }) => {
          const chunk = uploaded.get(partNumber);
          if (!chunk || etag !== `part-${partNumber}`)
            throw new Error(`Unknown part ${partNumber}`);
          return chunk;
        });
        const bytes = new Uint8Array(
          chunks.reduce((total, chunk) => total + chunk.length, 0),
        );
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        this.uploads.delete(uploadId);
        this.store(key, bytes, customMetadata);
        // Like R2, the completion response leaves out the custom metadata.
        return { key, size: bytes.length };
      },
      abort: async () => {
        upload();
        this.uploads.delete(uploadId);
      },
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}
