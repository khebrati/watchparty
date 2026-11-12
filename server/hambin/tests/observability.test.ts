import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ReportDelivery, feedbackEnvelope } from '../reportDelivery.ts';
import { sanitizeEvent } from '../observability.ts';

const row = {report_id:'12345678-1234-4234-8234-123456789012',description:'پخش قطع شد',
  client_info:{platform:'browser',build:'test',model:'Test device',token:'secret',name:'Private name'},
  app_log:'Started\nAuthorization: Bearer secret\nhttps://private.test/movie.mp4',sentry_attempts:0};
test('manual feedback has a stable ID, UTF8 byte lengths, redacted log and allowlisted context', () => {
  const body = feedbackEnvelope(row,'https://public@example.test/1','test');
  const lines = body.toString().split('\n');
  assert.equal(JSON.parse(lines[0]).event_id,row.report_id.replaceAll('-',''));
  assert.equal(JSON.parse(lines[1]).length,Buffer.byteLength(lines[2]));
  assert.equal(JSON.parse(lines[2]).contexts.feedback.message,row.description);
  assert.equal(JSON.parse(lines[2]).contexts.client.model,'Test device');
  const log = body.subarray(body.indexOf(Buffer.from(lines[3]))+Buffer.byteLength(lines[3])+1,-1);
  assert.equal(JSON.parse(lines[3]).length,log.length);
  assert.ok(!body.includes(Buffer.from('secret')));
  assert.ok(!body.includes(Buffer.from('Private name')));
  assert.ok(!body.includes(Buffer.from('private.test')));
});
test('delivery retries rejected/network sends and acknowledges only accepted envelopes', async () => {
  const queries: {sql:string; args?:unknown[]}[] = [];
  const db = {query:async (sql:string,args?:unknown[]) => {
    queries.push({sql,args});return {rows:sql.startsWith('SELECT')?[row]:[]};
  }} as unknown as Pool;
  let accept = false;
  const send = async () => new Response('',{status:accept?200:429});
  const delivery = new ReportDelivery(db,'https://public@example.test/1',send);
  await delivery.deliverDue();
  assert.ok(queries.some(q=>q.sql.includes('sentry_next_attempt_at=') && q.args?.[1]===15));
  assert.ok(!queries.some(q=>q.sql.includes('sentry_delivered_at=now()')));
  queries.length=0;accept=true;
  await delivery.deliverDue();
  assert.ok(queries.some(q=>q.sql.includes('sentry_delivered_at=now()')));
});
test('automatic errors retain stack locations without request bodies, user fields or exception content', () => {
  const event = sanitizeEvent({type:undefined, request:{data:'chat content'},user:{email:'private@test'},extra:{token:'secret'},
    exception:{values:[{type:'TypeError',value:'private movie URL',stacktrace:{frames:[{filename:'app.ts?token=secret',lineno:12,vars:{password:'secret'}}]}}]}});
  assert.equal(event.request,undefined);
  assert.equal(event.exception.values[0].value,'TypeError');
  assert.equal(event.exception.values[0].stacktrace.frames[0].lineno,12);
  assert.ok(!JSON.stringify(event).includes('secret'));
});
test('Sentry quota cooldown pauses the whole queue instead of sending other pending reports', async () => {
  let reads=0; let sends=0;
  const db = {query:async (sql:string) => {
    if (sql.startsWith('SELECT')) { reads++; return {rows:[row,{...row,report_id:'22345678-1234-4234-8234-123456789012'}]}; }
    return {rows:[]};
  }} as unknown as Pool;
  const delivery=new ReportDelivery(db,'https://public@example.test/1',async()=>{
    sends++;return new Response('',{status:429,headers:{'Retry-After':'120'}});
  });
  await delivery.deliverDue();
  await delivery.deliverDue();
  assert.equal(sends,1); assert.equal(reads,1);
});
