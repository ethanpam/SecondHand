'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const adapter = require('../extension/iowa-adapter.js');
const TOKEN = 'a'.repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve));

function worker({ holdType, blocked = false, revoked = false } = {}) {
  const calls = { native: [], content: [], tabGets: 0 };
  const tab = { id: 7, active: true, url: `${adapter.PORTAL}/applyForBenefits/enterPersonalInfo` };
  const page = { kind: blocked ? 'blocked' : 'fillable', pageKey: blocked ? 'consent' : 'personal', canAdvance: !blocked, reason: blocked ? 'Review consent yourself.' : '' };
  const fields = [{key:'firstName',label:'First name'}];
  let now = Date.now(), listener, release, releaseTab, holdTabWhen, complete = false, nextError = false, grants = 0;
  const nativeFailures = new Map();
  const events = {};
  const event = key => ({addListener: value => {events[key]=value;}});
  const chrome = {
    tabs: {
      get: async()=>{
        calls.tabGets++;
        if(holdTabWhen?.(calls)) {
          holdTabWhen=null;
          await new Promise(resolve=>{releaseTab=resolve;});
        }
        return {...tab};
      },
      sendMessage: async(_id,message)=>{
        calls.content.push(message);
        if(message.type==='secondhand:pageState') return {page:{...page},scan:{token:'preview',recognizedPage:page.kind==='fillable'||page.kind==='manual',supported:true,fields:complete?[]:[...fields],ambiguous:[],skipped:0},nextToken:page.canAdvance?'next-token':null};
        if(message.type==='secondhand:scan') return {token:'preview',recognizedPage:true,supported:true,fields:[...fields],ambiguous:[],skipped:0};
        if(message.type==='secondhand:fill'){complete=true;return{ok:true,filledCount:1,skippedCount:0};}
        if(message.type==='secondhand:next'){if(nextError)throw new Error('Navigation response unavailable.');return{advanced:true};}
        return {ok:true};
      },onActivated:event('activated'),onRemoved:event('removed'),onUpdated:event('updated')
    },
    scripting:{executeScript:async()=>{}},
    runtime:{id:'testextension',getURL:file=>`chrome-extension://testextension/${file}`,onMessage:{addListener:callback=>{listener=callback;}},connectNative:()=>{
      let messageListener,disconnectListener;
      return{onMessage:{addListener:callback=>{messageListener=callback;}},onDisconnect:{addListener:callback=>{disconnectListener=callback;}},disconnect:()=>disconnectListener?.(),postMessage:request=>{
        calls.native.push(request);
        const answer=()=>{
          if(nativeFailures.has(request.type)) return messageListener({id:request.id,ok:false,error:nativeFailures.get(request.type)});
          messageListener({id:request.id,ok:true,data:request.type==='startAssistedSession'?{assistanceToken:grants++===0?TOKEN:'b'.repeat(64),expiresAt:new Date(now+900000).toISOString(),fields:Object.keys(adapter.definitions)}:request.type==='getFields'?{values:{firstName:'Synthetic private value'}}:request.type==='checkAssistedSession'?{active:!revoked}:request.type==='status'?{unlocked:true}:{recorded:true,ended:true}});
        };
        if(request.type===holdType) release=answer;else queueMicrotask(answer);
      }};
    }}
  };
  class Clock extends Date { static now(){return now;} }
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'),'utf8'),{chrome,SecondHandIowa:adapter,importScripts:()=>{},crypto:webcrypto,setTimeout,clearTimeout,URL,Map,Set,Date:Clock,console});
  const panel=()=>({id:'testextension',url:chrome.runtime.getURL('panel.html'),frameId:3,tab:{...tab}});
  const send=(message,sender=panel())=>new Promise(resolve=>{if(!listener(message,sender,resolve))resolve(undefined);});
  return{calls,tab,page,fields,events,send,
    release:()=>{holdType=null;const answer=release;release=null;answer?.();},
    holdNative:type=>{holdType=type;},
    holdTabGetWhen:predicate=>{holdTabWhen=predicate;},
    releaseTab:()=>{const answer=releaseTab;releaseTab=null;answer?.();},
    tabHeld:()=>Boolean(releaseTab),
    advanceTime:ms=>{now+=ms;},setNextError:()=>{nextError=true;},resetFields:()=>{complete=false;},
    setComplete:value=>{complete=value;},setRevoked:value=>{revoked=value;},
    failNative:(type,message)=>{if(message)nativeFailures.set(type,message);else nativeFailures.delete(type);}};
}
const start=w=>w.send({type:'ui:auto',enabled:true,confirmed:true});
const stop=w=>w.send({type:'ui:auto',enabled:false});
async function settle(){for(let i=0;i<8;i++)await tick();}

