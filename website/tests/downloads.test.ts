import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, download, publish, filenames, libraryFilenames, LATEST_RELEASE, RELEASE } from '../lib/downloads.ts';
import { release as displayedRelease, downloads, libraryDownloads, libraryRelease } from '../lib/release.ts';
const secret = 'test-secret-that-is-at-least-32-characters';
const request = (path: string = filenames[0], headers = {}, method='GET') => new Request(`https://example.test/download/${path}`, {method, headers});
const object = {size:10,httpEtag:'"etag"',customMetadata:{sha256:'a'.repeat(64)}};
const bucket = {head:async()=>object,get:async(_key: string, options?: {range:{offset:number,length:number}})=>({body:new Blob([options?.range ? '0123456789'.slice(options.range.offset, options.range.offset+options.range.length) : '0123456789']).stream()})} as unknown as R2Bucket;
void test('upload endpoint fails closed without matching configured credential', async()=>{
 assert.equal(await authorized(request()),false);
 assert.equal(await authorized(request('',{authorization:`Bearer ${secret}`}),secret),true);
 assert.equal(await authorized(request('',{authorization:`Bearer ${secret}x`}),secret),false);
 assert.equal((await publish(request(),filenames[0],bucket)).status,404);
});
void test('only explicit release files are downloadable, headers force download', async()=>{
 assert.equal((await download(request(),'vault.json',bucket)).status,404);
 const result=await download(request(),filenames[0],bucket);
 assert.equal(result.headers.get('content-disposition'),`attachment; filename="${filenames[0]}"`);
 assert.equal(await result.text(),'0123456789');
});
void test('supports resumed downloads, suffix ranges and rejects invalid ranges',async()=>{
 for(const [range,text] of [['bytes=2-5','2345'],['bytes=-3','789'],['bytes=7-','789']]){
 const result=await download(request('',{range}),filenames[0],bucket);
 assert.equal(result.status,206);assert.equal(await result.text(),text);
 }
 for(const range of ['bytes=50-60','bytes=0-1,4-5','bytes=-0','bytes=-','bytes=5-2']) assert.equal((await download(request('',{range}),filenames[0],bucket)).status,416);
});
void test('HEAD and conditional requests avoid body, missing artifacts fail clearly',async()=>{
 assert.equal((await download(request('',{},'HEAD'),filenames[0],bucket)).body,null);
 assert.equal((await download(request('',{'if-none-match':'"etag"'}),filenames[0],bucket)).status,304);
 assert.equal((await download(request(),filenames[0],{head:async()=>null} as unknown as R2Bucket)).status,503);
});
void test('published filenames cannot be overwritten', async()=>{
 const req=new Request('https://example.test/api/publish/file?action=create',{method:'POST',headers:{authorization:`Bearer ${secret}`}});
 assert.equal((await publish(req,filenames[0],bucket,secret)).status,409);
});
void test('multipart completion verifies stored metadata even when completion response omits it', async()=>{
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

void test('versioned downloads preserve older releases and reject mismatched or unlisted versions', async()=>{
 const keys: string[]=[];
 const files={head:async(key: string)=>{keys.push(key);return object;},get:async()=>({body:'data'})} as unknown as R2Bucket;
 for(const [file,query,version] of [
  ['secondHand-0.2.0-win-x64.exe','','0.2.0'],
  ['secondHand-0.3.0-mac-arm64.dmg','','0.3.0'],
  ['secondHand-0.4.0-mac-arm64.dmg','','0.4.0'],
  ['secondHand-0.5.0-win-x64.exe','','0.5.0'],
  ['secondHand-0.5.0-mac-arm64.dmg','','0.5.0'],
  ['secondHand-0.5.0-mac-x64.dmg','','0.5.0'],
  ['secondHand-0.5.1-win-x64.exe','','0.5.1'],
  ['secondHand-0.5.1-mac-arm64.dmg','','0.5.1'],
  ['secondHand-0.5.1-mac-x64.dmg','','0.5.1'],
  ['secondHand-extension.zip','?release=0.3.0','0.3.0'],
  ['SHA256SUMS.txt','',LATEST_RELEASE],
 ]) {
  assert.equal((await download(request(file+query),file,files)).status,200);
  assert.equal(keys.at(-1),`releases/${version}/${file}`);
 }
 for(const [file,query] of [
  ['secondHand-0.2.0-win-x64.exe','?release=0.3.0'],
  ['secondHand-extension.zip','?release=../../vault'],
  ['secondHand-9.9.9-win-x64.exe',''],
  ['SHA256SUMS.txt','?release=9.9.9'],
 ]) assert.equal((await download(request(file+query),file,files)).status,404);
 const req=new Request('https://example.test/api/publish/file?action=create',{method:'POST',headers:{authorization:`Bearer ${secret}`}});
 assert.equal((await publish(req,'secondHand-0.2.0-win-x64.exe',files,secret)).status,400);
});

void test('public links and unversioned downloads stay on the verified release independently of the upload target', async()=>{
 assert.equal(displayedRelease,LATEST_RELEASE);
 assert.equal(filenames[0],`secondHand-${RELEASE}-win-x64.exe`);
 const keys: string[]=[];
 const files={head:async(key: string)=>{keys.push(key);return object;},get:async()=>({body:'data'})} as unknown as R2Bucket;
 for(const link of Object.values(downloads)) {
  const url=new URL(link,'https://example.test');
  const file=url.pathname.split('/').at(-1)!;
  assert.equal((await download(new Request(url),file,files)).status,200);
  assert.equal(keys.at(-1),`releases/${LATEST_RELEASE}/${file}`);
 }
 for(const file of ['secondHand-extension.zip','SHA256SUMS.txt']) {
  assert.equal((await download(request(file),file,files)).status,200);
  assert.equal(keys.at(-1),`releases/${LATEST_RELEASE}/${file}`);
  assert.equal((await download(request(`${file}?release=${RELEASE}`),file,files)).status,200);
  assert.equal(keys.at(-1),`releases/${RELEASE}/${file}`);
 }
});

void test('Library installers and checksums resolve to separate allowlisted artifacts', async () => {
  for (const href of Object.values(libraryDownloads)) {
    const url = new URL(href, 'https://example.test');
    const file = url.pathname.split('/').at(-1)!;
    assert.ok((libraryFilenames as readonly string[]).includes(file));
    let key = '';
    const storage = { ...bucket, head: async (value: string) => { key = value; return object; } } as unknown as R2Bucket;
    const result = await download(new Request(url), file, storage);
    assert.equal(result.status, 200);
    assert.equal(key, `releases/${libraryRelease}/${file}`);
    assert.equal(result.headers.get('content-disposition'), `attachment; filename="${file}"`);
    url.searchParams.set('release', '0.2.0');
    assert.equal((await download(new Request(url), file, storage)).status, 404);
  }
  assert.notEqual(libraryDownloads.windows as string, downloads.windows);
});
