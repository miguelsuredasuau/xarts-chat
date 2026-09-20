// Explicit UI test double. Never a substitute for SDK, model or release evidence.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RUNS_DIR } from '../lib/paths.mjs';
import { buildRecord, writeRecord } from './record.mjs';
export const sandboxRelease = {kind:'fixture',label:'Sandbox fixtures · no SDK or model',sourceSha:'0'.repeat(40),packageHash:'0'.repeat(64),version:'test',shims:[],note:'Synthetic UI test double. Not release evidence.'};
export function fixtureRun({runId,conversationId,message,startedAt=new Date().toISOString()}) {
 const dir=join(RUNS_DIR,runId);mkdirSync(dir,{recursive:true});
 const data=[{region:'North',revenue:120},{region:'South',revenue:80}];
 const spec={chartId:'bar',header:{title:'Synthetic revenue — sandbox fixture'}};
 const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 340"><rect width="600" height="340" fill="#f7f5ef"/><text x="30" y="42" font-size="22">Synthetic revenue — UI fixture</text><rect x="100" y="100" width="130" height="180" fill="#2557bd"/><rect x="320" y="160" width="130" height="120" fill="#249c9c"/><text x="130" y="310">North · 120</text><text x="350" y="310">South · 80</text></svg>';
 writeFileSync(join(dir,'chart-1.svg'),svg);writeFileSync(join(dir,'chart-1.spec.json'),JSON.stringify(spec));writeFileSync(join(dir,'chart-1.data.json'),JSON.stringify({rows:data,rowCount:data.length,sql:'SELECT region, revenue FROM sandbox_revenue',dataHash:createHash('sha256').update(JSON.stringify(data)).digest('hex')}));
 const render={tool:'chart_render',artifact:'chart-1',chartId:'bar',rows:2,sql:'SELECT region, revenue FROM sandbox_revenue',checks:[],warnings:['UI fixture; not SDK output']};
 appendFileSync(join(dir,'tools.jsonl'),JSON.stringify(render)+'\n');
 const rec=buildRecord({runId,conversationId,message,release:sandboxRelease,result:{isError:false},exitCode:0,startedAt,finalText:'Synthetic chart for testing history, evidence and feedback. No model or SDK ran.'});
 rec.testMode='ui-fixture';rec.agent={runner:'fixture',completion:'confirmed',usage:null};rec.checksNote='No SDK or release gates executed.';writeRecord(rec);
 return {record:rec,render};
}
