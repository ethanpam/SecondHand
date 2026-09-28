"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const assistant = require("../SafariExtension/Resources/application-assistant.js");
const BASE = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/";
const APPLICANT = BASE + "enterPersonalInfo";
const applicantFixture = require("../../tests/fixtures/iowa-personal-information.cjs");
const addressFixture = require("../../tests/fixtures/iowa-select-address.cjs");
const knownHTML = applicantFixture.html;
function page(html = knownHTML, url = APPLICANT) {
  const dom = new JSDOM(`<!doctype html><html><body><main>${html}</main></body></html>`, { url, pretendToBeVisual: true });
  const doc = dom.window.document;
  const box = { left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 };
  for (const node of doc.querySelectorAll("*")) {
    node.getBoundingClientRect = () => box;
    node.getClientRects = () => [box];
  }
  if (html === knownHTML) applicantFixture.attachConditionalHandlers(doc);
  // Only synthetic events: there is no live site or network in this suite.
  doc.addEventListener("submit", event => event.preventDefault());
  return doc;
}
const act = (doc, url, token, actionID, approval, expires = Date.now() + 60_000) => assistant.act(doc, url, token, actionID, approval, expires);
const inspect = doc => assistant.inspect(doc, doc.location.href);
const selected = scan => scan.fields.filter(field => field.key).map(({ id, key }) => ({ id, key }));
const fill = (doc, scan, values, assignments = selected(scan)) => assistant.fill(doc, doc.location.href, scan.token, assignments, values, Date.now() + 60_000);
function completedApplicant() {
  const doc = page();
  doc.querySelector("#firstName").value = "Example";
  doc.querySelector("#lastName").value = "Applicant";
  doc.querySelector("#hasHome1").click();
  for (const [id, value] of Object.entries({ addressLine1: "100 Example Road", city: "Des Moines", state: "IA", zipcode: "50309" })) doc.getElementById(id).value = value;
  doc.querySelector("#sameAddress1").click();
  doc.querySelector("#applicant1").click();
  doc.querySelector("#snap").click();
  return doc;
}
function signature() {
  return page('<h1>E-Signature</h1><form action="signature"><label>Your name<input name="signature" value="Sample Applicant" required></label><label>Check to Sign<input type="checkbox" checked required></label><button>Submit Application</button></form>', BASE + "signature");
}

test("workflow URL policy accepts only clean application URLs and excludes accounts", () => {
  for (const route of ["enterPersonalInfo", "income", "signature", "confirmation"]) assert.equal(assistant.isPortalURL(BASE + route), true);
  for (const url of [BASE, BASE + "login", BASE + "userProfile", APPLICANT + "?a=b", APPLICANT + "#fragment",
    BASE + "../other", BASE + "%2e%2e/other", BASE + "income%2f", BASE + "income\\foo", " " + APPLICANT,
    APPLICANT.replace("https:", "http:"), APPLICANT.replace(".gov", ".gov.evil.test"),
    APPLICANT.replace("hhsservices", "user@hhsservices"), APPLICANT.replace(".gov/", ".gov:444/")]) {
    assert.equal(assistant.isPortalURL(url), false, url);
  }
});

test("known applicant mapping reuses typed laptop fields without exposing existing values", async () => {
  const doc = page();
  doc.querySelector("#lastName").value = "PRIVATE_EXISTING_VALUE";
  const scan = inspect(doc);
  assert.equal(scan.kind, "known");
  assert.deepEqual(selected(scan).map(field => field.key), ["firstName", "middleName", "homePhone", "mobilePhone"]);
  assert.equal(JSON.stringify(scan).includes("PRIVATE_EXISTING_VALUE"), false);
  const result = await fill(doc, scan, { firstName: "Ada", middleName: "Example", homePhone: "5155550100", mobilePhone: "+1 (515) 555-0101" });
  assert.equal(result.filled, 4);
  assert.equal(doc.querySelector("#phoneNumber").value, "(515)555-0100");
  assert.equal(doc.querySelector("#otherPhoneNumber").value, "(515)555-0101");
  assert.equal(doc.querySelector("#lastName").value, "PRIVATE_EXISTING_VALUE");
});

const enableHome = (doc, scan, value = "yes", expiresAt = Date.now() + 60_000) =>
  assistant.enableHomeAddress(doc, doc.location.href, scan.token, value, expiresAt);

