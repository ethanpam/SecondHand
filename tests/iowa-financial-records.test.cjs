'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-record-adapter.js'), main = require('../extension/iowa-adapter.js'), fixture = require('./fixtures/iowa-financial-records.cjs');
const URL = fixture.URL;
const fixtures = {
 retirement: { person:'Jordan Sample',type:'Private Pension',amount:'345.67',frequency:'Monthly' },
 rent: { person:'Avery Example',type:'Rent',amount:'560',frequency:'Monthly' },
 utilities: { person:'Jordan Sample',gas:'yes',electricity:'yes',waterSewage:'no',telephone:'yes',petFees:'no',garageRent:'no',landlordExtra:'no',garbage:'no',heatingCooling:'yes' },
 assets: { person:'Avery Example',type:'Cash/Uncashed Check',currentValue:'90',amountOwed:'0',accountOrPolicy:'',institution:'',acquiredDate:'2026-01-03' }
};
function page(kind, options){const doc=new JSDOM(fixture.makeHtml(kind,options),{url:URL,pretendToBeVisual:true}).window.document;const E=doc.defaultView.Element;E.prototype.getBoundingClientRect=()=>({left:10,top:10,right:210,bottom:40,width:200,height:30});E.prototype.getClientRects=function(){return[this.getBoundingClientRect()];};E.prototype.scrollIntoView=()=>{};fixture.attachHandlers(doc);return doc;}
function fill(doc,values,api=adapter){return api.fill(doc,URL,api.scan(doc,URL).bindings,values);}
function complete(doc,values,api=adapter){for(let i=0;i<5;i++){const result=fill(doc,values,api);assert.notEqual(result.unsafe,true,JSON.stringify(result));}return api.probePage(doc,URL);}
const controls=doc=>[...doc.querySelectorAll('input,select')].map(el=>[el.id,el.value,el.checked]);
for(const kind of Object.keys(fixtures)){
 test(`${kind}: one explicit record fills its owner and only observed controls, with private metadata and one-use Next`,()=>{
  const doc=page(kind), initial=main.scan(doc,URL);assert.equal(initial.recognizedPage,true);assert.deepEqual(initial.fields.map(f=>f.key),['person']);
  const info=complete(doc,fixtures[kind],main);assert.equal(info.canAdvance,true,JSON.stringify(info));
  assert.doesNotMatch(JSON.stringify(info),/Avery|Jordan|345\.67|560|answerSets/);
  const token=main.captureNavigation(doc,URL);assert.ok(token);assert.equal(main.advance(doc,URL,token).advanced,true);assert.equal(main.advance(doc,URL,token).advanced,false);assert.equal(doc.__recordQa.nextClicks,1);
 });
 test(`${kind}: an unknown owner, duplicate owner, stale hidden payload, and conflicting selected owner are rejected`,()=>{
  const bad=page(kind), snapshot=controls(bad);assert.equal(fill(bad,{...fixtures[kind],person:'Unknown'}).unsafe,true);assert.deepEqual(controls(bad),snapshot);
  const duplicate=page(kind,{people:['Avery Example','avery  example']});assert.equal(fill(duplicate,{...fixtures[kind],person:'Avery Example'}).unsafe,true);
  const stale=page(kind), bindings=adapter.scan(stale,URL).bindings;stale.querySelector('input[type="hidden"]').value='changed';assert.equal(adapter.fill(stale,URL,bindings,fixtures[kind]).unsafe,true);
  const selected=page(kind), owner=selected.getElementById('answerSets0.personSelection');owner.value=fixtures[kind].person==='Avery Example'?'1':'0';owner.dispatchEvent(new selected.defaultView.Event('change'));assert.equal(fill(selected,fixtures[kind]).unsafe,true);
 });
 test(`${kind}: unknown question, error, visible modal, and altered Next all prevent navigation`,()=>{
  for(const mutate of [doc=>{const el=doc.createElement('input');doc.querySelector('form').append(el);},doc=>{const el=doc.createElement('div');el.className='questionAnswer';el.textContent='New question';doc.querySelector('form').append(el);},doc=>{const el=doc.createElement('div');el.setAttribute('role','alert');el.textContent='Required';doc.body.append(el);},doc=>{const el=doc.createElement('div');el.setAttribute('role','dialog');doc.body.append(el);},doc=>doc.querySelector('button.saveButton').setAttribute('onclick','submitApplication();')]){
   const doc=page(kind);complete(doc,fixtures[kind]);const token=adapter.captureNavigation(doc,URL);mutate(doc);assert.equal(adapter.probePage(doc,URL).canAdvance,false);assert.equal(adapter.advance(doc,URL,token).advanced,false);assert.equal(doc.__recordQa.nextClicks,0);
  }
 });
}
for(const kind of ['retirement','rent'])test(`${kind}: a hidden type picker may reset to blank; exact rendered branch still binds type`,()=>{
 const doc=page(kind);fill(doc,fixtures[kind]);fill(doc,fixtures[kind]);const picker=doc.getElementById('questionType');assert.ok(picker.value);picker.value='';
 const result=complete(doc,fixtures[kind]);assert.equal(result.canAdvance,true,JSON.stringify(result));
});
test('both actually observed retirement types are supported without converting annual amounts',()=>{
 const doc=page('retirement');const info=complete(doc,{...fixtures.retirement,type:'Social Security',amount:'720',frequency:'Weekly'});assert.equal(info.canAdvance,true);assert.equal(doc.getElementById('answerSets0.answers1.answerValue').value,'720');assert.equal(doc.getElementById('answerSets0.answers2.answerValue').value,'Weekly');
 for(const type of ['Railroad Retirement','401K','Unknown']){const no=page('retirement');const before=controls(no);assert.equal(fill(no,{...fixtures.retirement,type}).unsafe,true);assert.deepEqual(controls(no),before);}
});
test('rent uses explicit responsibility amount only; unsupported frequency/type or a conflicting value cannot be inferred or overwritten',()=>{
 const doc=page('rent');complete(doc,fixtures.rent);const amount=doc.getElementById('answerSets0.answers1.answerValue');amount.value='999';const before=controls(doc);assert.equal(fill(doc,fixtures.rent).unsafe,true);assert.deepEqual(controls(doc),before);assert.equal(adapter.probePage(doc,URL).canAdvance,false);
 const unsupported=page('rent');fill(unsupported,fixtures.rent);fill(unsupported,fixtures.rent);fill(unsupported,{...fixtures.rent,frequency:'Hourly'});assert.equal(adapter.probePage(unsupported,URL).canAdvance,false);
 assert.equal(fill(page('rent'),{...fixtures.rent,type:'Mortgage'}).unsafe,true);
});
test('utility unchecked boxes need explicit No; existing matching Yes is proved without a second click',()=>{
 const doc=page('utilities');fill(doc,fixtures.utilities);const input=doc.getElementById('answerSets0.answers0.answerValues1');input.checked=true;let clicks=0;input.addEventListener('click',()=>clicks++);const info=complete(doc,fixtures.utilities);assert.equal(info.canAdvance,true);assert.equal(clicks,0);
 const missing=page('utilities');complete(missing,{...fixtures.utilities,gas:''});assert.equal(adapter.probePage(missing,URL).canAdvance,false);
 const before=controls(doc);assert.equal(fill(doc,{...fixtures.utilities,gas:'no'}).unsafe,true);assert.deepEqual(controls(doc),before);
});
test('cash assets permit observed optional blanks, preserve exact current value, and reject unobserved types',()=>{
 const doc=page('assets');const info=complete(doc,{person:'Avery Example',type:'Cash/Uncashed Check',currentValue:'10'});assert.equal(info.canAdvance,true,JSON.stringify(info));assert.equal(info.checklist.find(row=>row.key==='amountOwed').status,'optional');assert.equal(doc.getElementById('answerSets0.answers1.answerValue').value,'10');
 assert.equal(fill(page('assets'),{...fixtures.assets,type:'Checking Account'}).unsafe,true);
});
test('simultaneous retirement panels and nonblank conflicting picker fail closed',()=>{
 for(const mutate of [doc=>{const second=doc.getElementById('section1977');second.hidden=false;second.querySelectorAll('input,select').forEach(el=>{el.disabled=false;});},doc=>{doc.getElementById('questionType').value='1977';}]){const doc=page('retirement');complete(doc,fixtures.retirement);mutate(doc);assert.equal(adapter.scan(doc,URL).recognizedPage,false);assert.equal(adapter.probePage(doc,URL).canAdvance,false);}
});
