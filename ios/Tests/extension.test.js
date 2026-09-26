"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const mapper = require("../SafariExtension/Resources/field-mapper.js");
const PORTAL = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo";
// Sanitized schema fixture transcribed from docs/iowa-portal.md; no live values.
const observedLabels = { firstName: "First Name*", lastName: "Last Name*", addressLine1: "Home Address Line 1*",
  addressLine2: "Home Address Line 2", city: "City*", state: "State*", zipcode: "Zip Code (99999)*" };
function label(textContent) { return { textContent, cloneNode() { return { textContent, querySelectorAll: () => [] }; } }; }

class Input {
  constructor(options = {}) {
    Object.assign(this, {
      tagName: "INPUT", type: "text", id: "", name: "", labels: [], attributes: {},
      disabled: false, readOnly: false, multiple: false, isConnected: true,
      visible: true, maxLength: -1, nodeType: 1, parentElement: null, events: [], _value: "",
      style: { display: "block", visibility: "visible", opacity: "1" }
    }, options);
    if (!Object.hasOwn(options, "name")) this.name = this.id;
    if (!Object.hasOwn(options, "labels") && observedLabels[this.id]) this.labels = [label(observedLabels[this.id])];
  }
  get value() { return this._value; }
  set value(value) { this._value = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  matches(selector) { return selector === ":disabled" && this.disabled; }
  closest(selector) {
    if (selector === "#personalInformation #homeAddrDiv") return this.homeContainer ? {} : null;
    if (selector === "fieldset") return this.legend ? { querySelector: () => ({ textContent: this.legend }) } : null;
    if (selector === "section") return this.sectionHeading ? { querySelector: () => ({ textContent: this.sectionHeading }) } : null;
    return this.hiddenAncestor ? {} : null;
  }
  getClientRects() { return this.visible ? [{}] : []; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 210, bottom: 40, width: 200, height: 30 }; }
  contains(node) { return node === this; }
  dispatchEvent(event) { this.events.push(event.type); this.onEvent?.(event); }
}
class Select extends Input { constructor(options = {}) { super({ tagName: "SELECT", type: "select-one", options: [], ...options }); } }
Object.defineProperty(Select.prototype, "value", Object.getOwnPropertyDescriptor(Input.prototype, "value"));

function fakeDocument(fields, url = PORTAL) {
  const window = {
    location: { href: url }, crypto: { randomUUID: () => "preview-token" },
    HTMLInputElement: Input, HTMLSelectElement: Select, Event: class { constructor(type) { this.type = type; } },
    getComputedStyle: element => element.style
  };
  window.innerWidth = 1024;
  window.innerHeight = 768;
  window.top = window;
  const form = { action: "enterPersonalInfo", getAttribute(name) { return name === "action" ? this.action : null; } };
  return { fields, form, forms: [form], headings: [new Input({ tagName: "H1", textContent: "Enter Personal Information" })], defaultView: window, querySelectorAll(selector) {
    for (const field of this.fields) if (!field.form) field.form = form;
    if (selector === "form#personalInformation") return this.forms;
    if (selector === "h1, h2, h3") return this.headings;
    if (selector === "input") return this.fields.filter(field => field.tagName === "INPUT");
    return this.fields;
  }, getElementById() { return null; } };
}
function hints(overrides = {}) { return { id: "", name: "", labels: [], type: "text", autocomplete: "", placeholder: "", ...overrides }; }
function fill(document, preview, values, expiresAt = Date.now() + 60_000) {
  return mapper.fill(document, PORTAL, preview.token, values, expiresAt);
}

test("URL policy accepts only HTTPS Iowa portal pages", () => {
  assert.equal(mapper.isAllowedURL(PORTAL), true);
  for (const url of ["http://hhsservices.iowa.gov/apspssp/form", "https://evil.example/apspssp/form",
    "https://hhsservices.iowa.gov.evil.example/apspssp/form", "https://user@hhsservices.iowa.gov/apspssp/form",
    "https://hhsservices.iowa.gov/other/form", "https://hhsservices.iowa.gov/apspssp/../other",
    "https://hhsservices.iowa.gov:444/apspssp/form", "https://hhsservices.iowa.gov/apspssp/%2e%2e/other",
    "https://hhsservices.iowa.gov/apspssp", PORTAL + "?page=sign-up", PORTAL + "?route=user%50rofile",
    "https://hhsservices.iowa.gov/apspssp/registration", PORTAL + "/login/personalInfoSignup",
    "garbage"]) assert.equal(mapper.isAllowedURL(url), false, url);
});

