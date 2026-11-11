import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportPayload } from '../bugReports.ts';
const valid = {reportId:'12345678-1234-1234-1234-123456789012', description:' Video freezes ', clientInfo:{platform:'Android', model:'Pixel'}, sessionStartedAt:'2026-11-11T12:00:00Z', log:'Started\nVideo failed'};
test('report validation preserves Unicode descriptions, metadata and complete logs', () => {
 const report = reportPayload(valid);
 assert.equal(report.description, 'Video freezes');
 assert.equal(report.log, valid.log);
 assert.deepEqual(report.clientInfo, {model:'Pixel',platform:'Android'});
 assert.doesNotThrow(() => reportPayload({...valid,description:'😀'.repeat(8000)}));
});
test('reports reject blank, oversized, malformed and unbounded diagnostic payloads', () => {
 for (const body of [null, {}, {...valid,description:'  '}, {...valid,description:'x'.repeat(8001)}, {...valid,reportId:'not-a-uuid'}, {...valid,clientInfo:[]}, {...valid,clientInfo:{model:{}}}, {...valid,sessionStartedAt:'yesterday'}]) assert.throws(() => reportPayload(body), {code:'INVALID_REPORT'});
 assert.throws(() => reportPayload({...valid,log:'😀'.repeat(2*1024*1024+1)}), {code:'REPORT_TOO_LARGE'});
});