test("verified home Yes uses Iowa's click handler and a fresh preview fills revealed address fields", async () => {
  const doc = page();
  const initial = inspect(doc);
  assert.equal(initial.canEnableHomeAddress, true);
  assert.ok(!initial.fields.some(field => field.key === "hasHomeAddress" || field.key === "city"));
  let clicks = 0;
  doc.querySelector("#hasHome1").addEventListener("click", () => { clicks++; });
  assert.equal((await enableHome(doc, initial)).filled, 1);
  assert.equal(clicks, 1);
  assert.equal(doc.querySelector("#hasHome1").checked, true);
  assert.equal(doc.querySelector("#homeAddrDiv").style.display, "block");
  assert.equal((await enableHome(doc, initial)).error, "preview_expired");
  const revealed = inspect(doc);
  assert.equal(revealed.documentID, initial.documentID);
  assert.notEqual(revealed.token, initial.token);
  assert.equal(revealed.canEnableHomeAddress, false);
  const result = await fill(doc, revealed, {
    addressLine1: "123 Test Way", addressLine2: "Unit 4", city: "Des Moines", state: "IA", postalCode: "50309"
  });
  assert.equal(result.filled, 5);
  assert.equal(doc.querySelector("#addressLine1").value, "123 Test Way");
  assert.equal(doc.querySelector("#city").value, "Des Moines");
  assert.equal(doc.querySelector("#state").value, "IA");
  assert.equal(doc.querySelector("#zipcode").value, "50309");
  assert.equal(doc.querySelector("#sameAddress1").checked, false);
  assert.equal(doc.querySelector("#applicant1").checked, false);
  assert.equal(doc.querySelector("#snap").checked, false);
});

test("home choice accepts only exact native yes and never a generic mapping", async () => {
  for (const value of [undefined, false, "no", "true", "Yes", " yes "]) {
    const doc = page();
    assert.equal((await enableHome(doc, inspect(doc), value === undefined ? null : value)).filled, 0);
    assert.equal(doc.querySelector("#hasHome1").checked, false);
    assert.equal(doc.querySelector("#hasHome2").checked, false);
  }
  const generic = page('<h1>Information</h1><form><label>Home answer<input id="home"></label></form>', BASE + "more");
  const scan = inspect(generic);
  assert.equal(scan.canEnableHomeAddress, false);
  assert.equal((await fill(generic, scan, { hasHomeAddress: "yes" }, [{ id: scan.fields[0].id, key: "hasHomeAddress" }])).error, "invalid_fields");
});

test("home choice rejects changed question schemas and never replaces existing Yes or No", async () => {
  for (const mutate of [
    doc => { doc.querySelector("#hasHome1").name = "differentQuestion"; },
    doc => { doc.querySelector("#hasHome1").value = "false"; },
    doc => { doc.querySelector("#hasHome1").setAttribute("onclick", "otherHandler()"); },
    doc => { doc.querySelector("#hasHome1").closest("fieldset").querySelector("legend").textContent = "Does another person have a home address?"; },
    doc => { doc.querySelector("#hasHome2").insertAdjacentHTML("afterend", '<input name="hasHome" type="radio" value="unknown">'); },
    doc => { doc.querySelector("#hasHome1").click(); },
    doc => { doc.querySelector("#hasHome2").click(); }
  ]) {
    const doc = page(); mutate(doc);
    const selectedBefore = Array.from(doc.querySelectorAll('input[name="hasHome"]'), element => element.checked);
    const scan = inspect(doc);
    assert.equal(scan.canEnableHomeAddress, false);
    assert.equal((await enableHome(doc, scan)).error, "preview_expired");
    assert.deepEqual(Array.from(doc.querySelectorAll('input[name="hasHome"]'), element => element.checked), selectedBefore);
  }
});

test("home Yes does not run a handler that could erase dependent home or mailing answers", async () => {
  for (const id of ["addressLine1", "city", "state", "zipcode", "mailingAddressLine1", "mailingCity", "sameAddress1", "sameAddress2"]) {
    const doc = page(), control = doc.getElementById(id);
    if (control.type === "radio") control.checked = true;
    else control.value = control.tagName === "SELECT" ? "IA" : "Existing answer";
    const before = Array.from(doc.querySelectorAll("input,select"), element => [element.value, element.checked]);
    let clicks = 0;
    doc.querySelector("#hasHome1").addEventListener("click", () => { clicks++; });
    assert.equal((await enableHome(doc, inspect(doc))).filled, 0, id);
    assert.equal(clicks, 0, id);
    assert.deepEqual(Array.from(doc.querySelectorAll("input,select"), element => [element.value, element.checked]), before, id);
  }
});

