/** Keep diagnostics useful without copying request bodies, headers, or credentials. */
export function redactSecrets(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_*-]+/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)["']?\s*[:=]\s*["']?)[^\s,;"'}&]+/gi, '$1[REDACTED]');
}

export interface SerializedError {
  name?: string;
  message: string;
  status?: number;
  code?: string;
  requestId?: string;
  cause?: SerializedError;
}

export function serializeError(error: unknown, seen = new WeakSet<object>(), depth = 0): SerializedError {
  if (typeof error === 'string') return { message: redactSecrets(error) };
  if (!error || typeof error !== 'object') return { message: 'Unknown error' };
  if (seen.has(error)) return { message: '[Circular error]' };
  if (depth >= 5) return { message: '[Error cause depth limit]' };
  seen.add(error);
  const value = error as Record<string, unknown>;
  const nested = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : undefined;
  const rawMessage = value.message ?? nested?.message;
  const result: SerializedError = {
    message: typeof rawMessage === 'string' ? redactSecrets(rawMessage) : 'Unknown error'
  };
  if (typeof value.name === 'string') result.name = redactSecrets(value.name);
  if (typeof value.status === 'number') result.status = value.status;
  const code = value.code ?? nested?.code;
  if (typeof code === 'string') result.code = redactSecrets(code);
  const requestId = value.requestId ?? value.requestID ?? value.request_id ?? value._request_id;
  if (typeof requestId === 'string') result.requestId = redactSecrets(requestId);
  if (value.cause !== undefined) {
    result.cause = serializeError(value.cause, seen, depth + 1);
  }
  return result;
}

export function errorMessage(error: unknown): string {
  return serializeError(error).message;
}

export function safeJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, current: unknown) =>
      typeof current === 'bigint' ? current.toString() : current
    )
  ) as unknown;
}
