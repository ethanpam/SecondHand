import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, download, publish, filenames } from '../lib/downloads.ts';
const secret = 'test-secret-that-is-at-least-32-characters';
const request = (path: string = filenames[0], headers = {}, method='GET') => new Request(`https://example.test/download/${path}`, {method, headers});
const object = {size:10,httpEtag:'"etag"',customMetadata:{sha256:'a'.repeat(64)}};
const bucket = {head:async()=>object,get:async(_key: string, options?: {range:{offset:number,length:number}})=>({body:new Blob([options?.range ? '0123456789'.slice(options.range.offset, options.range.offset+options.range.length) : '0123456789']).stream()})} as unknown as R2Bucket;
test('upload endpoint fails closed without matching configured credential', async()=>{
 assert.equal(await authorized(request()),false);
 assert.equal(await authorized(request('',{authorization:`Bearer ${secret}`}),secret),true);
 assert.equal(await authorized(request('',{authorization:`Bearer ${secret}x`}),secret),false);
 assert.equal((await publish(request(),filenames[0],bucket)).status,404);
});
test('only explicit release files are downloadable, headers force download', async()=>{
 assert.equal((await download(request(),'vault.json',bucket)).status,404);
 const result=await download(request(),filenames[0],bucket);
 assert.equal(result.headers.get('content-disposition'),`attachment; filename="${filenames[0]}"`);
 assert.equal(await result.text(),'0123456789');
});
test('supports resumed downloads, suffix ranges and rejects invalid ranges',async()=>{
 for(const [range,text] of [['bytes=2-5','2345'],['bytes=-3','789'],['bytes=7-','789']]){
 const result=await download(request('',{range}),filenames[0],bucket);
 assert.equal(result.status,206);assert.equal(await result.text(),text);
 }
 for(const range of ['bytes=50-60','bytes=0-1,4-5','bytes=-0','bytes=-','bytes=5-2']) assert.equal((await download(request('',{range}),filenames[0],bucket)).status,416);
});
test('HEAD and conditional requests avoid body, missing artifacts fail clearly',async()=>{
 assert.equal((await download(request('',{},'HEAD'),filenames[0],bucket)).body,null);
 assert.equal((await download(request('',{'if-none-match':'"etag"'}),filenames[0],bucket)).status,304);
 assert.equal((await download(request(),filenames[0],{head:async()=>null} as unknown as R2Bucket)).status,503);
});
test('published filenames cannot be overwritten', async()=>{
 const req=new Request('https://example.test/api/publish/file?action=create',{method:'POST',headers:{authorization:`Bearer ${secret}`}});
 assert.equal((await publish(req,filenames[0],bucket,secret)).status,409);
});
test('multipart completion verifies stored metadata even when completion response omits it', async()=>{
 let completed=false;
 const files={
  head:async()=>completed?{size:10,customMetadata:{size:'10',sha256:'a'.repeat(64)}}:null,
  resumeMultipartUpload:()=>({complete:async()=>{completed=true;return{size:10};}}),
 } as unknown as R2Bucket;
 const req=new Request('https://example.test/api/publish/file?action=complete&uploadId=test',{
  method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},
  body:JSON.stringify({parts:[{partNumber:1,etag:'etag'}]})
 });
 const result=await publish(req,filenames[0],files,secret);
 assert.equal(result.status,200);
 assert.deepEqual(await result.json(),{size:10,sha256:'a'.repeat(64)});
});
