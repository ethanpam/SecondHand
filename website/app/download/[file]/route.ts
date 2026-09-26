import { env } from 'cloudflare:workers';
import { download } from '@/lib/downloads';
export async function GET(request: Request, context: { params: Promise<{ file: string }> }) {
  return download(request, (await context.params).file, env.FILES);
}
export const HEAD = GET;