test("only observed exact ID/name/type/label pairs map to applicant keys", () => {
  assert.equal(mapper.classify(hints({ id: "firstName", name: "firstName", labels: ["First Name*"] })), "firstName");
  assert.equal(mapper.classify(hints({ id: "addressLine1", name: "addressLine1", labels: ["Home Address Line 1*"], homeContainer: true })), "addressLine1");
  assert.equal(mapper.classify(hints({ id: "firstName", name: "first_name", labels: ["First Name*"] })), null);
  assert.equal(mapper.classify(hints({ id: "firstName", name: "firstName", autocomplete: "given-name" })), null);
  assert.equal(mapper.classify(hints({ id: "firstName", name: "firstName", labels: ["First Name*"], type: "email" })), null);
});

test("broad, conflicting, sectioned and sensitive hints are rejected", () => {
  for (const candidate of [hints({ name: "household[0].firstName" }), hints({ labels: ["Name"] }),
    hints({ id: "lastName", autocomplete: "given-name" }), hints({ autocomplete: "section-child given-name" }),
    hints({ id: "ssn", autocomplete: "tel" }), hints({ labels: ["Date of birth"], id: "phone" }),
    hints({ labels: ["Monthly income"], autocomplete: "email" }), hints({ autocomplete: "name" }),
    hints({ autocomplete: "tel-area-code", id: "phone" })]) assert.equal(mapper.classify(candidate), null);
});

test("saved home address is never inferred to be a mailing, shipping or billing address", () => {
  assert.equal(mapper.classify(hints({ id: "residentialAddressLine1" })), null);
  for (const candidate of [hints({ id: "mailingAddressLine1" }), hints({ id: "addressLine1", labels: ["Mailing address"] }),
    hints({ id: "city", groupLabel: "Shipping address" }), hints({ id: "state", groupLabel: "Billing details" }),
    hints({ autocomplete: "shipping address-line1" })]) assert.equal(mapper.classify(candidate), null);
  const document = fakeDocument([new Input({ id: "city", legend: "Mailing address" }),
    new Input({ id: "postalCode", sectionHeading: "Mailing address" })]);
  assert.equal(mapper.scan(document, PORTAL).fields.length, 0);
});

test("preview returns names and counts without exposing existing values", () => {
  const document = fakeDocument([new Input({ id: "firstName" }), new Input({ id: "lastName", _value: "secret@example.test" })]);
  const preview = mapper.scan(document, PORTAL);
  assert.deepEqual(preview.fields, [{ key: "firstName", label: "First name" }]);
  assert.equal(preview.populated, 1);
  assert.equal(JSON.stringify(preview).includes("secret"), false);
});

test("duplicate contact fields remain ambiguous even if one is populated", () => {
  const document = fakeDocument([new Input({ id: "firstName" }), new Input({ id: "firstName", _value: "Child" })]);
  const preview = mapper.scan(document, PORTAL);
  assert.equal(preview.fields.length, 0);
  assert.equal(preview.ambiguous, 2);
});

test("unsafe, hidden and other-person fields are never previewed", () => {
  const fields = ["file", "checkbox", "radio", "hidden", "number", "date"].map(type => new Input({ id: "firstName", type }));
  fields.push(...[{ disabled: true }, { readOnly: true }, { visible: false }, { hiddenAncestor: true },
    { isConnected: false }, { legend: "Household member" }, { legend: "Spouse information" },
    { style: { display: "none", visibility: "visible", opacity: "1" } },
    { style: { display: "block", visibility: "visible", opacity: "0" } },
    { type: "email" }].map(options => new Input({ id: "firstName", ...options })));
  assert.equal(mapper.scan(fakeDocument(fields), PORTAL).fields.length, 0);
});

test("account and identity forms are rejected even on the generic portal route", () => {
  const document = fakeDocument([new Input({ id: "firstName" }), new Input({ type: "password" })]);
  assert.equal(mapper.scan(document, PORTAL).error, "account_page");
  document.fields.pop();
  document.headings = [{ textContent: "Create an account" }];
  assert.equal(mapper.scan(document, PORTAL).error, "account_page");
});

