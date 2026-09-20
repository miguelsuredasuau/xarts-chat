import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import puppeteer from 'puppeteer-core';

test('sandbox app: history, reload, feedback attribution, chart tabs and SQL refusal', {timeout:60000},async()=>{
 const executablePath=process.env.CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);
 assert.ok(executablePath,'Install Chromium or set CHROME_PATH; browser checks must not silently skip');
 const child=spawn(process.execPath,['--no-warnings','scripts/sandbox.mjs'],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
 let output='';let browser;
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Sandbox startup timed out: '+output)),15000);child.stdout.on('data',b=>{output+=b;const m=output.match(/xarts-chat on (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.on('exit',code=>{clearTimeout(timer);reject(Error('Sandbox exited '+code));});});
  browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();await page.setViewport({width:1440,height:1000});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.waitForSelector('#history-list button');
  assert.equal(await page.$$eval('#history-list button',nodes=>nodes.length),3);
  assert.match(await page.$eval('#release',e=>e.textContent),/UI SANDBOX/);
  await page.click('#history-list button');await page.waitForSelector('#feedback:not([hidden])');
  const feedbackRequest=page.waitForRequest(r=>r.url().endsWith('/api/feedback')&&r.method()==='POST');
  await page.click('[data-rate="up"]');
  await page.waitForFunction(()=>document.querySelector('[data-rate="up"]').getAttribute('aria-pressed')==='true');
  const feedback=await (await fetch(url+'/api/feedback/20260920T000003-aaaaaaaa')).json();
  assert.equal(feedback.feedback[0].value,'up');
  assert.equal(JSON.parse((await feedbackRequest).postData()).conversationId,'22222222-2222-4222-8222-222222222222');
  await page.click('[data-tab="data"]');await page.waitForFunction(()=>document.querySelector('#data-panel').textContent.includes('sandbox_revenue'));
  await page.reload();await page.waitForSelector('#history-list button');assert.equal(await page.$$eval('#history-list button',n=>n.length),3);
  const sql=await fetch(url+'/api/sql',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:JSON.stringify({sql:'DELETE FROM sandbox_revenue'})}).then(r=>r.json());assert.equal(sql.ok,false);
  const state=await fetch(url+'/api/state').then(r=>r.json());assert.equal(state.agent.runner,'fixture');assert.equal(state.testMode,'ui-fixture');
  const destination=process.env.TEST_ARTIFACTS || '.local/test-artifacts';mkdirSync(destination,{recursive:true});await page.screenshot({path:join(destination,'history.png'),fullPage:true});
  assert.deepEqual(errors,[]);writeFileSync(join(destination,'summary.json'),JSON.stringify({mode:'ui-fixture',checks:['history','reload','feedback attribution','data tab','SQL refusal'],errors},null,2));
 }finally{await browser?.close();child.kill('SIGTERM');}
});
