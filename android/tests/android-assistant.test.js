"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { JSDOM } = require("jsdom");
const ROOT = path.resolve(__dirname, "../..");
const BASE = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/";
const files = ["extension/iowa-adapter.js", "ios/SafariExtension/Resources/field-mapper.js",
  "ios/SafariExtension/Resources/application-assistant.js", "android/app/src/main/assets/android-assistant.js"];

function fixture(html = '<h1>Income</h1><form action="income"><label>Monthly earnings<input name="earnings" required></label><button>Continue</button></form>', route = "income") {
  const dom = new JSDOM(`<!doctype html><main>${html}</main>`, { url: BASE + route, runScripts: "outside-only", pretendToBeVisual: true });
  const { document } = dom.window;
  const messages = [];
  dom.window.SecondHandBridge = { postMessage: message => messages.push(JSON.parse(message)) };
  for (const node of document.querySelectorAll("*")) {
    node.getBoundingClientRect = () => ({ left: 10, top: 10, right: 200, bottom: 40, width: 190, height: 30 });
    node.getClientRects = () => [node.getBoundingClientRect()];
  }
  document.addEventListener("submit", event => event.preventDefault());
  for (const file of files) dom.window.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const documentID = messages[0].documentID;
  const request = (operation, extra = {}) => ({ id: crypto.randomUUID(), documentID, generation: 4,
    operation, pageURL: dom.window.location.href, expiresAt: Date.now() + 60_000, ...extra });
  const send = async payload => {
    await dom.window.SecondHandAndroid.command(payload);
    return messages.find(message => message.id === payload.id);
  };
  return { dom, document, messages, request, send };
}

test("isolated transport readiness contains no form values and install is idempotent", () => {
  const h = fixture('<h1>Income</h1><form action="income"><label>Email<input name="email" value="PRIVATE_VALUE"></label></form>');
  try {
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].type, "ready");
    assert.equal(JSON.stringify(h.messages).includes("PRIVATE_VALUE"), false);
    h.dom.window.eval(fs.readFileSync(path.join(ROOT, files.at(-1)), "utf8"));
    assert.equal(h.messages.length, 1);
    assert.equal(Object.getOwnPropertyDescriptor(h.dom.window, "SecondHandAndroid").writable, false);
  } finally { h.dom.window.close(); }
});

test("native-issued document and URL bind commands; malformed requests never execute", async () => {
  const h = fixture();
  try {
    for (const extra of [{ documentID: crypto.randomUUID() }, { pageURL: BASE + "different" },
      { id: "website-id" }, { generation: "4" }, { operation: "getVault" }]) {
      assert.equal(await h.send(h.request("inspect", extra)), undefined);
    }
    assert.equal(h.messages.length, 1);
  } finally { h.dom.window.close(); }
});

test("async engine fill returns only counts, clears transport values, and rejects request replay", async () => {
  const h = fixture();
  try {
    const scan = (await h.send(h.request("inspect"))).result;
    const payload = h.request("fill", { token: scan.token,
      assignments: [{ id: scan.fields[0].id, key: "monthlyIncome" }], values: { monthlyIncome: "1234.50" } });
    const result = await h.send(payload);
    assert.equal(result.result.filled, 1);
    assert.equal(h.document.querySelector("input").value, "1234.50");
    assert.equal(payload.values, null);
    assert.equal(JSON.stringify(h.messages).includes("1234.50"), false);
    await h.dom.window.SecondHandAndroid.command(payload);
    assert.equal(h.messages.at(-1).error, "changed");
  } finally { h.dom.window.close(); }
});

test("cancel stops an asynchronously scrolling fill and drops late completion", async () => {
  const h = fixture();
  try {
    const scan = (await h.send(h.request("inspect"))).result;
    const input = h.document.querySelector("input");
    const box = input.getBoundingClientRect;
    input.getBoundingClientRect = () => ({ left: 10, right: 200, top: 1100, bottom: 1140, width: 190, height: 40 });
    input.scrollIntoView = () => { input.getBoundingClientRect = box; };
    const payload = h.request("fill", { token: scan.token,
      assignments: [{ id: scan.fields[0].id, key: "monthlyIncome" }], values: { monthlyIncome: "1234.50" } });
    const pending = h.send(payload);
    h.dom.window.SecondHandAndroid.cancel();
    assert.equal(await pending, undefined);
    assert.equal(input.value, "");
  } finally { h.dom.window.close(); }
});

test("submission is one-use and explicitly approved; changed attestation fails", async () => {
  const html = '<h1>E-Signature</h1><form action="signature"><p id="terms">I certify these answers.</p><label>Signature<input name="signature" value="Example" required></label><label>Check to Sign<input type="checkbox" checked required></label><button>Submit Application</button></form>';
  const h = fixture(html, "signature");
  try {
    let clicked = 0;
    h.document.querySelector("button").addEventListener("click", () => { clicked++; });
    let scan = (await h.send(h.request("inspect"))).result;
    assert.equal((await h.send(h.request("act", { token: scan.token, actionID: scan.actions[0].id, approved: false }))).error, "approval_required");
    assert.equal(clicked, 0);
    scan = (await h.send(h.request("inspect"))).result;
    h.document.querySelector("#terms").textContent = "Materially changed statement.";
    assert.equal((await h.send(h.request("act", { token: scan.token, actionID: scan.actions[0].id, approved: true }))).error, "preview_expired");
    assert.equal(clicked, 0);
    scan = (await h.send(h.request("inspect"))).result;
    const payload = h.request("act", { token: scan.token, actionID: scan.actions[0].id, approved: true });
    assert.equal((await h.send(payload)).result.attempted, true);
    await h.dom.window.SecondHandAndroid.command(payload);
    assert.equal(clicked, 1);
  } finally { h.dom.window.close(); }
});

test("adapter errors are fixed codes; exception values never cross the bridge", async () => {
  const h = fixture();
  try {
    const result = await h.send(h.request("fill", { token: "missing", assignments: [], values: { firstName: "PRIVATE_VALUE" } }));
    assert.equal(result.error, "preview_expired");
    assert.equal(JSON.stringify(h.messages).includes("PRIVATE_VALUE"), false);
  } finally { h.dom.window.close(); }
});
