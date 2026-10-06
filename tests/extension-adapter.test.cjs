'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const adapter = require('../extension/iowa-adapter.js');
const fixture = require('./fixtures/iowa-personal-information.cjs');
const mockProfile = require('./fixtures/applicant-profile.json');
const { BOX, laidOut } = require('./helpers/harness.cjs');
const URL = `${adapter.PORTAL}/applyForBenefits/enterPersonalInfo`;

// Sanitized structure transcribed from the blank live applicant form.
// This is not a page dump: no values, tokens, cookies, or scripts are retained.
const basic = '<h1>Enter Personal Information</h1><form><label for="firstName">First Name *</label><input id="firstName" name="firstName"><label for="lastName">Last Name</label><input id="lastName" name="lastName"></form>';
function page(html = basic, url = URL) {
  const attrs = 'id="personalInformation" action="enterPersonalInfo" method="post"';
  html = html.includes('<form>') ? html.replace('<form>', `<form ${attrs}>`) : html.includes('<form ') ? html : `<form ${attrs}>${html}</form>`;
  // Every element is in the viewport. Tests for offscreen fields override this without relaxing production code.
  return laidOut(`<!doctype html><main>${html}</main>`, url);
}
const keys = doc => adapter.scan(doc, doc.location.href).fields.map(field => field.key);
const needsYou = result => result.requiredRemaining + result.manualRemaining > 0;

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

test('observed home container and exact IDs are required; generic mailing context cannot match home fields', () => {
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

test('a partial household question with a visible CAPTCHA is never filled', () => {
  // Only public non-sensitive attributes observed 2026-09-26. No tokens or values.
  const doc = page('<h3>Household Application Information</h3><form id="householdApplicationForm" action="selectHouseholdInfo"><label for="householdApplyProgYes">Yes. At least one person is applying for SNAP, FIP/RCA, or help paying for health coverage.</label><input type="radio" id="householdApplyProgYes" name="householdApplyProg"><input name="captchaAnswer"><input type="hidden" name="reCaptchaResponse"><button>Continue</button></form>', `${adapter.PORTAL}/applyForBenefits/selectHouseholdInfo`);
  assert.deepEqual(keys(doc), []);
  assert.equal(adapter.probePage(doc, doc.location.href).pageKey, 'iowa-captcha');
});

test('automatic detection is confined to Iowa portal top frames and applicant storage is unavailable', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'nativeMessaging', 'scripting', 'sidePanel']);
  assert.deepEqual(manifest.host_permissions, ['https://hhsservices.iowa.gov/*']);
  assert.deepEqual(manifest.content_scripts, [{ matches: [adapter.PORTAL, `${adapter.PORTAL}/*`], js: ['address-policy.js', 'iowa-later-adapter.js', 'iowa-record-adapter.js', 'iowa-adapter.js', 'generic-adapter.js', 'page-text.js', 'content.js'], run_at: 'document_idle', all_frames: false }]);
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
    target.getBoundingClientRect = () => BOX;
  };
  const result = adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, { firstName: 'Example' });
  assert.deepEqual(result.filled, ['firstName']);
  assert.equal(scrolled, 1);
  const blocked = page();
  const control = blocked.querySelector('#firstName');
  control.getBoundingClientRect = () => ({ left: 20, top: 1400, right: 220, bottom: 1430, width: 200, height: 30 });
  control.scrollIntoView = () => {
    control.getBoundingClientRect = () => BOX;
    control.hidden = true;
  };
  assert.deepEqual(adapter.fill(blocked, URL, adapter.scan(blocked, URL).bindings, { firstName: 'Example' }).filled, []);
  assert.equal(control.value, '');
});

// Synthetic values remain in jsdom. Question identities are the observed public
// applicant DOM; this helper never contacts or submits to the government portal.
function fullPage() {
  const doc = page(fixture.html);
  fixture.attachConditionalHandlers(doc);
  return doc;
}
function answeredPage() {
  const doc = fullPage();
  doc.querySelector('#firstName').value = 'Example';
  doc.querySelector('#lastName').value = 'Applicant';
  doc.querySelector('#hasHome1').click();
  for (const [id, value] of Object.entries({ addressLine1: '123 Test Road', city: 'Demo City', state: 'IA', zipcode: '50309' })) doc.getElementById(id).value = value;
  doc.querySelector('#sameAddress1').click();
  doc.querySelector('#applicant1').click();
  doc.querySelector('#snap').click();
  return doc;
}

test('probe returns sanitized page facts and stops at verification, consent, and unknown pages', () => {
  const ready = answeredPage();
  const result = adapter.probePage(ready, URL);
  assert.equal(result.kind, 'fillable');
  assert.equal(needsYou(result), false);
  assert.equal(result.canAdvance, true);
  assert.equal(typeof adapter.advance, 'function');
  assert.equal(typeof adapter.captureNavigation, 'function');
  assert.doesNotMatch(JSON.stringify(result), /Example|:"Applicant"|50309/);
  assert.equal(adapter.probePage(ready, 'https://example.com/').kind, 'unsupported');
  assert.equal(adapter.probePage(page('<h1>Household Members</h1>'), URL).kind, 'manual');
  for (const html of ['<h1>Confirmation</h1>', '<h1>Review and submit</h1>', '<h1>Enter Personal Information</h1><input id="termChkbox" type="checkbox">', '<input name="captchaAnswer">', '<input type="password">']) {
    const doc = page(html);
    assert.equal(adapter.probePage(doc, URL).kind, 'blocked', html);
  }
});

