'use strict';
// Synthetic reconstruction of the sanitized DOM metadata inspected on Iowa's
// fictional guest draft on 2026-10-06. This is NOT captured raw HTML. The exact
// route, heading, phase, question IDs/wording, options, form and Next metadata
// were observed. Wrapper whitespace, hidden values, test names, CSS and dynamic
// show/hide behavior are generated for tests. It does not prove other branches.
// Emergency has only a captured #stepper-div-id boundary, intro wording and one
// in-form H3; its generated paragraph and name wrappers are not asserted by the adapter.
const PORTAL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
const languageNames = 'English|Afghani|American Sign Language|Amharic|Arabic|Aramic|Armenian|Assyrian|Bengali|Bosnian|Cambodian|Cantonese (Chinese)|Croatian|Egyptian|Farsi|French|German|Greek|Hebrew|Hindi|Hmong|Ilacano|Indonesian|Italian|Japanese|Korean|Lao|Mandarin (Chinese)|Mien|Other Chinese Language|Other Non-English|Other Sign Language|Persian|Polish|Portuguese|Punjabi|Romanian|Russian|Samoan|Serbian|Spanish|Tagalog, Filipino|Thai|Turkish|Urdu|Vietnamese'.split('|');
const stateNames = 'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming'.split('|');
const races = ['American Indian or Alaskan Native', 'Asian', 'Black or African American', 'Hispanic or Latino', 'Native Hawaiian or Other Pacific Islander', 'White', 'Unknown'];
const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const radio = (question, index, label, rules = '', hidden = false) => ({ question, index, label, rules, hidden, type: 'radio', options: ['Yes', 'No'] });
const metadata = {
  emergency: { path: 'dynamicQuestionsStart', heading: 'Emergency Supplemental Nutrition Assistance Program (SNAP)', phase: 'Start Application',
    intro: 'These questions will help us decide if you can get food assistance quicker.', next: 'submitAction();return false;',
    questions: [radio('question015', 0, 'Does the household expect to have less than $150 income this month?'),
      radio('question016', 1, 'Is the total amount of money everyone in the household has less than $100?'),
      radio('question03136', 2, 'Is anyone a migrant or seasonal farm worker?'),
      radio('question017', 3, 'Are your monthly housing mortgage or rent and utility payments more than your expected monthly income?')] },
  background: { path: 'ssaVerificationRender', heading: 'Background Information', phase: 'Start Application',
    intro: 'Please give us additional information about yourself. If you cannot answer a question you can skip it.',
    nextId: 'dqButtonId311', next: "dynamicQuestionsButton('WARNING!', '', 'Ok', 'Cancel', 'answerSet', 'simple?buttonId=311', 'true', 'dqButtonId311');",
    questions: [radio('question02423', 1, 'Are you a resident of Iowa?'), radio('question01007303', 5, 'Are you a migrant or seasonal farm worker?'),
      { question: 'question08', index: 8, label: 'What is your preferred language?', type: 'select', options: languageNames,
        rules: `::566|English::566|${languageNames.slice(1).map(language => `${language}:566:`).join('|')}` },
      radio('question0566', 9, 'Would you like to have a person who speaks your first language help you when you visit the office at no cost?', '', true),
      radio('question02429', 18, 'Are you a naturalized citizen?', '::1007321,1751,1007320,1752,1007319,1753,1007318,1754,6252|Yes:1007321,1751,1007320,1752,1007319,1753,1007318,1754,6252:|No::1007321,1751,1007320,1752,1007319,1753,1007318,1754,6252'),
      { question: 'question012', index: 187, label: 'What state were you born in?', type: 'select', options: stateNames, rules: '' },
      { question: 'question014', index: 189, label: 'What is your race?', type: 'checkbox', options: races,
        rules: '::4064,4065,567|American Indian or Alaskan Native::4064,4065,567|Asian:567:4064,4065|Black or African American::4064,4065,567|Hispanic or Latino:4064:4065,567|Native Hawaiian or Other Pacific Islander:4065:4064,567|White::4064,4065,567|Unknown::4064,4065,567' }] },
  jobs: { path: 'dynamicQuestions', heading: 'Job Information', phase: 'Job and School', intro: null, next: 'submitAction();return false;',
    questions: [radio('question01007305', 0, 'Is anyone going to school or college? (For SNAP or FIP applicants, anyone 18 or older and in college or trade school.)'),
      radio('question052', 3, 'Is anyone currently on strike?', '::1007307|Yes:1007307:|No::1007307'),
      radio('question01007279', 6, 'Is anyone working, planning to work in the next two months or is self-employed? (include anyone who has been hired but hasn’t received a paycheck)'),
      radio('question01007277', 7, 'Has anyone ended a job in the last 30 days?')] },
  income: { path: 'dynamicQuestions', heading: 'Income Information', phase: 'Other Income', autocomplete: 'off',
    intro: "To make it faster to review your application, we need to know about your household's income from sources other than jobs. Answer for yourself and everyone in your household.",
    next: 'submitAction();return false;', questions: [
      radio('question01973', 0, "Is anyone getting or going to get money from Social Security, Retirement Accounts, Veteran's Administration or Pensions? This includes children."),
      { ...radio('question06542', 1, 'Is anyone getting or going to get money from any of these? This includes children.'),
        items: ['Child Support', 'Alimony', 'Capital Gains', 'Dividends/Interests', 'Net Farming/Fishing', 'Net Rental Royalties', 'Unemployment', 'Canceled Debts', 'Court Awards', 'Jury Duty'] },
      { ...radio('question01007080', 3, 'Is anyone getting or going to get money from any of these? This includes children.'),
        items: ['Loan, gifts, contributions', 'Work Compensation', 'Legal or Insurance settlements/court actions pending', 'Sales of notes, contracts, trust deeds, or promissory notes', 'Strike Pay/Benefits', 'Winnings such as bingo, lottery, prizes', 'Termination/Severance Pay', 'Supplemental Security Income (SSI)', 'Employee or Private disability'] },
      radio('question01007078', 5, 'Does anyone receive any money from educational grants, loans, and/or scholarships, per capita payments or training allowances?'),
      radio('question01007095', 10, 'Does anyone get housing or rent, utilities, food or clothing, for free or in exchange for work?'),
      radio('question01000022', 15, 'Do you expect your income to stay the same?'),
      radio('question01007309', 16, 'Is anyone getting money from friends or relatives?'),
      radio('question01007308', 17, 'Does anyone in the home (including children) get any other income that is not listed above?')] },
  expenses: { path: 'dynamicQuestions', heading: 'Expenses Information', phase: 'Expenses', autocomplete: 'off',
    intro: 'Tell us about the household expenses and bills you pay regularly. This information helps us see what benefits you can get, so be sure to include all your expenses. Answer for yourself and everyone in your household.',
    next: 'submitAction();return false;', questions: [
      radio('question0142', 1, 'Dependent Care Expenses (Child, Disabled Adult or Elder Care)?'),
      radio('question0149', 2, 'Housing Expenses?'), radio('question01007284', 3, 'Are you on low rent housing?'),
      radio('question0144', 6, 'Does anyone in the household currently pay child support?'),
      radio('question0150', 7, 'Utility Expense (Gas, Electricity, Water, etc.)?'),
      radio('question01007285', 8, 'Did you receive energy assistance in the past year at your current address?'),
      radio('question0146', 11, 'Medical Expenses (Medical Treatment, Prescriptions, In Home Support or Health Care Services for aged or disabled individuals that are NOT covered by insurance)?'),
      radio('question0147', 12, 'Medicare Coverage Expenses?')] },
  property: { path: 'dynamicQuestions', heading: 'Property Information', phase: 'Property', autocomplete: 'off',
    intro: 'Tell us about any assets and other property you own. Answer for yourself and everyone in your household.',
    next: 'submitAction();return false;', questions: [
      radio('question0555', 0, 'Do you or anyone in the household own, have the use of, or have their name on a checking/savings account, a Certificate of Deposit, money in a credit union, cash or uncashed checks?'),
      radio('question0223', 2, "Do you or anyone in the household own property? Is anyone buying property even if you don't live at that property?"),
      radio('question01007293', 4, 'Does anyone in the household have a conservatorship or trust?'),
      { ...radio('question01007317', 5, 'Has any resource been sold, transferred or given away in the last 90 days?'), values: [' Yes', ' No'] },
      radio('question0226', 6, 'Does anyone own any personal property or equipment?'),
      radio('question0227', 8, 'Does anyone own or have their name on the registration of any motor vehicle, even if not running? (car, truck, boat, camper, motorcycle, or other vehicle)'),
      radio('question01007286', 10, 'Do you or anyone in your household own resources with someone who does not live in your household?')] }
};
function questionHtml(spec) {
  const name = `answerSets[0].answers[${spec.index}].${spec.type === 'checkbox' ? 'answerValues' : 'answerValue'}`;
  const handler = `hideShowQuestions('question0', this, '${spec.rules}')`;
  let contents;
  if (spec.type === 'select') {
    const id = `answerSets0.answers${spec.index}.answerValue`;
    contents = `<div class="question"><label for="${id}">${escape(spec.label)}</label></div><div class="answer"><div class="fullrow"><select id="${id}" name="${name}" class="hasScript" onchange="${escape(handler)}"><option value="">Select One</option>${spec.options.map(option => `<option value="${escape(option)}">${escape(option)}</option>`).join('')}</select></div></div>`;
  } else contents = `<fieldset><legend class="question">${escape(spec.label)}${spec.items ? `<ul>${spec.items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}</legend><div class="answer"><div class="fullrow"><div class="answerInput">${spec.options.map((option, index) => {
    const id = `answerSets0.answers${spec.index}.${spec.type === 'checkbox' ? 'answerValues' : 'answerValue'}${index + 1}`;
    return `<div class="aswSpace"><input id="${id}" name="${name}" type="${spec.type}" class="hasScript" value="${escape(spec.values ? spec.values[index] : option)}" onclick="${escape(handler)}"${spec.type === 'radio' ? ` onchange="${escape(handler)} "` : ''}><label for="${id}">${escape(option)}</label></div>`;
  }).join('')}</div></div></div></fieldset>`;
  return `<div id="${spec.question}" class="${spec.hidden ? 'disabledQuestion hidden ' : '  '}questionAnswer ">${contents}<input type="hidden" name="answerSets[0].answers[${spec.index}].required" value=""><input type="hidden" name="answerSets[0].answers[${spec.index}].constraintGroupId" value=""></div>`;
}
function makeHtml(kind) {
  const data = metadata[kind];
  return `<!doctype html><style>.hidden,.disabledQuestion,.modal{display:none}</style><nav><ul><li class="current"><a title="${data.phase} | Active">${data.phase}</a></li>${data.phase === 'Start Application' ? '<li class="next"><a title="People | Unvisited">People</a></li>' : ''}</ul></nav><div class="htmlHeaderPageTitle"><h2>${data.heading}</h2></div>${data.intro ? `<div class="fullrow floatLeft"><p>${data.intro}</p></div>` : ''}<form id="answerSet" action="simple" method="post"><input name="questionSetId" type="hidden" value="qa-question-set"><input name="answerSets[0].personSelection" type="hidden" value="qa-person"><input name="answerSets[0].name" type="hidden" value="Synthetic Example"><div class="questionGroup interviewQuestion peTaxInfoName"><div class="questionAnswer"><div class="medium"><h3>Synthetic Example</h3></div></div></div><div class="panel-group"><div class="questionGroup interviewQuestion">${data.questions.map(questionHtml).join('')}</div></div><button type="button" ${data.nextId ? `id="${data.nextId}" title="Save and Continue" ` : ''}class="btn btn-primary saveButton" onclick="${escape(data.next)}">Save and Continue</button><input type="hidden" name="OWASP-CSRFTOKEN" value="qa-token"></form><div class="modal" role="dialog">Synthetic closed modal</div>`;
}
function fixtureHtml(kind) {
  const html = makeHtml(kind).replace('action="simple" method="post"', `action="simple" method="post"${metadata[kind].autocomplete ? ' autocomplete="off"' : ''}`);
  if (kind !== 'emergency') return html;
  return html.replace('<nav>', '<div id="stepper-div-id"><nav>').replace('</form>', '</form></div>')
    .replace('class="questionGroup interviewQuestion peTaxInfoName"', 'class="synthetic-name-wrapper"');
}
module.exports = { PORTAL, metadata, makeHtml: fixtureHtml, url: kind => `${PORTAL}/applyForBenefits/${metadata[kind].path}` };
