"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWorkflow, STORAGE_KEY } = require("../SafariExtension/Resources/background.js");
const PORTAL = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo";
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness(options = {}) {
  let time = Date.now(), serial = 0;
  const events = {}, stored = options.stored ? { [STORAGE_KEY]: options.stored } : {};
  const calls = { native: [], fill: [], home: [], act: [], actionPhases: [], cancel: 0, storage: [] };
  const tab = { id: 7, url: PORTAL };
  const site = { kind: "known", fields: [{ id: "field-1", key: "firstName", label: "First name", type: "text" }],
    actions: [{ id: "next", label: "Continue", kind: "continue" }], token: null, changed: false };
  const event = name => ({ addListener(listener) { events[name] = listener; } });
  const api = {
    runtime: { id: "secondhand-extension", getURL: file => `safari-web-extension://fixture/${file}`,
      onMessage: event("message"), async sendNativeMessage(_app, input) {
        calls.native.push(input);
        if (options.native) return options.native(input, calls.native.length);
        return input.action === "recordReceipt" ? { recorded: true }
          : { fields: Object.fromEntries(input.keys.map(key => [key, key === "firstName" ? "Private Name" : "Private Detail"])), expiresAt: time + 600000 };
      } },
    storage: { local: {
      async get(key) { return { [key]: stored[key] }; },
      async set(value) { calls.storage.push(JSON.stringify(value)); Object.assign(stored, JSON.parse(JSON.stringify(value))); },
      async remove(key) { delete stored[key]; }
    } },
    tabs: { async query() { return [{ ...tab }]; }, onUpdated: event("updated"), onActivated: event("activated"), onRemoved: event("removed") },
    scripting: { async executeScript(input) {
      if (input.files) return [];
      const code = input.func.toString();
      let result;
      if (code.includes(".inspect(")) {
        site.token = `token-${++serial}`;
        result = { token: site.token, pageURL: tab.url, kind: site.kind, title: "Application step",
          fields: [...site.fields], actions: [...site.actions], populated: 0, ambiguous: 0,
          documentID: site.documentID || "document-1", canAnswerHomeAddress: site.canAnswerHomeAddress === true };
      } else if (code.includes(".answerHomeAddress(")) {
        calls.home.push(input.args);
        result = options.homeResult || { filled: 1 };
        if (result.filled === 1) site.fields.push({ id: "home-city", key: "city", label: "Home city", type: "text" });
        if (options.replaceDocumentAfterChoice) site.documentID = "document-2";
      } else if (code.includes(".fill(")) {
        calls.fill.push(input.args);
        result = { filled: input.args[2].length, skipped: 0, needsInput: false };
        site.fields = [];
      } else if (code.includes(".act(")) {
        calls.act.push(input.args);
        calls.actionPhases.push(stored[STORAGE_KEY]?.phase);
        result = site.changed || site.token !== input.args[1] ? { error: "preview_expired" } : { attempted: true, kind: input.args[3] ? "submit" : "continue" };
      } else if (code.includes(".cancel")) { calls.cancel += 1; result = true; }
      else throw new Error("Unexpected script");
      return [{ frameId: 0, result }];
    } }
  };
  const workflow = createWorkflow(api, { now: () => time, uuid: () => "f1496248-1495-4d78-b80e-f37a65e7c544", disableTimer: true,
    isPortalURL: url => url.startsWith("https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/") && !url.includes("?") }).install();
  return { workflow, api, events, stored, calls, tab, site, advance(ms) { time += ms; }, now: () => time };
}
function popup(h) { return { id: h.api.runtime.id, url: h.api.runtime.getURL("popup.html") }; }

test("start fills known fields and waits for a separate Continue action", async () => {
  const h = harness();
  const view = await h.workflow.dispatch({ command: "start" });
  assert.equal(view.workflow.phase, "ready");
  assert.equal(view.workflow.filled, 1);
  assert.equal(h.calls.fill.length, 1);
  assert.equal(h.calls.act.length, 0);
  assert.equal(h.calls.native[0].action, "applicationFields");
  assert.equal(h.calls.fill[0][3].firstName, "Private Name");
});

