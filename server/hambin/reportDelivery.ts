import { logHandledException } from './diagnostics.ts';
import type { Pool } from 'pg';
interface ReportRow {
  report_id: string; description: string; client_info: Record<string, string>;
  app_log: string; sentry_attempts: number;
}
export function redactDiagnostic(value: string): string {
  return value.replace(/(?:https?|wss?|content|file|blob):[^\s"'<>]+/gi, '[url]')
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
    .replace(/(["']?(?:accessToken|refreshToken|authorization|password|credential|ticket|token)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]');
}
/** Explicit transport acknowledges HTTP acceptance rather than SDK enqueue. */
export function feedbackEnvelope(report: ReportRow, dsn: string, environment: string): Buffer {
  const eventId = report.report_id.replaceAll('-', '');
  const feedback = JSON.stringify({
    event_id: eventId, type: 'feedback', environment,
    contexts: { feedback: { message: redactDiagnostic(report.description), source: 'custom' },
      client: Object.fromEntries(Object.entries(report.client_info)
        .filter(([key]) => ['platform','build','appVersion','appVersionCode','os','osVersion','sdk','manufacturer','model','architecture','runtime','userAgent','locale','language','screen','viewport','density'].includes(key))
        .map(([key, value]) => [key, redactDiagnostic(value)])) },
    tags: { report_id: report.report_id, source: 'manual-report' },
  });
  const log = Buffer.from(redactDiagnostic(report.app_log), 'utf8');
  return Buffer.concat([
    Buffer.from(JSON.stringify({ event_id: eventId, dsn }) + '\n' + JSON.stringify({ type: 'feedback', length: Buffer.byteLength(feedback) }) + '\n' + feedback + '\n'),
    Buffer.from(JSON.stringify({ type: 'attachment', length: log.length, filename: 'session.log', content_type: 'text/plain', attachment_type: 'event.attachment' }) + '\n'),
    log, Buffer.from('\n'),
  ]);
}
export class ReportDelivery {
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private stopped = false;
  private pausedUntil = 0;
  private db: Pool;
  private dsn?: string;
  private send: typeof fetch;
  constructor(db: Pool, dsn = process.env.SENTRY_DSN, send: typeof fetch = fetch) {
    this.db = db; this.dsn = dsn; this.send = send;
  }
  start() {
    if (!this.dsn) return;
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref(); this.tick();
  }
  private tick() {
    if (!this.stopped && !this.flight) {
      this.flight = this.deliverDue().catch((handledError) => {
        logHandledException("reportDelivery.tick.1", handledError);
        console.error(JSON.stringify({event:'report_delivery_failed'}));
      }).finally(() => { this.flight = undefined; });
    }
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.flight; }
  async deliverDue() {
    if (!this.dsn || Date.now() < this.pausedUntil) return;
    const dsn = new URL(this.dsn);
    const project = dsn.pathname.split('/').pop();
    if (!project || dsn.protocol !== 'https:') throw new Error('Invalid Sentry DSN');
    const endpoint = new URL(`/api/${project}/envelope/`, dsn.origin);
    const rows = await this.db.query<ReportRow>(`SELECT report_id,description,client_info,app_log,sentry_attempts
      FROM bug_reports WHERE sentry_delivered_at IS NULL AND sentry_next_attempt_at <= now()
      AND created_at > now()-interval '30 days' ORDER BY sentry_next_attempt_at LIMIT 5`);
    for (const row of rows.rows) {
      if (this.stopped) break;
      let retryAfter = 0;
      try {
        const response = await this.send(endpoint, { method: 'POST',
          headers: {'Content-Type':'application/x-sentry-envelope',
            'X-Sentry-Auth': `Sentry sentry_version=7,sentry_key=${dsn.username},sentry_client=hambin-report-delivery/1.0`},
          body: new Uint8Array(feedbackEnvelope(row, this.dsn, process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development')),
          signal: AbortSignal.timeout(10000),
        });
        const retry = response.headers.get('retry-after');
        if (retry) retryAfter = Number.isFinite(Number(retry)) ? Number(retry) : Math.max(0, (Date.parse(retry) - Date.now()) / 1000);
        for (const limit of (response.headers.get('x-sentry-rate-limits') || '').split(',')) {
          const seconds = Number(limit.split(':')[0]);
          if (Number.isFinite(seconds)) retryAfter = Math.max(retryAfter, seconds);
        }
        await response.arrayBuffer();
        if (!response.ok) throw new Error('Sentry rejected report');
        await this.db.query('UPDATE bug_reports SET sentry_delivered_at=now(),sentry_attempts=sentry_attempts+1 WHERE report_id=$1', [row.report_id]);
      } catch (handledError) {
        logHandledException("reportDelivery.deliverDue.2", handledError);
        const delay = Math.max(Math.min(86400, retryAfter || 0), Math.min(3600, 15 * 2 ** Math.min(row.sentry_attempts, 8)));
        await this.db.query("UPDATE bug_reports SET sentry_attempts=sentry_attempts+1,sentry_next_attempt_at=now()+$2*interval '1 second' WHERE report_id=$1", [row.report_id, delay]);
        if (retryAfter > 0) { this.pausedUntil = Date.now() + delay * 1000; break; }
      }
    }
  }
}
