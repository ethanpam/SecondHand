"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { createWorkflow } = require("../SafariExtension/Resources/background.js");
const { isPortalURL } = require("../SafariExtension/Resources/application-assistant.js");
const BASE = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/";
const RESOURCES = path.join(__dirname, "../SafariExtension/Resources");
const applicantFixture = require("../../tests/fixtures/iowa-personal-information.cjs");

test("local multi-page application: automatic known fill, explicit mapping, signed approval, reported receipt", async () => {
  // These are synthetic forms. Neither the native bridge nor Iowa's site is contacted.
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
  const onUpdated = event();
  const nativeCalls = [];
  const storage = {};
  let dom;
  let submitted = 0;
  const profile = { firstName: "Example", lastName: "Applicant", monthlyIncome: "1234.50", hasHomeAddress: "yes",
    addressLine1: "100 Example Road", city: "Des Moines", state: "IA", postalCode: "50309" };
  const pages = {
    enterPersonalInfo: applicantFixture.html,
    income: '<h1>Income</h1><form action="income"><label>Monthly earnings<input id="earnings" required></label><button>Continue</button></form>',
    signature: '<h1>E-Signature</h1><form action="signature"><p>I certify these answers are accurate.</p><label>Your signature<input id="signature" required></label><label>Check to Sign<input id="signed" type="checkbox" required></label><button>Submit Application</button></form>',
    confirmation: '<h1>Application Confirmation</h1><p>Confirmation number: EXAMPLE-123</p>'
  };
  function navigate(route, emit = true) {
    if (emit) onUpdated.emit(7, { status: "loading", url: BASE + route });
    dom = new JSDOM(`<!doctype html><main>${pages[route]}</main>`, { url: BASE + route, runScripts: "outside-only", pretendToBeVisual: true });
    const doc = dom.window.document;
    const box = { left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 };
    for (const element of doc.querySelectorAll("*")) {
      element.getBoundingClientRect = () => box;
      element.getClientRects = () => [box];
    }
    if (route === "enterPersonalInfo") {
      // Reuse the desktop's sanitized observed schema and local show/hide handlers.
      applicantFixture.attachConditionalHandlers(doc);
      doc.querySelector(".saveAndContinueButton").addEventListener("click", () => doc.querySelector("form").requestSubmit());
    }
    doc.addEventListener("submit", event => {
      event.preventDefault();
      if (route === "signature") submitted++;
      navigate(({ enterPersonalInfo: "income", income: "signature", signature: "confirmation" })[route]);
    });
    if (emit) onUpdated.emit(7, { status: "complete" });
  }
  navigate("enterPersonalInfo", false);
  const api = {
    storage: { local: {
      get: async key => ({ [key]: storage[key] }),
      set: async value => Object.assign(storage, value),
      remove: async key => { delete storage[key]; }
    } },
    tabs: { query: async () => [{ id: 7, url: dom.window.location.href }], onUpdated, onRemoved: event(), onActivated: event() },
    runtime: { id: "test-extension", getURL: file => "extension://test/" + file, onMessage: event(),
      sendNativeMessage: async (_name, request) => {
        nativeCalls.push(request);
        if (request.action === "recordReceipt") return { recorded: true };
        return { expiresAt: Date.now() + 599_000, fields: Object.fromEntries(request.keys.filter(key => profile[key]).map(key => [key, profile[key]])) };
      }
    },
    scripting: { executeScript: async args => {
      if (args.files) {
        for (const file of args.files) {
          const source = file === "iowa-adapter.js" ? path.join(__dirname, "../../extension/iowa-adapter.js") : path.join(RESOURCES, file);
          dom.window.eval(fs.readFileSync(source, "utf8"));
        }
        return [{ frameId: 0 }];
      }
      const result = await dom.window.eval(`(${args.func.toString()})`)(...(args.args || []));
      return [{ frameId: 0, result }];
    } }
  };
  const workflow = createWorkflow(api, { isPortalURL, disableTimer: true, uuid: () => "c3a65cce-79dc-4f8a-9b49-9563089a25ac" }).install();
  let view = await workflow.dispatch({ command: "start" });
  assert.equal(view.workflow.phase, "ready");
  assert.equal(dom.window.document.querySelector("#firstName").value, "Example");
  assert.equal(dom.window.document.querySelector("#lastName").value, "Applicant");
  assert.equal(submitted, 0);
  assert.equal(view.scan.actions.length, 0);
  assert.equal(dom.window.document.querySelectorAll("input[required]").length, 0);
  assert.equal(dom.window.document.querySelectorAll("input:checked").length, 1);
  assert.equal(dom.window.document.querySelector("#hasHome1").checked, true);
  for (const [id, value] of Object.entries({ addressLine1: "100 Example Road", city: "Des Moines", state: "IA", zipcode: "50309" })) {
    assert.equal(dom.window.document.getElementById(id).value, value);
  }
  assert.equal(view.workflow.filled, 6); // Text/select fields; Yes is reported separately.
  assert.match(view.message, /Home address Yes selected/);
  assert.ok(!Object.hasOwn(view.savedFields, "hasHomeAddress"));
  assert.deepEqual(nativeCalls[1].keys, ["hasHomeAddress"]);
  // The remaining program and household answers come from the applicant.
  dom.window.document.querySelector("#sameAddress1").click();
  dom.window.document.querySelector("#applicant1").click();
  dom.window.document.querySelector("#snap").click();
  view = await workflow.dispatch({ command: "status" });
  assert.equal(view.scan.actions.length, 1);
  await workflow.dispatch({ command: "act", previewToken: view.scan.previewToken, actionID: view.scan.actions[0].id });
  view = await workflow.dispatch({ command: "status" });
  assert.equal(view.scan.kind, "mapping");
  assert.equal(dom.window.document.querySelector("#earnings").value, "");
  view = await workflow.dispatch({ command: "fill", previewToken: view.scan.previewToken, assignments: [{ id: view.scan.fields[0].id, key: "monthlyIncome" }] });
  assert.equal(dom.window.document.querySelector("#earnings").value, "1234.50");
  await workflow.dispatch({ command: "act", previewToken: view.scan.previewToken, actionID: view.scan.actions[0].id });
  view = await workflow.dispatch({ command: "status" });
  assert.equal(view.scan.kind, "signature");
  assert.equal(submitted, 0);
  assert.equal(dom.window.document.querySelector("#signed").checked, false);
  // The applicant signs on the website; the extension never supplies a signature.
  dom.window.document.querySelector("#signature").value = "Example Applicant";
  dom.window.document.querySelector("#signed").checked = true;
  view = await workflow.dispatch({ command: "status" });
  await workflow.dispatch({ command: "act", previewToken: view.scan.previewToken, actionID: view.scan.actions[0].id, approved: true });
  assert.equal(submitted, 1);
  view = await workflow.dispatch({ command: "status" });
  assert.equal(view.scan.kind, "receipt");
  assert.equal(nativeCalls.filter(call => call.action === "recordReceipt").length, 0);
  await workflow.dispatch({ command: "receipt", previewToken: view.scan.previewToken, confirmed: true, confirmationNumber: "EXAMPLE-123" });
  assert.equal(nativeCalls.filter(call => call.action === "recordReceipt").length, 1);
  assert.deepEqual(storage, {});
  assert.equal(submitted, 1);
  dom.window.close();
});
