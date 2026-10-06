// Stands in for vinext's fetch handler in worker tests. It records each
// request it gets, so a test can tell whether the Worker handed it to vinext.
export const handled: Request[] = [];

const handler = {
  async fetch(request: Request) {
    handled.push(request);
    return new Response('page from vinext');
  },
};

export default handler;