test("Start selects verified home Yes once, then rescans and requests newly visible saved fields", async () => {
  const h = harness({ native: async input => ({ fields: Object.fromEntries(input.keys.map(key =>
    [key, key === "hasHomeAddress" ? "yes" : "Example"])), expiresAt: Date.now() + 600000 }) });
  h.site.canAnswerHomeAddress = true;
  const view = await h.workflow.dispatch({ command: "start" });
  assert.equal(h.calls.home.length, 1); // The fake site deliberately leaves the capability true.
  assert.deepEqual(h.calls.native.map(call => call.keys), [["firstName"], ["hasHomeAddress"], ["firstName", "city"]]);
  assert.notEqual(h.calls.home[0][1], h.calls.fill[0][1]);
  assert.equal(h.calls.home[0][2], "yes");
  assert.equal(h.calls.fill.length, 1);
  assert.equal(view.workflow.filled, 2);
  assert.match(view.message, /Home address Yes selected/);
  assert.equal(view.savedFields.hasHomeAddress, undefined);
  assert.equal(view.scan.canAnswerHomeAddress, undefined);
  assert.equal(h.calls.act.length, 0);
});

test("Start selects a saved home No once and reports it", async () => {
  const h = harness({ native: async input => ({ fields: Object.fromEntries(input.keys.map(key =>
    [key, key === "hasHomeAddress" ? "no" : "Example"])), expiresAt: Date.now() + 600000 }) });
  h.site.canAnswerHomeAddress = true;
  const view = await h.workflow.dispatch({ command: "start" });
  assert.equal(h.calls.home.length, 1);
  assert.equal(h.calls.home[0][2], "no");
  assert.match(view.message, /^Home address No selected\. /);
  assert.equal(view.workflow.phase, "ready");
});

test("a saved answer that can't be selected tells the applicant the question was left for them", async () => {
  for (const answer of ["yes", "no"]) {
    const h = harness({ homeResult: { filled: 0 }, native: async input => ({ fields: Object.fromEntries(input.keys.map(key =>
      [key, key === "hasHomeAddress" ? answer : "Example"])), expiresAt: Date.now() + 600000 }) });
    h.site.canAnswerHomeAddress = true;
    const view = await h.workflow.dispatch({ command: "start" });
    assert.equal(h.calls.home.length, 1, answer);
    assert.equal(h.calls.fill.length, 1, answer);
    assert.match(view.message, /^“Do you have a home address\?” was left for you to answer on Iowa’s website\. 1 fields filled\./, answer);
    assert.doesNotMatch(view.message, /selected/, answer);
  }
});

test("Resume and the page after an extension Continue also answer the home-address question", async () => {
  const yes = async input => ({ fields: Object.fromEntries(input.keys.map(key =>
    [key, key === "hasHomeAddress" ? "yes" : "Example"])), expiresAt: Date.now() + 600000 });
  const resumed = harness({ native: yes });
  await resumed.workflow.dispatch({ command: "start" });
  await resumed.workflow.dispatch({ command: "pause" });
  resumed.site.canAnswerHomeAddress = true;
  assert.match((await resumed.workflow.dispatch({ command: "resume" })).message, /^Home address Yes selected\. /);
  assert.equal(resumed.calls.home.length, 1);

  const continued = harness({ native: yes });
  await continued.workflow.dispatch({ command: "start" });
  await continued.workflow.dispatch({ command: "act", previewToken: continued.site.token, actionID: "next" });
  continued.site.canAnswerHomeAddress = true;
  continued.events.updated(7, { status: "complete" });
  await continued.workflow.dispatch({ command: "status" });
  assert.equal(continued.calls.home.length, 1);
});

test("missing or unsupported native home answers never click, but other saved answers still fill", async () => {
  for (const answer of [undefined, false, "true", "Yes", "No"]) {
    const h = harness({ native: async input => ({ fields: input.keys.includes("hasHomeAddress")
      ? (answer === undefined ? {} : { hasHomeAddress: answer }) : { firstName: "Example" }, expiresAt: Date.now() + 600000 }) });
    h.site.canAnswerHomeAddress = true;
    const view = await h.workflow.dispatch({ command: "start" });
    assert.equal(h.calls.home.length, 0);
    assert.equal(h.calls.fill.length, 1);
    assert.equal(view.workflow.phase, "ready");
  }
});

