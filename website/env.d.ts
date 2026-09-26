/// <reference types="@cloudflare/workers-types" />
declare namespace Cloudflare {
  interface Env { FILES: R2Bucket; RELEASE_UPLOAD_TOKEN?: string; }
}
