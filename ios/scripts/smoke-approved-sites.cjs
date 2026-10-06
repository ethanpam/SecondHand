'use strict';
// Local Chromium replay of the Safari popup and production page engine. Native
// messaging and site permissions are stubbed; no outside requests are allowed.
const {chromium}=require('@playwright/test');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createWorkflow}=require('../SafariExtension/Resources/background.js');
const root=path.join(__dirname,'../..'), resources=path.join(__dirname,'../SafariExtension/Resources');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const origin='https://forms.example.test', store={};let approved=false;
  const first='<h1>Your details</h1><form action="/address"><label>First name<input id="first" required autocomplete="given-name"></label><label>Email address<input id="email" type="email" required></label><button>Next</button></form>';
  const second='<h1>Your address</h1><form><label>City<input required></label><button type="button">Next</button></form>';
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin===origin){await route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:18px sans-serif;padding:24px}label,input,button{display:block;margin:14px 0}input,button{font:inherit;padding:10px;max-width:95%}</style>'+(url.pathname==='/address'?second:first)});return;}
   if(url.origin==='https://extension.example.test'){
    const file=path.basename(url.pathname);if(['popup.html','popup.js','popup.css'].includes(file)){await route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:await fs.readFile(path.join(resources,file),'utf8')});return;}
   }
   await route.abort();
  });
  const form=await context.newPage();await form.goto(origin+'/contact');
  const api={
   runtime:{async sendNativeMessage(_app,input){
    if(input.action==='siteStatus')return {origin,approved,includeSensitive:false,revision:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'};
    if(input.action==='approveSite'){approved=true;return {origin,approved};}
    if(input.action==='applicationFields'){assert.equal(approved,true);const values={firstName:'Example',email:'example@example.test',city:'Des Moines'};return {fields:Object.fromEntries(input.keys.map(k=>[k,values[k]||''])),expiresAt:Date.now()+600000};}
    throw Error(input.action);
   }},
   permissions:{async contains(){return true;}},
   tabs:{async query(){return [{id:7,url:form.url()}];}},
   storage:{local:{async get(key){return {[key]:store[key]};},async set(data){Object.assign(store,structuredClone(data));},async remove(key){delete store[key];}}},
   scripting:{async executeScript(input){
    if(input.files){for(const file of input.files)await form.addScriptTag({path:file==='iowa-adapter.js'?path.join(root,'extension',file):path.join(resources,file)});return [];}
    const result=await form.evaluate(async ({source,args})=>await (0,eval)('('+source+')')(...args),{source:input.func.toString(),args:input.args||[]});
    return [{frameId:0,result}];
   }}
  };
  const workflow=createWorkflow(api,{disableTimer:true});
  const popup=await context.newPage();
  await popup.exposeFunction('qaSend',input=>workflow.dispatch(input));
  await popup.addInitScript(()=>{window.browser={runtime:{sendMessage:input=>window.qaSend(input)},permissions:{request:async()=>true}};});
  await popup.goto('https://extension.example.test/popup.html');
  await popup.locator('#allow-site').click();
  await popup.locator('#start').click();
  await popup.locator('#fields select').first().waitFor();
  assert.equal(await popup.locator('#continue').isDisabled(),true);
  await popup.screenshot({path:'/tmp/secondhand-approved-site-review.png',fullPage:true});
  await popup.locator('#remember').check();await popup.locator('#fill').click();
  await popup.waitForFunction(()=>!document.getElementById('continue').disabled);
  assert.equal(await form.locator('#first').inputValue(),'Example');
  assert.equal(await form.locator('#email').inputValue(),'example@example.test');
  await popup.screenshot({path:'/tmp/secondhand-approved-site-ready.png',fullPage:true});
  await popup.locator('#continue').click();await form.waitForURL(origin+'/address?**');
  await popup.locator('#refresh').click();
  await popup.waitForFunction(()=>document.querySelector('#fields select')?.value==='city');
  assert.equal(await popup.locator('#continue').isDisabled(),true);
  assert.equal(await form.locator('input').inputValue(),'');
  await popup.locator('#fill').click();await popup.waitForFunction(()=>!document.getElementById('continue').disabled);
  assert.equal(await form.locator('input').inputValue(),'Des Moines');
  assert.equal(JSON.stringify(store).includes('example@example.test'),false);
  console.log('Passed: approve site, suggested fields, remember matches, required-field Next gating, explicit Next navigation, fresh second-page fill.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
