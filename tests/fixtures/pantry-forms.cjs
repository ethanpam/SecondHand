'use strict';
// Sanitized, fictional food-assistance intake forms in three common builder styles.
// Structure only: no real organization, session material, or applicant data.

const plainPantry = `<main><h1>Food pantry sign-up</h1><form id="intake">
<label for="fname">First Name *</label><input id="fname" name="fname">
<label for="lname">Last Name *</label><input id="lname" name="lname">
<label for="dob">Date of Birth</label><input id="dob" name="dob" type="date">
<label for="addr">Street Address</label><input id="addr" name="address">
<label for="city">City</label><input id="city" name="city">
<label for="st">State</label><select id="st" name="state"><option value="">Choose one</option><option value="IA">Iowa</option><option value="MN">Minnesota</option></select>
<label for="zip">ZIP Code</label><input id="zip" name="zip">
<label for="phone">Phone Number</label><input id="phone" name="phone" type="tel">
<label for="email">Email</label><input id="email" name="email" type="email">
<label for="hh">How many people live in your household?</label><input id="hh" name="hh" type="number">
<label for="adults">Number of adults</label><input id="adults" name="adults" type="number">
<label for="kids">Number of children</label><input id="kids" name="kids" type="number">
<label for="seniors">Number of seniors (65+)</label><input id="seniors" name="seniors" type="number">
<fieldset><legend>Is anyone in your household a veteran?</legend><label><input type="radio" name="vet" value="y"> Yes</label><label><input type="radio" name="vet" value="n"> No</label></fieldset>
<label for="income">Total monthly household income</label><input id="income" name="income">
<label for="pw">Create a password</label><input id="pw" name="pw" type="password">
<label for="card">Card number</label><input id="card" name="card" autocomplete="cc-number">
<label for="notes">Anything else we should know?</label><textarea id="notes" name="notes"></textarea>
<button type="submit">Submit</button></form></main>`;

const googleStyle = `<form><div role="list">
<div role="listitem"><div id="q1" role="heading">Full name</div><input type="text" aria-labelledby="q1"></div>
<div role="listitem"><div id="q2" role="heading">Email address</div><input type="email" aria-labelledby="q2"></div>
<div role="listitem"><div id="q3" role="heading">What is your zip code?</div><input type="text" aria-labelledby="q3"></div>
<div role="listitem"><div id="q4" role="heading">Household size</div><div role="radiogroup" aria-labelledby="q4"><div role="radio" aria-label="1" tabindex="0"></div><div role="radio" aria-label="2" tabindex="0"></div></div></div>
</div><div role="button">Submit</div></form>`;

const jotformStyle = `<form class="jotform-form"><ul>
<li class="form-line"><label class="form-label" id="label_3" for="first_3">Name</label><div class="form-input">
<span><input id="first_3" name="q3_name[first]" autocomplete="given-name"><label for="first_3" class="form-sub-label">First Name</label></span>
<span><input id="last_3" name="q3_name[last]" autocomplete="family-name"><label for="last_3" class="form-sub-label">Last Name</label></span></div></li>
<li class="form-line"><label class="form-label" for="input_4">State</label><select id="input_4" name="q4_state"><option value=""> </option><option value="Iowa">Iowa</option><option value="Minnesota">Minnesota</option></select></li>
<li class="form-line"><label class="form-label" for="input_5">Monthly rent</label><input id="input_5" name="q5_rent"></li>
<li class="form-line"><label class="form-label" for="input_6">Tell us about your situation</label><textarea id="input_6" name="q6_situation"></textarea></li>
</ul></form>`;

// Google Form whose author numbered the questions and ran words together.
const numberedGoogle = `<form><div role="list">
<div role="listitem"><div id="n3" role="heading"><span>3.Email Address:</span><span aria-label="Required question"> *</span></div><input id="email" type="text" aria-labelledby="n3" required></div>
<div role="listitem"><div id="n4" role="heading"><span>4.PhoneNumber:</span></div><input id="phone" type="text" aria-labelledby="n4"></div>
<div role="listitem"><div id="n5" role="heading">5) ZipCode</div><input id="zip" type="text" aria-labelledby="n5"></div>
<div role="listitem"><div id="n7" role="heading">7.DoB</div><input id="dob" type="text" aria-labelledby="n7"></div>
<div role="listitem"><div id="nb" role="heading">b. City</div><input id="city" type="text" aria-labelledby="nb"></div>
<div role="listitem"><div id="n6" role="heading">6. U.S. citizen?</div><input id="citizen" type="text" aria-labelledby="n6"></div>
</div></form>`;

// Google Form date and time questions: each input is labelled by its own sub-label, not the question.
const googleDates = `<form><div role="list">
<div role="listitem"><div id="d5" role="heading"><span>5.Date ordered:</span><span aria-label="Required question"> *</span></div><div><div id="d5s">Date</div><input id="ordered" type="date" aria-labelledby="d5s" required></div></div>
<div role="listitem"><div id="d6" role="heading">Date of birth</div><div><div id="d6s">Date</div><input id="dob" type="date" aria-labelledby="d6s"></div></div>
<div role="listitem"><div id="t7" role="heading">Pickup time</div><div><div id="t7h">Hour</div><input id="hour" aria-labelledby="t7h"><div id="t7m">Minute</div><input id="minute" aria-labelledby="t7m"></div></div>
<div role="listitem"><div id="b8" role="heading">Birthday</div><div><span id="b8m">Month</span><input id="month" aria-labelledby="b8m"><span id="b8d">Day</span><input id="day" aria-labelledby="b8d"><span id="b8y">Year</span><input id="year" aria-labelledby="b8y"></div></div>
</div></form>`;

