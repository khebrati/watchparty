import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { start } from '../main.ts';
import { BugReports } from '../bugReports.ts';
import { config } from '../config.ts';
test('bug report HTTP auth, database persistence, private membership, durable retry, conflicts and retention', {skip:process.env.HAMBIN_INTEGRATION !== 'true'}, async () => {
 const app = await start({...config(),port:0});
 const base = `http://127.0.0.1:${(app.server!.address() as {port:number}).port}`;
 const users: string[] = [];
 try {
  const user = await app.auth!.create({name:'Report tester',avatar:'comet',language:'en'}); users.push(user.identity.id);
  const other = await app.auth!.create({name:'Other tester',avatar:'comet',language:'en'}); users.push(other.identity.id);
  const room = (await app.rooms!.create(user.identity.id,'Report test',randomUUID())).body.room;
  const report = {reportId:randomUUID(),description:'Playback stopped',clientInfo:{platform:'browser',userAgent:'test'},sessionStartedAt:new Date().toISOString(),log:'Application started\n'+'event\n'.repeat(3000),screenshots:[{contentType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII='}]};
  const send = (token:string, body:unknown=report) => fetch(`${base}/v1/rooms/${room.id}/bug-reports`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await send('invalid')).status,401);
  assert.equal((await send(other.accessToken)).status,403);
  assert.equal((await send(user.accessToken)).status,201);
  const rows = await app.db.query('SELECT * FROM bug_reports WHERE report_id=$1',[report.reportId]);
  assert.equal(rows.rows[0].app_log,report.log);
  assert.deepEqual(rows.rows[0].screenshots,report.screenshots);
  assert.equal(rows.rows[0].identity_id,user.identity.id);
  assert.equal((await send(user.accessToken)).status,201);
  assert.equal((await send(user.accessToken,{...report,description:'Changed'})).status,409);
  assert.equal((await send(user.accessToken,{...report,screenshots:[]})).status,409);
  assert.equal(Number((await app.db.query('SELECT count(*) FROM bug_reports WHERE report_id=$1',[report.reportId])).rows[0].count),1);
  await app.db.query("UPDATE bug_reports SET created_at=now()-interval '31 days' WHERE report_id=$1",[report.reportId]);
  await new BugReports(app.db).purge();
  assert.equal((await app.db.query('SELECT 1 FROM bug_reports WHERE report_id=$1',[report.reportId])).rowCount,0);
 } finally {
  await app.db.query('DELETE FROM bug_reports WHERE identity_id=ANY($1::uuid[])',[users]);
  await app.stop();
 }
});