test("observed page heading and exact unique applicant form/action are required", () => {
  for (const mutate of [document => { document.headings = []; }, document => { document.headings[0].textContent = "About you"; },
    document => { document.headings[0].hidden = true; }, document => { document.form.action = "enterAgencyDetails"; },
    document => { document.forms = []; }, document => { document.forms.push(document.form); }]) {
    const document = fakeDocument([new Input({ id: "firstName" })]);
    mutate(document);
    assert.equal(mapper.scan(document, PORTAL).error, "unrecognized_form");
  }
});

test("only controls in the exact applicant form and visible home address container map", () => {
  const first = new Input({ id: "firstName", form: {} });
  const home = new Input({ id: "addressLine1", homeContainer: true });
  const city = new Input({ id: "city" });
  const zip = new Input({ id: "zipcode", homeContainer: true });
  const document = fakeDocument([first, home, city, zip]);
  const scan = mapper.scan(document, PORTAL);
  assert.deepEqual(scan.fields.map(field => field.key), ["addressLine1", "postalCode"]);
  assert.equal(fill(document, scan, { addressLine1: "100 Example Road", postalCode: "50309-1234" }).filled, 1);
  assert.equal(zip.value, "");
});

test("observed home/mobile phone fields use explicit keys and email is not inferred", () => {
  const document = fakeDocument([new Input({ id: "phoneNumber", labels: [label("Home Phone Number (999)999-9999")] }),
    new Input({ id: "otherPhoneNumber", labels: [label("Mobile Phone Number (999)999-9999")] }),
    new Input({ id: "email", labels: [label("Email address")], attributes: { autocomplete: "email" } })]);
  assert.deepEqual(mapper.scan(document, PORTAL).fields.map(field => field.key), ["homePhone", "mobilePhone"]);
  const preview = mapper.scan(document, PORTAL);
  assert.equal(fill(document, preview, { phone: "5155550100" }).error, "invalid_fields");
});

test("ancestor section headings must identify the applicant or a known page section", () => {
  for (const title of ["Applicant's Information", "Unknown person", "Household members"]) {
    const first = new Input({ id: "firstName" });
    const heading = new Input({ tagName: "H3", textContent: title });
    heading.matches = selector => selector.includes("h3");
    const section = new Input({ tagName: "DIV", children: [heading, first] });
    first.parentElement = section;
    const document = fakeDocument([first]);
    assert.equal(mapper.scan(document, PORTAL).fields.length, title === "Applicant's Information" ? 1 : 0);
  }
});

test("offscreen and covered inputs are skipped until the user exposes them", () => {
  const first = new Input({ id: "firstName" });
  const document = fakeDocument([first]);
  document.elementFromPoint = () => ({});
  assert.equal(mapper.scan(document, PORTAL).fields.length, 0);
  document.elementFromPoint = () => first;
  first.getBoundingClientRect = () => ({ left: 10, top: 900, right: 210, bottom: 930, width: 200, height: 30 });
  assert.equal(mapper.scan(document, PORTAL).fields.length, 0);
});

test("changing the applicant form action invalidates an existing preview", () => {
  const first = new Input({ id: "firstName" });
  const document = fakeDocument([first]);
  const preview = mapper.scan(document, PORTAL);
  document.form.action = "enterAgencyDetails";
  assert.equal(fill(document, preview, { firstName: "Example" }).error, "preview_expired");
  assert.equal(first.value, "");
});

test("scan rejects subframes and URL disagreement", () => {
  const document = fakeDocument([new Input({ id: "email" })]);
  document.defaultView.top = {};
  assert.equal(mapper.scan(document, PORTAL).error, "unsupported_page");
  document.defaultView.top = document.defaultView;
  assert.equal(mapper.scan(document, PORTAL + "?changed").error, "unsupported_page");
});

test("fill writes only previewed empty fields and emits form events without submission", () => {
  const first = new Input({ id: "firstName" });
  const last = new Input({ id: "lastName" });
  const document = fakeDocument([first, last]);
  const preview = mapper.scan(document, PORTAL);
  assert.deepEqual(fill(document, preview, { firstName: "Ada" }), { filled: 1, skipped: 1 });
  assert.equal(first.value, "Ada");
  assert.deepEqual(first.events, ["input", "change"]);
  assert.equal(last.value, "");
});

