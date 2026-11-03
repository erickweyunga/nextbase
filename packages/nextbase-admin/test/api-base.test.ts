// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/admin"}
import { describe, expect, it } from 'vitest';
import { apiBasePath } from '../src/api.ts';

const page = (content: string | undefined): Document => {
  const doc = document.implementation.createHTMLDocument();
  if (content !== undefined) {
    const meta = doc.createElement('meta');
    meta.name = 'nextbase-base-path';
    meta.content = content;
    doc.head.append(meta);
  }
  return doc;
};

describe('apiBasePath', () => {
  it('takes the base path the server wrote into the page', () => {
    expect(apiBasePath(page('/api/nextbase'), '/admin')).toBe('/api/nextbase');
  });

  it('falls back to the page address, as the dev server serves it', () => {
    expect(apiBasePath(page(''), '/api/nextbase/_/')).toBe('/api/nextbase');
    expect(apiBasePath(page(undefined), '/backend/_')).toBe('/backend');
  });
});
