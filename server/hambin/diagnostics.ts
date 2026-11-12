/** Local operator diagnostics. Never serialize request bodies or arbitrary thrown objects. */
export function redactException(value: string): string {
  return value.replace(/(?:https?|wss?|content|file|blob):[^\s"'<>]+/gi, '[url]')
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
    .replace(/(["']?(?:accessToken|refreshToken|authorization|password|credential|ticket|token)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]');
}

export function logHandledException(operation: string, error: unknown): void {
  try {
    const seen = new Set<unknown>();
    const details = (value: unknown, depth = 0): Record<string, unknown> => {
      if (depth > 5 || seen.has(value)) return { message: '[cause cycle or depth limit]' };
      seen.add(value);
      if (value instanceof Error) return {
        name: value.name, message: redactException(value.message),
        stack: redactException((value.stack || '').replace(/(?:https?|file|blob):[^\s)]+/gi, url => {
          const location = url.split(/[?#]/, 1)[0];
          return '[source]/' + location.substring(location.lastIndexOf('/') + 1);
        })),
        ...(value.cause === undefined ? {} : { cause: details(value.cause, depth + 1) }),
        ...(value instanceof AggregateError ? { errors: value.errors.slice(0, 10).map(cause => details(cause, depth + 1)) } : {}),
      };
      if (value && typeof value === 'object') {
        const item = value as { name?: unknown; message?: unknown; code?: unknown };
        return { name: typeof item.name === 'string' ? redactException(item.name) : 'NonError',
          message: typeof item.message === 'string' ? redactException(item.message) : '[non-Error exception]',
          code: typeof item.code === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(item.code) ? item.code : 'UNKNOWN' };
      }
      return { name: 'NonError', message: redactException(String(value)) };
    };
    console.warn(JSON.stringify({ event: 'exception.handled', operation, ...details(error) }));
  } catch { /* Logging must not break recovery or recursively log itself. */ }
}
