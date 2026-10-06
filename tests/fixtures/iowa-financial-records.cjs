'use strict';
// Sanitized metadata projection observed in a user-authorized fictional guest draft.
// No raw application HTML, hidden values, or person identifiers are retained.
// Wrappers and handlers are synthetic QA scaffolding. Only one person was observed;
// the second fictional option exercises the same rule as an explicit generated variant.
const URL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/dynamicQuestions';
const NEXT_SELECTOR = 'button.saveButton';
const frequency = ['Annually','Every Other Week','Irregular/Infrequent','Monthly','Quarterly','Semi Annually','Twice a Month','Weekly'];
const utility = ['Gas','Electricity / Lights','Water / Sewage','Telephone','Pet Fees','Garage Rent','Extra Charges from your Landlord','Garbage / Trash','Any of the utility bills you have to pay are for heating or cooling/air conditioning?'];
const configs = {
 retirement: { heading:'Income from Other Sources – Retirement, Disability and Death Benefits', phase:'Other Income', intro:'Tell us about retirement money that you or someone in your home has.',
 prefix:':1986,2818,1987,2819,1988,2820,2822,2823,2824,2826,1995,2827,1996,2828,1997,1998,1999,2000,2001,2002,2003,2004,2005,2006,2007,2008,2009,2010,2011,2012,2013,2014,2015,2806,2807,1977,2809,1978,2810,1979:1984,2816,1985,2817,1989,2821,1990,1991,1992,1993,2825,1994,2829,2805,2808,2811,1980,2812,1981,2813,1982,2814,1983,2815',
 rule:':1977,1978,1979,2806,2807,1986,1987,1988,2809,2810,1995,1996,1997,1998,1999,2000,2001,2002,2003,2004,2005,2006,2007,2008,2009,2010,2011,2012,2013,2014,2015,2818,2819,2820,2822,2823,2824,2826,2827,2828:2805,1980,1981,1982,1983,1984,1985,2808,1989,1990,1991,1992,1993,1994,2811,2812,2813,2814,2815,2816,2817,2821,2825,2829',
 types:[['1977','Social Security'],['1986','Railroad Retirement'],['1995','Private Pension'],['1998','Deferred Comp'],['2001','Government Employee'],['2004','Retirement - Military'],['2007','401K'],['2010','Individual Retirement Account (IRA)'],['2013','Annuity'],['2818','Veteran Aid and Attendance'],['2822','Veteran Disability - Partial'],['2826','Veteran Disability - Total']],
 branches:[['1977','Social Security','question01977','question01978',1,'How much Social Security?*','question01979',2,'How often?*'],['1995','Private Pension','question01995','question01996',25,'How much Private Pension?*','question01997',26,'How often?*']] },
 rent:{heading:'Housing Expenses',phase:'Expenses',intro:'You told us that there are people in your home that pay for housing costs. Tell us more about these people by filling in the information for all fields for at least one type.',
 prefix:':3008,3009,3011,3012,3013,1007289,3126,2999,1007288,3127,3000,1007287,3128,3001,3003,3004,3005,3007:3010,1007290,3014,3129,3002,3006',
 rule:':2999,3000,3001,1007287,1007288,1007289,3126,3127,3128,3003,3004,3005,3007,3008,3009,3011,3012,3013:3002,1007290,3129,3006,3010,3014',
 types:[['2999','Rent(Amount you are responsible to pay)'],['1007287','Lot Rent(Amount you are responsible to pay)'],['3126','Mortgage(Amount you are responsible to pay)'],['3003','Insurance (Home)(if you pay separate from your mortgage)'],['3007',"Home-Owner's Association Fees"],['3011','Property Taxes(if you pay separate from your mortgage)']],
 branches:[['2999','Rent(Amount you are responsible to pay)','question02999','question03000',1,'How much?*','question03001',2,'How often*']]},
 utilities:{heading:'Utility Expenses',phase:'Expenses',intro:'You told us that there are people in your home that pay for utility costs. Tell us more about these people by selecting all the utilities they pay for.',prefix:':1007291:',rule:':1007291:'},
 assets:{heading:'Other Property - Liquid Assets',phase:'Property',intro:'Tell us about the liquid assets, such as money in bank accounts or stocks/bonds you or someone in your home have.',prefix:':7040,580,581,582,583,3113,3114,3115,3116,3117,4462,1007294,3125:3118',rule:':580,581,582,583,3125,4462,3113,3114,3115,3116,3117,1007294,7040:3118',types:['Annuity Accounts','Assistive Technology Accounts','Cash/Uncashed Check','Certificate of Deposit','Checking Account','Income Tax Refund','Life Estate','Life Insurance','Money Market','Mutual Funds','Other Liquid Assets','Promissory Notes','Retirement Plans','Savings/Credit Union Account','Stocks/Bonds','Tribal Gaming Disbursements','Trust','Winnings']}
};
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const id=i=>`answerSets0.answers${i}.answerValue`, name=i=>`answerSets[0].answers[${i}].answerValue`;
const hide="hideShowQuestions('question0', this, '')";
function text(q,i,label,date=false){return `<div class="questionAnswer" id="${q}"><label for="${id(i)}">${esc(label)}</label><input id="${id(i)}" name="${name(i)}" type="text" ${date?'class="date-format-class hasDatepicker" title="mm/dd/yyyy"':'autocomplete="off"'}></div>`;}
function select(q,i,label,options){return `<div class="questionAnswer" id="${q}"><label for="${id(i)}">${esc(label)}</label><select id="${id(i)}" name="${name(i)}" class="hasScript" onchange="${esc(hide)}"><option value="">Select One</option>${options.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select></div>`;}
function makeHtml(kind='retirement',{people=['Avery Example','Jordan Sample']}={}){
 const p=configs[kind]; if(!p)throw Error('Unknown synthetic fixture');
 const handler=`enableDisableQuestions('question0', this, '${p.prefix}${people.map((_,i)=>`|${i}${p.rule}`).join('')}')`;
 let fields='';
 if(p.branches) fields=`<div class="questionAnswer" id="qa-type"><label for="questionType">Select a type*</label><select id="questionType" name="questionType" class="hasScript"><option value="">Select One</option>${p.types.map(([v,t])=>`<option value="${v}">${esc(t)}</option>`).join('')}</select></div>`+p.branches.map(([v,t,q,aq,ai,al,fq,fi,fl])=>`<div id="section${v}" data-qa-branch="${v}" role="tabpanel" aria-labelledby="headingsection${v}" class="${v} panel-collapse collapse in show"><div id="${q}" class="questionAnswer hiddenLabel">${esc(t)}</div>${text(aq,ai,al)}${select(fq,fi,fl,frequency)}</div>`).join('');
 if(kind==='utilities') fields=`<div class="questionAnswer" id="question01007291"><fieldset><legend>Utility Type:</legend>${utility.map((v,i)=>`<input type="checkbox" class="hasScript" id="answerSets0.answers0.answerValues${i+1}" name="answerSets[0].answers[0].answerValues" value="${esc(v)}" onclick="${esc(hide)}"><label for="answerSets0.answers0.answerValues${i+1}">${esc(v)}</label><input type="hidden" name="_answerSets[0].answers[0].answerValues">`).join('')}</fieldset></div>`;
 if(kind==='assets') fields=select('question0580',0,'Type*',p.types)+text('question0581',1,'Current Value*')+text('question0582',2,'Amount Owed (if any)')+text('question0583',3,'Account/Policy #')+text('question03125',4,'Name of Bank (if any):')+text('question01007294',12,'When did this person get the asset (mm/dd/yyyy)?',true);
 return `<!doctype html><html><head><meta charset="utf-8"><title>Isolated financial record QA</title><style>[hidden]{display:none!important}body{font-family:system-ui}.questionAnswer{margin:12px}</style></head><body data-qa-kind="${kind}"><ul><li class="current"><a title="${p.phase} | Active">${p.phase}</a></li></ul><h2>${p.heading}</h2><p>${p.intro}</p><form id="answerSet" action="simple" method="post" autocomplete="off"><div class="questionAnswer" id="qa-person"><label for="answerSets0.personSelection">Select a person*</label><select id="answerSets0.personSelection" name="answerSets[0].personSelection" class="hasScript" onchange="${esc(handler)}"><option value="">Select One</option>${people.map((v,i)=>`<option value="${i}">${esc(v)}</option>`).join('')}</select></div>${fields}<input type="hidden" name="questionSetId"><button type="button" class="btn btn-primary saveButton" onclick="submitAction();return false;">Save and Continue</button></form></body></html>`;
}
function attachHandlers(doc){
 doc.__recordQa={nextClicks:0};const owner=doc.getElementById('answerSets0.personSelection'),type=doc.getElementById('questionType');
 const sync=()=>{for(const q of doc.querySelectorAll('#answerSet > .questionAnswer')){if(q.id==='qa-person')continue;q.hidden=!owner.value || q.id==='qa-type'&&Boolean(type.value);for(const el of q.querySelectorAll('input,select'))el.disabled=!owner.value;}for(const panel of doc.querySelectorAll('[data-qa-branch]')){panel.hidden=!owner.value||panel.dataset.qaBranch!==type.value;for(const el of panel.querySelectorAll('input,select'))el.disabled=panel.hidden;}};
 owner.onchange=sync;if(type)type.onchange=sync;
 for(const el of doc.querySelectorAll('select[id^="answerSets0.answers"]'))el.onchange=()=>{};
 for(const el of doc.querySelectorAll('input[type="checkbox"]'))el.onclick=()=>{};
 doc.querySelector('button.saveButton').onclick=()=>{doc.__recordQa.nextClicks++;return false;};doc.querySelector('form').addEventListener('submit',event=>event.preventDefault());sync();
}
module.exports={URL,NEXT_SELECTOR,makeHtml,attachHandlers};