test('required blank fields, unanswered choices, unknown controls, and errors need attention', () => {
  for (const change of [
    doc => { doc.querySelector('#firstName').value = ''; },
    doc => { doc.querySelector('#hasHome1').checked = false; },
    doc => { doc.querySelector('#snap').checked = false; },
    doc => { doc.querySelector('#lastName').setAttribute('aria-invalid', 'true'); },
    doc => { doc.querySelector('#firstName').name = 'otherPerson'; },
    doc => { doc.querySelector('#applicant1').remove(); },
    doc => { const field = doc.querySelector('#firstName'); field.id = 'unknownRequired'; field.required = true; }
  ]) {
    const doc = answeredPage(); change(doc);
    assert.equal(needsYou(adapter.probePage(doc, URL)), true);
  }
});

test('full applicant checklist contains only currently relevant static labels and statuses', () => {
  const doc = fullPage();
  const result = adapter.probePage(doc, URL);
  assert.equal(result.requiredRemaining, 4);
  assert.equal(result.manualRemaining, 0);
  assert.deepEqual(result.checklist.filter(item => item.status === 'missing').map(item => item.key), ['firstName', 'lastName', 'hasHomeAddress', 'isApplicant']);
  assert.equal(result.checklist.some(item => item.key === 'mailingCity'), false);
  assert.equal(result.checklist.some(item => item.key === 'programSnap'), false);
  assert.ok(result.checklist.every(item => ['complete', 'missing', 'optional', 'manual'].includes(item.status)));
  doc.querySelector('#firstName').value = 'Private Applicant Value';
  const control = doc.createElement('input'); control.id = 'unknown';
  const label = doc.createElement('label'); label.textContent = 'Private household label'; label.append(control);
  doc.querySelector('form').append(label);
  const box = doc.querySelector('#lastName').getBoundingClientRect();
  control.getBoundingClientRect = () => box; control.getClientRects = () => [box];
  const changed = adapter.probePage(doc, URL);
  assert.equal(needsYou(changed), true);
  assert.equal(changed.checklist.find(item => item.key === 'manualReview').status, 'manual');
  assert.doesNotMatch(JSON.stringify(changed), /Private/);
});

test('visible-only passes fill explicit choices then revealed mailing/program fields', () => {
  const doc = fullPage();
  const supplied = { ...mockProfile, programMedicaid: 'yes', helpPayMedicalBills: 'no' };
  const initial = adapter.scan(doc, URL);
  assert.deepEqual(initial.fields.map(item => item.key), ['firstName','middleName','lastName','suffix','maidenName','homePhone','mobilePhone','hasHomeAddress','isApplicant']);
  const first = adapter.fill(doc, URL, initial.bindings, supplied);
  assert.ok(first.filled.includes('hasHomeAddress'));
  assert.equal(doc.querySelector('#addressLine1').value, '', 'newly shown answers need another authorized scan');
  assert.equal(doc.querySelector('#mailingAddressLine1').value, '');
  assert.equal(doc.querySelector('#snap').checked, false);
  adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, supplied);
  assert.equal(doc.querySelector('#sameAddress2').checked, true);
  assert.equal(doc.querySelector('#snap').checked, true);
  assert.equal(doc.querySelector('#medicaid').checked, true);
  assert.equal(doc.querySelector('#mailingAddressLine1').value, '');
  const third = adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, supplied);
  assert.ok(third.filled.includes('mailingAddressLine1'));
  assert.ok(third.filled.includes('helpPayMedicalBills'));
  assert.equal(doc.querySelector('#bestTime').value, supplied.bestContactTime);
  assert.equal(doc.querySelector('#mailingState').value, 'IA');
  assert.equal(doc.querySelector('#helpPayMedBill2').checked, true);
  assert.equal(doc.querySelector('#tanf').checked, false);
  assert.equal(needsYou(adapter.probePage(doc, URL)), false);
  for (const key of ['firstName','lastName','hasHomeAddress','mailingSameAsHome','mailingAddressLine1','isApplicant','programSnap','helpPayMedicalBills']) {
    assert.equal(adapter.probePage(doc, URL).checklist.find(item => item.key === key).status, 'complete', key);
  }
  assert.doesNotMatch(JSON.stringify(adapter.probePage(doc, URL)), /Avery|123 Test|PO Box|Weekdays|50309/);
});

test('no-home answer reveals mailing fields without inventing a home or a same-address answer', () => {
  const doc = fullPage();
  const values = { ...mockProfile, hasHomeAddress: 'no', isApplicant: 'no' };
  for (let pass = 0; pass < 3; pass++) adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, values);
  assert.equal(doc.querySelector('#hasHome2').checked, true);
  assert.equal(doc.querySelector('#addressLine1').value, '');
  assert.equal(doc.querySelector('#sameAddress1').checked, false);
  assert.equal(doc.querySelector('#sameAddress2').checked, false);
  assert.equal(doc.querySelector('#mailingAddressLine1').value, values.mailingAddressLine1);
  assert.equal(doc.querySelector('#snap').checked, false);
  assert.equal(needsYou(adapter.probePage(doc, URL)), false);
});

