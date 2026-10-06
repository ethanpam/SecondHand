'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { evalFile, layoutElements, plain } = require('./helpers/harness.cjs');
const URL = 'https://forms.example.org/application/step-one';
const FORM = '<h1>Contact information</h1><form action="/application/step-two"><label for="first">First name</label><input id="first" required><label for="email">Email</label><input id="email" type="email" required><button id="next" type="submit">Save and continue</button></form>';
function page(t, html = FORM, url = URL) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  layoutElements(window);
  for (const file of ['generic-adapter.js', 'generic-navigation.js']) evalFile(window, `extension/${file}`);
  let clicks = 0, submits = 0;
  document.addEventListener('submit', event => { submits++; event.preventDefault(); });
  document.getElementById('next')?.addEventListener('click', () => { clicks++; });
  return { window, document, snapshot: () => plain(window.SecondHandNavigation.snapshot(document)),
    advance: token => plain(window.SecondHandNavigation.advance(document, token)),
    fill: () => { document.getElementById('first').value = 'Jordan'; document.getElementById('email').value = 'jordan@example.test'; },
    counts: () => ({ clicks, submits }) };
}
test('a complete ordinary same-site step can click Next exactly once, without exposing answers', t => {
  const p = page(t);
  assert.equal(p.snapshot().reason, 'missing');
  p.fill();
  const preview = p.snapshot();
  assert.equal(preview.canAdvance, true);
  assert.doesNotMatch(JSON.stringify(preview), /Jordan|jordan@|first|email|step-two/);
  assert.deepEqual(p.advance(preview.token), { ok: true, advanced: true });
  assert.deepEqual(p.counts(), { clicks: 1, submits: 1 }, 'ordinary Next can send the step to the website');
  assert.equal(p.advance(preview.token).ok, false);
  assert.equal(p.counts().clicks, 1);
});
test('missing required values, invalid emails, page errors, and disabled Next remain manual', t => {
  const p = page(t); p.fill();
  p.document.getElementById('email').value = 'invalid';
  assert.equal(p.snapshot().reason, 'missing');
  p.fill();
  p.document.body.insertAdjacentHTML('beforeend', '<p role="alert">Fix the address</p>');
  assert.equal(p.snapshot().reason, 'errors');
  p.document.querySelector('[role="alert"]').remove();
  p.document.getElementById('next').disabled = true;
  assert.equal(p.snapshot().reason, 'no-next');
  assert.equal(p.counts().clicks, 0);
});
test('a changed value, hidden payload, form action, or replaced button invalidates an approved preview', t => {
  for (const change of [p => { p.document.getElementById('first').value = 'Edited'; },
    p => p.document.querySelector('form').insertAdjacentHTML('beforeend', '<input type="hidden" name="csrf" value="changed">'),
    p => { p.document.querySelector('form').action = '/other-step'; },
    p => { const b = p.document.getElementById('next'); b.replaceWith(b.cloneNode(true)); }]) {
    const p = page(t); p.fill(); const preview = p.snapshot();
    change(p);
    assert.equal(p.advance(preview.token).ok, false);
    assert.equal(p.counts().clicks, 0);
  }
});
test('changed question labels or added local question text invalidate an approved preview', t => {
  for (const change of [
    p => { p.document.querySelector('label[for="first"]').textContent = 'Last name'; },
    p => { p.document.getElementById('next').insertAdjacentHTML('beforebegin', '<p>Which office should handle this request?</p>'); }
  ]) {
    const p = page(t); p.fill(); const preview = p.snapshot();
    assert.equal(preview.canAdvance, true);
    change(p);
    assert.equal(p.advance(preview.token).ok, false);
    assert.deepEqual(p.counts(), { clicks: 0, submits: 0 });
  }
});
test('query or hash rotation does not make an identical semantic step eligible for another attempt', t => {
  const pages = ['?nonce=first#one', '?nonce=rotated#two', '?step=2#three'].map(suffix => page(t, FORM, URL + suffix));
  const previews = pages.map(p => { p.fill(); return p.snapshot(); });
  assert.ok(previews.every(preview => preview.canAdvance));
  assert.equal(new Set(previews.map(preview => preview.step)).size, 1, 'the worker attempt ledger must survive URL token rotation');
  const current = pages[0], approved = current.snapshot();
  current.window.history.replaceState(null, '', URL + '?nonce=changed#four');
  assert.equal(current.advance(approved.token).ok, false, 'the immediate approval still requires the exact original URL');
  assert.deepEqual(current.counts(), { clicks: 0, submits: 0 });
});
test('navigation never crosses origins, opens another target, or uses a final action', t => {
  for (const attributes of ['formaction="https://elsewhere.example.org/next"', 'formtarget="_blank"', 'formaction="/submit-application"']) {
    const p = page(t, FORM.replace('id="next"', `id="next" ${attributes}`)); p.fill();
    assert.equal(p.snapshot().canAdvance, false);
    assert.equal(p.counts().clicks, 0);
  }
  for (const text of ['Submit application', 'Finish', 'Pay now', 'Sign and submit']) {
    const p = page(t, FORM.replace('Save and continue', text)); p.fill();
    assert.equal(p.snapshot().reason, 'protected');
  }
});
test('Continue stays manual when its form destination names a final action in a query or camel-case path', t => {
  for (const action of ['/application?action=submitApplication', '/submitApplication']) {
    const p = page(t, FORM.replace('/application/step-two', action)); p.fill();
    assert.equal(p.snapshot().reason, 'protected', action);
    assert.deepEqual(p.counts(), { clicks: 0, submits: 0 });
  }
});
test('rendered local consent or certification disclosure blocks Continue without a consent control', t => {
  for (const disclosure of [
    '<p>By clicking Continue, you agree to the terms and certify that this application is true and complete.</p>',
    '<p>By clicking <span>Continue</span>, you <strong>agree</strong> to the <a href="/terms">terms</a> and certify that this application is true and complete.</p>'
  ]) {
    const p = page(t, FORM.replace('</form>', `${disclosure}</form>`)); p.fill();
    assert.equal(p.snapshot().reason, 'protected');
    assert.deepEqual(p.counts(), { clicks: 0, submits: 0 });
  }
  const shadow = page(t, FORM.replace('</form>', '<div id="disclosure"></div></form>')); shadow.fill();
  shadow.document.getElementById('disclosure').attachShadow({ mode: 'open' }).innerHTML =
    '<p>By clicking <span>Continue</span>, you agree to the terms and certify that this application is true and complete.</p>';
  assert.equal(shadow.snapshot().reason, 'protected', 'disclosure inside an open shadow root is still part of this form');
  assert.deepEqual(shadow.counts(), { clicks: 0, submits: 0 });
});
test('the current main-step disclosure blocks Continue even when it is outside the form', t => {
  const p = page(t, `<main>${FORM.replace('<form ', '<p>By clicking Continue, you certify that this application is true and complete.</p><form ')}</main>`);
  p.fill();
  assert.equal(p.snapshot().reason, 'protected');
  assert.deepEqual(p.counts(), { clicks: 0, submits: 0 });
});
test('unrelated footer terms and applicant-entered text are not treated as a local action disclosure', t => {
  const p = page(t, FORM.replace('</form>', '<label>Notes<textarea>My notes say agree, certify, submitApplication.</textarea></label></form>') +
    '<footer><p>By using this website you agree to its terms.</p><a href="/terms">Terms</a></footer>');
  p.fill();
  assert.equal(p.snapshot().canAdvance, true);
  const hidden = page(t, FORM.replace('</form>', '<p hidden>By clicking Continue, you agree to the terms.</p></form>')); hidden.fill();
  assert.equal(hidden.snapshot().canAdvance, true, 'an unrendered notice is not the current action disclosure');
});
test('an unrelated form and footer inside main do not block the ordinary application step', t => {
  const p = page(t, `<main>${FORM}<form aria-label="Newsletter"><p>By subscribing, you agree to the newsletter terms.</p>` +
    '<label>Newsletter email<input type="email"></label><button type="button">Subscribe</button></form>' +
    '<footer><p>By using this website you agree to its terms.</p><a href="/terms">Terms</a></footer></main>');
  p.fill();
  assert.equal(p.snapshot().canAdvance, true);
});
test('consent, signatures, review screens, verification and uploads stay manual even if answered', t => {
  for (const extra of ['<label><input type="checkbox" checked>I agree to the terms</label>', '<label>Signature<input value="Jordan"></label>',
    '<input type="password" value="not-a-real-password">', '<input autocomplete="one-time-code" value="123456">', '<input type="file">',
    '<dialog open>Check your answers</dialog>', '<iframe src="https://embedded.example.org/form"></iframe>']) {
    const p = page(t, FORM.replace('</form>', `${extra}</form>`)); p.fill();
    assert.equal(p.snapshot().canAdvance, false, extra);
  }
  const review = page(t, FORM.replace('Contact information', 'Review your application')); review.fill();
  assert.equal(review.snapshot().reason, 'protected');
});
test('guessed answers block Next, while optional empty fields and unrelated footer links do not', t => {
  const p = page(t, FORM.replace('</form>', '<label>Apartment<input id="apt"></label></form>') + '<footer><a href="/terms">Terms</a><a href="/privacy">Privacy</a></footer>');
  p.fill();
  assert.equal(p.snapshot().canAdvance, true);
  p.document.getElementById('first').setAttribute('data-secondhand-filled', 'guess');
  assert.equal(p.snapshot().reason, 'review');
});
test('ambiguous Next controls and unknown required widgets are not clicked', t => {
  const p = page(t, FORM.replace('</form>', '<button type="button">Next</button></form>')); p.fill();
  assert.equal(p.snapshot().canAdvance, false);
  const unsupported = page(t, FORM.replace('</form>', '<div role="textbox" aria-required="true" tabindex="0"></div></form>')); unsupported.fill();
  assert.equal(unsupported.snapshot().canAdvance, false);
});
test('Iowa and insecure pages cannot use generic navigation, and tokens belong to one document', t => {
  for (const url of ['http://forms.example.org/form', 'https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/dynamicQuestions']) {
    const p = page(t, FORM, url); p.fill(); assert.equal(p.snapshot().reason, 'unsupported');
  }
  const a = page(t), b = page(t); a.fill(); b.fill();
  assert.equal(b.advance(a.snapshot().token).ok, false);
});


test('a sign-up information step is ordinary, while signing language remains protected', t => {
  const signup = page(t, FORM.replace('Contact information', 'Sign up: contact information'));
  signup.fill(); assert.equal(signup.snapshot().canAdvance, true);
  for (const heading of ['Sign your application', 'Sign here', 'Signature', 'Signing', 'Sign and submit']) {
    const protectedPage = page(t, FORM.replace('Contact information', heading)); protectedPage.fill();
    assert.equal(protectedPage.snapshot().reason, 'protected', heading);
  }
});


test('regenerated field IDs and names do not make a repeated visible step new, but invalidate its pending approval', t => {
  const p = page(t); p.fill(); const before = p.snapshot();
  const input = p.document.getElementById('first');
  p.document.querySelector('label[for="first"]').htmlFor = 'new-generated-id';
  input.id = 'new-generated-id'; input.name = 'new-generated-name';
  assert.equal(p.advance(before.token).ok, false);
  const after = p.snapshot();
  assert.equal(after.canAdvance, true); assert.equal(after.step, before.step);
  assert.equal(p.counts().clicks, 0);
});
