'use strict';

// A Mac on battery whose display has gone to sleep drops into maintenance sleep for seconds to minutes
// at a time (`pmset -g log`: "Entering Sleep state due to 'Maintenance Sleep'"). Chromium and the smoke
// freeze together, but Node's clocks keep counting through the sleep, so on wake the wait in flight is
// past its deadline although no time passed for the page (#153). A heartbeat that comes late shows that
// the computer slept. Only a wait a sleep interrupted is run again; every other failure is thrown.
const TICK_MS = 250;
const LATE_MS = 1500;

function watch({ now = Date.now, lateMs = LATE_MS } = {}) {
  let last = now(), sleeps = 0;
  const beat = () => { if (now() - last > lateMs) sleeps++; last = now(); };
  return {
    beat,
    // A mark to give `slept` later.
    mark: () => sleeps,
    // Whether the computer slept since the mark, counting a sleep whose late heartbeat hasn't run yet.
    slept: mark => { if (now() - last > lateMs) beat(); return sleeps > mark; }
  };
}

const host = watch();
setInterval(host.beat, TICK_MS).unref();

// Runs `wait`, and runs it again when it failed after the computer slept.
async function despiteSleep(wait, sleep = host, log = console.log) {
  for (;;) {
    const mark = sleep.mark();
    try { return await wait(); }
    catch (error) {
      if (!sleep.slept(mark)) throw error;
      log(`The computer slept during a wait; waiting again: ${String(error?.message).split('\n')[0]}`);
    }
  }
}

// Playwright's expect and expect.poll, with each matcher (after .not too) asked again of a fresh assertion
// when the computer slept while it waited.
function sleepTolerant(expect, sleep = host, log = console.log) {
  const assertion = (make, path = []) => new Proxy({}, {
    get: (_, key) => {
      if (key === 'then') return undefined;
      if (key === 'not') return assertion(make, [...path, key]);
      return (...args) => despiteSleep(() => path.reduce((value, step) => value[step], make())[key](...args), sleep, log);
    }
  });
  const tolerant = (...args) => assertion(() => expect(...args));
  tolerant.poll = (...args) => assertion(() => expect.poll(...args));
  return tolerant;
}

module.exports = { watch, despiteSleep, sleepTolerant, host };