test('choice mapping requires exact observed values, handlers, legends, and containers', () => {
  for (const change of [
    doc => doc.querySelector('#hasHome1').setAttribute('value', 'unexpected'),
    doc => doc.querySelector('#hasHome1').setAttribute('onclick', "submitApplication()"),
    doc => { doc.querySelector('#hasHome1').closest('fieldset').querySelector('legend').textContent = 'Consent to application terms?'; },
    doc => { const copy = doc.querySelector('#hasHome1').cloneNode(true); doc.querySelector('form').append(copy); }
  ]) {
    const doc = fullPage(); change(doc);
    assert.equal(keys(doc).includes('hasHomeAddress'), false);
    assert.equal(needsYou(adapter.probePage(doc, URL)), true);
  }
  const wrongContainer = fullPage(); wrongContainer.querySelector('#applicant1').click();
  wrongContainer.querySelector('#progSelection').id = 'otherPersonPrograms';
  assert.equal(keys(wrongContainer).includes('programSnap'), false);
});

test('unanswered choices stay blank without exact yes/no and program No never unchecks existing choices', () => {
  for (const value of ['', 'true', 'false', true, false, 'Yes', '0']) {
    const doc = fullPage();
    adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, { hasHomeAddress: value, isApplicant: value });
    assert.equal(doc.querySelector('#hasHome1').checked, false);
    assert.equal(doc.querySelector('#hasHome2').checked, false);
  }
  const doc = fullPage(); doc.querySelector('#applicant1').click();
  const scan = adapter.scan(doc, URL);
  doc.querySelector('#snap').click();
  adapter.fill(doc, URL, scan.bindings, { programSnap: 'no', programFip: 'no', programMedicaid: 'no' });
  assert.equal(doc.querySelector('#snap').checked, true);
  assert.equal(doc.querySelector('#medicaid').checked, false);
  assert.equal(doc.querySelector('#tanf').checked, false);
});

test('parent choices cannot clear preexisting dependent answers and produce manual attention', () => {
  for (const [key, id, value] of [
    ['hasHomeAddress', 'addressLine1', 'Existing home address'],
    ['hasHomeAddress', 'mailingAddressLine1', 'Existing mailing address'],
    ['mailingSameAsHome', 'mailingAddressLine1', 'Existing mailing address'],
    ['isApplicant', 'bestTime', 'Existing best time']
  ]) {
    const doc = fullPage();
    if (key === 'mailingSameAsHome') doc.querySelector('#hasHome1').click();
    doc.getElementById(id).value = value;
    adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, { [key]: 'yes' });
    assert.equal(doc.getElementById(id).value, value);
    const entry = adapter.probePage(doc, URL).checklist.find(item => item.key === key);
    assert.equal(entry.status, 'manual');
    assert.equal(entry.fillable, false);
    assert.match(entry.label, /review existing dependent answers/);
    assert.equal(needsYou(adapter.probePage(doc, URL)), true);
  }
});

test('known optional medical question can remain blank; required conditional fields cannot disappear', () => {
  const doc = answeredPage(); doc.querySelector('#medicaid').click();
  const medical = adapter.probePage(doc, URL).checklist.find(item => item.key === 'helpPayMedicalBills');
  assert.equal(medical.status, 'optional'); assert.equal(medical.required, false);
  assert.equal(needsYou(adapter.probePage(doc, URL)), false);
  for (const change of [
    doc => { doc.querySelector('#homeAddrDiv').style.display = 'none'; },
    doc => doc.querySelector('#sameAddress1').remove(),
    doc => { doc.querySelector('#firstName').disabled = true; },
    doc => { doc.querySelector('#hasHome1').hidden = true; },
    doc => doc.querySelector('#tanf').remove()
  ]) {
    const changed = answeredPage(); change(changed);
    assert.equal(needsYou(adapter.probePage(changed, URL)), true);
  }
});

test('checklist focus only scrolls and focuses a verified control on the exact portal page', () => {
  const doc = fullPage();
  assert.equal(adapter.focusField(doc, URL, 'firstName'), true);
  assert.equal(doc.activeElement.id, 'firstName');
  assert.equal(adapter.focusField(doc, URL, 'mailingCity'), false);
  assert.equal(adapter.focusField(doc, 'https://example.com/', 'firstName'), false);
  assert.equal(adapter.focusField(doc, URL, 'input[type=password]'), false);
  doc.querySelector('#firstName').name = 'otherPerson';
  assert.equal(adapter.focusField(doc, URL, 'firstName'), false);
  const offscreen = doc.querySelector('#lastName');
  offscreen.getBoundingClientRect = () => ({ left: 20, top: 2000, right: 220, bottom: 2030, width: 200, height: 30 });
  offscreen.scrollIntoView = () => { offscreen.getBoundingClientRect = () => BOX; };
  assert.equal(adapter.focusField(doc, URL, 'lastName'), true);
  assert.equal(doc.activeElement.id, 'lastName');
});

