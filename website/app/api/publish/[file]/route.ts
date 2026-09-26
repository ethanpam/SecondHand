import { env } from 'cloudflare:workers';
import { publish } from '@/lib/downloads';
export async function POST(request: Request, context: { params: Promise<{ file: string }> }) {
  return publish(request, (await context.params).file, env.FILES, env.RELEASE_UPLOAD_TOKEN);
}
export const PUT = POST;
export const DELETE = POST;
