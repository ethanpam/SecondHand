'use strict';
// Sanitized metadata reconstructed from the blank Iowa applicant DOM observed
// 2026-09-26. This fixture contains no session material or real applicant data.
// Handlers simulate only observed show/hide/reset effects; never send a request.
const states = '<option value="">Select One</option><option value="IA">Iowa</option><option value="MN">Minnesota</option>';
const text = (id, label, extra = '') => `<label for="${id}">${label}</label><input id="${id}" name="${id}" ${extra}>`;
const radio = (name, first, second, question, handler = '') => `<fieldset><legend>${question}</legend><label for="${first}">Yes</label><input type="radio" id="${first}" name="${name}" value="true" ${handler ? `onclick="${handler}('Yes');"` : ''}><label for="${second}">No</label><input type="radio" id="${second}" name="${name}" value="false" ${handler ? `onclick="${handler}('No');"` : ''}></fieldset>`;
const html = `<h1>Enter Personal Information</h1><form id="personalInformation" action="enterPersonalInfo" method="post">
<h3>Applicant's Information</h3>
${text('firstName', 'First Name*')}${text('middleName', 'Middle Name')}${text('lastName', 'Last Name*')}
<label for="suffix">Suffix</label><select id="suffix" name="suffix"><option value="">Select One</option>${['I','II','III','IV','V','VI','VII','VIII','IX','X','Jr.','Sr.'].map(value => `<option value="${value}">${value}</option>`).join('')}</select>${text('maidenName', 'Maiden Name')}
<h3>Contact Information</h3>${text('phoneNumber', 'Home Phone Number (999)999-9999')}${text('otherPhoneNumber', 'Mobile Phone Number (999)999-9999')}
<h3>Address Information</h3>${radio('hasHome','hasHome1','hasHome2','Do you have a home address?*','hideShowHome')}
<div id="homeAddrDiv" style="display:none">${text('addressLine1','Home Address Line 1*')}${text('addressLine2','Home Address Line 2')}${text('city','City*')}<label for="state">State*</label><select id="state" name="state">${states}</select>${text('zipcode','Zip Code (99999)*')}
${radio('sameAddress','sameAddress1','sameAddress2','Is your mailing address the same as your home address?*','sameAddressCheck')}</div>
<div id="sameAdd" style="display:none">${text('mailingAddressLine1','Mailing Address Line 1*')}${text('mailingAddressLine2','Mailing Address Line 2')}${text('mailingCity','Mailing City*')}<label for="mailingState">Mailing State*</label><select id="mailingState" name="mailingState">${states}</select>${text('mailingZipcode','Mailing Zip Code (99999)*')}</div>
<h3>Program Information</h3>${radio('applicant','applicant1','applicant2','Are you applying for benefits?*','checkForApplicant')}
<div id="progSelection" style="display:none"><fieldset><legend>What benefits are you applying for?*</legend>
<label for="medicaid">Health Coverage (Medicaid or Children's Health Insurance Program - CHIP)</label><input id="medicaid" name="programs" type="checkbox" value="MC" onclick="showHideFA()">
<div id="faDiv" style="display:none">${radio('helpPayMedBill','helpPayMedBill1','helpPayMedBill2','Do you need help paying for medical bills from the last three calendar months? If you answer yes and you fall into a category that allows for retroactive approval, we will determine if you are eligible for coverage during those months.')}</div>
<label for="snap">Supplemental Nutritional Assistance Program(SNAP)</label><input id="snap" name="programs" type="checkbox" value="FS" onclick="showHideBestTimetoCall()">
<label for="tanf">Family Investment Program (FIP) or Refugee Cash Assistance (RCA)</label><input id="tanf" name="programs" type="checkbox" value="CW" onclick="showHideBestTimetoCall()">
<div id="bstTime" style="display:none"><label for="bestTime">Best Time to Call? (30 character limit)</label><input id="bestTime" name="bestTimeToCall" maxlength="30"></div>
</fieldset></div>
<button type="button" class="btn btn-light backButton" onclick="submitUrlLink('enterPersonalInfoBack');return false;">Back</button>
<button type="button" class="btn btn-primary saveAndContinueButton" onclick="submitAction('#personalInformation');">Save and Continue</button></form>`;

function attachConditionalHandlers(doc) {
  const byId = id => doc.getElementById(id);
  const show = (id, visible) => { byId(id).style.display = visible ? 'block' : 'none'; };
  const clear = id => byId(id).querySelectorAll('input,select').forEach(element => {
    if (['radio', 'checkbox'].includes(element.type)) element.checked = false;
    else element.value = '';
  });
  byId('hasHome1').onclick = () => { show('homeAddrDiv', true); show('sameAdd', false); byId('sameAddress1').checked = false; byId('sameAddress2').checked = false; };
  byId('hasHome2').onclick = () => { show('homeAddrDiv', false); show('sameAdd', true); clear('homeAddrDiv'); byId('sameAddress1').value = 'false'; byId('sameAddress2').value = 'false'; };
  byId('sameAddress1').onclick = () => { show('sameAdd', false); clear('sameAdd'); };
  byId('sameAddress2').onclick = () => show('sameAdd', true);
  byId('applicant1').onclick = () => show('progSelection', true);
  byId('applicant2').onclick = () => { show('progSelection', false); clear('progSelection'); show('faDiv', false); show('bstTime', false); };
  byId('medicaid').onclick = () => { show('faDiv', byId('medicaid').checked); if (!byId('medicaid').checked) clear('faDiv'); };
  const bestTime = () => { const visible = byId('snap').checked || byId('tanf').checked; show('bstTime', visible); if (!visible) clear('bstTime'); };
  byId('snap').onclick = bestTime; byId('tanf').onclick = bestTime;
  // No form submission or Iowa network activity is possible from these controls.
  doc.querySelectorAll('#personalInformation button').forEach(button => { button.onclick = event => event.preventDefault(); });
  doc.querySelector('#personalInformation').addEventListener('submit', event => event.preventDefault());
}
module.exports = { html, attachConditionalHandlers };
