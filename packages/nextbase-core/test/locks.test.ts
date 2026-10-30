import { afterAll, beforeAll, expect, it } from 'vitest';
import { NextBase } from '../src/index.ts';
import { createTestDatabase, type TestDatabase } from './postgres.ts';
import { waitFor, waitsForLock } from './wait.ts';

let t: TestDatabase;
let nextbase: NextBase;

beforeAll(async () => {
  t = await createTestDatabase();
  nextbase = new NextBase({ database: t.pool });
});

afterAll(async () => {
  // Log entries still waiting would be written to an ended pool.
  await nextbase.flush();
  await t.close();
});

it('updates a record while another request creates a record that references it', async () => {
  const admin = nextbase.client({ superuser: true });
  const posts = await admin.collections.create({
    name: 'posts',
    fields: [{ name: 'title', type: 'text' }],
  });
  await admin.collections.create({
    name: 'comments',
    fields: [{ name: 'post', type: 'relation', collectionId: posts.id }],
  });
  const post = await admin.collection('posts').create({ title: 'draft' });

  // Creating a comment holds this lock on its post until it commits.
  const client = await t.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT id FROM nextbase.posts WHERE id = $1 FOR KEY SHARE',
      [post?.id],
    );
    let done = false;
    const update = admin
      .collection('posts')
      .update(post?.id ?? '', { title: 'final' })
      .finally(() => {
        done = true;
      });
    // However long the update takes, it must never wait for the lock.
    await waitFor(async () => {
      if (done) return true;
      if (await waitsForLock(t.pool)) {
        throw new Error("The update waited for the comment's lock.");
      }
      return false;
    }, 'the update');
    expect(await update).toMatchObject({ title: 'final' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
