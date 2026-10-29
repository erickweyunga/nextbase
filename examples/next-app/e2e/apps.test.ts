import { filter } from '@nextbasejs/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api } from './client.ts';
import { type Server, startServer } from './server.ts';
import { firstSuperuser } from './setup.ts';

type Rec = Record<string, unknown> & { id: string };

let server: Server;
let admin: Api;

beforeAll(async () => {
  server = await startServer();
  admin = await firstSuperuser(server);

  const users = await admin.send('POST', '/collections', {
    name: 'users',
    type: 'auth',
    listRule: '',
    viewRule: '',
    createRule: '',
    updateRule: 'id = @request.auth.id',
    fields: [{ name: 'name', type: 'text', required: true }],
  });
  expect(users.status).toBe(200);
});

afterAll(() => server?.stop());

async function newCollection(body: Record<string, unknown>): Promise<string> {
  const reply = await admin.send('POST', '/collections', body);
  if (reply.status !== 200)
    throw new Error(`${reply.status}: ${JSON.stringify(reply.body)}`);
  return reply.body.id as string;
}

async function usersId(): Promise<string> {
  return (await admin.send('GET', '/collections/users')).body.id as string;
}

describe('a blog', () => {
  let alice: { api: Api; id: string };
  let bob: { api: Api; id: string };
  const posts: Record<string, Rec> = {};

  beforeAll(async () => {
    const users = await usersId();
    const postsId = await newCollection({
      name: 'posts',
      listRule: 'status = "published" || author = @request.auth.id',
      viewRule: 'status = "published" || author = @request.auth.id',
      createRule: '@request.auth.id != "" && author = @request.auth.id',
      updateRule:
        'author = @request.auth.id && @request.body.author:isset = false',
      deleteRule: 'author = @request.auth.id',
      fields: [
        {
          id: 'title00000',
          name: 'title',
          type: 'text',
          required: true,
          max: 200,
        },
        {
          id: 'slug000000',
          name: 'slug',
          type: 'text',
          required: true,
          pattern: '^[a-z0-9-]+$',
        },
        { name: 'body', type: 'text', max: 20000 },
        {
          name: 'status',
          type: 'select',
          values: ['draft', 'published'],
          required: true,
        },
        {
          name: 'tags',
          type: 'select',
          values: ['next', 'postgres', 'react'],
          maxSelect: 3,
        },
        {
          name: 'author',
          type: 'relation',
          collectionId: users,
          required: true,
        },
        { name: 'created', type: 'autodate' },
        { name: 'updated', type: 'autodate', onUpdate: true },
      ],
      indexes: [
        { name: 'posts_slug', unique: true, fields: ['slug000000'] },
        { name: 'posts_title_search', type: 'trigram', fields: ['title00000'] },
      ],
    });
    await newCollection({
      name: 'comments',
      listRule: 'post.status = "published"',
      viewRule: 'post.status = "published"',
      createRule:
        '@request.auth.id != "" && author = @request.auth.id && post.status = "published"',
      deleteRule: 'author = @request.auth.id || post.author = @request.auth.id',
      fields: [
        {
          name: 'post',
          type: 'relation',
          collectionId: postsId,
          required: true,
          cascadeDelete: true,
        },
        {
          name: 'author',
          type: 'relation',
          collectionId: users,
          required: true,
        },
        { name: 'text', type: 'text', required: true },
      ],
    });
    const anonymous = new Api(server.api);
    alice = await anonymous.signup('alice@example.com', 'Alice');
    bob = await anonymous.signup('bob@example.com', 'Bob');
  });

  it('lets authors write posts and only publishes what they publish', async () => {
    for (const [key, title, status, tags] of [
      ['intro', 'Getting started with Next.js 🚀', 'published', ['next']],
      ['quotes', 'He said "hi" \\ then left', 'published', ['react']],
      ['draft', 'Postgres internals (draft)', 'draft', ['postgres']],
    ] as const) {
      const reply = await alice.api.create<Rec>('posts', {
        title,
        slug: key,
        body: 'Lorem ipsum '.repeat(100),
        status,
        tags,
        author: alice.id,
      });
      expect(reply.status).toBe(200);
      posts[key] = reply.body;
    }
    expect(posts.intro?.created).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
    );

    const forBob = await bob.api.list<Rec>('posts', { sort: '-created' });
    expect(forBob.body.items.map((p) => p.slug).sort()).toEqual([
      'intro',
      'quotes',
    ]);
    const forAlice = await alice.api.list<Rec>('posts');
    expect(forAlice.body.totalItems).toBe(3);
  });

  it('refuses posts that break the rules or the schema', async () => {
    expect(
      (
        await bob.api.create('posts', {
          title: 'x',
          slug: 'x',
          status: 'draft',
          author: alice.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await new Api(server.api).create('posts', {
          title: 'x',
          slug: 'x',
          status: 'draft',
          author: alice.id,
        })
      ).status,
    ).toBe(400);
    const duplicate = await alice.api.create('posts', {
      title: 'Again',
      slug: 'intro',
      status: 'draft',
      author: alice.id,
    });
    expect(duplicate.body.data).toMatchObject({
      slug: { code: 'validation_not_unique' },
    });
    const invalid = await alice.api.create('posts', {
      title: '',
      slug: 'Not A Slug',
      status: 'archived',
      author: alice.id,
    });
    expect(invalid.body.data).toMatchObject({
      title: { code: 'validation_required' },
      slug: { code: 'validation_invalid_format' },
      status: { code: 'validation_invalid_value' },
    });
  });

  it('searches, filters with awkward strings, and paginates', async () => {
    const anonymous = new Api(server.api);
    const search = await anonymous.list<Rec>('posts', {
      filter: 'title ~ "next.js"',
    });
    expect(search.body.items.map((p) => p.slug)).toEqual(['intro']);
    const exact = await anonymous.list<Rec>('posts', {
      filter: filter('title = {:title}', {
        title: 'He said "hi" \\ then left',
      }),
    });
    expect(exact.body.items.map((p) => p.slug)).toEqual(['quotes']);
    const tagged = await anonymous.list<Rec>('posts', {
      filter: 'tags ?= "react" || tags ?= "next"',
      sort: 'slug',
    });
    expect(tagged.body.items.map((p) => p.slug)).toEqual(['intro', 'quotes']);
    const page = await anonymous.list<Rec>('posts', {
      perPage: 1,
      page: 2,
      sort: 'slug',
    });
    expect(page.body).toMatchObject({
      page: 2,
      perPage: 1,
      totalItems: 2,
      totalPages: 2,
    });
    expect(page.body.items.map((p) => p.slug)).toEqual(['quotes']);
    // The draft stays hidden from search too.
    expect(
      (await anonymous.list('posts', { filter: 'title ~ "postgres"' })).body
        .items,
    ).toEqual([]);
  });

  it('builds a post page with comments, authors and counts in one request', async () => {
    const intro = posts.intro as Rec;
    expect(
      (
        await bob.api.create('comments', {
          post: intro.id,
          author: bob.id,
          text: 'Great post!',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await alice.api.create('comments', {
          post: intro.id,
          author: alice.id,
          text: 'Thanks Bob',
        })
      ).status,
    ).toBe(200);
    // Commenting on a draft fails the create rule.
    const onDraft = await bob.api.create('comments', {
      post: posts.draft?.id,
      author: bob.id,
      text: '?',
    });
    expect(onDraft.status).toBe(400);

    const page = await new Api(server.api).view<Rec>('posts', intro.id, {
      expand: 'author,comments_via_post.author',
      fields:
        'title,expand.author.name,expand.comments_via_post.text,expand.comments_via_post.expand.author.name',
    });
    expect(page.body.expand).toMatchObject({ author: { name: 'Alice' } });
    const comments = (
      page.body.expand as {
        comments_via_post: {
          text: string;
          expand: { author: { name: string } };
        }[];
      }
    ).comments_via_post;
    expect(
      comments.map((c) => `${c.expand.author.name}: ${c.text}`).sort(),
    ).toEqual(['Alice: Thanks Bob', 'Bob: Great post!']);
    expect(page.body).not.toHaveProperty('body');

    const popular = await new Api(server.api).list<Rec>('posts', {
      filter: 'comments_via_post:length >= 2',
    });
    expect(popular.body.items.map((p) => p.slug)).toEqual(['intro']);
  });

  it('lets authors edit their own posts only, and keeps authorship fixed', async () => {
    const intro = posts.intro as Rec;
    expect(
      (await bob.api.update('posts', intro.id, { title: 'Hacked' })).status,
    ).toBe(404);
    expect(
      (await alice.api.update('posts', intro.id, { author: bob.id })).status,
    ).toBe(404);
    const edited = await alice.api.update<Rec>('posts', intro.id, {
      title: 'Getting started with Next.js 16',
      'tags+': 'react',
    });
    expect(edited.body).toMatchObject({
      title: 'Getting started with Next.js 16',
      tags: ['next', 'react'],
    });
    expect(String(edited.body.updated) >= String(intro.updated)).toBe(true);
  });

  it('deletes a post with its comments', async () => {
    const intro = posts.intro as Rec;
    expect((await bob.api.remove('posts', intro.id)).status).toBe(404);
    expect((await alice.api.remove('posts', intro.id)).status).toBe(204);
    const left = await admin.list('comments', {
      filter: filter('post = {:post}', { post: intro.id }),
    });
    expect(left.body.totalItems).toBe(0);
  });
});

describe('a multi-team task board', () => {
  const people: Record<string, { api: Api; id: string }> = {};
  const teams: Record<string, string> = {};

  beforeAll(async () => {
    const users = await usersId();
    const teamsId = await newCollection({
      name: 'teams',
      listRule: '',
      viewRule: '',
      fields: [{ name: 'name', type: 'text' }],
    });
    await newCollection({
      name: 'memberships',
      listRule: 'user = @request.auth.id',
      fields: [
        {
          name: 'team',
          type: 'relation',
          collectionId: teamsId,
          required: true,
        },
        { name: 'user', type: 'relation', collectionId: users, required: true },
        {
          name: 'role',
          type: 'select',
          values: ['owner', 'member'],
          required: true,
        },
      ],
    });
    const member =
      '@collection.memberships.team = team && @collection.memberships.user = @request.auth.id';
    await newCollection({
      name: 'tasks',
      listRule: member,
      viewRule: member,
      createRule: member,
      updateRule: `${member} && @request.body.team:isset = false`,
      deleteRule: `${member} && @collection.memberships.role = "owner"`,
      fields: [
        {
          name: 'team',
          type: 'relation',
          collectionId: teamsId,
          required: true,
        },
        { name: 'title', type: 'text', required: true },
        {
          name: 'status',
          type: 'select',
          values: ['todo', 'doing', 'done'],
          required: true,
        },
        { name: 'assignee', type: 'relation', collectionId: users },
        { name: 'meta', type: 'json' },
        { name: 'due', type: 'date' },
        { name: 'created', type: 'autodate' },
      ],
    });
    const anonymous = new Api(server.api);
    for (const name of ['carol', 'dave', 'erin'])
      people[name] = await anonymous.signup(`${name}@example.com`, name);
    for (const name of ['red', 'blue'])
      teams[name] = (await admin.create('teams', { name })).body.id as string;
    for (const [team, person, role] of [
      ['red', 'carol', 'owner'],
      ['red', 'dave', 'member'],
      ['blue', 'erin', 'owner'],
    ] as const) {
      expect(
        (
          await admin.create('memberships', {
            team: teams[team],
            user: people[person]?.id,
            role,
          })
        ).status,
      ).toBe(200);
    }
  });

  it("keeps each team's tasks inside the team", async () => {
    const { carol, dave, erin } = people as Record<
      string,
      { api: Api; id: string }
    >;
    const tasks = [
      {
        title: 'Design schema',
        status: 'done',
        assignee: carol?.id,
        meta: { priority: 1 },
        due: '2026-01-10T09:00:00Z',
      },
      {
        title: 'Build API',
        status: 'doing',
        assignee: dave?.id,
        meta: { priority: 3, labels: ['backend'] },
        due: '2026-12-01T09:00:00Z',
      },
      { title: 'Write docs', status: 'todo', meta: { priority: 2 } },
    ];
    for (const task of tasks) {
      expect(
        (await dave?.api.create('tasks', { team: teams.red, ...task }))?.status,
      ).toBe(200);
    }
    expect(
      (
        await erin?.api.create('tasks', {
          team: teams.blue,
          title: 'Blue secret',
          status: 'todo',
        })
      )?.status,
    ).toBe(200);
    // Dave is not in blue, so creating there fails.
    expect(
      (
        await dave?.api.create('tasks', {
          team: teams.blue,
          title: 'Intrusion',
          status: 'todo',
        })
      )?.status,
    ).toBe(400);

    expect((await carol?.api.list('tasks'))?.body.totalItems).toBe(3);
    expect(
      (await erin?.api.list<Rec>('tasks'))?.body.items.map((t) => t.title),
    ).toEqual(['Blue secret']);
    expect((await new Api(server.api).list('tasks')).body.totalItems).toBe(0);
  });

  it("filters the board like an app's toolbar would", async () => {
    const carol = people.carol as { api: Api; id: string };
    const titles = async (filter: string): Promise<unknown[]> =>
      (
        await carol.api.list<Rec>('tasks', { filter, sort: 'title' })
      ).body.items.map((t) => t.title);
    expect(
      await titles(
        filter('status = "doing" && assignee = {:dave}', {
          dave: people.dave?.id ?? '',
        }),
      ),
    ).toEqual(['Build API']);
    expect(await titles('meta.priority >= 2')).toEqual([
      'Build API',
      'Write docs',
    ]);
    expect(
      await titles('meta.labels ?~ "back" || meta.labels.0 = "backend"'),
    ).toEqual(['Build API']);
    expect(await titles('due < @now && status != "done"')).toEqual([]);
    expect(await titles('assignee = ""')).toEqual(['Write docs']);
    expect(await titles('assignee.name = "carol"')).toEqual(['Design schema']);
  });

  it('lets members update but only owners delete', async () => {
    const { carol, dave } = people as Record<string, { api: Api; id: string }>;
    const [task] =
      (await dave?.api.list<Rec>('tasks', { filter: 'title = "Write docs"' }))
        ?.body.items ?? [];
    expect(
      (
        await dave?.api.update('tasks', task?.id ?? '', {
          status: 'doing',
          assignee: dave.id,
        })
      )?.status,
    ).toBe(200);
    expect(
      (await dave?.api.update('tasks', task?.id ?? '', { team: teams.blue }))
        ?.status,
    ).toBe(404);
    expect(
      (
        await people.erin?.api.update('tasks', task?.id ?? '', {
          status: 'done',
        })
      )?.status,
    ).toBe(404);
    expect((await dave?.api.remove('tasks', task?.id ?? ''))?.status).toBe(404);
    expect((await carol?.api.remove('tasks', task?.id ?? ''))?.status).toBe(
      204,
    );
  });

  it('serializes concurrent edits over real HTTP', async () => {
    const carol = people.carol as { api: Api; id: string };
    const task = await carol.api.create<Rec>('tasks', {
      team: teams.red,
      title: 'Counter',
      status: 'todo',
      meta: {},
    });
    await newCollection({
      name: 'votes',
      listRule: '',
      viewRule: '',
      createRule: '',
      updateRule: '',
      fields: [
        {
          name: 'task',
          type: 'relation',
          collectionId: (await admin.send('GET', '/collections/tasks')).body.id,
        },
        { name: 'count', type: 'number' },
      ],
    });
    const votes = await carol.api.create<Rec>('votes', {
      task: task.body.id,
      count: 0,
    });
    const replies = await Promise.all(
      Array.from({ length: 30 }, () =>
        carol.api.update('votes', votes.body.id, { 'count+': 1 }),
      ),
    );
    expect(replies.every((r) => r.status === 200)).toBe(true);
    expect((await carol.api.view<Rec>('votes', votes.body.id)).body.count).toBe(
      30,
    );
  });
});

describe('accounts', () => {
  it('changes a password, signing out every other session', async () => {
    const anonymous = new Api(server.api);
    const frank = await anonymous.signup('frank@example.com', 'frank');
    const laptop = await anonymous.login(
      'users',
      'frank@example.com',
      'pw-frank-123-4567',
    );
    const change = await frank.api.update('users', frank.id, {
      oldPassword: 'pw-frank-123-4567',
      password: 'a brand new password',
      passwordConfirm: 'a brand new password',
    });
    expect(change.status).toBe(200);
    expect((await laptop.view('users', frank.id)).status).toBe(401);
    // The session that made the change stays signed in.
    expect((await frank.api.view('users', frank.id)).status).toBe(200);
    const again = await anonymous.login(
      'users',
      'frank@example.com',
      'a brand new password',
    );
    expect((await again.view<Rec>('users', frank.id)).body.email).toBe(
      'frank@example.com',
    );
  });

  it('shows emails only to their owners unless made visible', async () => {
    const anonymous = new Api(server.api);
    const gina = await anonymous.signup('gina@example.com', 'gina');
    const hank = await anonymous.signup('hank@example.com', 'hank');
    expect((await hank.api.view<Rec>('users', gina.id)).body.email).toBe('');
    expect(
      (await gina.api.update('users', gina.id, { emailVisibility: true }))
        .status,
    ).toBe(200);
    expect((await hank.api.view<Rec>('users', gina.id)).body.email).toBe(
      'gina@example.com',
    );
    expect(
      (await hank.api.update('users', gina.id, { name: 'not yours' })).status,
    ).toBe(404);
  });

  it('throttles password guessing', async () => {
    const anonymous = new Api(server.api);
    await anonymous.signup('ivan@example.com', 'ivan');
    const guesses = await Promise.all(
      Array.from({ length: 12 }, () =>
        anonymous.send('POST', '/collections/users/auth-with-password', {
          identity: 'ivan@example.com',
          password: 'guess',
        }),
      ),
    );
    expect(guesses.every((g) => g.status === 400 || g.status === 429)).toBe(
      true,
    );
    const real = await anonymous.send(
      'POST',
      '/collections/users/auth-with-password',
      {
        identity: 'ivan@example.com',
        password: 'pw-ivan-123-4567',
      },
    );
    expect(real.status).toBe(429);
  });
});

describe('HTTP behavior behind Next.js', () => {
  it('handles methods, slashes, encodings and sizes the way clients send them', async () => {
    const health = `${server.api}/health`;
    expect((await fetch(health, { method: 'HEAD' })).status).toBe(200);
    expect((await fetch(`${health}/`)).status).toBe(200);
    expect(
      (await fetch(`${server.api}/collections`, { method: 'PUT' })).status,
    ).toBe(405);
    const traversal = await fetch(
      `${server.api}/collections/users/records/%2E%2E%2F%2E%2E`,
    );
    expect(traversal.status).toBe(404);
    expect(await traversal.json()).toMatchObject({ status: 404 });

    const big = await admin.send('POST', '/collections/users/records', {
      name: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(big.status).toBe(413);
    const notJson = await fetch(`${server.api}/collections/users/records`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'email=x',
    });
    expect(notJson.status).toBe(415);
  });

  it('never answered with a server error', () => {
    expect(server.output()).not.toContain('request failed');
  });
});
