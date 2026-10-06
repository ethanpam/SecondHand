'use strict';
// Capture-derived QA fixture, NOT a raw second live HTML dump.
// The full sanitized dynamicQuestionsStart template supplies exact control markup. On 2026-10-06,
// a read-only live DOM/AX inspection at dynamicQuestions confirmed the same full sibling name/panel
// layout, exact Next, the baseline below, and these expanded branches: citizenship Yes -> q06180;
// SSN Yes -> q03/q04068, card mismatch -> q04070/q04071/q04072; Female -> q0443;
// pregnant Yes -> q01030/q01031, pregnant No -> neither. Only those observed visibility states
// are projected here. Hidden alternative templates are retained, with no hidden values/session data.
// The name remains fictional. Test handlers below emulate those observed branches; they are not
// downloaded Iowa code and cannot contact the real portal.
const { JSDOM } = require('jsdom');
const original = require('./iowa-tell-us-more.cjs');
const URL = original.URL.replace('dynamicQuestionsStart', 'dynamicQuestions');
const BASELINE = Object.freeze(['question01', 'question02419', 'question02420', 'question06179', 'question04', 'question01007331', 'question02422', 'question07', 'question0565']);
const FOLLOWUPS = Object.freeze(['question03', 'question04068', 'question04070', 'question04071', 'question04072', 'question06180', 'question0443', 'question01030', 'question01031']);
const doc = new JSDOM(original.html).window.document;
for (const question of doc.querySelectorAll('.panel-group .questionAnswer[id]')) {
  if (BASELINE.includes(question.id)) { question.className = 'questionAnswer'; question.style.display = ''; }
  else if (FOLLOWUPS.includes(question.id)) { question.className = 'hidden questionAnswer'; question.style.display = 'none'; }
  else { question.className = 'disabledQuestion hidden questionAnswer'; question.style.display = 'none'; }
}
const html = doc.head.innerHTML + doc.body.innerHTML;
doc.defaultView.close();
const ANSWERS = Object.freeze({ gender: 2, hasSsn: 6, ssnCardName: 11, usCitizen: 19, bornInUs: 20, maritalStatus: 22, militaryOrVeteran: 24,
  eatsMealsWithHousehold: 25, hasDisability: 26, blind: 27, pregnant: 32 });
const DOB_ID = 'answerSets0.answers3.answerValue';
const DUE_ID = 'answerSets0.answers33.answerValue';
const EXPECTED_BABIES_ID = 'answerSets0.answers34.answerValue';
const NEXT_SELECTOR = '#dqButtonId309';
function attachHandlers(document) {
  const byId = id => document.getElementById(id);
  const selected = (index, option) => byId(`answerSets0.answers${index}.answerValue${option}`).checked;
  const show = (ids, visible) => ids.forEach(id => {
    const q = byId(id); q.classList.toggle('hidden', !visible); q.style.display = visible ? '' : 'none';
  });
  document.__tellQa = { nextClicks: 0 };
  // Set DOM properties, preserving observed onclick attributes for the production matcher.
  for (const radio of document.querySelectorAll('input[type="radio"]')) {
    radio.onchange = () => {};
    radio.onclick = () => {
      if (radio.name === 'answerSets[0].answers[6].answerValue') {
        show(['question03', 'question04068', 'question04070', 'question04071', 'question04072'], selected(6, 1));
        if (selected(11, 1)) show(['question04070', 'question04071', 'question04072'], false);
      }
      if (radio.name === 'answerSets[0].answers[11].answerValue') show(['question04070', 'question04071', 'question04072'], selected(6, 1) && selected(11, 2));
      if (radio.name === 'answerSets[0].answers[19].answerValue') show(['question06180'], selected(19, 1));
      if (radio.name === 'answerSets[0].answers[2].answerValue') {
        show(['question0443'], selected(2, 2));
        show(['question01030', 'question01031'], selected(2, 2) && selected(32, 1));
      }
      if (radio.name === 'answerSets[0].answers[32].answerValue') show(['question01030', 'question01031'], selected(2, 2) && selected(32, 1));
    };
  }
  byId('answerSets0.answers22.answerValue').onchange = () => {};
  byId('dqButtonId308').onclick = () => {};
  byId('dqButtonId309').onclick = () => { document.__tellQa.nextClicks++; };
}
module.exports = { URL, html, BASELINE, FOLLOWUPS, ANSWERS, DOB_ID, DUE_ID, EXPECTED_BABIES_ID, NEXT_SELECTOR, attachHandlers, radioId: original.radioId, SSN_BOX_ID: original.SSN_BOX_ID };