test("home eligibility never becomes a generic popup mapping or an unknown-page automatic answer", async () => {
  const h = harness();
  h.site.kind = "mapping"; h.site.canAnswerHomeAddress = true;
  h.site.fields = [{ id: "field-1", key: null, label: "Home question", type: "text" }];
  const view = await h.workflow.dispatch({ command: "start" });
  const result = await h.workflow.dispatch({ command: "fill", previewToken: view.scan.previewToken,
    assignments: [{ id: "field-1", key: "hasHomeAddress" }] });
  assert.equal(result.error, "mapping");
  assert.equal(h.calls.native.length, 1);
  assert.equal(h.calls.home.length, 0);
});

test("Stop, Pause, tab switch and navigation cancel delayed native home eligibility", async () => {
  for (const command of ["stop", "pause", "switch", "navigate"]) {
    const gate = deferred();
    const h = harness({ native: async input => input.keys.includes("hasHomeAddress") ? gate.promise
      : { fields: { firstName: "Example" }, expiresAt: Date.now() + 600000 } });
    h.site.canAnswerHomeAddress = true;
    const starting = h.workflow.dispatch({ command: "start" });
    while (h.calls.native.length < 2) await new Promise(resolve => setImmediate(resolve));
    let pending;
    if (command === "switch") { h.tab.id = 8; h.events.activated({ tabId: 8 }); }
    else if (command === "navigate") { h.tab.url = PORTAL + "Changed"; h.events.updated(7, { status: "loading", url: h.tab.url }); }
    else pending = h.workflow.dispatch({ command });
    gate.resolve({ fields: { hasHomeAddress: "yes" }, expiresAt: Date.now() + 600000 });
    await starting;
    if (pending) await pending;
    await h.workflow.dispatch({ command: "status" });
    assert.equal(h.calls.home.length, 0, command);
    assert.equal(h.calls.fill.length, 0, command);
  }
});

test("revoked or expired native home eligibility cannot choose Yes", async () => {
  for (const response of [{ error: "session_expired" }, { fields: { hasHomeAddress: "yes" }, expiresAt: Date.now() - 1 }]) {
    const h = harness({ native: async input => input.keys.includes("hasHomeAddress") ? response
      : { fields: {}, expiresAt: Date.now() + 600000 } });
    h.site.canAnswerHomeAddress = true;
    assert.equal((await h.workflow.dispatch({ command: "start" })).error, "session");
    assert.equal(h.calls.home.length, 0);
    assert.equal(h.calls.fill.length, 0);
  }
});

test("a replacement document after home choice never receives the next address fill", async () => {
  const h = harness({ replaceDocumentAfterChoice: true, native: async input => ({ fields: input.keys.includes("hasHomeAddress")
    ? { hasHomeAddress: "yes" } : {}, expiresAt: Date.now() + 600000 }) });
  h.site.canAnswerHomeAddress = true;
  const result = await h.workflow.dispatch({ command: "start" });
  assert.equal(result.error, "changed");
  assert.equal(h.calls.home.length, 1);
  assert.equal(h.calls.fill.length, 0);
  assert.equal(h.calls.native.length, 2);
});

test("persistent storage contains metadata only, never values, page labels, URLs, or preview tokens", async () => {
  const h = harness();
  await h.workflow.dispatch({ command: "start" });
  const writes = h.calls.storage.join("\n");
  for (const secret of ["Private Name", "Private Detail", PORTAL, "token-", "First name"]) assert.equal(writes.includes(secret), false);
  assert.deepEqual(Object.keys(h.stored[STORAGE_KEY]).sort(), ["expiresAt", "filled", "pages", "phase", "tabId"]);
  assert.equal(JSON.stringify(await h.workflow.dispatch({ command: "status" })).includes("Private Name"), false);
});