test('Select Address is a manual checklist from official help, with no guessed field mapping', () => {
  const doc = page('<h1>Select Address</h1><p>Private Suggested Address</p><input name="selectedAddress"><button>Save and Continue</button>');
  const result = adapter.probePage(doc, URL);
  assert.equal(result.pageKey, 'iowa-select-address');
  assert.equal(result.kind, 'manual'); assert.equal(needsYou(result), true);
  assert.equal(result.checklist[0].status, 'manual');
  assert.equal(adapter.focusField(doc, URL, 'addressReview'), false);
  assert.doesNotMatch(JSON.stringify(result), /Private Suggested/);
});

const preApplicant = require('./fixtures/iowa-pre-applicant.cjs');
function screen(name, change) {
  const { html, path } = preApplicant.screens[name];
  const document = laidOut(html, `${adapter.PORTAL}${path}`);
  preApplicant.attach(document);
  change?.(document);
  return document;
}
const withBox = element => { element.getBoundingClientRect = () => BOX; element.getClientRects = () => [BOX]; return element; };
const clicks = (doc, selector) => { let count = 0; doc.querySelectorAll(selector).forEach(element => element.addEventListener('click', () => count++)); return () => count; };

test('household question is a fillable page answered only from an explicit saved program choice', () => {
  const doc = screen('household');
  const url = doc.location.href;
  const probe = adapter.probePage(doc, url);
  assert.equal(probe.kind, 'fillable');
  assert.equal(probe.pageKey, 'iowa-program-intent');
  assert.deepEqual(probe.checklist.map(item => [item.key, item.status, item.required]), [['householdApplyProg', 'missing', true]]);
  const scanned = adapter.scan(doc, url);
  assert.deepEqual(scanned.fields.map(field => field.key), ['householdApplyProg']);
  assert.deepEqual(adapter.profileRequest('iowa-program-intent'), ['programSnap', 'programFip', 'programMedicaid']);
  assert.deepEqual(adapter.profileRequest('iowa-personal-information'), Object.keys(adapter.definitions).filter(key => key !== 'birthDate'));
  assert.deepEqual(adapter.profileRequest('iowa-instructions'), []);
  assert.deepEqual(adapter.pageValues('iowa-program-intent', { programSnap: 'yes', programFip: 'no' }), { householdApplyProg: 'yes' });
  for (const values of [{ programSnap: 'no', programFip: 'no', programMedicaid: 'no' }, {}, { programSnap: 'maybe' }]) {
    assert.deepEqual(adapter.pageValues('iowa-program-intent', values), {});
  }
  assert.deepEqual(adapter.fill(doc, url, scanned.bindings, { householdApplyProg: 'maybe' }).filled, []);
  const result = adapter.fill(doc, url, adapter.scan(doc, url).bindings, { householdApplyProg: 'yes' });
  assert.deepEqual(result.filled, ['householdApplyProg']);
  assert.equal(doc.getElementById('householdApplyProgYes').checked, true);
  const after = adapter.probePage(doc, url);
  assert.equal(after.kind, 'blocked');
  assert.equal(after.pageKey, 'iowa-captcha');
  assert.equal(after.todo, 'Solve the CAPTCHA, then click Continue.');
});

test('household matcher fails closed on an extra option, changed label, or changed handler', () => {
  for (const change of [
    doc => { const extra = withBox(doc.getElementById('householdApplyProgNo').cloneNode()); extra.id = 'householdApplyProgMaybe'; doc.getElementById('householdApplicationForm').append(extra); },
    doc => { doc.querySelector('label[for="householdApplyProgYes"]').textContent = 'Yes. Everyone in the household is applying.'; },
    doc => { doc.getElementById('householdApplyProgYes').setAttribute('onclick', 'submitNow();'); }
  ]) {
    const doc = screen('household', change);
    assert.deepEqual(adapter.scan(doc, doc.location.href).fields, []);
  }
});

test('info screens continue through only their exact recorded Continue button, once', () => {
  for (const [name, pageKey] of [['beforeYouStart', 'iowa-before-start'], ['importantInfo', 'iowa-information'], ['instructions', 'iowa-instructions']]) {
    const doc = screen(name);
    const probe = adapter.probePage(doc, doc.location.href);
    assert.equal(probe.kind, 'info', name);
    assert.equal(probe.pageKey, pageKey);
    const saveButton = clicks(doc, 'button.saveButton');
    const everything = clicks(doc, 'button');
    assert.equal(adapter.continuePage(doc, doc.location.href).continued, true, name);
    assert.equal(saveButton(), 1);
    assert.equal(everything(), 1, 'no illustration, Back, or carousel button is clicked');
  }
});

test('continue refuses decoys, duplicates, hidden buttons, form fields, consent, CAPTCHA, and unknown pages', () => {
  const refusals = [
    ['instructions', doc => { doc.querySelector('button.saveButton').setAttribute('onclick', "submitUrlLink('submitApplication');return false;"); }],
    ['importantInfo', doc => { doc.querySelector('main').append(withBox(doc.querySelector('button.saveButton').cloneNode(true))); }],
    ['importantInfo', doc => { doc.querySelector('button.saveButton').style.display = 'none'; }],
    ['beforeYouStart', doc => { const input = withBox(doc.createElement('input')); input.name = 'ssn'; doc.querySelector('main').append(input); }],
    ['instructions', doc => { doc.querySelector('h1').textContent = 'Review and Submit'; }],
    ['letsGetStarted', null],
    ['household', doc => { doc.getElementById('captchaDiv').style.display = 'block'; }]
  ];
  for (const [name, change] of refusals) {
    const doc = screen(name, change || undefined);
    const clicked = clicks(doc, 'button');
    assert.equal(adapter.continuePage(doc, doc.location.href).continued, false, name);
    assert.equal(clicked(), 0, name);
  }
  const doc = screen('instructions');
  assert.equal(adapter.continuePage(doc, `${adapter.PORTAL}/applyForBenefits/other`).continued, false);
});

