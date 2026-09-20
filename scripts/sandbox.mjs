#!/usr/bin/env node
// Fresh isolated state every launch. Never reads credentials or invokes Claude.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const state=mkdtempSync(join(tmpdir(),'xarts-chat-sandbox-'));
process.env.XARTS_CHAT_RUNS=join(state,'runs');process.env.XARTS_CHAT_DB=join(state,'data.sqlite');
process.env.XARTS_CHAT_SANDBOX='ui-fixture';delete process.env.PROMOTE_REGISTRY;
const db=new DatabaseSync(process.env.XARTS_CHAT_DB);
db.exec("CREATE TABLE _about(key TEXT,value TEXT); INSERT INTO _about VALUES('company','Sandbox fixtures'); CREATE TABLE _dictionary(table_name TEXT,column_name TEXT,unit TEXT,description TEXT); CREATE TABLE sandbox_revenue(region TEXT,revenue REAL); INSERT INTO sandbox_revenue VALUES('North',120),('South',80);");db.close();
const {fixtureRun}=await import('../server/sandbox-fixtures.mjs');
for(const [i,conversationId] of [[1,'11111111-1111-4111-8111-111111111111'],[2,'11111111-1111-4111-8111-111111111111'],[3,'22222222-2222-4222-8222-222222222222']]) fixtureRun({runId:`20260920T00000${i}-aaaaaaaa`,conversationId,message:`Sandbox saved request ${i}`});
console.log('UI FIXTURE SANDBOX · no paid calls · no SDK verification. State: '+state);
await import('../server/main.mjs');