test("only the owned extension popup can send commands", async () => {
  const h = harness();
  for (const sender of [undefined, { id: h.api.runtime.id }, { id: "other", url: h.api.runtime.getURL("popup.html") },
    { id: h.api.runtime.id, url: PORTAL }, { ...popup(h), tab: { id: 7 } }, { ...popup(h), url: h.api.runtime.getURL("popup.html?x=1") }]) {
    assert.equal(h.events.message({ command: "start" }, sender), undefined);
  }
  assert.equal(h.events.message({ command: "expire" }, popup(h)), undefined);
  assert.equal(h.calls.native.length, 0);
  assert.equal((await h.events.message({ command: "start" }, popup(h))).workflow.phase, "ready");
});

test("manual and unfamiliar pages pause without requesting private fields", async () => {
  for (const kind of ["manual", "mapping", "signature", "receipt"]) {
    const h = harness(); h.site.kind = kind; h.site.fields = []; h.site.actions = [];
    const view = await h.workflow.dispatch({ command: "start" });
    assert.equal(h.calls.native.length, 1); // Session validation only.
    assert.equal(h.calls.fill.length, 0);
    assert.equal(h.calls.act.length, 0);
    assert.equal(view.workflow.phase, kind === "manual" ? "paused" : kind);
  }
});

test("page-specific mappings require explicit selections and request only selected keys", async () => {
  const h = harness(); h.site.kind = "mapping";
  h.site.fields = [{ id: "unfamiliar-1", key: null, label: "Email address", type: "email" }];
  await h.workflow.dispatch({ command: "start" });
  assert.equal(h.calls.fill.length, 0);
  await h.workflow.dispatch({ command: "fill", previewToken: h.site.token, assignments: [{ id: "unfamiliar-1", key: "email" }] });
  assert.deepEqual(h.calls.native.at(-1).keys, ["email"]);
  assert.equal(h.calls.fill.length, 1);
  assert.equal(h.calls.act.length, 0);
});

test("invalid, duplicate, and undisplayed mappings are rejected before data release", async () => {
  for (const assignments of [[{ id: "unknown", key: "email" }], [{ id: "field-1", key: "ssn" }],
    [{ id: "field-1", key: "email" }, { id: "field-2", key: "email" }]]) {
    const h = harness(); h.site.kind = "mapping";
    h.site.fields = [{ id: "field-1", key: null }, { id: "field-2", key: null }];
    await h.workflow.dispatch({ command: "start" });
    const view = await h.workflow.dispatch({ command: "fill", previewToken: h.site.token, assignments });
    assert.equal(view.error, "mapping");
    assert.equal(h.calls.native.length, 1);
    assert.equal(h.calls.fill.length, 0);
  }
});

test("a stopped session cannot fill after a delayed native reply", async () => {
  const gate = deferred();
  const h = harness({ native: async (_input, count) => count === 1
    ? { fields: { firstName: "Private Name" }, expiresAt: Date.now() + 600000 } : gate.promise });
  const starting = h.workflow.dispatch({ command: "start" });
  while (h.calls.native.length < 2) await new Promise(resolve => setImmediate(resolve));
  const stopping = h.workflow.dispatch({ command: "stop" });
  gate.resolve({ fields: { firstName: "Private Name" }, expiresAt: Date.now() + 600000 });
  await starting; const view = await stopping;
  assert.equal(view.workflow, null);
  assert.equal(h.calls.fill.length, 0);
  assert.equal(h.calls.cancel, 1);
  assert.equal(h.stored[STORAGE_KEY], undefined);
});

test("native reply after an active-tab switch does not fill another tab", async () => {
  const gate = deferred();
  const h = harness({ native: async (_input, count) => count === 1
    ? { fields: {}, expiresAt: Date.now() + 600000 } : gate.promise });
  const starting = h.workflow.dispatch({ command: "start" });
  while (h.calls.native.length < 2) await new Promise(resolve => setImmediate(resolve));
  h.tab.id = 8;
  gate.resolve({ fields: { firstName: "Private Name" }, expiresAt: Date.now() + 600000 });
  assert.equal((await starting).error, "wrong_tab");
  assert.equal(h.calls.fill.length, 0);
});

