'use strict';
// Sanitized projection of the observed Start Application / Tell Us More page.
// Only verified DOB metadata is reproduced as an editable control. Other
// question groups are static placeholders: their answers/options are not mapped.
// Hidden alternatives use synthetic display:none to model the observed state.
// This is not a full 98-template capture or proof of later household-member forms.
const URL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/dynamicQuestions';
const DOB_ID = 'answerSets0.answers3.answerValue';
const html = `<nav><ul><li class="current"><a title="Start Application | Active">Start Application</a></li><li class="next"><a title="People | Unvisited">People</a></li></ul></nav>
<h2>Tell Us More</h2><div class="fullrow floatLeft"><p>Please give us additional information about yourself. If you cannot answer a question you can skip it. QA placeholder for the observed Social Security explanation and required-field note.</p></div>
<form id="answerSet" action="simple" method="post"><div class="panel-group">
<div class="questionGroup interviewQuestion peTaxInfoName"><div class="medium"><h3>Avery Jordan Example</h3></div></div>
<div class="questionGroup interviewQuestion">
<div id="question02419" class="questionAnswer"><label for="${DOB_ID}">Date of Birth (mm/dd/yyyy)</label><div class="answer"><div class="fullrow flex"><input id="${DOB_ID}" name="answerSets[0].answers[3].answerValue" type="text" class="date-format-class hasDatepicker" title="mm/dd/yyyy"><button type="button" title="QA calendar placeholder">Calendar</button></div></div></div>
<div class="disabledQuestion" style="display:none"><div id="question07982" class="questionAnswer"><label for="answerSets0.answers4.answerValue">Date of Birth (mm/dd/yyyy)*</label><input id="answerSets0.answers4.answerValue" name="answerSets[0].answers[4].answerValue" type="text"></div></div>
<div class="disabledQuestion" style="display:none"><div id="question02" class="questionAnswer"><label for="answerSets0.answers5.answerValue">Date of Birth (mm/dd/yyyy)*</label><input id="answerSets0.answers5.answerValue" name="answerSets[0].answers[5].answerValue" type="text"></div></div>
${['01', '02420', '06179', '04', '01007331', '02422', '07', '0565'].map(id => `<div id="question${id}" class="questionAnswer"><p>QA manual-question placeholder</p></div>`).join('')}
</div></div>
<button id="dqButtonId309" type="button" class="btn btn-primary saveButton" onclick="dynamicQuestionsButton('WARNING!', '', 'Ok', 'Cancel', 'answerSet', 'simple?buttonId=309', 'true', 'dqButtonId309');">Save and Continue</button></form>`;
module.exports = { URL, DOB_ID, html };
