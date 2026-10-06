"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../SafariExtension/Resources/application-assistant.js');
const {createWorkflow} = require('../SafariExtension/Resources/background.js');
const ORIGIN = 'https://forms.example.test';
const URL = ORIGIN + '/apply/contact?step=1';
const html = '<h1>Your details</h1><form><label>First name<input id="first" required autocomplete="given-name"></label><label>Email address<input id="email" required type="email"></label><label>Preferred contact<input id="unclear"></label><button>Next</button></form>';
function page(markup = html, url = URL) {
  const dom = new JSDOM(markup, {url, pretendToBeVisual: true, runScripts: 'outside-only'});
  for (const node of dom.window.document.querySelectorAll('*')) {
    node.getBoundingClientRect = () => ({left: 20, top: 20, right: 200, bottom: 60, width: 180, height: 40});
    node.getClientRects = () => [node.getBoundingClientRect()];
  }
  dom.window.document.addEventListener('submit', e => e.preventDefault());
  return dom;
}
const inspect = dom => engine.inspect(dom.window.document, dom.window.location.href, ORIGIN);
const fill = (dom, scan, assignments, values) => engine.fill(dom.window.document, dom.window.location.href, scan.token, assignments, values, Date.now()+60000);

test('generic URL policy requires HTTPS exact public origins and refuses account/payment routes', () => {
  assert.equal(engine.siteOrigin(URL), ORIGIN);
  assert.equal(engine.isWebsiteURL(URL), true);
  for(const bad of ['http://forms.example.test/a','https://user@forms.example.test/a','https://forms.example.test:444/a','https://127.0.0.1/a','https://localhost/a','https://forms.example.test./a',' https://forms.example.test/a',ORIGIN+'/login',ORIGIN+'/checkout',ORIGIN+'/a#signin']) assert.equal(engine.isWebsiteURL(bad), false, bad);
  const dom = page();
  assert.equal(engine.inspect(dom.window.document, URL).error, 'unsupported_page');
  assert.equal(engine.inspect(dom.window.document, URL, 'https://other.example.test').error, 'unsupported_page');
  assert.equal(inspect(dom).kind, 'mapping');
});

test('general labels suggest values, preserve uncertain fields, and Next waits for required answers', async () => {
  const dom = page(); const doc = dom.window.document;
  let scan = inspect(dom);
  assert.deepEqual(scan.fields.map(f => f.suggestedKey), ['firstName','email',null]);
  assert.equal(scan.actions[0].ready, false);
  assert.equal((await engine.act(doc, URL, scan.token, scan.actions[0].id, false, Date.now()+60000)).error, 'needs_input');
  scan = inspect(dom);
  const assignments = scan.fields.filter(f=>f.suggestedKey).map(f=>({id:f.id,key:f.suggestedKey}));
  const result = await fill(dom,scan,assignments,{firstName:'Example',email:'person@example.test'});
  assert.equal(result.filled,2); assert.equal(doc.querySelector('#unclear').value,'');
  scan=inspect(dom); assert.equal(scan.actions[0].ready,true);
  let clicks=0;doc.querySelector('button').addEventListener('click',()=>clicks++);
  assert.equal(clicks,0);
  assert.equal((await engine.act(doc,URL,scan.token,scan.actions[0].id,false,Date.now()+60000)).attempted,true);
  assert.equal(clicks,1);
  assert.equal((await engine.act(doc,URL,scan.token,scan.actions[0].id,false,Date.now()+60000)).error,'preview_expired');
  assert.equal(clicks,1);
});