// Google Form choice questions: div[role=radio] / div[role=checkbox] / div[role=listbox], not native controls.
const radio = value => `<label><div role="radio" data-value="${value}" aria-label="${value}" aria-checked="false" tabindex="0"></div><span>${value}</span></label>`;
const checked = value => `<label><div role="radio" data-value="${value}" aria-label="${value}" aria-checked="true" tabindex="0"></div><span>${value}</span></label>`;
const required = '<span aria-label="Required question"> *</span>';
const googleChoices = `<form><div role="list">
<div role="listitem"><div id="c1" role="heading"><span>Number of Family / Household Members</span>${required}</div>
<div role="radiogroup" aria-labelledby="c1">${['One (Myself)', 'Two', 'Three', 'Four', 'Five or more'].map(radio).join('')}</div><input type="hidden" name="entry.101" value=""></div>
<div role="listitem"><div id="c2" role="heading">Is anyone in your household a veteran?</div>
<div role="radiogroup" aria-labelledby="c2">${radio('Yes')}${radio('No')}</div><input type="hidden" name="entry.102" value=""></div>
<div role="listitem"><div id="c3" role="heading"><span>Which pantry location?</span>${required}</div>
<div role="radiogroup" aria-labelledby="c3">${radio('North')}${radio('South')}</div></div>
<div role="listitem"><div id="c4" role="heading">Does anyone in your household have a disability?</div>
<div role="radiogroup" aria-labelledby="c4">${checked('Yes')}${radio('No')}</div></div>
<div role="listitem"><div id="c5" role="heading"><span>Which items do you need?</span>${required}</div>
<div role="list"><div role="listitem"><div role="checkbox" aria-label="Produce" data-answer-value="Produce" aria-checked="false" tabindex="0"></div></div>
<div role="listitem"><div role="checkbox" aria-label="Dairy" data-answer-value="Dairy" aria-checked="false" tabindex="0"></div></div></div></div>
<div role="listitem"><div id="c6" role="heading"><span>County</span>${required}</div>
<div role="listbox" aria-labelledby="c6" tabindex="0"><div role="option" data-value="" aria-selected="true">Choose</div><div role="option" data-value="Polk" aria-selected="false">Polk</div><div role="option" data-value="Story" aria-selected="false">Story</div></div></div>
</div><div role="button">Submit</div></form>`;

// Iowa HHS "Financial Information" eligibility page, reconstructed from its question wording:
// native count selects ("1" … "8 or More") and native Yes/No radios. No real answers.
const iowaCount = (id, question, from) => `<label for="${id}">${question}*</label><select id="${id}" name="${id}"><option value="">Select One</option>${
  Array.from({ length: 8 - from }, (_, index) => `<option value="${index + from}">${index + from}</option>`).join('')}<option value="8">8 or More</option></select>`;
const iowaYesNo = (name, question) => `<fieldset><legend>${question}*</legend><input type="radio" id="${name}Yes" name="${name}" value="true"><label for="${name}Yes">Yes</label>` +
  `<input type="radio" id="${name}No" name="${name}" value="false"><label for="${name}No">No</label></fieldset>`;
const iowaMoney = (id, question) => `<label for="${id}">${question}*</label><input id="${id}" name="${id}" type="text">`;
const iowaFinancial = `<main><h1>Financial Information</h1><form id="financialInformation" action="financialInfo" method="post">
${iowaCount('adults', 'How many adults are in your household?', 1)}
${iowaYesNo('senior', 'Is anyone age 65 or older?')}
${iowaCount('children', 'How many children are in your household?', 0)}
${iowaYesNo('resident', 'Is at least one member a resident of Iowa?')}
${iowaMoney('income', 'How much total money (before taxes) did all of the people in your household get last month? Include money from jobs, benefits, and any other source.')}
${iowaMoney('onHand', 'How much does the household have on hand? This includes cash and money in checking and savings accounts.')}
${iowaMoney('medical', 'How much does the household pay for medical expenses monthly?')}
${iowaYesNo('citizens', 'Are all the household members United States citizens?')}
${iowaYesNo('legal', 'If not, do they have legal documents to stay in the US?')}
${iowaYesNo('disability', 'Does anyone have a disability?')}
${iowaYesNo('pregnant', 'Is anyone pregnant?')}
${iowaYesNo('medicare', 'Is anyone in the household enrolled in Medicare?')}
${iowaYesNo('healthHelp', 'Do you want to find out if you or your family can get help paying for health insurance?')}
<button type="button" class="btn btn-primary saveButton">Continue</button></form></main>`;

module.exports = { plainPantry, googleStyle, jotformStyle, numberedGoogle, googleDates, googleChoices, iowaFinancial };