test('pages that need the applicant carry a plain instruction', () => {
  const consent = adapter.probePage(screen('letsGetStarted'), `${adapter.PORTAL}/applyForBenefits/letsGetStarted`);
  assert.equal(consent.kind, 'blocked');
  assert.equal(consent.pageKey, 'iowa-consent');
  assert.equal(consent.todo, 'Read and accept Iowa’s consent, then click Continue.');
  const assisting = adapter.probePage(page('<h1>Assisting Organization or Person</h1><input id="agencyName" name="agencyName">'), `${adapter.PORTAL}/applyForBenefits/assistance`);
  assert.equal(assisting.todo, 'If nobody is helping you, leave this blank and click Continue.');
  const address = adapter.probePage(page('<h1>Select Address</h1>'), URL);
  assert.equal(address.todo, 'Review this address step and continue in Iowa’s form yourself.');
  const applicant = adapter.probePage(fullPage(), URL);
  assert.match(applicant.todo, /Complete the missing answers/);
  const unknown = adapter.probePage(page('<h1>Household Members</h1><input id="member" name="member">'), `${adapter.PORTAL}/applyForBenefits/householdMembers`);
  assert.equal(unknown.kind, 'manual');
  assert.equal(unknown.todo, undefined);
});

const navigationPage = answeredPage;
test('required blank fields, unanswered choices, unknown controls, and errors disable Next', () => {
  for (const change of [
    doc => { doc.querySelector('#firstName').value = ''; },
    doc => { doc.querySelector('#hasHome1').checked = false; },
    doc => { doc.querySelector('#snap').checked = false; },
    doc => { doc.querySelector('#lastName').setAttribute('aria-invalid', 'true'); },
    doc => { doc.querySelector('#firstName').name = 'otherPerson'; },
    doc => { doc.querySelector('#applicant1').remove(); },
    doc => { const field = doc.querySelector('#firstName'); field.id = 'unknownRequired'; field.required = true; },
    doc => { doc.querySelector('button.saveAndContinueButton').setAttribute('formaction', 'https://example.com/submit'); }
  ]) {
    const doc = navigationPage(); change(doc);
    assert.equal(adapter.probePage(doc, URL).canAdvance, false);
    assert.equal(adapter.captureNavigation(doc, URL), null);
  }
});

test('Next requires a single-use private snapshot and clicks the exact observed button once', () => {
  const doc = navigationPage();
  let clicks = 0;
  doc.querySelector('button.saveAndContinueButton').addEventListener('click', event => { event.preventDefault(); clicks++; });
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
    doc => { doc.querySelector('button.saveAndContinueButton').textContent = 'Submit Application'; },
    doc => { doc.querySelector('button.saveAndContinueButton').setAttribute('onclick', 'changedHandler()'); },
    doc => { doc.querySelector('button.saveAndContinueButton').replaceWith(doc.querySelector('button.saveAndContinueButton').cloneNode(true)); },
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
    const doc = navigationPage(); doc.querySelector('button.saveAndContinueButton').textContent = label;
    assert.equal(adapter.probePage(doc, URL).canAdvance, false, label);
  }
  const duplicate = navigationPage();
  const button = duplicate.querySelector('button.saveAndContinueButton').cloneNode(true);
  duplicate.querySelector('form').append(button);
  assert.equal(adapter.probePage(duplicate, URL).canAdvance, false);
});


const addressFixture = require('./fixtures/iowa-select-address.cjs');
function addressPage(options = {}, url = addressFixture.URL) {
  const doc = page(addressFixture.makeHtml(options), url);
  addressFixture.attachHandlers(doc, options);
  return doc;
}

test('verified Select Address exposes static checklist only and advances preselected first home once', () => {
  const doc = addressPage();
  const result = adapter.probePage(doc, addressFixture.URL);
  assert.equal(result.kind, 'fillable'); assert.equal(result.pageKey, 'iowa-select-address'); assert.equal(result.canAdvance, true);
  assert.deepEqual(result.checklist, [{ key: 'addressReview', label: 'First suggested home address', status: 'complete', required: true, fillable: false }]);
  assert.deepEqual(adapter.scan(doc, addressFixture.URL).fields, []);
  assert.equal(adapter.scan(doc, addressFixture.URL).recognizedPage, true);
  assert.doesNotMatch(JSON.stringify(result), /MORRILL|Morrill|50011|Ames|addressLst|homeAddressIndex/);
  const token = adapter.captureNavigation(doc, addressFixture.URL); assert.ok(token); assert.deepEqual(Object.keys(token), []);
  assert.equal(adapter.advance(doc, addressFixture.URL, token).advanced, true);
  assert.deepEqual(doc.__addressQa, { selectionClicks: [], selectedIndexes: [['0']], shownCountyRows: [[]], nextClicks: 1 });
  assert.equal(adapter.advance(doc, addressFixture.URL, token).advanced, false); assert.equal(doc.__addressQa.nextClicks, 1);
});