test('guided mode requires explicit UI approval; one desktop grant fills and advances once',async()=>{
 const w=worker();
 assert.equal(await w.send({type:'ui:auto',enabled:true}),undefined);
 await w.send({type:'ui:pageState'});
 assert.equal(w.calls.native.length,0);
 const result=await start(w);
 assert.equal(result.ok,true);
 assert.deepEqual(w.calls.native.map(x=>x.type),['startAssistedSession','getFields','recordProgress','checkAssistedSession']);
 assert.equal(w.calls.native[1].assistanceToken,TOKEN);
 assert.equal(w.calls.content.filter(x=>x.type==='secondhand:next').length,1);
 assert.doesNotMatch(JSON.stringify(result),/Synthetic private value|aaaaaaaaaaaaaaaa/);
 // Same page after a click cannot cause a loop or duplicate save.
 await w.send({type:'ui:pageState'});await settle();
 assert.equal(w.calls.content.filter(x=>x.type==='secondhand:next').length,1);
 assert.equal((await w.send({type:'ui:status'})).data.automatic.paused,true);
});

test('unrecognized and consent pages pause without requesting or navigating',async()=>{
 const blocked=worker({blocked:true});
 assert.equal((await start(blocked)).ok,false);
 assert.equal(blocked.calls.native.length,0);
 const w=worker();await start(w);
 Object.assign(w.page,{kind:'unsupported',pageKey:'income',canAdvance:false,reason:'Complete income questions yourself.'});
 w.tab.url=`${adapter.PORTAL}/applyForBenefits/income`;
 await w.send({type:'ui:pageState'});await settle();
 const state=(await w.send({type:'ui:status'})).data;
 assert.equal(state.automatic.paused,true);assert.match(state.automatic.reason,/income/);
 assert.equal(w.calls.native.filter(x=>x.type==='getFields').length,1);
 assert.equal(w.calls.content.filter(x=>x.type==='secondhand:next').length,1);
});

test('stopping during the initial desktop prompt revokes late approval and never fills',async()=>{
 const w=worker({holdType:'startAssistedSession'});const pending=start(w);await settle();
 assert.equal(w.calls.native.length,1);
 await stop(w);w.release();await pending;
 assert.deepEqual(w.calls.native.map(x=>x.type),['startAssistedSession','endAssistedSession']);
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:fill'||x.type==='secondhand:next'),false);
});

test('stopping after grant but during data retrieval discards returned values',async()=>{
 const w=worker({holdType:'getFields'});const pending=start(w);await settle();
 assert.equal(w.calls.native.some(x=>x.type==='getFields'),true);
 await stop(w);w.release();await pending;
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:fill'||x.type==='secondhand:next'),false);
 assert.equal((await w.send({type:'ui:status'})).data.automatic.enabled,false);
});

test('switching tabs revokes guided approval and rejects cross-tab panel requests',async()=>{
 const w=worker();await start(w);w.events.activated({tabId:12});await settle();
 assert.equal(w.calls.native.at(-1).type,'endAssistedSession');
 assert.equal((await w.send({type:'ui:status'})).data.automatic.enabled,false);
 assert.equal(await w.send({type:'ui:fill',tabId:12,confirmed:true}),undefined);
 const hostile={id:'testextension',url:adapter.PORTAL,frameId:0,tab:{...w.tab}};
 assert.equal(await w.send({type:'ui:auto',enabled:true,confirmed:true},hostile),undefined);
});

