'use strict';
// Sanitized structure of Iowa's pre-applicant guest screens, recorded read-only
// on 2026-09-26: headings, control ids/names/values, and button handlers only.
// No session material, answers, or page scripts. Handlers are simulated below.
const language = '<form id="languageFormMenu" action="/apspssp/ssp.portal/header/locale" method="post"><input type="hidden" name="language" value="en"></form>';
const back = target => `<button type="button" class="btn btn-light backButton" onclick="submitUrlLink('${target}');return false;">Back</button>`;
const next = handler => `<button type="button" class="btn btn-primary saveButton" onclick="${handler}">Continue</button>`;
const link = target => `submitUrlLink('${target}');return false;`;

const screens = Object.freeze({
  household: {
    path: '/applyForBenefits/guestLogin',
    html: `${language}<main><h1>Household Application Information</h1>
<form id="householdApplicationForm" action="selectHouseholdInfo" method="post">
<p><em>Please tell us more about what the household is applying for.</em></p>
<p>Is anyone in the household applying for Supplemental Nutrition Assistance Program (SNAP), Family Investment Program (FIP) or Refugee Cash Assistance (RCA), or do you want to find out if you or your family can get help paying for health coverage? *</p>
<input type="radio" id="householdApplyProgYes" name="householdApplyProg" value="true" onclick="toggleCaptcha();"><label for="householdApplyProgYes">Yes. At least one person is applying for SNAP, FIP/RCA, or help paying for health coverage.</label>
<input type="radio" id="householdApplyProgNo" name="householdApplyProg" value="false" onclick="toggleCaptcha();"><label for="householdApplyProgNo">No. You will answer fewer questions but you will not get help paying for health coverage.</label>
<div id="captchaDiv" style="display:none"><img id="simpleCaptcha" alt="Security image"><input type="hidden" id="reCaptchaResponse"><label for="captchaAnswer">Enter the characters shown</label><input id="captchaAnswer" name="captchaAnswer"></div>
</form>${back('/apspssp/ssp.portal')}${next('validateMsg();')}</main>`
  },
  beforeYouStart: {
    path: '/applyForBenefits/welcome',
    html: `${language}<main><h1>Before You Start...</h1><p>Have these ready before you start your application.</p>
<button type="button" class="carousel-control right">Next</button><form id="welcomeForm" action="letsGetStarted" method="post"></form>
${back('householdApplicationInfoBack')}${next(link('letsGetStarted'))}</main>`
  },
  letsGetStarted: {
    path: '/applyForBenefits/letsGetStarted',
    html: `${language}<main><h1>Let's get started</h1><form id="welcomeForm" action="forceLogin" method="post">
<input type="checkbox" id="termChkbox" name="termChkbox" onclick="onCheck()"><label for="termChkbox">* I agree to allow my information to be used and retrieved from data sources for this application.</label></form>
${back('welcome')}${next('welcomeSubmit();')}</main>`
  },
  importantInfo: {
    path: '/applyForBenefits/importantInfo',
    html: `${language}<main><h1>Important Information when applying and what to expect.</h1><p>What you need to do.</p>
${back('letsGetStarted')}${next(link('instructions'))}</main>`
  },
  instructions: {
    path: '/applyForBenefits/instructions',
    html: `${language}<main><h1>Instructions</h1><p>You'll see some questions with a star next to them.</p>
<input type="checkbox" checked><p>Check this box next to the item you want to select.</p><input type="radio" checked><p>Check this button next to the item you want to select.</p>
<button type="button" class="btn btn-primary saveAndContinueButton" onclick="">Save and Continue</button><button type="button" class="btn btn-light cancelButton" onclick="">Back</button>
<button type="button" class="btn btn-primary saveAndContinueButton" onclick="">Edit</button><button type="button" class="btn btn-primary saveAndContinueButton" onclick="">Submit Application</button>
<p>OK. Let's start the application.</p>${back('importantInfo')}${next(link('aboutYou'))}</main>`
  }
});

// Mirrors the observed effect of toggleCaptcha(): choosing an answer reveals the CAPTCHA.
function attach(doc) {
  for (const radio of doc.querySelectorAll('input[name="householdApplyProg"]')) {
    radio.onclick = () => { doc.getElementById('captchaDiv').style.display = 'block'; };
  }
}

module.exports = { screens, attach };
