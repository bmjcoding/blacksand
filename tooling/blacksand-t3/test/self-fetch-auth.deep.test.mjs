// Real selfUpdate -> publicGit -> HTTPS Git -> scoped helper -> fake gh.
// All traffic is routed by a test-only git shim into a loopback TLS fixture;
// no real login, token, authenticated remote, build or source commit is used.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fixture, run } from './trust-fixtures.mjs';
import { publicGit, UPSTREAM_URL } from '../lib/git.mjs';
import { buildEnv } from '../lib/build.mjs';
import { canonicalSelfOrigin, selfFetchConfig, selfFetchEnv } from '../lib/self-fetch-auth.mjs';

const URL = 'https://github.com/test-owner/private.git';
const realGit = spawnSync('which', ['git'], {encoding:'utf8'}).stdout.trim();
const helper = fileURLToPath(new globalThis.URL('../lib/self-fetch-auth.mjs', import.meta.url));
const synthetic = 'test-only-credential-DO-NOT-USE';

async function sandbox(body, mode = 'success') {
  const f = fixture();
  const bin = path.join(f.dir, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(f.dir, 'gh-calls');
  const requests = path.join(f.dir, 'requests');
  const cert = path.join(f.dir, 'cert.pem'), key = path.join(f.dir, 'key.pem');
  const certResult = spawnSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=github.com','-addext','subjectAltName=DNS:github.com','-keyout',key,'-out',cert], {stdio:'ignore'});
  assert.equal(certResult.status, 0);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8'),env:process.env})+'\\n'); process.stderr.write(${JSON.stringify(synthetic)}); process.stdout.write('protocol=https\\nhost=github.com\\nusername=test-user\\npassword=${synthetic}\\n');`, {mode:0o755});
  const server = spawn(process.execPath, ['--input-type=module','-e', `
    import https from 'node:https'; import http from 'node:http'; import net from 'node:net'; import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
    const expected='Basic '+Buffer.from('test-user:${synthetic}').toString('base64');
    const server=https.createServer({key:fs.readFileSync(${JSON.stringify(key)}),cert:fs.readFileSync(${JSON.stringify(cert)})},(req,res)=>{
      fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify({url:req.url,auth:req.headers.authorization===expected})+'\\n');
      if (${JSON.stringify(mode)}==='redirect-before' || (${JSON.stringify(mode)}==='redirect-after' && req.headers.authorization===expected)) {res.writeHead(302,{location:'https://github.com/test-owner/other.git/info/refs?service=git-upload-pack'});res.end();return;}
      if (${JSON.stringify(mode)}==='failure' || req.headers.authorization!==expected) {res.writeHead(401,{'www-authenticate':'Basic realm="fixture"'});res.end();return;}
      const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
        const u=new URL(req.url,'https://github.com');
        if (!u.pathname.startsWith('/test-owner/private.git/')) {res.writeHead(404);res.end();return;}
        const r=spawnSync(${JSON.stringify(realGit)},['http-backend'],{input:Buffer.concat(chunks),env:{PATH:process.env.PATH,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_PROJECT_ROOT:${JSON.stringify(f.dir)},GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:u.pathname.replace('/test-owner/private.git','/origin'),QUERY_STRING:u.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']??'',REMOTE_USER:'fixture'}});
        const split=r.stdout.indexOf('\\r\\n\\r\\n');const headers=r.stdout.subarray(0,split).toString().split('\\r\\n');let status=200;const h={};for(const line of headers){const cut=line.indexOf(':');const k=line.slice(0,cut);const v=line.slice(cut+1).trim();if(k.toLowerCase()==='status')status=parseInt(v);else h[k]=v;}res.writeHead(status,h);res.end(r.stdout.subarray(split+4));
      });
    });
    server.listen(0,'127.0.0.1',()=>{const proxy=http.createServer();proxy.on('connect',(req,client,head)=>{if(req.url!=='github.com:443'){client.destroy();return;}const socket=net.connect(server.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');if(head.length)socket.write(head);client.pipe(socket);socket.pipe(client);});socket.on('error',()=>client.destroy());client.on('error',()=>socket.destroy());});proxy.listen(0,'127.0.0.1',()=>console.log(proxy.address().port));});
  `], {stdio:['ignore','pipe','pipe']});
  let errors=''; server.stderr.on('data',c=>errors+=c);
  const port = await new Promise((resolve,reject)=>{server.stdout.once('data',c=>resolve(Number(c.toString().trim())));server.once('exit',code=>reject(new Error(`TLS fixture ${code}: ${errors}`)));});
  fs.writeFileSync(path.join(bin,'git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');let args=process.argv.slice(2);const i=args.indexOf('fetch');if(i!==-1 && args.slice(i).some(x=>x.startsWith('https://')))args.splice(i,0,'-c',${JSON.stringify(`http.proxy=http://127.0.0.1:${port}`)},'-c',${JSON.stringify(`http.sslCAInfo=${cert}`)});const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});process.exit(r.status??1);`,{mode:0o755});
  const saved={...process.env};
  Object.assign(process.env,{PATH:`${bin}:${process.env.PATH}`,HOME:f.dir,GH_TOKEN:'must-not-inherit',GIT_TRACE:'1',GIT_CURL_VERBOSE:'1',HTTPS_PROXY:'http://unsafe.invalid',GH_CONFIG_DIR:'/unsafe',NODE_OPTIONS:''});
  run(f.clone,['remote','set-url','origin',URL]);
  try { await body({f,bin,calls,requests}); }
  finally { for(const k of Object.keys(process.env)) if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve)); }
}
const records = file => fs.existsSync(file) ? fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)) : [];

test('private success through the real HTTPS/helper path verifies and merges exactly the signed fetched tip', async()=>{
  await sandbox(async({f,calls,requests})=>{
    const tip=f.commit(f.owner,{'lib/delivery.mjs':'// fixture\n'},'fixture');
    assert.equal(await f.update({remote:null}), 'updated', f.logs.join('\n'));
    assert.equal(f.head(),tip);
    assert.ok(records(requests).some(r=>r.auth));
    const gh=records(calls);assert.ok(gh.length>0);
    for(const c of gh){assert.deepEqual(c.args,['auth','git-credential','get']);assert.equal(c.input,'protocol=https\nhost=github.com\npath=test-owner/private.git\n\n');for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_CONFIG_DIR','HTTPS_PROXY','GIT_TRACE','GIT_CURL_VERBOSE'])assert.equal(c.env[key],undefined,key);}
    assert.ok(!f.logs.join('\n').includes(synthetic));
    assert.equal(process.env.GH_TOKEN,'must-not-inherit');
    const env=buildEnv();for(const key of Object.keys(env))assert.ok(!/credential|helper|GH_TOKEN|GIT_CONFIG/i.test(key));
    const upstream=publicGit(['credential','fill'],{url:UPSTREAM_URL,input:`url=${UPSTREAM_URL}\n\n`,env:selfFetchEnv(),timeout:5000});
    assert.notEqual(upstream.status,0);assert.equal(records(calls).length,gh.length,'upstream never calls gh');
  });
});

test('helper refuses wrong host/path, unsafe origin, duplicates, oversized requests and storage; real Git path scoping also holds',async()=>{
  await sandbox(async({calls})=>{
    for(const url of ['http://github.com/test-owner/private.git','https://github.com.evil/test-owner/private.git','https://user@github.com/test-owner/private.git','https://github.com:443/test-owner/private.git','https://github.com/test-owner/../private.git',UPSTREAM_URL])assert.equal(canonicalSelfOrigin(url),false,url);
    const valid='protocol=https\nhost=github.com\npath=test-owner/private.git\n\n';
    for(const input of [valid.replace('host=github.com','host=elsewhere.invalid'),valid.replace('private.git','other.git'),valid.replace('https','http'),valid.replace('\n\n','\nhost=github.com\n\n'),valid+'x'.repeat(8193)]){
      const r=spawnSync(process.execPath,[helper,URL,'get'],{env:selfFetchEnv(),encoding:'utf8',input,timeout:5000});assert.equal(r.stdout,'');
    }
    for(const op of ['store','erase'])assert.equal(spawnSync(process.execPath,[helper,URL,op],{env:selfFetchEnv(),encoding:'utf8',input:valid,timeout:5000}).stdout,'');
    for(const url of [UPSTREAM_URL,'https://github.com/test-owner/other.git','https://other.invalid/test-owner/private.git']){
      const r=publicGit(['credential','fill'],{url,config:selfFetchConfig(URL),env:selfFetchEnv(),input:`url=${url}\n\n`,timeout:5000});assert.notEqual(r.status,0);assert.ok(!r.stdout.includes(synthetic));
    }
    assert.equal(records(calls).length,0);
  });
});

test('actual HTTPS redirects before and after authentication are refused without following or exposing diagnostics',async()=>{
  for(const mode of ['redirect-before','redirect-after','failure']) await sandbox(async({f,calls,requests})=>{
    const before=f.head();assert.equal(await f.update({remote:null}),'skipped');assert.equal(f.head(),before);
    assert.ok(records(requests).length>0);assert.ok(records(requests).every(r=>r.url.startsWith('/test-owner/private.git/')));
    assert.ok(!f.logs.join('\n').includes(synthetic));assert.match(f.logs.at(-1),/private self-fetch failed/);
    if(mode==='redirect-before')assert.equal(records(calls).length,0);else assert.ok(records(calls).length>0);
  },mode);
});

test('repo transport injection is rejected before credentials or network; remote overrides remain anonymous',async()=>{
  await sandbox(async({f,calls,requests})=>{
    for(const [key,value] of [['credential.helper',`!touch '${path.join(f.dir,'injected-helper')}'`],['http.proxy','http://evil.invalid'],['url.https://evil.invalid/.insteadOf','https://github.com/'],['remote.origin.uploadpack','evil'],['remote.origin.proxy','http://evil.invalid']]){
      run(f.clone,['config',key,value]);assert.equal(await f.update({remote:null}),'skipped');run(f.clone,['config','--unset',key]);
      assert.equal(records(calls).length,0);assert.equal(records(requests).length,0);assert.ok(!fs.existsSync(path.join(f.dir,'injected-helper')));
    }
    assert.equal(await f.update({remote:URL}),'skipped');assert.equal(records(calls).length,0,'explicit HTTPS override has no helper');
    assert.equal(await f.update({remote:f.origin}),'skipped');assert.equal(records(calls).length,0,'local override is anonymous too');
    assert.ok(!f.logs.join('\n').includes(synthetic));
  });
});

test('failed, signalled or malformed gh replies return no credential or diagnostic',async()=>{
  await sandbox(async({f,bin})=>{
    const good=`protocol=https\nhost=github.com\nusername=test-user\npassword=${synthetic}\n`;
    for(const code of [
      `process.stdout.write(${JSON.stringify(good)});process.stderr.write(${JSON.stringify(synthetic)});process.exit(1);`,
      `process.stdout.write(${JSON.stringify(good)});process.kill(process.pid,'SIGTERM');`,
      `process.stdout.write(${JSON.stringify(good+'injected=value\n')});`,
    ]){
      fs.writeFileSync(path.join(bin,'gh'),`#!${process.execPath}\n${code}`,{mode:0o755});
      const r=spawnSync(process.execPath,[helper,URL,'get'],{env:selfFetchEnv(),encoding:'utf8',input:'protocol=https\nhost=github.com\npath=test-owner/private.git\n',timeout:5000});
      assert.equal(r.stdout,'');assert.equal(r.stderr,'');
      assert.equal(await f.update({remote:null}),'skipped');assert.ok(!f.logs.join('\n').includes(synthetic));
    }
  });
});