test("home choice checks cancellation, expiry, document changes and overlays after asynchronous reveal", async () => {
  for (const [label, interrupt] of [
    ["Stop", doc => assistant.cancel(doc)],
    ["changed answer", doc => { doc.querySelector("#lastName").value = "User edit"; }],
    ["changed radio", doc => { doc.querySelector("#hasHome1").name = "otherQuestion"; }],
    ["navigation", doc => { doc.defaultView.history.replaceState({}, "", BASE + "income"); }],
    ["overlay", doc => { doc.elementFromPoint = () => doc.body; }]
  ]) {
    const doc = page(), target = doc.querySelector("#hasHome1"), normal = target.getBoundingClientRect;
    target.getBoundingClientRect = () => ({ left: 20, right: 220, top: 1000, bottom: 1030, width: 200, height: 30 });
    target.scrollIntoView = () => { target.getBoundingClientRect = normal; interrupt(doc); };
    const scan = inspect(doc);
    await enableHome(doc, scan);
    assert.equal(target.checked, false, label);
  }
  const expired = page();
  assert.equal((await enableHome(expired, inspect(expired), "yes", Date.now() - 1)).error, "session_expired");
  assert.equal(expired.querySelector("#hasHome1").checked, false);
  const changed = page(), scan = inspect(changed);
  changed.querySelector("#hasHome1").name = "otherQuestion";
  assert.equal((await enableHome(changed, scan)).error, "preview_expired");
});

test("a native home grant that expires during scrolling cannot click Yes", async () => {
  const doc = page(), target = doc.querySelector("#hasHome1");
  const originalNow = Date.now, normal = target.getBoundingClientRect;
  const expiresAt = Date.now() + 1_000;
  target.getBoundingClientRect = () => ({ left: 20, right: 220, top: 1000, bottom: 1030, width: 200, height: 30 });
  target.scrollIntoView = () => { target.getBoundingClientRect = normal; Date.now = () => expiresAt; };
  const scan = inspect(doc);
  try {
    assert.equal((await enableHome(doc, scan, "yes", expiresAt)).error, "preview_expired");
    assert.equal(target.checked, false);
  } finally { Date.now = originalNow; }
});

test("unknown pages never infer an answer but accept a user-selected mapping", async () => {
  const doc = page('<h1>Income</h1><form action="income"><label>Monthly earnings<input id="earnings" name="earnings"></label><label>Email<input type="email" id="email"></label><button>Continue</button></form>', BASE + "income");
  const scan = inspect(doc);
  assert.equal(scan.kind, "mapping");
  assert.ok(scan.fields.every(field => field.key === null));
  const result = await fill(doc, scan, { monthlyIncome: "1234.50", email: "example@example.invalid" }, [
    { id: scan.fields[0].id, key: "monthlyIncome" }, { id: scan.fields[1].id, key: "email" }
  ]);
  assert.equal(result.filled, 2);
  assert.equal(doc.querySelector("#earnings").value, "1234.50");
});

test("blocked credentials, identity, signature and other-person fields are never offered", () => {
  const doc = page('<h1>More information</h1><form action="more"><label>SSN<input name="ssn"></label><label>Date of birth<input name="dateOfBirth"></label><label>Signature<input name="signature"></label><label>Proof<input type="file"></label><label>Agree<input type="checkbox"></label><fieldset><legend>Household member</legend><label>First name<input name="first"></label></fieldset></form>', BASE + "more");
  assert.deepEqual(inspect(doc).fields, []);
  const child = page('<h1>Details</h1><form><label>Child first name<input id="childFirstName"></label><label>Spouse income<input name="spouseIncome"></label></form>', BASE + "more");
  assert.deepEqual(inspect(child).fields, []);
});

