'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');
const fixture = require('./fixtures/iowa-self-details.cjs');
const { layoutElements } = require('./helpers/harness.cjs');
function page(html = fixture.html, url = fixture.URL) {
  return layoutElements(new JSDOM(`<!doctype html><main>${html}</main>`, { url, pretendToBeVisual: true }).window);
}
const input = doc => doc.getElementById(fixture.DOB_ID);

test('self-only Tell Us More offers DOB with static manual checklist and never automatic Next', () => {
  const doc = page(), scan = adapter.scan(doc, fixture.URL), probe = adapter.probePage(doc, fixture.URL);
  assert.equal(scan.recognizedPage, true);
  assert.deepEqual(scan.fields, [{ key: 'birthDate', label: 'Date of birth' }]);
  assert.ok(Object.hasOwn(adapter.definitions, 'birthDate'));
  assert.equal(probe.kind, 'fillable'); assert.equal(probe.pageKey, 'iowa-self-details'); assert.equal(probe.canAdvance, false);
  assert.equal(probe.checklist.length, 10); assert.equal(probe.manualRemaining, 9);
  assert.equal(probe.checklist[0].status, 'optional'); assert.equal(probe.requiredRemaining, 0);
  assert.doesNotMatch(JSON.stringify(probe), /Avery|Jordan|Example|QA manual|answerSets|1985/);
  assert.equal(adapter.captureNavigation(doc, fixture.URL), null);
  let clicked = 0; doc.querySelector('#dqButtonId309').addEventListener('click', () => clicked++);
  assert.equal(adapter.advance(doc, fixture.URL, {}).advanced, false); assert.equal(clicked, 0);
});

test('valid saved ISO birth date formats as observed month/day/year and hidden alternatives stay empty', () => {
  const doc = page(); let changes = 0; input(doc).addEventListener('change', () => changes++);
  const result = adapter.fill(doc, fixture.URL, adapter.scan(doc, fixture.URL).bindings, { birthDate: '1985-04-12', ssn: '999-99-9999', email: 'qa@example.test' });
  assert.deepEqual(result, { filled: ['birthDate'], skipped: [] }); assert.equal(input(doc).value, '04/12/1985'); assert.equal(changes, 1);
  assert.equal(doc.getElementById('answerSets0.answers4.answerValue').value, ''); assert.equal(doc.getElementById('answerSets0.answers5.answerValue').value, '');
  assert.deepEqual(adapter.scan(doc, fixture.URL).fields, []); assert.equal(adapter.probePage(doc, fixture.URL).checklist[0].status, 'complete');
  assert.equal(adapter.probePage(doc, fixture.URL).canAdvance, false);
});

test('DOB never defaults, guesses ambiguous date formats, truncates or accepts impossible/future dates', () => {
  for (const value of ['', '04/12/1985', '1985-4-12', '1985-02-29', '2020-02-30', '1900-02-29', '9999-12-31', '1985-13-01', '1985-00-12', '1985-04-31', '1985-04-12T00:00:00Z']) {
    const doc = page(); assert.deepEqual(adapter.fill(doc, fixture.URL, adapter.scan(doc, fixture.URL).bindings, { birthDate: value }).filled, [], value); assert.equal(input(doc).value, '');
  }
  const doc = page(); assert.deepEqual(adapter.fill(doc, fixture.URL, adapter.scan(doc, fixture.URL).bindings, { birthDate: '2000-02-29' }).filled, ['birthDate']);
  assert.equal(input(doc).value, '02/29/2000');
});

