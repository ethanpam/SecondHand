'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('preload forwards only valid lock revisions and treats malformed or legacy events as uncorrelated locks', () => {
  let api;
  let listener;
  let removed;
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/preload.cjs'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
        ipcRenderer: {
          on(channel, callback) { assert.equal(channel, 'secondhand:locked'); listener = callback; },
          removeListener(channel, callback) { removed = { channel, callback }; }
        }
      };
    }
  });
  const received = [];
  const unsubscribe = api.onLocked(payload => received.push(payload));
  listener({ sender: 'private-electron-event' }, { lockRevision: 3, ignored: 'private-extra-payload' });
  assert.deepEqual(JSON.parse(JSON.stringify(received.pop())), { lockRevision: 3 });
  for (const payload of [undefined, null, {}, { lockRevision: 0 }, { lockRevision: -1 }, { lockRevision: 2.5 }, { lockRevision: '3' }, { lockRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    listener({ sender: 'private-electron-event' }, payload);
    assert.equal(received.pop(), undefined);
  }
  unsubscribe();
  assert.equal(removed.channel, 'secondhand:locked');
  assert.equal(removed.callback, listener);
});