test("login, CAPTCHA, preliminary consent, uploads and receipt pages pause", () => {
  for (const [html, route, kind] of [
    ['<h1>Verify</h1><input id="captchaAnswer">', "selectHouseholdInfo", "manual"],
    ['<h1>Login</h1><input type="password">', "start", "manual"],
    ['<h1>Verify</h1><iframe title="CAPTCHA"></iframe>', "start", "manual"],
    ['<h1>Let’s get started</h1><input type="checkbox">', "letsGetStarted", "manual"],
    ['<h1>Verification Documents</h1><input type="file">', "documents", "manual"],
    ['<h1>Application Confirmation</h1>', "confirmation", "receipt"]
  ]) {
    const scan = inspect(page(html, BASE + route));
    assert.equal(scan.kind, kind);
    assert.deepEqual(scan.fields, []);
    assert.deepEqual(scan.actions, []);
  }
});

test("observed Iowa address selection stays manual on mobile, including errors and dialogs", async () => {
  for (const [name, options] of [["normal", {}], ["error", { error: true }], ["dialog", { modal: true }]]) {
    const doc = page(addressFixture.makeHtml(options), addressFixture.URL);
    addressFixture.attachHandlers(doc);
    const scan = inspect(doc);
    assert.equal(scan.kind, "manual", name);
    assert.deepEqual(scan.fields, [], name);
    assert.deepEqual(scan.actions, [], name);
    const result = await act(doc, addressFixture.URL, scan.token, "action-0", false);
    assert.equal(result.error, "approval_required", name);
    assert.equal(doc.__addressQa.nextClicks, 0, name);
    assert.deepEqual(doc.__addressQa.selectionClicks, [], name);
  }
});

test("address route or heading independently blocks generic mobile Continue", () => {
  for (const [html, url] of [
    ['<h1>Changed layout</h1><form action="selectedAddress"><button>Continue</button></form>', addressFixture.URL],
    ['<h1>Select Address</h1><form action="more"><button>Continue</button></form>', BASE + "more"]
  ]) {
    const scan = inspect(page(html, url));
    assert.equal(scan.kind, "manual");
    assert.deepEqual(scan.fields, []);
    assert.deepEqual(scan.actions, []);
  }
});

test("foreign form actions and navigation targets exclude data and actions", () => {
  for (const attrs of ['action="https://evil.example/"', 'action="/other"', 'action="income" target="_blank"']) {
    const doc = page(`<h1>Information</h1><form ${attrs}><label>Email<input type="email"></label><button>Continue</button></form>`, BASE + "income");
    assert.equal(inspect(doc).fields.length, 0);
    assert.equal(inspect(doc).actions.length, 0);
  }
});

test("a preview belongs to one document and tokens are consumed on failed validation", async () => {
  const doc = page();
  const scan = inspect(doc);
  assert.equal((await assistant.fill(doc, APPLICANT, scan.token, [{ id: "missing", key: "firstName" }], { firstName: "Ada" }, Date.now() + 1000)).error, "invalid_fields");
  assert.equal((await fill(doc, scan, { firstName: "Ada" })).error, "preview_expired");
  const newScan = inspect(doc);
  assert.equal((await fill(page(), newScan, { firstName: "Ada" })).error, "preview_expired");
  assert.equal(inspect(doc).documentID, newScan.documentID);
});

test("changes to answers, form structure, or identity invalidate an approved preview", async () => {
  for (const mutate of [doc => { doc.querySelector("#lastName").value = "User edit"; },
    doc => { doc.querySelector("form").action = "income"; },
    doc => { doc.querySelector("#firstName").name = "child"; },
    doc => { doc.querySelector("#firstName").replaceWith(doc.querySelector("#firstName").cloneNode(true)); }]) {
    const doc = page();
    const scan = inspect(doc);
    mutate(doc);
    assert.equal((await fill(doc, scan, { firstName: "Ada" })).error, "preview_expired");
  }
});

test("input handlers that change later recipient fields stop the affected writes", async () => {
  const doc = page();
  const scan = inspect(doc);
  doc.querySelector("#firstName").addEventListener("change", () => { doc.querySelector("#middleName").name = "child"; });
  await fill(doc, scan, { firstName: "Ada", middleName: "Should not fill" });
  assert.equal(doc.querySelector("#firstName").value, "Ada");
  assert.equal(doc.querySelector("#middleName").value, "");
});

