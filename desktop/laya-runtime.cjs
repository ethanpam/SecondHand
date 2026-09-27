'use strict';
// The one place the desktop app gets its Laya runtime: the local model (#38), with
// status(), decide(), and decideBatch(). This build ships without it, so there is none:
// every Laya request answers "not ready" and SecondHand fills forms as it does without Laya.
function createLayaRuntime() {
  return null;
}

module.exports = { createLayaRuntime };
