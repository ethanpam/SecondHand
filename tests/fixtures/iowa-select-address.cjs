'use strict';
// Sanitized metadata transcribed from the live Select Address HOME-only page.
// All displayed addresses and hidden values below are QA data, not a page dump.
// candidateCount > 1 is a generated structural variation, not live-verified.
const URL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/addressValidation';
const NEXT_SELECTOR = 'form#addressValue button.btn.btn-primary.saveAndContinueButton';
function makeHtml({ candidateCount = 1, selected = 'first', error = false, modal = false, mailing = false, renderedCounty = false } = {}) {
  if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 8) throw new Error('Invalid QA candidate count');
  const selectedIndex = selected === 'original' ? candidateCount : selected === 'second' ? 1 : 0;
  const rows = [];
  function choice(index, original) {
    const address = original ? '411 Morrill Road, Ames, IA 50011' : index ? '415 MORRILL RD, AMES, IA 50011' : '411 MORRILL RD, AMES, IA 50011';
    return `<tr><td><fieldset><legend>applyforBenefits.legend.linkText1</legend><input type="radio" id="homeAddressIndex${index}" name="homeAddressIndex" value="${index}" onclick="onHomeAddrSelect('${index}');" ${selectedIndex === index ? 'checked' : ''}><label for="homeAddressIndex${index}"><div>${address}</div></label></fieldset></td></tr>
<tr id="homeAddrCounty${index}" class="displayNone" style="display:${original && renderedCounty ? 'block' : 'none'}">${original ? `<td><label for="homeAddressLst${index}.county">County*</label><select id="homeAddressLst${index}.county" name="homeAddressLst[${index}].county"><option value="">Select One</option><option value="STORY">Story</option></select></td>` : ''}</tr><tr><td></td></tr>`;
  }
  for (let index = 0; index < candidateCount; index++) rows.push(choice(index, false));
  return `<style>.displayNone,.modal { display:none; } .modal.qa-visible { display:block; }</style><h2>Select Address</h2>
<form id="addressValue" action="selectedAddress" method="post">
<input type="hidden" name="hasHome" value="true"><input type="hidden" name="sameAddress" value="true"><input type="hidden" name="qaAddressLine" value="411 MORRILL RD">
<div class="colWrapper topMargin"><div id="alignmentleft" class="formLayout alignmentLeft"><table><tbody><tr><td><table class="fullwidth"><tbody>
<tr><td>Possible matches for your home address:</td></tr>${rows.join('')}
<tr><td>Your Home address as you entered is:</td></tr>${choice(candidateCount, true)}
</tbody></table></td></tr></tbody></table></div></div>
${mailing ? '<div hidden><input type="radio" name="mailingAddressIndex" id="mailingAddressIndex0" value="0"></div>' : ''}
<div id="selectMailingAddrError" class="displayNone">Invalid mailing address</div><div id="selectPhysicalAddrError" class="displayNone">Invalid home address</div>
<div id="errorMsg" class="${error ? '' : 'displayNone'}">QA address error</div><div id="errorMsgHome" class="displayNone"></div><div id="errorMsgMail" class="displayNone"></div>
<div id="infoMsg">Select a possible address match before continuing.</div>
<button type="button" onclick="submitUrlLink('enterPersonalInfo?enterPersonalInfo=true');return false;">Back</button>
<button type="button" class="btn btn-primary saveAndContinueButton" onclick="submitForm();">Save and Continue</button>
<div id="simplemodal" class="modal fade ${modal ? 'qa-visible' : ''}" role="dialog"><button type="button">Close</button><button type="button">Sign &amp; Submit</button><button type="button">Continue With Application</button></div>
</form>`;
}
// Synthetic behavior only. The production adapter clicks verified controls; it
// never evaluates or invokes the live page's JavaScript handler source.
function attachHandlers(doc) {
  doc.__addressQa = { selectionClicks: [], selectedIndexes: [], nextClicks: 0 };
  doc.querySelectorAll('input[name="homeAddressIndex"]').forEach(radio => { radio.onclick = () => {
    doc.__addressQa.selectionClicks.push(radio.value);
    doc.querySelectorAll('input[name="homeAddressIndex"]').forEach(item => {
      doc.getElementById(`homeAddrCounty${item.value}`).style.display = item.checked ? 'block' : 'none';
    });
  }; });
  doc.querySelector('form#addressValue button.saveAndContinueButton').onclick = event => {
    event.preventDefault();
    doc.__addressQa.nextClicks++;
    doc.__addressQa.selectedIndexes.push(Array.from(doc.querySelectorAll('input[name="homeAddressIndex"]:checked'), item => item.value));
  };
}
module.exports = { URL, NEXT_SELECTOR, makeHtml, html: makeHtml(), attachHandlers };