test('ambiguous navigation failure is never retried automatically',async()=>{
 const w=worker();w.setNextError();await start(w);
 await w.send({type:'ui:pageState'});await settle();
 assert.equal(w.calls.content.filter(x=>x.type==='secondhand:next').length,1);
 assert.equal((await w.send({type:'ui:status'})).data.automatic.paused,true);
});

test('expired grants stop and worker restarts do not resume sessions',async()=>{
 const w=worker();await start(w);w.advanceTime(900001);
 await w.send({type:'ui:pageState'});await settle();
 assert.equal(w.calls.native.at(-1).type,'endAssistedSession');
 assert.equal((await w.send({type:'ui:status'})).data.automatic.enabled,false);
 const restarted=worker();await restarted.send({type:'ui:pageState'});
 assert.equal(restarted.calls.native.length,0);
});

test('Fill and Next fills reviewed fields but leaves manual questions to the applicant',async()=>{
 const w=worker();w.page.kind='manual';w.page.canAdvance=false;w.page.reason='Answer the home-address question yourself.';
 await w.send({type:'ui:scan'});
 const result=await w.send({type:'ui:fillAndNext',token:'preview',fields:['firstName'],confirmed:true});
 assert.equal(result.ok,true);assert.equal(result.data.advanced,false);
 assert.match(result.data.message,/home-address/);
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:next'),false);
});

test('desktop revocation is checked immediately before Next even when fields are already filled',async()=>{
 const w=worker({revoked:true});await start(w);
 assert.equal(w.calls.native.some(x=>x.type==='checkAssistedSession'),true);
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:next'),false);
 assert.equal((await w.send({type:'ui:status'})).data.automatic.paused,true);
});

test('stop while navigation authorization is pending prevents Next',async()=>{
 const w=worker({holdType:'checkAssistedSession'});const pending=start(w);await settle();
 assert.equal(w.calls.native.at(-1).type,'checkAssistedSession');
 await stop(w);w.release();await pending;
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:next'),false);
});

test('Stop during the initial manual fill tab check never opens a desktop field prompt',async()=>{
 const w=worker();await w.send({type:'ui:scan'});
 w.holdTabGetWhen(()=>true);
 const pending=w.send({type:'ui:fill',token:'preview',fields:['firstName'],confirmed:true});
 await settle();assert.equal(w.tabHeld(),true);
 await stop(w);w.releaseTab();
 assert.equal((await pending).ok,false);
 assert.equal(w.calls.native.length,0);
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:fill'),false);
});

test('Stop while initially inspecting a page cannot create a new assisted consent prompt',async()=>{
 const w=worker();w.holdTabGetWhen(()=>true);
 const pending=start(w);await settle();assert.equal(w.tabHeld(),true);
 await stop(w);w.releaseTab();
 assert.equal((await pending).ok,false);
 assert.equal(w.calls.native.length,0);
});

test('Stop during the final tab check after desktop approval revokes the late grant',async()=>{
 const w=worker();w.holdTabGetWhen(calls=>calls.native.at(-1)?.type==='startAssistedSession');
 const pending=start(w);await settle();assert.equal(w.tabHeld(),true);
 await stop(w);w.releaseTab();await pending;
 assert.deepEqual(w.calls.native.map(x=>x.type),['startAssistedSession','endAssistedSession']);
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:fill'||x.type==='secondhand:next'),false);
 assert.equal((await w.send({type:'ui:status'})).data.automatic.enabled,false);
});

test('Stop after profile retrieval but during the final tab check discards the values',async()=>{
 const w=worker();w.holdTabGetWhen(calls=>calls.native.at(-1)?.type==='getFields');
 const pending=start(w);await settle();assert.equal(w.tabHeld(),true);
 await stop(w);w.releaseTab();await pending;
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:fill'||x.type==='secondhand:next'),false);
 assert.doesNotMatch(JSON.stringify((await w.send({type:'ui:status'})).data),/Synthetic private value/);
});