test('People phase, other person context, wrong form, altered DOB metadata and visible alternatives refuse mapping', () => {
  const mutations = [
    doc => { doc.querySelector('[title="People | Unvisited"]').title = 'People | Active'; },
    doc => { doc.querySelector('[title="Start Application | Active"]').title = 'Start Application | Visited'; },
    doc => { doc.querySelector('li.current').className = 'visited'; },
    doc => { doc.querySelector('div.fullrow.floatLeft p').textContent = 'Give us additional information about this household member.'; },
    doc => { doc.querySelector('h2').textContent = 'Tell Us About Another Person'; },
    doc => { doc.querySelector('form').action = 'otherPerson'; },
    doc => { doc.querySelector('form').method = 'get'; },
    doc => { doc.querySelector('form').setAttribute('onsubmit', 'saveOtherPerson()'); },
    doc => { doc.querySelector('.peTaxInfoName').classList.remove('peTaxInfoName'); },
    doc => { doc.querySelector('.panel-group').append(doc.querySelector('.peTaxInfoName').cloneNode(true)); },
    doc => { input(doc).id = 'answerSets1.answers3.answerValue'; },
    doc => { input(doc).name = 'answerSets[1].answers[3].answerValue'; },
    doc => { input(doc).title = 'dd/mm/yyyy'; },
    doc => { input(doc).type = 'date'; },
    doc => { input(doc).maxLength = 8; },
    doc => { input(doc).setAttribute('onchange', 'save()'); },
    doc => { input(doc).setAttribute('onblur', 'save()'); },
    doc => { input(doc).setAttribute('form', 'anotherPerson'); },
    doc => { input(doc).setAttribute('pattern', '.*'); },
    doc => { input(doc).classList.remove('date-format-class'); },
    doc => { input(doc).required = true; },
    doc => { doc.querySelector('#question02419').classList.add('disabledQuestion'); },
    doc => { doc.querySelector('.disabledQuestion').style.display = 'block'; },
    doc => { input(doc).after(input(doc).cloneNode(true)); }
  ];
  for (const mutate of mutations) {
    const doc = page(); mutate(doc); assert.deepEqual(adapter.scan(doc, fixture.URL).fields, [], mutate.toString()); assert.equal(adapter.captureNavigation(doc, fixture.URL), null);
  }
  for (const url of [fixture.URL + '?person=1', fixture.URL.replace('dynamicQuestions', 'peopleDetails'), fixture.URL.replace('hhsservices.iowa.gov', 'example.com')]) assert.deepEqual(adapter.scan(page(fixture.html, url), url).fields, []);
});

test('DOB preserves existing text and refuses hidden, disabled, readonly or occluded controls', () => {
  for (const mutate of [doc => { input(doc).value = '01/01/1970'; }, doc => { input(doc).hidden = true; }, doc => { input(doc).disabled = true; }, doc => { input(doc).readOnly = true; }, doc => { doc.elementFromPoint = () => doc.querySelector('h2'); }]) {
    const doc = page(); mutate(doc); assert.deepEqual(adapter.scan(doc, fixture.URL).fields, []);
  }
  const doc = page(), bindings = adapter.scan(doc, fixture.URL).bindings; input(doc).value = '01/01/1970';
  assert.deepEqual(adapter.fill(doc, fixture.URL, bindings, { birthDate: '1985-04-12' }).filled, []); assert.equal(input(doc).value, '01/01/1970');
});

test('private self-context fingerprint rejects switched applicant, intro, group, control or phase after preview', () => {
  const mutations = [
    doc => { doc.querySelector('h3').textContent = 'Another Fictional Person'; },
    doc => { doc.querySelector('h3').replaceWith(doc.querySelector('h3').cloneNode(true)); },
    doc => { doc.querySelector('div.fullrow.floatLeft p').append(' Changed explanation.'); },
    doc => { input(doc).replaceWith(input(doc).cloneNode(true)); },
    doc => { doc.querySelector('[title="People | Unvisited"]').title = 'People | Active'; }
  ];
  for (const mutate of mutations) {
    const doc = page(), bindings = adapter.scan(doc, fixture.URL).bindings; mutate(doc);
    assert.deepEqual(adapter.fill(doc, fixture.URL, bindings, { birthDate: '1985-04-12' }).filled, [], mutate.toString()); assert.equal(input(doc).value, '');
  }
});

test('scroll and focus recheck self-context; visible protected dialogs prevent DOB release', () => {
  const doc = page(), target = input(doc), bindings = adapter.scan(doc, fixture.URL).bindings;
  const original = target.getBoundingClientRect; target.getBoundingClientRect = () => ({ left: 20, top: 2000, right: 220, bottom: 2030, width: 200, height: 30 });
  target.scrollIntoView = () => { target.getBoundingClientRect = original; doc.querySelector('h3').textContent = 'Different QA Applicant'; };
  assert.deepEqual(adapter.fill(doc, fixture.URL, bindings, { birthDate: '1985-04-12' }).filled, []);
  const focus = page(); assert.equal(adapter.focusField(focus, fixture.URL, 'birthDate'), true); assert.equal(focus.activeElement, input(focus));
  assert.equal(adapter.focusField(focus, fixture.URL, 'ssn'), false);
  const protectedPage = page(fixture.html.replace('</form>', '<div role="dialog">Consent review</div></form>'));
  assert.deepEqual(adapter.scan(protectedPage, fixture.URL).fields, []); assert.equal(adapter.probePage(protectedPage, fixture.URL).kind, 'blocked');
});

