import type {IncomingMessage, ServerResponse} from 'node:http';
import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';

export class ProjectHttpError extends Error {
  // Project metadata is also loaded by the unbundled Node/Electron launchers.
  // Keep their transitive imports valid in native TypeScript strip-only mode.
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(value));
}

/** Authenticate before any project read or side effect; writes also require the exact Host origin. */
export function requireAuthenticatedRequest(ctx: Context, req: IncomingMessage, methods: readonly string[]): void {
  const rejection = ctx.connection.requestRejection(req);
  if (rejection !== undefined) throw new ProjectHttpError(rejection, 'unauthorized');
  if (!methods.includes(req.method ?? '')) throw new ProjectHttpError(405, 'method-not-allowed');
  if (req.method !== 'GET' && (req.headers.origin !== `http://127.0.0.1:${ctx.webServer.port}`
    || req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')) {
    throw new ProjectHttpError(403, 'same-origin-json-required');
  }
}

export async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const length = req.headers['content-length'];
  if (length !== undefined && Number(length) > limit) throw new ProjectHttpError(413, 'body-too-large');
  const chunks: Buffer[] = [];
  let size = 0;
  // Do not destroy the socket on an early limit rejection; the caller must send 413.
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {req.resume(); throw new ProjectHttpError(413, 'body-too-large');}
    chunks.push(buffer);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch {throw new ProjectHttpError(422, 'invalid-json');}
}

/** Never expose parser/schema exceptions: they may include private YAML or request values. */
export function sendProjectError(res: ServerResponse, error: unknown, methods: readonly string[]): void {
  const status = error instanceof ProjectHttpError ? error.status : 422;
  if (status === 405) res.setHeader('allow', methods.join(', '));
  sendJson(res, {error: error instanceof ProjectHttpError ? error.code : 'operation-failed'}, status);
}
