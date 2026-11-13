import * as Sentry from '@sentry/node';

export function sanitizeEvent<T extends Sentry.ErrorEvent>(event: T): T {
  delete event.request;
  delete event.user;
  delete event.extra;
  event.breadcrumbs = [];
  event.contexts = {};
  if (event.message) event.message = 'Application error';
  for (const exception of event.exception?.values ?? []) {
    exception.value = exception.type || 'Application error';
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
      if (frame.filename?.includes('?')) frame.filename = frame.filename.split('?')[0];
    }
  }
  return event;
}
export function initializeMonitoring() {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, databaseQueryData: false, stackFrameVariables: false },
    defaultIntegrations: false,
    integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration({ mode: 'strict' })],
    beforeSend: sanitizeEvent, maxBreadcrumbs: 0,
  });
}
export function captureServerError(error: unknown) {
  if (process.env.SENTRY_DSN) Sentry.captureException(error);
}
export const flushMonitoring = () => Sentry.flush(5000);
