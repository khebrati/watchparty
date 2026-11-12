import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { start } from '../main.ts';
import { config } from '../config.ts';
import { BugReports } from '../bugReports.ts';
import { ReportDelivery } from '../reportDelivery.ts';

test('durable Sentry queue preserves acceptance, excludes historical reports and recovers after delivery failure',
  {skip:process.env.HAMBIN_INTEGRATION !== 'true'}, async () => {
    const app = await start({...config(),port:0});
    const reportId = randomUUID();
    let identityId: string | undefined;
    try {
      const user = await app.auth!.create({name:'Delivery tester',avatar:'comet',language:'en'});
      identityId = user.identity.id;
      const room = (await app.rooms!.create(identityId,'Delivery verification',randomUUID())).body.room;
      const reports = new BugReports(app.db);
      const report = {reportId,description:'Synthetic report',clientInfo:{platform:'test'},sessionStartedAt:new Date().toISOString(),log:'Synthetic log'};
      await reports.submit(identityId,room.id,report);
      await reports.submit(identityId,room.id,report);
      assert.equal((await app.db.query('SELECT count(*)::int AS n FROM bug_reports WHERE report_id=$1',[reportId])).rows[0].n,1);
      await app.db.query('UPDATE bug_reports SET sentry_next_attempt_at=NULL WHERE report_id=$1',[reportId]);
      let sends=0;
      const unavailable = new ReportDelivery(app.db,'https://public@example.test/1',async () => {sends++;return new Response('',{status:503});});
      await unavailable.deliverDue(); assert.equal(sends,0);
      await app.db.query('UPDATE bug_reports SET sentry_next_attempt_at=now() WHERE report_id=$1',[reportId]);
      await unavailable.deliverDue(); assert.equal(sends,1);
      const pending=(await app.db.query('SELECT sentry_attempts,sentry_delivered_at FROM bug_reports WHERE report_id=$1',[reportId])).rows[0];
      assert.equal(pending.sentry_attempts,1); assert.equal(pending.sentry_delivered_at,null);
      await app.db.query('UPDATE bug_reports SET sentry_next_attempt_at=now() WHERE report_id=$1',[reportId]);
      const recovered = new ReportDelivery(app.db,'https://public@example.test/1',async () => {sends++;return new Response('',{status:200});});
      await recovered.deliverDue();
      assert.ok((await app.db.query('SELECT sentry_delivered_at FROM bug_reports WHERE report_id=$1',[reportId])).rows[0].sentry_delivered_at);
      await recovered.deliverDue(); assert.equal(sends,2);
    } finally {
      await app.db.query('DELETE FROM bug_reports WHERE report_id=$1',[reportId]);
      await app.stop();
    }
  });