test("offscreen rendered fields can scroll into view, occluded and hidden fields stay empty", async () => {
  const doc = page();
  const first = doc.querySelector("#firstName");
  const normal = first.getBoundingClientRect;
  first.getBoundingClientRect = () => ({ left: 20, right: 220, top: 1000, bottom: 1030, width: 200, height: 30 });
  let scrolled = 0;
  first.scrollIntoView = () => { scrolled++; first.getBoundingClientRect = normal; };
  const scan = inspect(doc);
  const result = await fill(doc, scan, { firstName: "Ada" });
  assert.equal(scrolled, 1);
  assert.equal(result.filled, 1);
  const covered = page();
  covered.elementFromPoint = () => covered.body;
  assert.equal((await fill(covered, inspect(covered), { firstName: "Ada" })).filled, 0);
  const hidden = page();
  hidden.querySelector("#firstName").hidden = true;
  assert.ok(!inspect(hidden).fields.some(field => field.key === "firstName"));
});

test("scrolling waits for delayed Safari layout and retries once before filling", async () => {
  for (const revealAfter of [2, 17]) {
    const doc = page(), first = doc.querySelector("#firstName");
    const normal = first.getBoundingClientRect;
    let frames = 0, scrolls = 0;
    first.getBoundingClientRect = () => frames >= revealAfter ? normal()
      : { left: 20, right: 220, top: 1000, bottom: 1030, width: 200, height: 30 };
    first.scrollIntoView = () => { scrolls++; };
    doc.defaultView.requestAnimationFrame = callback => queueMicrotask(() => { frames++; callback(); });
    const scan = inspect(doc);
    const assignment = selected(scan).filter(field => field.key === "firstName");
    assert.equal((await fill(doc, scan, { firstName: "Avery" }, assignment)).filled, 1);
    assert.equal(first.value, "Avery");
    assert.equal(frames, revealAfter + 1);
    assert.equal(scrolls, revealAfter <= 15 ? 1 : 2);
  }
});

test("permanently occluded or offscreen fields stop after thirty frames and two scrolls", async () => {
  for (const kind of ["occluded", "offscreen"]) {
    const doc = page(), first = doc.querySelector("#firstName");
    let frames = 0, scrolls = 0;
    if (kind === "occluded") doc.elementFromPoint = () => doc.body;
    else first.getBoundingClientRect = () => ({ left: 20, right: 220, top: 1000, bottom: 1030, width: 200, height: 30 });
    first.scrollIntoView = () => { scrolls++; };
    doc.defaultView.requestAnimationFrame = callback => queueMicrotask(() => { frames++; callback(); });
    const scan = inspect(doc);
    const result = await fill(doc, scan, { firstName: "Avery" }, selected(scan).filter(field => field.key === "firstName"));
    assert.equal(result.filled, 0);
    assert.equal(first.value, "");
    assert.equal(frames, 30);
    assert.equal(scrolls, 2);
  }
});

test("Stop, expiry and recipient changes during delayed layout still prevent every write", async () => {
  for (const interrupt of ["stop", "expire", "recipient"]) {
    const doc = page(), first = doc.querySelector("#firstName");
    const normal = first.getBoundingClientRect, originalNow = Date.now;
    const expiresAt = Date.now() + 1_000;
    let frames = 0;
    first.getBoundingClientRect = () => frames >= 3 ? normal()
      : { left: 20, right: 220, top: 1000, bottom: 1030, width: 200, height: 30 };
    first.scrollIntoView = () => {};
    doc.defaultView.requestAnimationFrame = callback => queueMicrotask(() => {
      frames++;
      if (frames === 2) {
        if (interrupt === "stop") assistant.cancel(doc);
        if (interrupt === "expire") Date.now = () => expiresAt;
        if (interrupt === "recipient") first.name = "childFirstName";
      }
      callback();
    });
    const scan = inspect(doc);
    try {
      const result = await assistant.fill(doc, APPLICANT, scan.token,
        selected(scan).filter(field => field.key === "firstName"), { firstName: "Avery" }, expiresAt);
      assert.equal(result.filled, 0, interrupt);
      assert.equal(first.value, "", interrupt);
      assert.equal(frames, interrupt === "recipient" ? 4 : 2, interrupt);
    } finally { Date.now = originalNow; }
  }
});

test("no values can be filled on signature pages", async () => {
  const doc = signature();
  const scan = inspect(doc);
  assert.equal(scan.kind, "signature");
  assert.equal(scan.fields.length, 0);
  assert.equal(scan.actions[0].kind, "submit");
  assert.equal((await fill(doc, scan, { firstName: "Ada" })).error, "preview_expired");
});

