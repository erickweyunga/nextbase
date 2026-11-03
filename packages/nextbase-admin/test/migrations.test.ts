// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3001/api/nextbase/_/"}
import type { MigrationModel } from '@nextbasejs/client';
import { describe, expect, it } from 'vitest';
import { migrationState } from '../src/migrations.tsx';

const migration = (fields: Partial<MigrationModel>): MigrationModel => ({
  name: '1762200000_created_posts',
  applied: '2026-11-02T11:28:00.000Z',
  file: true,
  revertible: true,
  ...fields,
});

describe('migrationState', () => {
  it('names pending, applied and removed migrations', () => {
    expect(migrationState(migration({ applied: null }))).toBe('Pending');
    expect(migrationState(migration({}))).toBe('Applied');
    expect(migrationState(migration({ file: false }))).toBe(
      'Applied, file removed',
    );
  });
});