test("same-tab navigation while awaiting native data invalidates the operation", async () => {
  const gate = deferred();
  const h = harness({ native: async (_input, count) => count === 1
    ? { fields: {}, expiresAt: Date.now() + 600000 } : gate.promise });
  const starting = h.workflow.dispatch({ command: "start" });
  while (h.calls.native.length < 2) await new Promise(resolve => setImmediate(resolve));
  h.tab.url = PORTAL + "Changed";
  h.events.updated(7, { status: "loading", url: h.tab.url });
  gate.resolve({ fields: { firstName: "Private Name" }, expiresAt: Date.now() + 600000 });
  await starting;
  assert.equal(h.calls.fill.length, 0);
});

test("expired sessions are deleted before any further data release or page action", async () => {
  const h = harness();
  await h.workflow.dispatch({ command: "start" });
  const nativeCalls = h.calls.native.length;
  h.advance(600001);
  const view = await h.workflow.dispatch({ command: "act", previewToken: h.site.token, actionID: "next" });
  assert.equal(view.workflow, null);
  assert.equal(h.stored[STORAGE_KEY], undefined);
  assert.equal(h.calls.native.length, nativeCalls);
  assert.equal(h.calls.act.length, 0);
});

test("submission needs explicit approval, a displayed signature action, and a fresh native session", async () => {
  const h = harness(); h.site.kind = "signature"; h.site.fields = [];
  h.site.actions = [{ id: "submit", kind: "submit", label: "Submit application" }];
  await h.workflow.dispatch({ command: "start" });
  assert.equal(h.calls.act.length, 0);
  assert.equal((await h.workflow.dispatch({ command: "act", previewToken: h.site.token, actionID: "submit" })).error, "approval");
  assert.equal(h.calls.act.length, 0);
  await h.workflow.dispatch({ command: "status" });
  const nativeCount = h.calls.native.length;
  await h.workflow.dispatch({ command: "act", previewToken: h.site.token, actionID: "submit", approved: true });
  assert.equal(h.calls.native.length, nativeCount + 1);
  assert.equal(h.calls.act.length, 1);
  assert.equal(h.calls.act[0][3], true);
  assert.equal(h.calls.actionPhases[0], "awaiting_confirmation");
  assert.equal(h.stored[STORAGE_KEY].phase, "awaiting_confirmation");
  await h.workflow.dispatch({ command: "status" });
  await h.workflow.dispatch({ command: "act", previewToken: h.site.token, actionID: "submit", approved: true });
  assert.equal(h.calls.act.length, 1);
});

test("form changes after the user sees a review are rejected without silently replacing the token", async () => {
  const h = harness();
  await h.workflow.dispatch({ command: "start" });
  const displayedToken = h.site.token;
  h.site.changed = true;
  const view = await h.workflow.dispatch({ command: "act", previewToken: h.site.token, actionID: "next" });
  assert.equal(view.error, "changed");
  assert.equal(h.calls.act[0][1], displayedToken);
  assert.equal(h.site.token, displayedToken);
});

test("a Continue click does not record submission; the next page may fill but never auto-submit", async () => {
  const h = harness();
  await h.workflow.dispatch({ command: "start" });
  await h.workflow.dispatch({ command: "act", previewToken: h.site.token, actionID: "next" });
  assert.equal(h.stored[STORAGE_KEY].phase, "navigating");
  h.site.kind = "signature"; h.site.actions = [{ id: "submit", kind: "submit" }];
  h.events.updated(7, { status: "complete" });
  await h.workflow.dispatch({ command: "status" });
  assert.equal(h.calls.act.length, 1);
  assert.equal(h.calls.native.filter(call => call.action === "recordReceipt").length, 0);
});

test("worker recovery never replays submission or a partially completed operation", async () => {
  for (const phase of ["awaiting_confirmation", "processing", "navigating"]) {
    const h = harness({ stored: { tabId: 7, expiresAt: Date.now() + 500000, phase, pages: 1, filled: 3 } });
    h.site.kind = "signature"; h.site.actions = [{ id: "submit", kind: "submit" }];
    const view = await h.workflow.dispatch({ command: "status" });
    assert.equal(h.calls.act.length, 0);
    assert.equal(h.calls.fill.length, 0);
    if (phase === "awaiting_confirmation") assert.equal(view.workflow.phase, phase);
  }
});