test('Next rejects invalid email, visible errors, changed answers, disabled and competing buttons', async () => {
  const dom=page();const doc=dom.window.document;
  doc.querySelector('#first').value='Example';doc.querySelector('#email').value='invalid';
  assert.equal(inspect(dom).actions[0].ready,false);
  doc.querySelector('#email').value='person@example.test';
  let scan=inspect(dom);doc.querySelector('#first').value='';
  assert.equal((await engine.act(doc,URL,scan.token,scan.actions[0].id,false,Date.now()+60000)).error,'preview_expired');
  doc.querySelector('#first').value='Example';
  doc.querySelector('form').insertAdjacentHTML('beforeend','<p role="alert">Please fix this field</p>');
  const alert = doc.querySelector('[role="alert"]');
  alert.getBoundingClientRect = () => doc.querySelector('input').getBoundingClientRect();
  alert.getClientRects = () => [alert.getBoundingClientRect()];
  assert.equal(inspect(dom).actions[0].ready,false);
  doc.querySelector('button').disabled=true;assert.equal(inspect(dom).actions.length,0);
  doc.querySelector('button').disabled=false;
  doc.querySelector('form').insertAdjacentHTML('beforeend','<button>Continue</button>');
  const secondButton = doc.querySelectorAll('button')[1];
  secondButton.getBoundingClientRect = () => doc.querySelector('input').getBoundingClientRect();
  secondButton.getClientRects = () => [secondButton.getBoundingClientRect()];
  assert.equal(inspect(dom).actions.length,0);
});

test('formless forms work, foreign form actions and protected steps do not', async () => {
  const dom=page('<main><h1>Your details</h1><label>First name<input required></label><button type="button">Next</button></main>');
  let scan=inspect(dom);assert.equal(scan.fields[0].suggestedKey,'firstName');assert.equal(scan.actions[0].ready,false);
  await fill(dom,scan,[{id:scan.fields[0].id,key:'firstName'}],{firstName:'Example'});
  assert.equal(inspect(dom).actions[0].ready,true);
  for (const content of ['<form action="https://evil.example.test/"><label>First name<input></label><button>Next</button></form>', '<h1>E-Signature</h1><form><button>Submit Application</button></form>','<form><label>Password<input type="password"></label><button>Next</button></form>','<form><label>First name<input></label><button>Pay now</button></form>']) {
    const scan=inspect(page(content));assert.equal(scan.fields.length,0);assert.equal(scan.actions.length,0);
  }
});

function harness({sensitive=false, approved=true, permission=true}={}) {
  let dom=page(), current=URL, valid=true, revision="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const stored={}, nativeCalls=[],events={};
  const profile={firstName:'Example',email:'person@example.test',mobilePhone:'5155550100',ssn:'000-12-3456'};
  const event=name=>({addListener(fn){events[name]=fn;}});
  const api={
    runtime:{id:'extension',getURL:p=>'safari-web-extension://fixture/'+p,onMessage:event('message'),async sendNativeMessage(_app,input){
      nativeCalls.push(input);
      if(input.action==='siteStatus')return {origin:engine.siteOrigin(input.pageURL),approved,includeSensitive:sensitive,revision};
      if(input.action==='approveSite'){approved=true;sensitive=input.includeSensitive;return {origin:ORIGIN,approved,includeSensitive:sensitive,revision};}
      if(input.action==='removeSite'){approved=false;valid=false;return {origin:ORIGIN,approved:false};}
      if(input.action==='applicationFields')return valid?{fields:Object.fromEntries(input.keys.filter(k=>k!=='ssn'||sensitive).map(k=>[k,profile[k]||''])),expiresAt:Date.now()+600000}:{error:'expired'};
      throw Error(input.action);
    }},
    permissions:{async contains(){return permission;},async remove(){permission=false;return true;},onRemoved:event('permissionRemoved')},
    tabs:{async query(){return [{id:7,url:current}];},onUpdated:event('updated'),onActivated:event('activated'),onRemoved:event('removed')},
    storage:{local:{async get(key){return {[key]:stored[key]};},async set(value){Object.assign(stored,structuredClone(value));},async remove(key){delete stored[key];}}},
    scripting:{async executeScript(args){
      if(args.files){for(const file of args.files){const location=file==='iowa-adapter.js'?path.join(__dirname,'../../extension',file):path.join(__dirname,'../SafariExtension/Resources',file);dom.window.eval(fs.readFileSync(location,'utf8'));}return [];}
      return [{frameId:0,result:await dom.window.eval('('+args.func.toString()+')')(...(args.args||[]))}];
    }}
  };
  const make=()=>createWorkflow(api,{disableTimer:true}).install();
  let workflow=make();
  return {api,stored,nativeCalls,events,get dom(){return dom;},get workflow(){return workflow;},navigate(content=html,url=URL){dom.window.close();dom=page(content,url);current=url;},restart(){workflow=make();},revoke(){approved=false;},setPermission(value){permission=value;},setRevision(value){revision=value;}};
}