test("submission needs explicit approval and a fresh one-use unchanged review", async () => {
  const doc = signature();
  let clicks = 0;
  doc.querySelector("button").addEventListener("click", () => { clicks++; });
  let scan = inspect(doc);
  assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, false)).error, "approval_required");
  assert.equal(clicks, 0);
  scan = inspect(doc);
  const result = await act(doc, doc.location.href, scan.token, scan.actions[0].id, true);
  assert.deepEqual(result, { attempted: true, kind: "submit" });
  assert.equal(clicks, 1);
  assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, true)).error, "preview_expired");
  assert.equal(clicks, 1);
});

test("submission rejects edits after review and does not complete signature controls", async () => {
  for (const mutate of [doc => { doc.querySelector('input[name="signature"]').value = "Changed"; },
    doc => { doc.querySelector('input[type="checkbox"]').checked = false; },
    doc => { doc.querySelector("button").textContent = "Different action"; }]) {
    const doc = signature();
    const scan = inspect(doc);
    let clicks = 0;
    doc.querySelector("button").addEventListener("click", () => { clicks++; });
    mutate(doc);
    assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, true)).error, "preview_expired");
    assert.equal(clicks, 0);
  }
  const unsigned = signature();
  unsigned.querySelector('input[type="checkbox"]').checked = false;
  const scan = inspect(unsigned);
  assert.equal((await act(unsigned, unsigned.location.href, scan.token, scan.actions[0].id, true)).error, "needs_input");
  assert.equal(unsigned.querySelector('input[type="checkbox"]').checked, false);
});

test("changed attestation prose or review tables invalidate final approval", async () => {
  for (const html of ['<p id="review">I certify statement A.</p>', '<table><tr><td id="review">Monthly income: 100</td></tr></table>']) {
    const doc = signature();
    doc.querySelector("form").insertAdjacentHTML("afterbegin", html);
    const scan = inspect(doc);
    let clicks = 0;
    doc.querySelector("button").addEventListener("click", () => { clicks++; });
    doc.querySelector("#review").textContent = "Changed after your review";
    assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, true)).error, "preview_expired");
    assert.equal(clicks, 0);
  }
});

test("unrecognized signing, consent and submission steps cannot bypass final approval through Continue", () => {
  for (const html of [
    '<h1>Review and sign</h1><form action="submit"><label>Signature<input name="signature" value="Sample" required></label><button>Continue</button></form>',
    '<h1>Review</h1><form action="submitApplication"><button>Continue</button></form>',
    '<h1>About you</h1><form><label>I agree<input type="checkbox"></label><button>Continue</button></form>'
  ]) {
    const scan = inspect(page(html, BASE + "review"));
    assert.equal(scan.kind, "manual");
    assert.deepEqual(scan.actions, []);
    assert.deepEqual(scan.fields, []);
  }
});

test("Stop cancels a scrolling fill and invalidates a displayed submission approval", async () => {
  const doc = page();
  const first = doc.querySelector("#firstName");
  const box = first.getBoundingClientRect;
  first.getBoundingClientRect = () => ({ left: 20, right: 220, top: 900, bottom: 930, width: 200, height: 30 });
  first.scrollIntoView = () => { first.getBoundingClientRect = box; assistant.cancel(doc); };
  assert.equal((await fill(doc, inspect(doc), { firstName: "Ada", middleName: "Example" })).filled, 0);
  const sign = signature();
  const scan = inspect(sign);
  assistant.cancel(sign);
  assert.equal((await act(sign, sign.location.href, scan.token, scan.actions[0].id, true)).error, "preview_expired");
});

test("final actions require a live session, including after asynchronous scrolling", async () => {
  const doc = signature();
  let scan = inspect(doc);
  assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, true, Date.now() - 1)).error, "session_expired");
  const button = doc.querySelector("button");
  const box = button.getBoundingClientRect;
  button.getBoundingClientRect = () => ({ left: 20, right: 220, top: 900, bottom: 930, width: 200, height: 30 });
  button.scrollIntoView = () => { button.getBoundingClientRect = box; };
  let resolveFrame;
  doc.defaultView.requestAnimationFrame = callback => { resolveFrame = callback; };
  scan = inspect(doc);
  const expiration = Date.now() + 30;
  const pending = act(doc, doc.location.href, scan.token, scan.actions[0].id, true, expiration);
  await new Promise(resolve => setTimeout(resolve, 35));
  resolveFrame();
  assert.equal((await pending).error, "preview_expired");
});