test("receipt recording requires the receipt page and user confirmation, then clears the session", async () => {
  const h = harness(); h.site.kind = "receipt"; h.site.fields = []; h.site.actions = [];
  await h.workflow.dispatch({ command: "start" });
  await h.workflow.dispatch({ command: "receipt", previewToken: h.site.token, confirmationNumber: "EXAMPLE-123" });
  assert.equal(h.calls.native.filter(call => call.action === "recordReceipt").length, 0);
  await h.workflow.dispatch({ command: "status" });
  const view = await h.workflow.dispatch({ command: "receipt", previewToken: h.site.token, confirmed: true, confirmationNumber: "EXAMPLE-123" });
  assert.equal(view.workflow, null);
  const receipt = h.calls.native.find(call => call.action === "recordReceipt");
  assert.equal(receipt.confirmationNumber, "EXAMPLE-123");
  assert.equal(receipt.receiptID, "f1496248-1495-4d78-b80e-f37a65e7c544");
  assert.equal(h.calls.storage.some(write => write.includes("EXAMPLE-123")), false);
});

test("manifest requests additional HTTPS sites only as optional access and runs a nonpersistent Safari background", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../SafariExtension/Resources/manifest.json"), "utf8"));
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.background.persistent, false);
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.permissions.includes("storage"));
});


test("revoked native sharing prevents an already-reviewed submission", async () => {
  const h = harness({ native: async (_input, count) => count === 1
    ? { fields: {}, expiresAt: Date.now() + 600000 } : { error: "session_expired" } });
  h.site.kind = "signature"; h.site.fields = []; h.site.actions = [{ id: "submit", kind: "submit" }];
  await h.workflow.dispatch({ command: "start" });
  const view = await h.workflow.dispatch({ command: "act", previewToken: h.site.token, actionID: "submit", approved: true });
  assert.equal(view.error, "session");
  assert.equal(h.calls.act.length, 0);
});

test("pausing interrupts the page engine and subsequent navigation does not resume filling", async () => {
  const h = harness();
  await h.workflow.dispatch({ command: "start" });
  await h.workflow.dispatch({ command: "pause" });
  assert.equal(h.calls.cancel, 1);
  h.site.fields = [{ id: "field-1", key: "firstName" }];
  h.events.updated(7, { status: "complete" });
  await h.workflow.dispatch({ command: "status" });
  assert.equal(h.calls.fill.length, 1);
});

async function popupHarness(initial) {
  const { JSDOM } = require("jsdom");
  const resources = path.join(__dirname, "../SafariExtension/Resources");
  const dom = new JSDOM(fs.readFileSync(path.join(resources, "popup.html"), "utf8"), { runScripts: "outside-only", url: "https://extension.invalid/popup.html" });
  const messages = [], permissionCalls = [];
  let response = {site: {origin: "https://hhsservices.iowa.gov", approved: true, iowa: true}, ...initial};
  dom.window.browser = {
    runtime: { async sendMessage(input) { messages.push(input); return response; } },
    permissions: { async request(input) { permissionCalls.push(input); return true; } }
  };
  dom.window.eval(fs.readFileSync(path.join(resources, "popup.js"), "utf8"));
  await new Promise(resolve => setImmediate(resolve));
  return { dom, messages, permissionCalls, node: id => dom.window.document.getElementById(id),
    setResponse(value) { response = value; }, async settle() { await new Promise(resolve => setImmediate(resolve)); } };
}
function popupView(kind, phase = kind) {
  return { workflow: { tabId: 7, expiresAt: Date.now() + 600000, phase, pages: 1, filled: 0 },
    scan: { previewToken: "popup-reviewed-token", kind, title: "Application step", fields: [], actions: [{ id: "submit", kind: "submit", label: "Submit application" }], populated: 0, ambiguous: 0 },
    message: "Review this page.", savedFields: { firstName: "First name", email: "Email" } };
}

