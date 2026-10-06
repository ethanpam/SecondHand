// The Worker's entry point. Installer downloads are answered here, before
// vinext, so R2's stream goes straight back to the visitor. Passing a 170 MB
// installer through vinext's response pipeline uses more than the free plan's
// 10 ms of CPU, and Cloudflare cuts the download short.
import handler from 'vinext/server/fetch-handler';
import { download } from './lib/downloads';

type Env = { FILES: R2Bucket };

export function downloadFile(pathname: string) {
  const match = /^\/download\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const file = downloadFile(new URL(request.url).pathname);
    if (
      file !== null &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return download(request, file, env.FILES);
    }
    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export default worker;