test("Submit on an unrecognized page and multiple action controls are never operated", () => {
  for (const doc of [page('<h1>Other page</h1><form><button>Submit Application</button></form>', BASE + "other"),
    page('<h1>E-Signature</h1><form><button>Submit Application</button><button>Submit Application</button></form>', BASE + "signature"),
    page('<h1>Other page</h1><form><button>Continue</button><button>Next</button></form>', BASE + "other")]) {
    assert.equal(inspect(doc).actions.length, 0);
  }
});

test("Continue validates required answers, never silently fills defaults", async () => {
  const doc = page('<h1>Income</h1><form action="income"><label>Answer<input required></label><button>Continue</button></form>', BASE + "income");
  let clicks = 0;
  doc.querySelector("button").addEventListener("click", () => { clicks++; });
  let scan = inspect(doc);
  assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, false)).error, "needs_input");
  assert.equal(clicks, 0);
  doc.querySelector("input").value = "User supplied answer";
  scan = inspect(doc);
  assert.deepEqual(await act(doc, doc.location.href, scan.token, scan.actions[0].id, false), { attempted: true, kind: "continue" });
  assert.equal(clicks, 1);
});

test("formaction overrides and click-time overlay changes block navigation", async () => {
  const foreign = signature();
  foreign.querySelector("button").setAttribute("formaction", "https://evil.example/");
  assert.equal(inspect(foreign).actions.length, 0);
  const doc = signature();
  const scan = inspect(doc);
  doc.elementFromPoint = () => doc.body;
  doc.defaultView.requestAnimationFrame = callback => queueMicrotask(callback);
  assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, true)).error, "needs_input");
});

test("field formatting rejects truncation, guessed select values, wrong types, and invalid amounts", () => {
  const doc = page('<form><input maxlength="3"><select><option value=""></option><option value="IA">Iowa</option></select><input type="number"></form>');
  const [short, number] = doc.querySelectorAll("input");
  assert.equal(assistant.formatValue("firstName", "Too long", short), null);
  assert.equal(assistant.formatValue("state", "IA", doc.querySelector("select")), "IA");
  assert.equal(assistant.formatValue("state", "Nebraska", doc.querySelector("select")), null);
  assert.equal(assistant.formatValue("monthlyIncome", "-200", number), null);
  assert.equal(assistant.formatValue("monthlyIncome", "200.00", number), "200.00");
  assert.equal(assistant.formatValue("firstName", "200", number), null);
});

test("known Next requires applicant answers and program choices even without HTML required attributes", () => {
  const ready = completedApplicant();
  assert.equal(ready.querySelectorAll("[required]").length, 0);
  assert.equal(inspect(ready).actions.length, 1);
  for (const [reason, change] of [
    ["missing first name", doc => { doc.querySelector("#firstName").value = ""; }],
    ["missing last name", doc => { doc.querySelector("#lastName").value = ""; }],
    ["unanswered home question", doc => { doc.querySelector("#hasHome1").checked = false; }],
    ["unanswered applicant question", doc => { doc.querySelector("#applicant1").checked = false; }],
    ["no selected program", doc => { doc.querySelector("#snap").checked = false; }],
    ["label-only required field", doc => { doc.querySelector("#middleName").labels[0].firstChild.textContent = "Middle Name*"; }],
    ["missing observed radio", doc => { doc.querySelector("#applicant2").remove(); }],
    ["changed question identity", doc => { doc.querySelector("#hasHome1").name = "anotherQuestion"; }]
  ]) {
    const doc = completedApplicant();
    change(doc);
    assert.equal(doc.querySelector("form").checkValidity(), true, reason);
    assert.equal(inspect(doc).actions.length, 0, reason);
  }
});

test("known Next requires the laptop adapter's exact observed button and form", () => {
  for (const [reason, change] of [
    ["submit type", doc => { doc.querySelector(".saveAndContinueButton").type = "submit"; }],
    ["missing expected class", doc => { doc.querySelector(".saveAndContinueButton").className = "different"; }],
    ["different handler", doc => { doc.querySelector(".saveAndContinueButton").setAttribute("onclick", "differentAction()"); }],
    ["different form method", doc => { doc.querySelector("form").method = "get"; }],
    ["added form handler", doc => { doc.querySelector("form").setAttribute("onsubmit", "differentAction()"); }],
    ["different target", doc => { doc.querySelector("form").target = "_blank"; }],
    ["different action", doc => { doc.querySelector(".saveAndContinueButton").setAttribute("formaction", "otherStep"); }],
    ["duplicate Next", doc => { doc.querySelector("form").append(doc.querySelector(".saveAndContinueButton").cloneNode(true)); }]
  ]) {
    const doc = completedApplicant();
    change(doc);
    assert.equal(inspect(doc).actions.length, 0, reason);
  }
});