test('approved Next chooses first possible match over an unchanged original or generated second suggestion', () => {
  // Only a single possible home match was observed live. The two-suggestion
  // fixture exercises the same row schema with explicitly generated variation.
  for (const options of [{ selected: 'original' }, { candidateCount: 2, selected: 'second' }, { candidateCount: 8, selected: 'original' }]) {
    const doc = addressPage(options);
    const before = doc.querySelector('input[name="homeAddressIndex"]:checked');
    assert.notEqual(before.id, 'homeAddressIndex0');
    const state = adapter.probePage(doc, addressFixture.URL); assert.equal(state.canAdvance, true); assert.equal(state.checklist[0].status, 'missing');
    const token = adapter.captureNavigation(doc, addressFixture.URL);
    assert.equal(doc.querySelector('input[name="homeAddressIndex"]:checked'), before, 'preview does not select an address');
    assert.equal(adapter.advance(doc, addressFixture.URL, token).advanced, true);
    assert.deepEqual(doc.__addressQa, { selectionClicks: ['0'], selectedIndexes: [['0']], shownCountyRows: [[]], nextClicks: 1 });
  }
});

test('address page only clicks the first suggestion, irrespective of substantive address differences', () => {
  const doc = addressPage({ selected: 'original' });
  doc.querySelector('label[for="homeAddressIndex0"] div').textContent = '999 DIFFERENT AVE UNIT 3, DIFFERENT CITY IA 99999';
  const token = adapter.captureNavigation(doc, addressFixture.URL); assert.ok(token);
  assert.equal(adapter.advance(doc, addressFixture.URL, token).advanced, true);
  assert.deepEqual(doc.__addressQa.selectedIndexes, [['0']]);
});

test('address errors, visible dialogs, hidden mailing controls, and a county question beside a suggestion pause', () => {
  const enteredCounty = { selected: 'original', renderedCounty: true };
  for (const options of [{ error: true }, { modal: true }, { mailing: true }, { renderedCounty: true }, { candidateCount: 2, selected: 'second', renderedCounty: true },
    { ...enteredCounty, error: true }, { ...enteredCounty, modal: true }, { ...enteredCounty, mailing: true }]) {
    const doc = addressPage(options);
    assert.equal(adapter.probePage(doc, addressFixture.URL).canAdvance, false, JSON.stringify(options));
    assert.equal(adapter.captureNavigation(doc, addressFixture.URL), null);
    assert.equal(doc.__addressQa.nextClicks, 0); assert.deepEqual(doc.__addressQa.selectionClicks, []);
  }
});

test('with the entered address chosen and its county shown, Next selects the first suggestion and continues once the county is hidden again', () => {
  for (const candidateCount of [1, 2]) {
    const doc = addressPage({ candidateCount, selected: 'original', renderedCounty: true });
    const entered = doc.querySelector(`#homeAddressIndex${candidateCount}`), county = doc.querySelector(`[id="homeAddressLst${candidateCount}.county"]`);
    assert.equal(adapter.rendered(county, doc), true);
    const state = adapter.probePage(doc, addressFixture.URL);
    assert.equal(state.kind, 'fillable'); assert.equal(state.canAdvance, true);
    assert.deepEqual(state.checklist, [{ key: 'addressReview', label: 'First suggested home address', status: 'missing', required: true, fillable: false }]);
    assert.equal(adapter.scan(doc, addressFixture.URL).recognizedPage, true);
    const token = adapter.captureNavigation(doc, addressFixture.URL); assert.ok(token);
    assert.equal(entered.checked, true, 'preview does not select an address');
    assert.equal(adapter.advance(doc, addressFixture.URL, token).advanced, true);
    assert.deepEqual(doc.__addressQa, { selectionClicks: ['0'], selectedIndexes: [['0']], shownCountyRows: [[]], nextClicks: 1 });
    assert.equal(entered.checked, false); assert.equal(adapter.rendered(county, doc), false);
    assert.equal(county.value, 'ADAIR', 'the county select is never changed');
  }
});

test('an applicant who picks the entered address reveals its county; Next still selects the first suggestion', () => {
  const doc = addressPage();
  doc.querySelector('#homeAddressIndex1').click();
  assert.equal(adapter.rendered(doc.querySelector('[id="homeAddressLst1.county"]'), doc), true);
  const token = adapter.captureNavigation(doc, addressFixture.URL); assert.ok(token);
  assert.equal(adapter.advance(doc, addressFixture.URL, token).advanced, true);
  assert.deepEqual(doc.__addressQa, { selectionClicks: ['1', '0'], selectedIndexes: [['0']], shownCountyRows: [[]], nextClicks: 1 });
});

