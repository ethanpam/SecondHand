// Stands in for the Workers runtime module in Node tests. Each test sets the
// bindings a route reads; nothing here reaches Cloudflare.
export const env = {} as Cloudflare.Env;