test("a fill token is single-use and unmatched keys are rejected", () => {
  const field = new Input({ id: "firstName" });
  const document = fakeDocument([field]);
  const preview = mapper.scan(document, PORTAL);
  assert.equal(fill(document, preview, { ssn: "123" }).error, "invalid_fields");
  assert.equal(fill(document, preview, { firstName: "Ada" }).error, "preview_expired");
  assert.equal(field.value, "");
});

test("fill preserves user edits made after preview", () => {
  const field = new Input({ id: "firstName" });
  const document = fakeDocument([field]);
  const preview = mapper.scan(document, PORTAL);
  field.value = "User edit";
  assert.equal(fill(document, preview, { firstName: "Ada" }).filled, 0);
  assert.equal(field.value, "User edit");
});

test("fill rejects fields replaced or duplicated after preview", () => {
  for (const mode of ["replace", "duplicate"]) {
    const original = new Input({ id: "firstName" });
    const document = fakeDocument([original]);
    const preview = mapper.scan(document, PORTAL);
    const replacement = new Input({ id: "firstName" });
    document.fields = mode === "replace" ? [replacement] : [original, replacement];
    const result = fill(document, preview, { firstName: "Ada" });
    assert.equal(result.filled, 0);
    assert.equal(original.value, "");
    assert.equal(replacement.value, "");
  }
});

test("fill rechecks whether fields are hidden or sensitive", () => {
  for (const mutate of [field => { field.visible = false; }, field => { field.type = "password"; },
    field => { field.labels = [label("SSN")]; }]) {
    const field = new Input({ id: "firstName" });
    const document = fakeDocument([field]);
    const preview = mapper.scan(document, PORTAL);
    mutate(field);
    const result = fill(document, preview, { firstName: "Ada" });
    assert.ok(result.filled === 0 || result.error === "preview_expired");
  }
});

test("navigation before fill prevents data entry", () => {
  const field = new Input({ id: "firstName" });
  const document = fakeDocument([field]);
  const preview = mapper.scan(document, PORTAL);
  document.defaultView.location.href = PORTAL + "?new-page";
  assert.equal(fill(document, preview, { firstName: "Ada" }).error, "preview_expired");
  assert.equal(field.value, "");
});

test("navigation or duplicate fields triggered by an input event stop subsequent data entry", () => {
  for (const mode of ["navigation", "duplicate"]) {
    const first = new Input({ id: "firstName" });
    const last = new Input({ id: "lastName" });
    const document = fakeDocument([first, last]);
    const preview = mapper.scan(document, PORTAL);
    first.onEvent = () => {
      if (mode === "navigation") document.defaultView.location.href = PORTAL + "?changed";
      else document.fields.push(new Input({ id: "lastName" }));
    };
    assert.equal(fill(document, preview, { firstName: "Ada", lastName: "Lovelace" }).filled, 1);
    assert.equal(last.value, "");
  }
});

test("expired or malformed session timestamps prevent entry", () => {
  for (const expiration of [Date.now() - 1, NaN, Infinity, Date.now() + 3_600_000, "future"]) {
    const field = new Input({ id: "firstName" });
    const document = fakeDocument([field]);
    const preview = mapper.scan(document, PORTAL);
    assert.equal(fill(document, preview, { firstName: "Ada" }, expiration).error, "preview_expired");
    assert.equal(field.value, "");
  }
});

test("state selection requires a unique exact option and never invents a value", () => {
  const state = new Select({ id: "state", homeContainer: true, options: [{ value: "", textContent: "Choose" }, { value: "19", textContent: "Iowa" }] });
  const document = fakeDocument([state]);
  const preview = mapper.scan(document, PORTAL);
  assert.equal(fill(document, preview, { state: "IA" }).filled, 1);
  assert.equal(state.value, "19");
  state.value = "";
  state.options.push({ value: "IA", textContent: "Iowa" });
  const duplicate = mapper.scan(document, PORTAL);
  assert.equal(fill(document, duplicate, { state: "IA" }).filled, 0);
});

test("input maximum length prevents truncated saved information", () => {
  const field = new Input({ id: "firstName", maxLength: 3 });
  const document = fakeDocument([field]);
  const preview = mapper.scan(document, PORTAL);
  assert.equal(fill(document, preview, { firstName: "Example" }).filled, 0);
  assert.equal(field.value, "");
});