test('if the county stays shown or changes after the switch, Save and Continue is never pressed and the page is left to the applicant', () => {
  const doc = addressPage({ selected: 'original', renderedCounty: true, countyStaysVisible: true });
  const county = doc.querySelector('[id="homeAddressLst1.county"]');
  const token = adapter.captureNavigation(doc, addressFixture.URL); assert.ok(token);
  assert.deepEqual(adapter.advance(doc, addressFixture.URL, token), { advanced: false, reason: 'The address page changed after selection. Review it before continuing.' });
  assert.deepEqual(doc.__addressQa, { selectionClicks: ['0'], selectedIndexes: [], shownCountyRows: [], nextClicks: 0 });
  assert.equal(adapter.rendered(county, doc), true); assert.equal(county.value, 'ADAIR');
  const after = adapter.probePage(doc, addressFixture.URL);
  assert.equal(after.kind, 'manual'); assert.equal(after.canAdvance, false); assert.equal(after.checklist[0].status, 'manual');
  assert.equal(after.todo, 'Review this address step and continue in Iowa’s form yourself.');
  assert.equal(adapter.captureNavigation(doc, addressFixture.URL), null);
  assert.equal(adapter.advance(doc, addressFixture.URL, token).advanced, false); assert.equal(doc.__addressQa.nextClicks, 0);
  const changed = addressPage({ selected: 'original', renderedCounty: true });
  changed.querySelector('#homeAddressIndex0').addEventListener('click', () => { changed.querySelector('[id="homeAddressLst1.county"]').value = 'STORY'; });
  const changedToken = adapter.captureNavigation(changed, addressFixture.URL); assert.ok(changedToken);
  assert.equal(adapter.advance(changed, addressFixture.URL, changedToken).advanced, false); assert.equal(changed.__addressQa.nextClicks, 0);
});

test('a shown county question is accepted only as the chosen entered address’s single, exact county select', () => {
  const mutations = [
    doc => { doc.querySelector('#homeAddressIndex1').checked = false; },
    doc => { doc.querySelector('[id="homeAddressLst1.county"]').name = 'homeAddressLst[0].county'; },
    doc => { doc.querySelector('[id="homeAddressLst1.county"]').id = 'homeAddressLst0.county'; },
    doc => { doc.querySelector('label[for="homeAddressLst1.county"]').textContent = 'Mailing county*'; },
    doc => { doc.querySelector('#homeAddrCounty1').classList.remove('displayNone'); },
    doc => { doc.querySelector('#homeAddrCounty1 td').append(withBox(doc.createElement('select'))); },
    doc => { doc.querySelector('#homeAddrCounty0').append(withBox(doc.createElement('td'))); doc.querySelector('#homeAddrCounty0 td').textContent = 'County*'; }
  ];
  for (const mutate of mutations) {
    const doc = addressPage({ selected: 'original', renderedCounty: true }); mutate(doc);
    assert.equal(adapter.probePage(doc, addressFixture.URL).canAdvance, false, mutate.toString());
    assert.equal(adapter.captureNavigation(doc, addressFixture.URL), null);
  }
});

test('exact address endpoint, form, headings, sections, candidate metadata and ordinary Next are mandatory', () => {
  const mutations = [
    doc => { doc.querySelector('h2').textContent = 'Review and Submit'; },
    doc => { doc.querySelector('form').action = 'submitApplication'; },
    doc => { doc.querySelector('form').method = 'get'; },
    doc => { doc.querySelector('form').setAttribute('onsubmit', 'submitApplication()'); },
    doc => { doc.querySelector('form').target = '_blank'; },
    doc => { doc.querySelector('table.fullwidth tr td').textContent = 'Your mailing address:'; },
    doc => { doc.querySelector('table.fullwidth tbody').children[4].firstElementChild.textContent = 'Possible matches for your original address:'; },
    doc => { doc.querySelector('#homeAddressIndex0').name = 'mailingAddressIndex'; },
    doc => { doc.querySelector('#homeAddressIndex0').value = '1'; },
    doc => { doc.querySelector('#homeAddressIndex0').setAttribute('onclick', "onMailingAddrSelect('0');"); },
    doc => { doc.querySelector('#homeAddressIndex0').disabled = true; },
    doc => { doc.querySelector('label[for="homeAddressIndex0"]').remove(); },
    doc => { doc.querySelector('legend').textContent = 'Other addresses'; },
    doc => { doc.querySelector('table.fullwidth tbody').insertBefore(doc.querySelector('#homeAddrCounty0'), doc.querySelector('table.fullwidth tbody').children[1]); },
    doc => { doc.querySelector('[id="homeAddressLst1.county"]').name = 'unverifiedCounty'; },
    doc => { doc.querySelector('.saveAndContinueButton').setAttribute('onclick', 'signAndSubmit();'); },
    doc => { doc.querySelector('.saveAndContinueButton').type = 'submit'; },
    doc => { doc.querySelector('.saveAndContinueButton').setAttribute('formaction', 'submitApplication'); },
    doc => { doc.querySelector('.saveAndContinueButton').disabled = true; },
    doc => { doc.querySelector('#homeAddressIndex0').after(doc.querySelector('#homeAddressIndex0').cloneNode(true)); },
    doc => { doc.querySelector('form').insertAdjacentHTML('beforeend', '<textarea hidden name="unknown"></textarea>'); },
    doc => { doc.querySelector('form').insertAdjacentHTML('beforeend', '<input hidden type="checkbox" name="acceptTerms">'); },
    doc => { doc.querySelector('form').insertAdjacentHTML('beforeend', '<button type="button">Finish application</button>'); }
  ];
  for (const mutate of mutations) {
    const doc = addressPage(); mutate(doc);
    assert.equal(adapter.probePage(doc, addressFixture.URL).canAdvance, false, mutate.toString());
    assert.equal(adapter.captureNavigation(doc, addressFixture.URL), null);
  }
  for (const url of [URL, `${addressFixture.URL}?unverified=1`, `${addressFixture.URL}/`, addressFixture.URL.replace('hhsservices.iowa.gov', 'example.com')]) {
    const doc = addressPage({}, url); assert.equal(adapter.probePage(doc, url).canAdvance, false, url);
  }
});

