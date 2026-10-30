import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/** An object in the fake bucket. */
interface FakeObject {
  body: Buffer;
  contentType: string;
}

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  objects: Map<string, FakeObject>;
  /** Every request, as `METHOD /path?query`, for checking what was sent. */
  requests: string[];
  /** While set, PUT requests wait for it, to test what happens meanwhile. */
  hold: Promise<void> | undefined;
  /** While set, GET requests for objects wait for it. */
  holdGets: Promise<void> | undefined;
  stop(): Promise<void>;
}

/**
 * Enough of the S3 API, with path-style addressing, to test storage through
 * the real AWS SDK: put (and copy), get with ranges, head, batch delete and
 * list, and signed URLs. Signatures are not checked.
 */
export async function startFakeS3(bucket = 'test-bucket'): Promise<FakeS3> {
  const objects = new Map<string, FakeObject>();
  const requests: string[] = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const [, name, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    if (name !== bucket) return error(response, 404, 'NoSuchBucket');
    // A client that hangs up while sending, as an aborted upload does.
    const body = await readBody(request).catch(() => undefined);
    if (!body) return;

    if (
      request.method === 'GET' &&
      key === '' &&
      url.searchParams.has('list-type')
    ) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      return xml(
        response,
        200,
        `<ListBucketResult><Name>${bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys
          .map(
            (k) =>
              `<Contents><Key>${escapeXml(k)}</Key><Size>${objects.get(k)?.body.length}</Size></Contents>`,
          )
          .join('')}</ListBucketResult>`,
      );
    }
    if (
      request.method === 'POST' &&
      key === '' &&
      url.searchParams.has('delete')
    ) {
      for (const match of body.toString().matchAll(/<Key>(.*?)<\/Key>/g)) {
        objects.delete(unescapeXml(match[1] as string));
      }
      return xml(response, 200, '<DeleteResult></DeleteResult>');
    }
    if (request.method === 'PUT') {
      await fake.hold;
      const source = request.headers['x-amz-copy-source'];
      if (typeof source === 'string') {
        const from = decodeURIComponent(source).replace(/^\/?[^/]+\//, '');
        const object = objects.get(from);
        if (!object) return error(response, 404, 'NoSuchKey');
        objects.set(key, { ...object });
        return xml(
          response,
          200,
          `<CopyObjectResult><ETag>"copied"</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`,
        );
      }
      const chunked = String(
        request.headers['content-encoding'] ?? '',
      ).includes('aws-chunked');
      objects.set(key, {
        body: chunked ? decodeAwsChunked(body) : body,
        contentType: String(request.headers['content-type'] ?? ''),
      });
      response.writeHead(200, { etag: '"stored"' });
      return response.end();
    }
    const object = objects.get(key);
    if (request.method === 'HEAD') {
      if (!object) {
        response.writeHead(404);
        return response.end();
      }
      response.writeHead(200, {
        'content-length': object.body.length,
        'content-type': object.contentType,
      });
      return response.end();
    }
    if (request.method === 'GET') {
      await fake.holdGets;
      if (!object) return error(response, 404, 'NoSuchKey');
      const headers: Record<string, string | number> = {
        // Signed URLs may override how the object is presented, as on S3.
        'content-type':
          url.searchParams.get('response-content-type') ?? object.contentType,
        ...(url.searchParams.has('response-content-disposition') && {
          'content-disposition': url.searchParams.get(
            'response-content-disposition',
          ) as string,
        }),
      };
      const range = /^bytes=(\d+)-(\d+)$/.exec(
        String(request.headers.range ?? ''),
      );
      if (range) {
        const part = object.body.subarray(
          Number(range[1]),
          Number(range[2]) + 1,
        );
        response.writeHead(206, { ...headers, 'content-length': part.length });
        return response.end(part);
      }
      response.writeHead(200, {
        ...headers,
        'content-length': object.body.length,
      });
      return response.end(object.body);
    }
    return error(response, 405, 'MethodNotAllowed');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeS3 = {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    requests,
    hold: undefined,
    holdGets: undefined,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return fake;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** The data of an `aws-chunked` body: `<hex size>[;ext]\r\n<data>\r\n...0\r\n<trailers>`. */
function decodeAwsChunked(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = body.indexOf('\r\n', at);
    const size = Number.parseInt(
      body.subarray(at, lineEnd).toString().split(';')[0] as string,
      16,
    );
    if (!size) break;
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

function xml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'application/xml' });
  response.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
}

function error(response: ServerResponse, status: number, code: string): void {
  xml(
    response,
    status,
    `<Error><Code>${code}</Code><Message>${code}</Message></Error>`,
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
