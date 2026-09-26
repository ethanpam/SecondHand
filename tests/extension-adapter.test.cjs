'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const adapter = require('../extension/iowa-adapter.js');
const URL = `${adapter.PORTAL}/applyForBenefits/personalInformation`;

// Synthetic empty form: labels are conservative candidates, not a capture of
// Iowa's post-CAPTCHA applicant page. See docs/iowa-portal.md for provenance.
const basic = '<h1>Enter Personal Information</h1><form><label for="first">First Name *</label><input id="first"><label for="last">Last Name</label><input id="last"></form>';
function page(html = basic, url = URL) {
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
  let changes = 0; doc.querySelector('#first').addEventListener('change', () => changes++);
  const result = adapter.fill(doc, URL, scan.bindings, { firstName: 'Example', lastName: 'Applicant', ssn: 'not-requested' });
  assert.deepEqual(result.filled, ['firstName', 'lastName']);
  assert.equal(doc.querySelector('#first').value, 'Example');
  assert.equal(changes, 1);
  assert.deepEqual(keys(doc), []);
});

test('wrong pages, other people, and unknown groups are not mapped', () => {
  assert.deepEqual(keys(page(basic.replace('Enter Personal Information', 'Household Members'))), []);
  assert.deepEqual(keys(page(basic, 'https://example.com/')), []);
  for (const legend of ['Household members', 'Spouse', 'Authorized representative', 'Signature', 'Unknown section']) {
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><fieldset><legend>${legend}</legend><label>First name<input></label></fieldset>`)), []);
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><form><h2>${legend}</h2><label>First name<input></label></form>`)), []);
  }
  assert.deepEqual(keys(page('<h1 hidden>Enter Personal Information</h1><label>First name<input></label>')), []);
});

test('hidden, offscreen, occluded, disabled, readonly, or prefilled fields are skipped', () => {
  for (const attributes of ['type="hidden"', 'disabled', 'readonly', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"', 'aria-hidden="true"', 'inert', 'value="Existing"']) {
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><label>First name<input ${attributes}></label>`)), [], attributes);
  }
  for (const wrapper of ['<div hidden>', '<div style="display:none">', '<fieldset disabled>', '<div inert>', '<div aria-hidden="true">']) {
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1>${wrapper}<label>First name<input></label>`)), [], wrapper);
  }
  const offscreen = page();
  offscreen.querySelector('#first').getBoundingClientRect = () => ({ left: -300, top: 20, right: -100, bottom: 40, width: 200, height: 20 });
  assert.deepEqual(keys(offscreen), ['lastName']);
  const occluded = page();
  occluded.elementFromPoint = () => occluded.querySelector('h1');
  assert.deepEqual(keys(occluded), []);
});

test('duplicate matches and conflicting labels fail closed', () => {
  const doc = page(`${basic}<label>First name<input></label>`);
  assert.deepEqual(keys(doc), ['lastName']);
  assert.deepEqual(adapter.scan(doc, URL).ambiguous, ['First name']);
  assert.deepEqual(keys(page('<h1>Enter Personal Information</h1><label>First name<input aria-label="Last name"></label>')), []);
  assert.deepEqual(keys(page('<h1>Enter Personal Information</h1><label>First name of your child<input></label>')), []);
});

test('unsafe controls are never filled even if mislabeled as a supported field', () => {
  for (const type of ['password', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'number']) {
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><label>First name<input type="${type}"></label>`)), [], type);
  }
  for (const id of ['signatureName', 'captchaAnswer', 'password', 'securityCode', 'authorized_representative']) {
    assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><label>First name<input id="${id}"></label>`)), [], id);
  }
});

test('address requires explicit home scope and mailing/unknown addresses remain manual', () => {
  const address = '<label>Street address<input id="address"></label><label>City<input></label><label>State<select><option value=""></option><option value="19">Iowa</option></select></label>';
  assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1>${address}`)), []);
  assert.deepEqual(keys(page(`<h1>Enter Personal Information</h1><fieldset><legend>Mailing address</legend>${address}</fieldset>`)), []);
  const doc = page(`<h1>Enter Personal Information</h1><fieldset><legend>Home address</legend>${address}</fieldset>`);
  assert.deepEqual(keys(doc), ['addressLine1', 'city', 'state']);
  const result = adapter.fill(doc, URL, adapter.scan(doc, URL).bindings, { addressLine1: '100 Example Road', city: 'Example City', state: 'IA' });
  assert.equal(result.filled.length, 3);
  assert.equal(doc.querySelector('select').value, '19');
});

test('DOB is formatted only when the destination format is explicit, invalid dates are skipped', () => {
  const doc = page('<h1>Enter Personal Information</h1><label>Date of birth<input placeholder="MM/DD/YYYY"></label>');
  const field = doc.querySelector('input');
  assert.equal(adapter.formatValue('birthDate', '2000-02-29', field), '02/29/2000');
  assert.equal(adapter.formatValue('birthDate', '2001-02-29', field), null);
  field.removeAttribute('placeholder');
  assert.equal(adapter.formatValue('birthDate', '2000-02-29', field), null);
  field.type = 'date';
  assert.equal(adapter.formatValue('birthDate', '2000-02-29', field), '2000-02-29');
  field.type = 'text'; field.maxLength = 2;
  assert.equal(adapter.formatValue('firstName', 'Example', field), null);
  assert.equal(adapter.formatValue('firstName', '', field), null);
});

test('changes between preview and approval or caused by page events cannot overwrite user work', () => {
  const doc = page(); const scan = adapter.scan(doc, URL);
  doc.querySelector('#first').value = 'User entered';
  const replacement = doc.querySelector('#last').cloneNode();
  doc.querySelector('#last').replaceWith(replacement);
  assert.deepEqual(adapter.fill(doc, URL, scan.bindings, { firstName: 'Replace', lastName: 'Replace' }).filled, []);
  assert.equal(doc.querySelector('#first').value, 'User entered');
  const changing = page(); const original = adapter.scan(changing, URL);
  changing.querySelector('#first').addEventListener('input', () => { changing.querySelector('#last').value = 'Portal supplied'; });
  assert.deepEqual(adapter.fill(changing, URL, original.bindings, { firstName: 'Example', lastName: 'Replace' }).filled, ['firstName']);
  assert.equal(changing.querySelector('#last').value, 'Portal supplied');
});

test('public Iowa guest screen metadata fixture is deliberately unsupported', () => {
  // Only public non-sensitive attributes observed 2026-09-26. No tokens or values.
  const doc = page('<h3>Household Application Information</h3><form id="householdApplicationForm" action="selectHouseholdInfo"><label for="householdApplyProgYes">Yes. At least one person is applying for SNAP, FIP/RCA, or help paying for health coverage.</label><input type="radio" id="householdApplyProgYes" name="householdApplyProg"><input name="captchaAnswer"><input type="hidden" name="reCaptchaResponse"><button>Continue</button></form>', `${adapter.PORTAL}/applyForBenefits/selectHouseholdInfo`);
  assert.equal(adapter.scan(doc, doc.location.href).recognizedPage, false);
  assert.deepEqual(keys(doc), []);
});

test('manifest grants only user activated injection and native messaging; applicant storage unavailable', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'nativeMessaging', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
});
