'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const adapter = require('../extension/iowa-adapter.js');
const URL = `${adapter.PORTAL}/applyForBenefits/enterPersonalInfo`;

// Sanitized structure transcribed from the blank live applicant form.
// This is not a page dump: no values, tokens, cookies, or scripts are retained.
const basic = '<h1>Enter Personal Information</h1><form><label for="firstName">First Name *</label><input id="firstName" name="firstName"><label for="lastName">Last Name</label><input id="lastName" name="lastName"></form>';
function page(html = basic, url = URL) {
  const attrs = 'id="personalInformation" action="enterPersonalInfo" method="post"';
  html = html.includes('<form>') ? html.replace('<form>', `<form ${attrs}>`) : `<form ${attrs}>${html}</form>`;
  const dom = new JSDOM(`<!doctype html><main>${html}</main>`, { url, pretendToBeVisual: true });
  const { document } = dom.window;
  // jsdom has no layout engine; explicitly model in-viewport geometry. Tests
  // for offscreen fields override these values without relaxing production code.
  const box = { left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 };
  for (const node of document.querySelectorAll('*')) {
    node.getBoundingClientRect = () => box;
    node.getClientRects = () => [box];
  }
  return document;
}
const keys = doc => adapter.scan(doc, doc.location.href).fields.map(field => field.key);

test('only exact HTTPS Iowa portal origin and path are supported', () => {
  for (const url of [adapter.PORTAL, URL, `${URL}?step=1#main`]) assert.equal(adapter.isSupportedUrl(url), true, url);
  for (const url of ['http://hhsservices.iowa.gov/apspssp/ssp.portal', 'https://hhsservices.iowa.gov.evil.test/apspssp/ssp.portal', 'https://user@hhsservices.iowa.gov/apspssp/ssp.portal', 'https://hhsservices.iowa.gov:8443/apspssp/ssp.portal', 'https://hhsservices.iowa.gov/apspssp/ssp.portal.evil', 'https://hhsservices.iowa.gov/apspssp/pages/WebHelp/', `${adapter.PORTAL}/%2fwrong`, 'file:///apspssp/ssp.portal', 'not a URL']) assert.equal(adapter.isSupportedUrl(url), false, url);
});

test('scan exposes names only and filling requires the exact original elements', () => {
  const doc = page();
  const scan = adapter.scan(doc, URL);
  assert.deepEqual(scan.fields, [{ key: 'firstName', label: 'First name' }, { key: 'lastName', label: 'Last name' }]);
  let changes = 0; doc.querySelector('#firstName').addEventListener('change', () => changes++);
  const result = adapter.fill(doc, URL, scan.bindings, { firstName: 'Example', lastName: 'Applicant', ssn: 'not-requested' });
  assert.deepEqual(result.filled, ['firstName', 'lastName']);
  assert.equal(doc.querySelector('#firstName').value, 'Example');
  assert.equal(changes, 1);
  assert.deepEqual(keys(doc), []);
});

test('wrong pages, other people, and unknown groups are not mapped', () => {
  assert.deepEqual(keys(page(basic.replace('Enter Personal Information', 'Household Members'))), []);
  assert.deepEqual(keys(page(basic, 'https://example.com/')), []);
  for (const legend of ['Household members', 'Spouse', 'Authorized representative', 'Signature', 'Unknown section']) {
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><fieldset><legend>${legend}</legend><label>First name<input id="firstName" name="firstName"></label></fieldset>`)), []);
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><form><h2>${legend}</h2><label>First name<input id="firstName" name="firstName"></label></form>`)), []);
  }
  assert.deepEqual(keys(page('<h1 hidden>Enter Personal Information</h1><label>First name<input id="firstName" name="firstName"></label>')), []);
});

test('hidden, occluded, disabled, readonly, or prefilled fields are skipped', () => {
  for (const attributes of ['type="hidden"', 'disabled', 'readonly', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"', 'aria-hidden="true"', 'inert', 'value="Existing"']) {
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><label>First name<input id="firstName" name="firstName" ${attributes}></label>`)), [], attributes);
  }
  for (const wrapper of ['<div hidden>', '<div style="display:none">', '<fieldset disabled>', '<div inert>', '<div aria-hidden="true">']) {
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1>${wrapper}<label>First name<input id="firstName" name="firstName"></label>`)), [], wrapper);
  }
  const offscreen = page();
  offscreen.querySelector('#firstName').getBoundingClientRect = () => ({ left: -300, top: 20, right: -100, bottom: 40, width: 200, height: 20 });
  assert.deepEqual(keys(offscreen), ['firstName', 'lastName']);
  assert.deepEqual(adapter.fill(offscreen, URL, adapter.scan(offscreen, URL).bindings, { firstName: 'Example' }).filled, [], 'offscreen field cannot be written until a successful scroll and visibility check');
  const occluded = page();
  occluded.elementFromPoint = () => occluded.querySelector('h1');
  assert.deepEqual(keys(occluded), []);
});

