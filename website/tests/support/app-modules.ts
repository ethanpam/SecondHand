// Lets Node's test runner load the site's own modules the way vinext resolves
// them: `@/` paths, imports without a file extension, and the Workers
// `cloudflare:workers` module, which loads the stand-in env next to this file.
// Import this file first, then load app modules with a dynamic import().
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

const root = new URL('../../', import.meta.url);
const workers = new URL('./cloudflare-workers.ts', import.meta.url).href;

function siteFile(specifier: string, parentURL: string | undefined) {
  if (specifier.startsWith('@/')) return new URL(specifier.slice(2), root);
  const ownModule =
    parentURL?.startsWith(root.href) && !parentURL.includes('/node_modules/');
  if (ownModule && /^\.\.?\//.test(specifier))
    return new URL(specifier, parentURL);
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers')
      return { url: workers, shortCircuit: true };
    const file = siteFile(specifier, context.parentURL);
    if (!file) return nextResolve(specifier, context);
    const typescript = new URL(`${file.href}.ts`);
    if (!/\.[a-z]+$/.test(file.pathname) && existsSync(typescript))
      return { url: typescript.href, shortCircuit: true };
    return nextResolve(file.href, context);
  },
});