test("popup requests host access only after Start and then begins the workflow", async () => {
  const h = await popupHarness({ workflow: null, scan: null, message: "Start a session", savedFields: {} });
  try {
    assert.equal(h.permissionCalls.length, 0);
    assert.deepEqual(h.messages.map(message => message.command), ["status"]);
    h.node("start").click();
    await h.settle();
    assert.equal(h.permissionCalls.length, 1);
    assert.equal(h.permissionCalls[0].origins[0], "https://hhsservices.iowa.gov/*");
    assert.deepEqual(h.messages.map(message => message.command), ["status", "start"]);
  } finally { h.dom.window.close(); }
});

test("popup submission needs review checkbox and discards approval after each response", async () => {
  const h = await popupHarness(popupView("signature"));
  try {
    assert.equal(h.node("submit").disabled, true);
    h.node("submit").click();
    assert.equal(h.messages.length, 1);
    h.node("reviewed").checked = true;
    h.node("reviewed").dispatchEvent(new h.dom.window.Event("change"));
    assert.equal(h.node("submit").disabled, false);
    h.node("submit").click();
    await h.settle();
    assert.equal(h.messages.at(-1).approved, true);
    assert.equal(h.messages.at(-1).actionID, "submit");
    assert.equal(h.node("reviewed").checked, false);
    assert.equal(h.node("submit").disabled, true);
  } finally { h.dom.window.close(); }
});

test("popup leaves unfamiliar mappings unselected and renders portal labels as text", async () => {
  const view = popupView("mapping");
  view.scan.fields = [{ id: "field-1", key: null, type: "email", label: "<img src=x onerror=alert(1)>" }];
  const h = await popupHarness(view);
  try {
    const select = h.node("fields").querySelector("select");
    assert.equal(select.value, "");
    assert.equal(h.node("fields").querySelector("img"), null);
    assert.ok(h.node("fields").textContent.includes("<img"));
    select.value = "email";
    h.node("fill").click(); await h.settle();
    assert.equal(h.messages.at(-1).command, "fill");
    assert.equal(h.messages.at(-1).assignments[0].id, "field-1");
    assert.equal(h.messages.at(-1).assignments[0].key, "email");
  } finally { h.dom.window.close(); }
});

test("an explicit pause survives page checks and blocks mutations until Resume", async () => {
  const h = harness();
  await h.workflow.dispatch({ command: "start" });
  await h.workflow.dispatch({ command: "pause" });
  h.site.fields = [{ id: "field-2", key: "firstName", label: "First name" }];
  assert.equal((await h.workflow.dispatch({ command: "status" })).workflow.phase, "suspended");
  const nativeCount = h.calls.native.length;
  const blocked = await h.workflow.dispatch({ command: "fill", previewToken: h.site.token, assignments: [{ id: "field-2", key: "firstName" }] });
  assert.equal(blocked.error, "paused");
  assert.equal(blocked.workflow.phase, "suspended");
  assert.equal(h.calls.native.length, nativeCount);
  await h.workflow.dispatch({ command: "resume" });
  assert.equal(h.calls.fill.length, 2);
});

test("popup Stop remains usable during filling and ignores the canceled request's late response", async () => {
  const view = popupView("mapping");
  view.scan.fields = [{ id: "field-1", key: null, type: "email", label: "Email" }];
  const h = await popupHarness(view);
  const gate = deferred();
  try {
    h.dom.window.browser.runtime.sendMessage = async input => {
      h.messages.push(input);
      return input.command === "fill" ? gate.promise : { workflow: null, scan: null, message: "Session stopped.", savedFields: {} };
    };
    h.node("fields").querySelector("select").value = "email";
    h.node("fill").click(); await h.settle();
    assert.equal(h.node("fill").disabled, true);
    assert.equal(h.node("stop").disabled, false);
    assert.equal(h.node("pause").disabled, false);
    h.node("stop").click(); await h.settle();
    assert.equal(h.messages.at(-1).command, "stop");
    assert.equal(h.node("session").hidden, true);
    gate.resolve(view); await h.settle();
    assert.equal(h.node("session").hidden, true);
    assert.equal(h.node("status").textContent, "Session stopped.");
  } finally { gate.resolve(view); h.dom.window.close(); }
});