test('duplicate matches and conflicting labels fail closed', () => {
  const doc = page(basic.replace('</form>', '<label>First name<input id="firstName" name="firstName"></label></form>'));
  assert.deepEqual(keys(doc), ['lastName']);
  assert.deepEqual(adapter.scan(doc, URL).ambiguous, ['First name']);
  assert.deepEqual(keys(page('<h1>Enter Personal Information</h1><label>First name<input id="firstName" name="firstName" aria-label="Last name"></label>')), []);
  assert.deepEqual(keys(page('<h1>Enter Personal Information</h1><label>First name of your child<input></label>')), []);
});

test('unsafe controls are never filled even if mislabeled as a supported field', () => {
  for (const type of ['password', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'number']) {
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><label>First name<input id="firstName" name="firstName" type="${type}"></label>`)), [], type);
  }
  for (const id of ['signatureName', 'captchaAnswer', 'password', 'securityCode', 'authorized_representative']) {
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><label>First name<input id="${id}" name="${id}"></label>`)), [], id);
  }
});

test('observed home container and exact IDs are required; mailing addresses stay manual', () => {
  const address = '<label>Home Address Line 1*<input id="addressLine1" name="addressLine1"></label><label>City*<input id="city" name="city"></label><label>State*<select id="state" name="state"><option value=""></option><option value="IA">Iowa</option></select></label><label>Zip Code (99999)*<input id="zipcode" name="zipcode"></label>';
  assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1>${address}`)), []);
  assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><div id="mailingAddress">${address}</div>`)), []);
  const doc = page(`<h1>Enter Personal Information</h1><h3>Address Information</h3><div id="homeAddrDiv">${address}</div>`);
  assert.deepEqual(keys(doc), ['addressLine1', 'city', 'state', 'zip']);
  const result = adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, { addressLine1: '100 Example Road', city: 'Example City', state: 'IA', zip: '50309' });
  assert.equal(result.filled.length, 4);
  assert.equal(doc.querySelector('select').value, 'IA');
  const hidden = page(`<h1>Enter Personal Information</h1><div id="homeAddrDiv" style="display:none">${address}</div>`);
  assert.deepEqual(keys(hidden), []);
});

test('explicit home/mobile phone fields format separately and generic phone is never guessed', () => {
  const doc = page('<h1>Enter Personal Information</h1><h3>Contact Information</h3><label>Home Phone Number (999)999-9999<input id="phoneNumber" name="phoneNumber"></label><label>Mobile Phone Number (999)999-9999<input id="otherPhoneNumber" name="otherPhoneNumber"></label>');
  assert.deepEqual(keys(doc), ['homePhone', 'mobilePhone']);
  const result = adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, { homePhone: '5155550100', mobilePhone: '15155550101', phone: '5155550999' });
  assert.equal(result.filled.length, 2);
  assert.equal(doc.querySelector('#phoneNumber').value, '(515)555-0100');
  assert.equal(doc.querySelector('#otherPhoneNumber').value, '(515)555-0101');
  const field = doc.querySelector('input');
  assert.equal(adapter.formatValue('homePhone', '123', field), null);
  assert.equal(adapter.formatValue('mobilePhone', '44 1234567890', field), null);
  assert.equal(adapter.formatValue('zip', '50309-1234', field), null);
  field.maxLength = 2;
  assert.equal(adapter.formatValue('firstName', 'Example', field), null);
  assert.equal(adapter.formatValue('firstName', '', field), null);
});

test('same name and label on the observed assisting-person form cannot match', () => {
  const doc = page(basic);
  doc.querySelector('form').id = 'agencyDetails';
  doc.querySelector('form').setAttribute('action', 'enterAgencyDetails');
  assert.deepEqual(keys(doc), []);
  const changed = page(basic);
  changed.querySelector('#firstName').name = 'otherPersonFirstName';
  assert.deepEqual(keys(changed), ['lastName']);
});

