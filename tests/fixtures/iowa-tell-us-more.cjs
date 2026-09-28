'use strict';
// Trimmed from a sanitized capture of Iowa's Start Application / Tell Us More page at
// dynamicQuestionsStart: values, selections, scripts and query strings were removed and the
// applicant's name is fictional. iowa-tell-us-more.html keeps the step navigation, the title, the
// "yourself" introduction, the whole answer form with every question (hidden and disabled ones
// too, with their real ids, names, classes, labels, options and handlers) and one closed pop-up.
// The portal's head, scripts, header, footer, other pop-ups, calendar images, comments and
// whitespace were dropped. Its first <style> rule is synthetic: it stands in for Iowa's
// stylesheets, which hide disabled and hidden questions and closed pop-ups.
const fs = require('node:fs');
const path = require('node:path');

const URL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/dynamicQuestionsStart';
const html = fs.readFileSync(path.join(__dirname, 'iowa-tell-us-more.html'), 'utf8');
const DOB_ID = 'answerSets0.answers5.answerValue';
// A Yes/No (or Male/Female) radio's id: option 1 is Yes (Male), option 2 is No (Female).
const radioId = (answer, option) => `answerSets0.answers${answer}.answerValue${option}`;
// The visible questions and the answer index Iowa numbers each one's controls with.
const ANSWERS = Object.freeze({ gender: 1, hasSsn: 6, usCitizen: 18, maritalStatus: 22, militaryOrVeteran: 24, hasDisability: 26, blind: 27, healthLimits: 28, hasMedicare: 29 });
const MARITAL_ID = 'answerSets0.answers22.answerValue';
const SSN_BOX_ID = 'answerSets0.answers8.answerValue';

module.exports = { URL, html, DOB_ID, radioId, ANSWERS, MARITAL_ID, SSN_BOX_ID };