test('address snapshots invalidate edits, changed display text, hidden data, options or Next and cannot be reused', () => {
  const mutations = [
    doc => { doc.querySelector('#homeAddressIndex1').checked = true; },
    doc => { doc.querySelector('label[for="homeAddressIndex0"] div').textContent = 'Changed suggested address'; },
    doc => { doc.querySelector('label[for="homeAddressIndex1"] div').textContent = 'Changed original address'; },
    doc => { doc.querySelector('input[type="hidden"]').value = 'changed'; },
    doc => { doc.querySelector('#homeAddressIndex0').replaceWith(doc.querySelector('#homeAddressIndex0').cloneNode(true)); },
    doc => { doc.querySelector('.saveAndContinueButton').replaceWith(doc.querySelector('.saveAndContinueButton').cloneNode(true)); },
    doc => { doc.querySelector('#errorMsg').classList.remove('displayNone'); },
    doc => { doc.querySelector('#simplemodal').classList.add('qa-visible'); }
  ];
  for (const mutate of mutations) {
    const doc = addressPage(); const token = adapter.captureNavigation(doc, addressFixture.URL); assert.ok(token);
    mutate(doc); assert.equal(adapter.advance(doc, addressFixture.URL, token).advanced, false, mutate.toString());
    assert.equal(adapter.advance(doc, addressFixture.URL, token).advanced, false); assert.equal(doc.__addressQa.nextClicks, 0);
  }
});

test('selection-time changes and overlays stop address Next while preserving the one-attempt token', () => {
  const doc = addressPage({ selected: 'original' });
  doc.querySelector('#homeAddressIndex0').addEventListener('click', () => { doc.querySelector('label[for="homeAddressIndex0"] div').textContent = 'Changed after choice'; });
  const token = adapter.captureNavigation(doc, addressFixture.URL);
  assert.equal(adapter.advance(doc, addressFixture.URL, token).advanced, false); assert.equal(doc.__addressQa.nextClicks, 0);
  const covered = addressPage(); const coveredToken = adapter.captureNavigation(covered, addressFixture.URL);
  covered.elementFromPoint = () => covered.querySelector('h2');
  assert.equal(adapter.advance(covered, addressFixture.URL, coveredToken).advanced, false); assert.equal(covered.__addressQa.nextClicks, 0);
});

test('address checklist focus selects nothing and only verified first-suggestion controls can receive focus', () => {
  const doc = addressPage({ selected: 'original' });
  assert.equal(adapter.focusField(doc, addressFixture.URL, 'addressReview'), true);
  assert.equal(doc.activeElement.id, 'homeAddressIndex0'); assert.equal(doc.querySelector('#homeAddressIndex1').checked, true);
  assert.deepEqual(doc.__addressQa.selectionClicks, []);
  assert.equal(adapter.focusField(doc, addressFixture.URL, 'homeAddressIndex1'), false);
});

test('the words on Iowa’s information-only screens are listed for the translated view; screens with questions list none', () => {
  const instructions = screen('instructions');
  assert.deepEqual(adapter.instructions(instructions, instructions.location.href), ['Instructions', 'You\'ll see some questions with a star next to them.',
    'Check this box next to the item you want to select.', 'Check this button next to the item you want to select.', 'OK. Let\'s start the application.']);
  const hidden = screen('importantInfo', doc => { doc.querySelector('p').hidden = true; });
  assert.deepEqual(adapter.instructions(hidden, hidden.location.href), ['Important Information when applying and what to expect.'], 'hidden text is not listed');
  const household = screen('household');
  assert.deepEqual(adapter.instructions(household, household.location.href), [], 'a screen with questions can hold answers, so its text is never listed');
  assert.deepEqual(adapter.instructions(page(), URL), []);
});

test('Iowa’s information-only screens are named for the side panel’s summary; a screen with questions is not one', () => {
  for (const [name, pageKey] of [['beforeYouStart', 'iowa-before-start'], ['importantInfo', 'iowa-information'], ['instructions', 'iowa-instructions']]) {
    const doc = screen(name);
    assert.equal(adapter.informationScreen(doc, doc.location.href), pageKey, name);
    assert.ok(adapter.INFO_PAGE_KEYS.includes(pageKey));
  }
  assert.deepEqual([...adapter.INFO_PAGE_KEYS], ['iowa-before-start', 'iowa-information', 'iowa-instructions']);
  for (const name of ['household', 'letsGetStarted']) { const doc = screen(name); assert.equal(adapter.informationScreen(doc, doc.location.href), '', name); }
  assert.equal(adapter.informationScreen(page(), URL), '');
});