test('changes between preview and approval or caused by page events cannot overwrite user work', () => {
  const doc = page(); const scan = adapter.scan(doc, URL);
  doc.querySelector('#firstName').value = 'User entered';
  const replacement = doc.querySelector('#lastName').cloneNode();
  doc.querySelector('#lastName').replaceWith(replacement);
  assert.deepEqual(adapter.fill(doc, URL, scan.bindings, { firstName: 'Replace', lastName: 'Replace' }).filled, []);
  assert.equal(doc.querySelector('#firstName').value, 'User entered');
  const changing = page(); const original = adapter.scan(changing, URL);
  changing.querySelector('#firstName').addEventListener('input', () => { changing.querySelector('#lastName').value = 'Portal supplied'; });
  assert.deepEqual(adapter.fill(changing, URL, original.bindings, { firstName: 'Example', lastName: 'Replace' }).filled, ['firstName']);
  assert.equal(changing.querySelector('#lastName').value, 'Portal supplied');
});

test('public Iowa guest screen metadata fixture is deliberately unsupported', () => {
  // Only public non-sensitive attributes observed 2026-09-26. No tokens or values.
  const doc = page('<h3>Household Application Information</h3><form id="householdApplicationForm" action="selectHouseholdInfo"><label for="householdApplyProgYes">Yes. At least one person is applying for SNAP, FIP/RCA, or help paying for health coverage.</label><input type="radio" id="householdApplyProgYes" name="householdApplyProg"><input name="captchaAnswer"><input type="hidden" name="reCaptchaResponse"><button>Continue</button></form>', `${adapter.PORTAL}/applyForBenefits/selectHouseholdInfo`);
  assert.equal(adapter.scan(doc, doc.location.href).recognizedPage, false);
  assert.deepEqual(keys(doc), []);
});

test('automatic detection is confined to Iowa portal top frames and applicant storage is unavailable', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'nativeMessaging', 'scripting']);
  assert.deepEqual(manifest.host_permissions, ['https://hhsservices.iowa.gov/*']);
  assert.deepEqual(manifest.content_scripts, [{ matches: [adapter.PORTAL, `${adapter.PORTAL}/*`], js: ['iowa-adapter.js', 'content.js'], run_at: 'document_idle', all_frames: false }]);
  assert.equal(manifest.externally_connectable, undefined);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
});

test('rendered offscreen fields are scrolled into view and rechecked before filling', () => {
  const doc = page();
  const target = doc.querySelector('#firstName');
  let scrolled = 0;
  target.getBoundingClientRect = () => ({ left: 20, top: 1400, right: 220, bottom: 1430, width: 200, height: 30 });
  target.scrollIntoView = () => {
    scrolled++;
    target.getBoundingClientRect = () => ({ left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 });
  };
  const result = adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, { firstName: 'Example' });
  assert.deepEqual(result.filled, ['firstName']);
  assert.equal(scrolled, 1);
  const blocked = page();
  const control = blocked.querySelector('#firstName');
  control.getBoundingClientRect = () => ({ left: 20, top: 1400, right: 220, bottom: 1430, width: 200, height: 30 });
  control.scrollIntoView = () => {
    control.getBoundingClientRect = () => ({ left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 });
    control.hidden = true;
  };
  assert.deepEqual(adapter.fill(blocked, URL, adapter.scan(blocked, URL).bindings, { firstName: 'Example' }).filled, []);
  assert.equal(control.value, '');
});

// Synthetic values remain in jsdom. Question identities are the observed public
// applicant DOM; this helper never contacts or submits to the government portal.
function navigationPage() {
  const doc = page(`<h1>Enter Personal Information</h1><form>
    <h3>Applicant's Information</h3>
    <label>First Name*<input id="firstName" name="firstName" value="Example"></label>
    <label>Last Name*<input id="lastName" name="lastName" value="Applicant"></label>
    <h3>Address Information</h3><fieldset><legend>Do you have a home address?*</legend>
      <label>Yes<input id="hasHome1" name="hasHome" type="radio"></label><label>No<input id="hasHome2" name="hasHome" type="radio" checked></label>
    </fieldset><h3>Program Information</h3><fieldset><legend>Are you applying for benefits?*</legend>
      <label>Yes<input id="applicant1" name="applicant" type="radio" checked></label><label>No<input id="applicant2" name="applicant" type="radio"></label>
    </fieldset><fieldset><legend>What benefits are you applying for?*</legend>
      <label>Supplemental Nutritional Assistance Program(SNAP)<input id="snap" name="programs" type="checkbox" checked></label>
      <label>Best Time to Call? (30 character limit)<input id="bestTime" name="bestTimeToCall" maxlength="30"></label>
    </fieldset><button type="button" class="btn btn-primary saveAndContinueButton" onclick="submitAction('#personalInformation');">Save and Continue</button></form>`);
  return doc;
}