test('approved-site workflow remembers hashed matches, restores after restart, and clears them on removal', async () => {
  const h=harness();let view=await h.workflow.dispatch({command:'start'});
  assert.equal(view.workflow.phase,'mapping');assert.equal(h.dom.window.document.querySelector('#first').value,'');
  const assignments=view.scan.fields.map(f=>({id:f.id,key:f.suggestedKey||'mobilePhone'}));
  view=await h.workflow.dispatch({command:'fill',previewToken:view.scan.previewToken,assignments,remember:true});
  assert.equal(view.workflow.filled,3);assert.equal(view.scan.actions[0].ready,true);
  const remembered=h.stored.secondHandSiteMappings[ORIGIN];assert.equal(Object.keys(remembered).length,3);
  for(const key of Object.keys(remembered))assert.match(key,/^[a-f0-9]{64}$/);
  for(const secret of ['Example','person@example.test','5155550100','Preferred contact'])assert.equal(JSON.stringify(h.stored).includes(secret),false);
  h.navigate();h.restart();view=await h.workflow.dispatch({command:'status'});
  assert.equal(view.scan.fields.find(f=>f.label==='Preferred contact').suggestedKey,'mobilePhone');
  assert.equal(view.scan.fields.find(f=>f.label==='Preferred contact').remembered,true);
  // A changed question never inherits the old mapping.
  h.navigate(html.replace('Preferred contact','Different question'));
  view=await h.workflow.dispatch({command:'status'});
  assert.equal(view.scan.fields.find(f=>f.label==='Different question').suggestedKey,null);
  view=await h.workflow.dispatch({command:'remove-site',origin:ORIGIN});
  assert.equal(view.workflow,null);assert.equal(h.stored.secondHandSiteMappings,undefined);
  assert.equal((await h.workflow.dispatch({command:'start'})).error,'site');
});

test('site approval, browser access, sensitive scope, expiry and origin binding guard release', async () => {
  for(const options of [{approved:false},{permission:false}]){
    const h=harness(options);assert.equal((await h.workflow.dispatch({command:'start'})).error,'site');
    assert.equal(h.nativeCalls.some(c=>c.action==='applicationFields'),false);
  }
  const h=harness();h.navigate('<h1>Your details</h1><form><label>Your SSN<input></label><label>First name<input></label></form>');
  let view=await h.workflow.dispatch({command:'start'});assert.equal(view.scan.fields.some(f=>f.label==='Your SSN'),false);
  h.revoke();const calls=h.nativeCalls.filter(c=>c.action==='applicationFields').length;
  view=await h.workflow.dispatch({command:'fill',previewToken:view.scan.previewToken,assignments:[{id:view.scan.fields[0].id,key:'firstName'}]});
  assert.equal(view.error,'site');assert.equal(h.nativeCalls.filter(c=>c.action==='applicationFields').length,calls);
  const other=harness({sensitive:true});view=await other.workflow.dispatch({command:'start'});
  other.navigate(html,'https://different.example.test/apply');
  assert.equal((await other.workflow.dispatch({command:'status'})).error,'site');
});

test('new site approval and a user-clicked Next move to a fresh page without automatically filling it', async () => {
  const h=harness({approved:false});
  let view=await h.workflow.dispatch({command:'status'});
  assert.equal(view.site.approved,false);
  view=await h.workflow.dispatch({command:'approve-site',origin:ORIGIN,includeSensitive:false});
  assert.equal(view.site.approved,true);
  view=await h.workflow.dispatch({command:'start'});
  view=await h.workflow.dispatch({command:'fill',previewToken:view.scan.previewToken,assignments:view.scan.fields.filter(f=>f.suggestedKey).map(f=>({id:f.id,key:f.suggestedKey}))});
  assert.equal(view.scan.actions[0].ready,true);
  let clicked=0;
  h.dom.window.document.querySelector('button').addEventListener('click',()=>clicked++);
  await h.workflow.dispatch({command:'act',previewToken:view.scan.previewToken,actionID:view.scan.actions[0].id});
  assert.equal(clicked,1);
  h.navigate('<h1>Your address</h1><form><label>City<input required></label><button>Next</button></form>',ORIGIN+'/apply/address');
  h.events.updated(7,{status:'complete'});
  view=await h.workflow.dispatch({command:'status'});
  assert.equal(view.scan.fields[0].suggestedKey,'city');
  assert.equal(h.dom.window.document.querySelector('input').value,'');
  assert.equal(view.scan.actions[0].ready,false);
  assert.equal(view.workflow.filled,2);
});