test("the first Start operation exposes Stop while it is waiting for the native app", async () => {
  const h = await popupHarness({ workflow: null, scan: null, message: "Start a session", savedFields: {} });
  const gate = deferred();
  try {
    h.dom.window.browser.runtime.sendMessage = async input => {
      h.messages.push(input);
      return input.command === "start" ? gate.promise : { workflow: null, scan: null, message: "Session stopped.", savedFields: {} };
    };
    h.node("start").click(); await h.settle();
    assert.equal(h.node("session").hidden, false);
    assert.equal(h.node("stop").disabled, false);
    h.node("stop").click(); await h.settle();
    assert.equal(h.messages.at(-1).command, "stop");
    gate.resolve(popupView("known", "ready")); await h.settle();
    assert.equal(h.node("session").hidden, true);
  } finally { gate.resolve({ workflow: null }); h.dom.window.close(); }
});

test("a stale popup cannot approve the replacement preview even when its action ID is reused", async () => {
  const h = harness(); h.site.kind = "signature"; h.site.fields = [];
  h.site.actions = [{ id: "action-0", kind: "submit", label: "Submit application" }];
  const oldView = await h.workflow.dispatch({ command: "start" });
  const oldToken = oldView.scan.previewToken;
  h.site.actions = [{ id: "action-0", kind: "submit", label: "Submit changed application" }];
  const newView = await h.workflow.dispatch({ command: "status" });
  assert.notEqual(newView.scan.previewToken, oldToken);
  const nativeCount = h.calls.native.length;
  const result = await h.workflow.dispatch({ command: "act", previewToken: oldToken, actionID: "action-0", approved: true });
  assert.equal(result.error, "changed");
  assert.equal(h.calls.native.length, nativeCount);
  assert.equal(h.calls.act.length, 0);
});

test("old field mappings cannot target reused IDs in a replacement page preview", async () => {
  const h = harness(); h.site.kind = "mapping";
  h.site.fields = [{ id: "field-0", key: null, label: "Email", type: "email" }];
  const oldView = await h.workflow.dispatch({ command: "start" });
  h.site.fields = [{ id: "field-0", key: null, label: "Different applicant field", type: "text" }];
  await h.workflow.dispatch({ command: "status" });
  const nativeCount = h.calls.native.length;
  const result = await h.workflow.dispatch({ command: "fill", previewToken: oldView.scan.previewToken,
    assignments: [{ id: "field-0", key: "email" }] });
  assert.equal(result.error, "changed");
  assert.equal(h.calls.native.length, nativeCount);
  assert.equal(h.calls.fill.length, 0);
});

test("receipt commands require the preview token shown to that popup", async () => {
  const h = harness(); h.site.kind = "receipt"; h.site.fields = []; h.site.actions = [];
  const oldView = await h.workflow.dispatch({ command: "start" });
  await h.workflow.dispatch({ command: "status" });
  const result = await h.workflow.dispatch({ command: "receipt", previewToken: oldView.scan.previewToken,
    confirmed: true, confirmationNumber: "EXAMPLE-123" });
  assert.equal(result.error, "changed");
  assert.equal(h.calls.native.some(call => call.action === "recordReceipt"), false);
});

test("popup echoes its reviewed token and clears approval before sending, including transport failure", async () => {
  const h = await popupHarness(popupView("signature"));
  const gate = deferred();
  try {
    h.dom.window.browser.runtime.sendMessage = async input => {
      h.messages.push(input);
      await gate.promise;
      throw new Error("transport unavailable");
    };
    h.node("reviewed").checked = true;
    h.node("reviewed").dispatchEvent(new h.dom.window.Event("change"));
    h.node("submit").click();
    assert.equal(h.messages.at(-1).previewToken, "popup-reviewed-token");
    assert.equal(h.node("reviewed").checked, false);
    assert.equal(h.node("submit").disabled, true);
    gate.resolve(); await h.settle();
    assert.equal(h.node("page").hidden, true);
    assert.equal(h.node("submit").disabled, true);
  } finally { gate.resolve(); h.dom.window.close(); }
});