test("observed Next clicks once and rejects button or question changes after review", async () => {
  const doc = completedApplicant();
  let clicks = 0;
  doc.querySelector(".saveAndContinueButton").addEventListener("click", () => { clicks++; });
  const scan = inspect(doc);
  assert.deepEqual(await act(doc, APPLICANT, scan.token, scan.actions[0].id, false), { attempted: true, kind: "continue" });
  assert.equal(clicks, 1);
  assert.equal((await act(doc, APPLICANT, scan.token, scan.actions[0].id, false)).error, "preview_expired");
  assert.equal(clicks, 1);
  for (const change of [
    changed => { changed.querySelector(".saveAndContinueButton").setAttribute("onclick", "differentAction()"); },
    changed => { changed.querySelector(".saveAndContinueButton").classList.remove("saveAndContinueButton"); },
    changed => { changed.querySelector("#snap").checked = false; },
    changed => { changed.querySelector("#hasHome2").checked = true; }
  ]) {
    const changed = completedApplicant();
    const before = inspect(changed);
    let changedClicks = 0;
    changed.querySelector(".saveAndContinueButton").addEventListener("click", () => { changedClicks++; });
    change(changed);
    assert.equal((await act(changed, APPLICANT, before.token, before.actions[0].id, false)).error, "preview_expired");
    assert.equal(changedClicks, 0);
  }
});

test("generic Continue requires label-marked answers and a manually answered radio group", async () => {
  const doc = page('<h1>Income</h1><form action="income"><label>Monthly earnings*<input id="earnings" name="earnings"></label><fieldset><legend>How often are you paid?</legend><label>Monthly<input id="monthly" type="radio" name="frequency"></label><label>Weekly<input id="weekly" type="radio" name="frequency"></label></fieldset><button>Continue</button></form>', BASE + "income");
  assert.equal(doc.querySelectorAll("[required]").length, 0);
  assert.equal(doc.querySelector("form").checkValidity(), true);
  let clicks = 0;
  doc.querySelector("button").addEventListener("click", () => { clicks++; });
  let scan = inspect(doc);
  assert.equal(scan.kind, "mapping");
  assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, false)).error, "needs_input");
  assert.equal(doc.querySelector("#earnings").value, "");
  assert.equal(doc.querySelectorAll("input:checked").length, 0);
  doc.querySelector("#earnings").value = "1234.50";
  scan = inspect(doc);
  assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, false)).error, "needs_input");
  assert.equal(clicks, 0);
  doc.querySelector("#monthly").checked = true;
  scan = inspect(doc);
  assert.deepEqual(await act(doc, doc.location.href, scan.token, scan.actions[0].id, false), { attempted: true, kind: "continue" });
  assert.equal(clicks, 1);
});

test("generic Continue respects required checkbox groups, aria requirements, and visible validation errors", async () => {
  const doc = page('<h1>Contact preferences</h1><form action="preferences"><label>Contact detail<input id="contact" aria-required="true"></label><fieldset><legend>Preferred contact methods*</legend><label>Email<input id="emailChoice" type="checkbox" name="methods"></label><label>Phone<input id="phoneChoice" type="checkbox" name="methods"></label></fieldset><p role="alert" hidden>Fix this answer</p><button>Continue</button></form>', BASE + "preferences");
  let scan = inspect(doc);
  assert.equal(scan.kind, "mapping");
  assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, false)).error, "needs_input");
  doc.querySelector("#contact").value = "Applicant supplied detail";
  scan = inspect(doc);
  assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, false)).error, "needs_input");
  doc.querySelector("#emailChoice").checked = true;
  doc.querySelector('[role="alert"]').hidden = false;
  scan = inspect(doc);
  assert.equal((await act(doc, doc.location.href, scan.token, scan.actions[0].id, false)).error, "needs_input");
  doc.querySelector('[role="alert"]').hidden = true;
  scan = inspect(doc);
  assert.deepEqual(await act(doc, doc.location.href, scan.token, scan.actions[0].id, false), { attempted: true, kind: "continue" });
});