test('probe returns sanitized page facts and stops at verification, consent, and unknown pages', () => {
  const ready = navigationPage();
  const result = adapter.probePage(ready, URL);
  assert.equal(result.kind, 'fillable');
  assert.equal(result.canAdvance, true);
  assert.doesNotMatch(JSON.stringify(result), /Example|Applicant"|50309/);
  assert.equal(adapter.probePage(ready, 'https://example.com/').kind, 'unsupported');
  assert.equal(adapter.probePage(page('<h1>Household Members</h1>'), URL).kind, 'manual');
  for (const html of ['<h1>Confirmation</h1>', '<h1>Review and submit</h1>', '<h1>Enter Personal Information</h1><input id="termChkbox" type="checkbox">', '<input name="captchaAnswer">', '<input type="password">']) {
    const doc = page(html);
    assert.equal(adapter.probePage(doc, URL).kind, 'blocked', html);
    assert.equal(adapter.captureNavigation(doc, URL), null);
  }
});

test('required blank fields, unanswered choices, unknown controls, and errors disable Next', () => {
  for (const change of [
    doc => { doc.querySelector('#firstName').value = ''; },
    doc => { doc.querySelector('#hasHome2').checked = false; },
    doc => { doc.querySelector('#snap').checked = false; },
    doc => { doc.querySelector('#lastName').setAttribute('aria-invalid', 'true'); },
    doc => { doc.querySelector('#firstName').name = 'otherPerson'; },
    doc => { doc.querySelector('#applicant1').remove(); },
    doc => { const field = doc.querySelector('#firstName'); field.id = 'unknownRequired'; field.required = true; },
    doc => { doc.querySelector('button').setAttribute('formaction', 'https://example.com/submit'); }
  ]) {
    const doc = navigationPage(); change(doc);
    assert.equal(adapter.probePage(doc, URL).canAdvance, false);
    assert.equal(adapter.captureNavigation(doc, URL), null);
  }
});

test('Next requires a single-use private snapshot and clicks the exact observed button once', () => {
  const doc = navigationPage();
  let clicks = 0;
  doc.querySelector('button').addEventListener('click', event => { event.preventDefault(); clicks++; });
  assert.equal(adapter.advance(doc, URL).advanced, false);
  const snapshot = adapter.captureNavigation(doc, URL);
  assert.ok(snapshot);
  assert.equal(JSON.stringify(snapshot), '{}');
  assert.equal(adapter.advance(doc, URL, snapshot).advanced, true);
  assert.equal(clicks, 1);
  assert.equal(adapter.advance(doc, URL, snapshot).advanced, false);
  assert.equal(clicks, 1);
});

test('Next stops on answer, page, form, handler, or button changes after preview', () => {
  for (const change of [
    doc => { doc.querySelector('#firstName').value = 'User changed'; },
    doc => { doc.querySelector('form').setAttribute('action', 'submitApplication'); },
    doc => { doc.querySelector('button').textContent = 'Submit Application'; },
    doc => { doc.querySelector('button').setAttribute('onclick', 'changedHandler()'); },
    doc => { doc.querySelector('button').replaceWith(doc.querySelector('button').cloneNode(true)); },
    doc => { doc.defaultView.history.replaceState({}, '', `${adapter.PORTAL}/different`); }
  ]) {
    const doc = navigationPage();
    const snapshot = adapter.captureNavigation(doc, URL);
    let clicks = 0;
    doc.addEventListener('click', () => clicks++);
    change(doc);
    assert.equal(adapter.advance(doc, URL, snapshot).advanced, false);
    assert.equal(clicks, 0);
  }
});

test('save-and-exit, final submission, and duplicate Next buttons never advance', () => {
  for (const label of ['Save and Exit', 'Submit Application', 'Sign and Continue', 'Finish']) {
    const doc = navigationPage(); doc.querySelector('button').textContent = label;
    assert.equal(adapter.probePage(doc, URL).canAdvance, false, label);
  }
  const duplicate = navigationPage();
  const button = duplicate.querySelector('button').cloneNode(true);
  duplicate.querySelector('form').append(button);
  assert.equal(adapter.probePage(duplicate, URL).canAdvance, false);
});
