'use strict';
// Sanitized projection of the captured Job and Job History controls. Names and
// answers are fictional. Conditional handlers below are QA simulations, not a
// copy of Iowa JavaScript; no submission or network navigation occurs.
const URL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/dynamicQuestions';
const NEXT_SELECTOR = 'button.saveButton';
const PERSON_PREFIX = ':1007278,69,70,1007368,72,73,74,75,76,2802,2803,1000181,1000021,1000020,1000019:7987,7988,1771,1007281';
const PERSON_RULE = ':69,70,2803,72,73,74,75,1000181,1007368,2802,1000020,76,1000019,1000021,1007278:7987,7988,1771,1007281';
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const hide = rule => `hideShowQuestions('question0', this, '${rule}')`;
const id = index => `answerSets0.answers${index}.answerValue`;
const name = index => `answerSets[0].answers[${index}].answerValue`;
function radio(question, index, legend, options, rule = '') {
  return `<div class="questionAnswer" id="${question}"><fieldset><legend>${esc(legend)}</legend>${options.map((value, i) => `<input class="hasScript" type="radio" id="${id(index)}${i + 1}" name="${name(index)}" value="${esc(value)}" onclick="${esc(hide(rule))}" onchange="${esc(hide(rule) + ' ')}"><label for="${id(index)}${i + 1}">${esc(value)}</label>`).join('')}</fieldset></div>`;
}
function text(question, index, label, date = false) {
  return `<div class="questionAnswer" id="${question}"><label for="${id(index)}">${esc(label)}</label><input type="text" id="${id(index)}" name="${name(index)}" ${date ? 'class="date-format-class hasDatepicker" title="mm/dd/yyyy"' : 'autocomplete="off"'}></div>`;
}
function makeHtml({ people = ['Avery Example', 'Jordan Sample'] } = {}) {
  // Only the first option was observed. Extra fictional options exercise the
  // same captured option rule, without claiming another live capture.
  const ownerRule = PERSON_PREFIX + people.map((_, index) => `|${index}${PERSON_RULE}`).join('');
  const frequencies = ['Annually', 'Every Other Week', 'Irregular/Infrequent', 'Monthly', 'Quarterly', 'Semi Annually', 'Twice a Month', 'Weekly'];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Isolated job form QA</title><style>[hidden]{display:none!important}body{font-family:system-ui}.questionAnswer{margin:12px}label{margin:4px}</style></head><body>
  <ul><li><a title="Start Application | Visited">Start Application</a></li><li><a title="People | Visited">People</a></li><li class="current"><a title="Job and School | Active">Job and School</a></li><li><a title="Other Income | Unvisited">Other Income</a></li></ul>
  <h2><div class="htmlHeaderPageTitle">Job and Job History</div></h2>
  <form id="answerSet" action="simple" method="post">
  <div class="questionAnswer" id="qa-person"><label for="answerSets0.personSelection">Select a person*</label><select id="answerSets0.personSelection" name="answerSets[0].personSelection" class="hasScript" onchange="${esc(`enableDisableQuestions('question0', this, '${ownerRule}')`)}"><option value="">Select One</option>${people.map((value, index) => `<option value="${index}">${esc(value)}</option>`).join('')}</select></div>
  ${radio('question069', 0, 'Work or Training:', ['Work', 'Training'], '::2803,1007368,1000181|Work:2803,1007368,1000181:|Training::2803,1007368,1000181')}
  ${text('question070', 2, 'Start Date*', true)}
  ${radio('question02803', 3, 'Is this job self-employment?', ['Yes', 'No'], '::1007368,1000181|Yes:1007368,1000181:|No::1007368,1000181')}
  ${text('question072', 4, 'Employer Name:')}${text('question073', 5, 'Job Title')}${text('question074', 6, 'Monthly Number of Hours:')}
  ${text('question075', 8, 'Gross Income (before taxes) per pay period*')}
  <div class="questionAnswer" id="question01000181">Enter monthly net income if you are self-employed</div>
  ${radio('question01007368', 10, 'Do you have business expenses related to your self-employment?', ['Yes', 'No'])}
  <div class="questionAnswer" id="question02802"><label for="${id(11)}">Pay period frequency*</label><select class="hasScript" id="${id(11)}" name="${name(11)}" onchange="${esc(hide(''))}"><option value="">Select One</option>${frequencies.map(value => `<option value="${value}">${value}</option>`).join('')}</select></div>
  ${text('question076', 13, 'Tips or Commissions')}${radio('question01000019', 14, 'Do you expect this income to stay the same?', ['Yes', 'No'])}
  <div class="questionAnswer" id="question01007278"><fieldset><legend>In the past 30 days, did this person</legend>${['Change Jobs', 'Stop working', 'Start working fewer hours'].map((value, index) => `<input type="checkbox" class="hasScript" id="answerSets0.answers17.answerValues${index + 1}" name="answerSets[0].answers[17].answerValues" value="${value}" onclick="${esc(hide(''))}"><label for="answerSets0.answers17.answerValues${index + 1}">${value}</label>`).join('')}<input type="hidden" name="_answerSets[0].answers[17].answerValues"></fieldset></div>
  <button type="button" class="btn btn-primary saveButton" onclick="submitAction();return false;">Save and Continue</button>
  </form></body></html>`;
}
function attachHandlers(doc) {
  doc.__jobQa = { nextClicks: 0, ownerChanges: [] };
  const owner = doc.getElementById('answerSets0.personSelection');
  const sync = () => {
    const selected = Boolean(owner.value);
    const work = doc.getElementById('answerSets0.answers0.answerValue1').checked;
    const self = doc.getElementById('answerSets0.answers3.answerValue1').checked;
    for (const question of doc.querySelectorAll('#answerSet > .questionAnswer')) {
      if (question.id === 'qa-person') continue;
      const visible = selected && (question.id === 'question02803' ? work : ['question01007368', 'question01000181'].includes(question.id) ? work && self : true);
      question.hidden = !visible;
      for (const control of question.querySelectorAll('input,select')) control.disabled = !visible;
    }
  };
  owner.onchange = () => { doc.__jobQa.ownerChanges.push(owner.value); sync(); };
  for (const input of doc.querySelectorAll('input[type="radio"],input[type="checkbox"]')) {
    input.onclick = () => { sync(); }; input.onchange = () => { sync(); };
    if (input.type === 'checkbox') input.onchange = null;
  }
  doc.getElementById('answerSets0.answers11.answerValue').onchange = () => {};
  doc.querySelector('button.saveButton').onclick = () => { doc.__jobQa.nextClicks++; return false; };
  doc.querySelector('form').addEventListener('submit', event => event.preventDefault());
  sync();
}
module.exports = { URL, NEXT_SELECTOR, makeHtml, html: makeHtml(), attachHandlers };
