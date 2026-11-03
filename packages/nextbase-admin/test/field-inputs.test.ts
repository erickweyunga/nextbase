// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import type {
  Collection,
  FileField,
  RecordModel,
  RelationField,
} from '@nextbasejs/client';
import { describe, expect, it } from 'vitest';
import {
  type FileValue,
  fileBody,
  relationOptions,
} from '../src/field-inputs.tsx';
import { labelOf } from '../src/record-text.ts';
import { FILE_STATUS, type FileRow } from '../src/ui/file-uploader/index.ts';

const users = {
  id: 'c_users',
  name: 'users',
  type: 'auth',
  fields: [
    { name: 'id', type: 'text', hidden: false },
    { name: 'email', type: 'email', hidden: false },
  ],
} as unknown as Collection;

const record = (fields: Record<string, unknown>) =>
  ({ id: 'r1', collectionId: 'c_posts', ...fields }) as RecordModel;

const file = (maxSelect: number) => ({ name: 'docs', maxSelect }) as FileField;

const row = (name: string, status: keyof typeof FILE_STATUS) =>
  ({ file: new File(['x'], name), status }) as FileRow;

describe('labelOf', () => {
  it('uses the first text-like value and falls back to the id', () => {
    expect(labelOf(users, record({ email: 'ada@example.com' }))).toBe(
      'ada@example.com',
    );
    expect(labelOf(users, record({ email: '' }))).toBe('r1');
  });
});

describe('relationOptions', () => {
  it('labels related ids from the expanded records', () => {
    const field = { name: 'author', maxSelect: 2 } as RelationField;
    expect(
      relationOptions(
        field,
        users,
        record({
          author: ['u1', 'u2'],
          expand: { author: [record({ id: 'u1', email: 'ada@example.com' })] },
        }),
      ),
    ).toEqual([
      { id: 'u1', label: 'ada@example.com' },
      { id: 'u2', label: 'u2' },
    ]);
  });
});

describe('fileBody', () => {
  it('keeps the remaining files and adds the processed ones', () => {
    const value: FileValue = {
      kept: ['a.png'],
      added: [
        row('b.png', FILE_STATUS.processed),
        row('c.png', FILE_STATUS.error),
      ],
    };
    const body = fileBody(file(5), value) as unknown[];
    expect(body[0]).toBe('a.png');
    expect(body).toHaveLength(2);
    expect((body[1] as File).name).toBe('b.png');
  });

  it('replaces a single file with a new one', () => {
    const value: FileValue = {
      kept: ['a.png'],
      added: [row('b.png', FILE_STATUS.processed)],
    };
    expect((fileBody(file(1), value) as File).name).toBe('b.png');
  });

  it('clears a single file once removed', () => {
    expect(fileBody(file(1), { kept: [], added: [] })).toBe('');
  });
});