test('generic matching rejects other-person, hidden, credential and conflicting autocomplete fields', () => {
  const dom=page('<h1>Your details</h1><form><label>First name<input autocomplete="family-name"></label><label hidden>Email<input></label><fieldset><legend>Household member</legend><label>First name<input></label><label>Your SSN<input></label></fieldset><label>Account number<input></label><button>Next</button></form>');
  const scan=inspect(dom);
  assert.equal(scan.fields.length,1);
  assert.equal(scan.fields[0].suggestedKey,null);
});


test('re-approving a site invalidates old review tokens and remembered matches', async () => {
  const h=harness();let view=await h.workflow.dispatch({command:'start'});
  const assignments=view.scan.fields.map(f=>({id:f.id,key:f.suggestedKey||'mobilePhone'}));
  await h.workflow.dispatch({command:'fill',previewToken:view.scan.previewToken,assignments,remember:true});
  h.navigate();view=await h.workflow.dispatch({command:'status'});
  assert.equal(view.scan.fields.find(f=>f.label==='Preferred contact').remembered,true);
  h.setRevision('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  const result=await h.workflow.dispatch({command:'fill',previewToken:view.scan.previewToken,assignments});
  assert.equal(result.error,'site');
  view=await h.workflow.dispatch({command:'status'});
  assert.equal(view.scan.fields.find(f=>f.label==='Preferred contact').remembered,undefined);
  assert.equal(view.scan.fields.find(f=>f.label==='Preferred contact').suggestedKey,null);
});


test('optional radio choices do not block Next, while required groups accept any selected option', () => {
  const dom=page('<form><label>Option A<input type="radio" name="optional" value="a"></label><label>Option B<input type="radio" name="optional" value="b"></label><button>Next</button></form>');
  assert.equal(inspect(dom).actions[0].ready,true);
  dom.window.document.querySelector('input').required=true;
  assert.equal(inspect(dom).actions[0].ready,false);
  dom.window.document.querySelectorAll('input')[1].checked=true;
  assert.equal(inspect(dom).actions[0].ready,true);
});

test('different approved websites support contact aliases, address selects, and explicitly mapped SSN/income', async () => {
  const cases = [
    {origin:'https://college.example.test',html:'<form><label>Given name<input required></label><label>Family name<input required></label><label>Email<input type="email" required></label><button>Next</button></form>', keys:['firstName','lastName','email'], values:{firstName:'Example',lastName:'Applicant',email:'example@example.test'}},
    {origin:'https://benefits.example.test',html:'<form><label>City or town<input required></label><label>State<select required><option value="">Choose</option><option value="IA">Iowa</option></select></label><label>Postal code<input required></label><button>Continue</button></form>',keys:['city','state','postalCode'],values:{city:'Des Moines',state:'IA',postalCode:'50309'}},
    {origin:'https://jobs.example.test',html:'<form><label>Your Social Security number<input type="tel" maxlength="9" required></label><label>Annual income<input type="number" required></label><label>Tax year<input type="number" required></label><button>Next</button></form>',keys:['ssn','annualIncome','annualIncomeYear'],values:{ssn:'000-12-3456',annualIncome:'68450.00',annualIncomeYear:'2025'}}
  ];
  for(const item of cases){
    const url=item.origin+'/application';const dom=page(item.html,url);const doc=dom.window.document;
    let scan=engine.inspect(doc,url,item.origin);
    assert.equal(scan.fields.length,3,item.origin);
    const assignments=scan.fields.map((f,i)=>({id:f.id,key:item.keys[i]}));
    assert.equal((await engine.fill(doc,url,scan.token,assignments,item.values,Date.now()+60000)).filled,3,item.origin);
    scan=engine.inspect(doc,url,item.origin);assert.equal(scan.actions[0].ready,true,item.origin);
    if(item.values.ssn)assert.equal(doc.querySelector('input').value,'000123456');
    dom.window.close();
  }
});
