import { ClientError, NextBaseClient } from '@nextbasejs/client';
import { describe, expect, it } from 'vitest';
import { NextBase, type Pool } from '../src/index.ts';

const origin = 'http://localhost:3000';

describe('route handler', () => {
  // No database, so no log either.
  const { handle } = new NextBase({ logs: false });

  it('reports health', async () => {
    const response = await handle(new Request(`${origin}/api/nextbase/health`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('serves the embedded admin UI', async () => {
    const response = await handle(new Request(`${origin}/api/nextbase/_`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(await response.text()).toContain('NextBase');
  });

  it('serves the admin UI with a trailing slash without redirecting', async () => {
    const response = await handle(new Request(`${origin}/api/nextbase/_/`));
    expect(response.status).toBe(200);
  });

  it('returns the error shape for unknown routes', async () => {
    const response = await handle(new Request(`${origin}/api/nextbase/nope`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      status: 404,
      message: 'Not found.',
      data: {},
    });
  });

  it('honours a custom base path', async () => {
    const custom = new NextBase({ basePath: '/backend/', logs: false });
    const response = await custom.handle(
      new Request(`${origin}/backend/health`),
    );
    expect(response.status).toBe(200);
  });

  it('rejects a base path that is not an absolute URL path', () => {
    for (const basePath of [
      'api/nextbase',
      '',
      '//evil.example',
      '/api nextbase',
      '/api/../nextbase',
      '/api?x=1',
      '/api#x',
    ]) {
      expect(() => new NextBase({ basePath })).toThrow(TypeError);
    }
    expect(() => new NextBase({ basePath: 'api/nextbase' })).toThrow(
      'basePath must be an absolute URL path such as "/api/nextbase", not "api/nextbase".',
    );
    expect(() => new NextBase({ basePath: '/' })).not.toThrow();
  });
});

describe('client', () => {
  const { handle } = new NextBase({ logs: false });
  // Calls the handler in-process: the same path server components will use.
  const client = new NextBaseClient({
    baseUrl: `${origin}/api/nextbase`,
    fetch: (input, init) => handle(new Request(input, init)),
  });

  it('calls health', async () => {
    await expect(client.health()).resolves.toEqual({ status: 'ok' });
  });

  it('rejects in-process requests once their signal aborts, as fetch does', async () => {
    // A database that never answers, so requests wait until aborted.
    const never = new Promise<never>(() => {});
    const stuck = new NextBase({
      database: { query: () => never, connect: () => never } as unknown as Pool,
    }).client();
    const aborted = await stuck
      .collection('posts')
      .getList(1, 30, { signal: AbortSignal.abort() })
      .catch((e: unknown) => e);
    expect(aborted).toBeInstanceOf(ClientError);
    expect(aborted).toMatchObject({ status: 0, isAbort: true });

    const controller = new AbortController();
    const pending = stuck
      .collection('posts')
      .getList(1, 30, { signal: controller.signal })
      .catch((e: unknown) => e);
    controller.abort();
    expect(await pending).toMatchObject({ status: 0, isAbort: true });
  });

  it('throws ClientError with the API error body', async () => {
    const broken = new NextBaseClient({
      baseUrl: `${origin}/api/nextbase/missing`,
      fetch: (input, init) => handle(new Request(input, init)),
    });
    const err = await broken.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect(err).toMatchObject({ status: 404, message: 'Not found.' });
  });
});