test('visible protected headings at any page-heading level also stop DOB scan and stale fill', () => {
  for (const tag of ['h1', 'h2', 'h3']) {
    const doc = page(), bindings = adapter.scan(doc, fixture.URL).bindings;
    // This variant represents an unexpected protected context appearing while
    // the original self-information form remains in the DOM.
    const heading = doc.querySelector(tag) || doc.createElement(tag);
    if (!heading.isConnected) {
      heading.getBoundingClientRect = () => ({ left: 20, top: 20, right: 220, bottom: 50, width: 200, height: 30 });
      heading.getClientRects = () => [heading.getBoundingClientRect()];
      doc.body.prepend(heading);
    }
    heading.textContent = 'E-Signature';
    assert.deepEqual(adapter.scan(doc, fixture.URL).fields, [], tag);
    assert.deepEqual(adapter.fill(doc, fixture.URL, bindings, { birthDate: '1985-04-12' }).filled, [], tag);
    assert.equal(input(doc).value, ''); assert.equal(adapter.captureNavigation(doc, fixture.URL), null);
  }
});

test('observed final E-Signature controls never receive saved facts, certification clicks, or automatic submission', () => {
  const url = `${adapter.PORTAL}/applyForBenefits/eSignature`;
  // Observed control identities only; certification prose is a QA placeholder,
  // not the agency's actual attestation or an acceptance of its terms.
  const doc = page(`<h2>E-Signature</h2><form id="representativeForm" action="eSignature" method="post">
    <p>QA certification placeholder. Final review stays with the applicant.</p>
    <input id="checktoSign" name="sign" type="checkbox" onclick="onCheckToSignChange(this.checked)">
    <input id="signature" name="signature" type="text">
    <select id="role" name="role"><option>Applicant</option></select>
    <button id="submitAnchorId" type="button" disabled onclick="submitApplication(); return false;">Submit Application</button>
  </form>`, url);
  let clicks = 0; doc.querySelectorAll('input,button').forEach(element => element.addEventListener('click', () => clicks++));
  const scan = adapter.scan(doc, url), probe = adapter.probePage(doc, url);
  assert.equal(scan.recognizedPage, false); assert.deepEqual(scan.fields, []);
  assert.equal(probe.kind, 'blocked'); assert.equal(probe.canAdvance, false); assert.equal(adapter.captureNavigation(doc, url), null);
  const oldDoc = page(), staleDobBindings = adapter.scan(oldDoc, fixture.URL).bindings;
  assert.deepEqual(adapter.fill(doc, url, staleDobBindings, { firstName: 'Avery', birthDate: '1985-04-12', ssn: '999-99-9999' }).filled, []);
  assert.deepEqual(adapter.fill(doc, url, scan.bindings, { firstName: 'Avery', birthDate: '1985-04-12' }).filled, []);
  assert.equal(adapter.focusField(doc, url, 'birthDate'), false);
  assert.equal(adapter.advance(doc, url, {}).advanced, false);
  assert.equal(doc.querySelector('#checktoSign').checked, false); assert.equal(doc.querySelector('#signature').value, '');
  assert.equal(doc.querySelector('#submitAnchorId').disabled, true); assert.equal(clicks, 0);
  // Even an enabled final button cannot turn this protected page into an
  // ordinary Next action. This mutation exists only in the local QA fixture.
  doc.querySelector('#submitAnchorId').disabled = false;
  assert.equal(adapter.captureNavigation(doc, url), null); assert.equal(adapter.advance(doc, url, {}).advanced, false); assert.equal(clicks, 0);
});

// #135: the date of birth is checked against today on this computer's calendar, as the app checks it:
// today or earlier, and no more than 130 years ago. Each test pins the clock and the timezone.
function inZone(t, zone, instant) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(instant) });
}
const fillDate = value => { const doc = page(); adapter.fill(doc, fixture.URL, adapter.scan(doc, fixture.URL).bindings, { birthDate: value }); return input(doc).value; };

test('on an Iowa evening, a date of birth of tomorrow is never filled, though it is already that date in UTC', t => {
  // 8:30 pm on October 5 in Iowa is 01:30 on October 6 in UTC.
  inZone(t, 'America/Chicago', '2026-10-06T01:30:00Z');
  assert.equal(fillDate('2026-10-06'), '');
  assert.equal(fillDate('2026-10-05'), '10/05/2026', 'born today');
  assert.equal(fillDate('1896-10-05'), '10/05/1896', 'exactly 130 years ago');
  assert.equal(fillDate('1896-10-04'), '', 'more than 130 years ago');
  assert.equal(fillDate('1825-06-01'), '');
});

test('just after midnight in UTC+14, today’s date of birth is filled while UTC is still on the day before', t => {
  inZone(t, 'Pacific/Kiritimati', '2026-10-05T10:00:00Z');
  assert.equal(fillDate('2026-10-06'), '10/06/2026');
  assert.equal(fillDate('2026-10-07'), '');
});