test('Stop during replacement-session cleanup cannot be overwritten by the replacement',async()=>{
 const w=worker();await start(w);
 w.advanceTime(900001);w.holdNative('endAssistedSession');
 const pending=start(w);await settle();
 assert.equal(w.calls.native.at(-1).type,'endAssistedSession');
 await stop(w);w.release();
 assert.equal((await pending).ok,false);
 assert.equal(w.calls.native.filter(x=>x.type==='startAssistedSession').length,1);
 assert.equal(w.calls.content.filter(x=>x.type==='secondhand:next').length,1);
 assert.equal((await w.send({type:'ui:status'})).data.automatic.enabled,false);
});

test('expiry during the final navigation tab check prevents Next and requires fresh consent',async()=>{
 const w=worker();w.holdTabGetWhen(calls=>calls.native.at(-1)?.type==='checkAssistedSession');
 const pending=start(w);await settle();assert.equal(w.tabHeld(),true);
 w.advanceTime(900001);w.releaseTab();await pending;
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:next'),false);
 assert.equal(w.calls.native.at(-1).type,'endAssistedSession');
 assert.equal((await w.send({type:'ui:status'})).data.automatic.paused,true);
 await start(w);
 assert.equal(w.calls.native.filter(x=>x.type==='startAssistedSession').length,2);
 assert.equal(w.calls.content.filter(x=>x.type==='secondhand:next').length,1);
});

test('expiry after retrieved fields but during the final tab check prevents filling',async()=>{
 const w=worker();w.holdTabGetWhen(calls=>calls.native.at(-1)?.type==='getFields');
 const pending=start(w);await settle();assert.equal(w.tabHeld(),true);
 w.advanceTime(900001);w.releaseTab();await pending;
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:fill'||x.type==='secondhand:next'),false);
 assert.equal((await w.send({type:'ui:status'})).data.automatic.paused,true);
});

test('a revoked desktop session on an already completed page asks for fresh consent on Resume',async()=>{
 const w=worker({revoked:true});w.setComplete(true);await start(w);
 assert.equal(w.calls.native.some(x=>x.type==='getFields'),false);
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:next'),false);
 assert.equal((await w.send({type:'ui:status'})).data.automatic.paused,true);
 w.setRevoked(false);await start(w);
 assert.equal(w.calls.native.filter(x=>x.type==='startAssistedSession').length,2);
 assert.equal(w.calls.native.filter(x=>x.type==='checkAssistedSession').at(-1).assistanceToken,'b'.repeat(64));
 assert.equal(w.calls.content.filter(x=>x.type==='secondhand:next').length,1);
});

test('a rejected guided field request is ended and Resume uses a new desktop grant',async()=>{
 const w=worker();w.failNative('getFields','Guided assistance has ended.');await start(w);
 assert.equal(w.calls.content.some(x=>x.type==='secondhand:fill'),false);
 assert.equal(w.calls.native.at(-1).type,'endAssistedSession');
 w.failNative('getFields',null);await start(w);
 assert.equal(w.calls.native.filter(x=>x.type==='startAssistedSession').length,2);
 assert.equal(w.calls.native.filter(x=>x.type==='getFields').at(-1).assistanceToken,'b'.repeat(64));
 assert.equal(w.calls.content.filter(x=>x.type==='secondhand:fill').length,1);
});

test('a manual-question pause retains valid approval when the applicant resumes',async()=>{
 const w=worker();Object.assign(w.page,{kind:'manual',canAdvance:false,reason:'Answer the remaining question yourself.'});
 await start(w);
 assert.equal((await w.send({type:'ui:status'})).data.automatic.paused,true);
 Object.assign(w.page,{kind:'fillable',canAdvance:true,reason:''});await start(w);
 assert.equal(w.calls.native.filter(x=>x.type==='startAssistedSession').length,1);
 assert.equal(w.calls.native.filter(x=>x.type==='checkAssistedSession').at(-1).assistanceToken,TOKEN);
 assert.equal(w.calls.content.filter(x=>x.type==='secondhand:next').length,1);
});
