import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientError,
  type Collection,
  type NextBaseClient,
  type RecordModel,
  type RecordService,
} from "@nextbasejs/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import {
  ApiError,
  type HookPrincipal,
  type HookSource,
  type MailMessage,
  NextBase,
  type RecordHooks,
  type SmsMessage,
} from "../src/index.ts";
import { newId } from "../src/random.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

const PASSWORD = "password 123 456";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

interface PostsRecord extends RecordModel {
  title: string;
  slug: string;
  views: number;
}
interface AuditRecord extends RecordModel {
  key: string;
  action: string;
  post: string;
}
type Collections = {
  posts: PostsRecord;
  audit: AuditRecord;
};

/** An event as the tests read it, whichever hook it is for. */
interface AnyEvent {
  collection: Collection;
  principal: HookPrincipal;
  source: HookSource;
  record: Record<string, unknown> & { id: string };
  original: Record<string, unknown> & { id: string };
  input: Record<string, unknown>;
  nextbase: NextBaseClient<Collections>;
}
type Handler = (e: AnyEvent) => unknown;

const HOOKS = [
  "beforeCreate",
  "beforeUpdate",
  "beforeDelete",
  "onCreate",
  "onUpdate",
  "onDelete",
  "afterCreate",
  "afterUpdate",
  "afterDelete",
];
const COLLECTIONS = [
  "posts",
  "audit",
  "gated",
  "comments",
  "likes",
  "loops",
  "docs",
  "users",
  "members",
  "secrets",
  "titles",
  "*",
];

describe("record hooks", () => {
  let t: TestDatabase;
  let dir: string;
  let nextbase: NextBase<Collections>;
  let admin: NextBaseClient<Collections>;
  const handlers = new Map<string, Handler>();
  const pending: Promise<unknown>[] = [];
  const mails: MailMessage[] = [];
  const texts: SmsMessage[] = [];

  /** Sets what `collection.hook` does, until the test ends. */
  const hook = (name: string, handler: Handler): void => {
    handlers.set(name, handler);
  };
  /** Waits for the background work queued so far, such as after hooks. */
  const flush = async (): Promise<void> => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };
  const count = async (name: string): Promise<number> =>
    (await admin.collection(name).getList(1, 1)).totalItems;
  /** Silences, and records, what failed requests log. */
  const logged = () => vi.spyOn(console, "error").mockImplementation(() => {});
  const tokenIn = (to: string): string => {
    const text = mails.filter((m) => m.to === to).at(-1)?.text ?? "";
    return /token=([\w.-]+)/.exec(text)?.[1] ?? "";
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), "nextbase-hooks-"));
    // Every hook of every collection relays to the test's handler, if any.
    const hooks = Object.fromEntries(
      COLLECTIONS.map((collection) => [
        collection,
        Object.fromEntries(
          HOOKS.map((name) => [
            name,
            (e: AnyEvent) => handlers.get(`${collection}.${name}`)?.(e),
          ]),
        ),
      ]),
    ) as RecordHooks<Collections>;
    nextbase = new NextBase<Collections>({
      database: t.pool,
      storage: { dir },
      waitUntil: (promise) => pending.push(promise),
      mail: {
        from: "app@example.com",
        appUrl: "https://app.example.com",
        send: async (message) => {
          mails.push(message);
        },
      },
      sms: {
        countries: ["TZ"],
        send: async (message) => {
          texts.push(message);
        },
      },
      hooks,
    });
    admin = nextbase.client({ superuser: true });
    const open = {
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
    };
    const posts = await admin.collections.create({
      name: "posts",
      ...open,
      fields: [
        { name: "title", type: "text", max: 50 },
        { name: "slug", type: "text" },
        { name: "views", type: "number" },
      ],
    });
    await admin.collections.create({
      name: "audit",
      fields: [
        { id: "auditkey00", name: "key", type: "text" },
        { name: "action", type: "text" },
        { name: "post", type: "text" },
      ],
      indexes: [{ name: "audit_key", unique: true, fields: ["auditkey00"] }],
    });
    await admin.collections.create({
      name: "gated",
      createRule: 'title = "allowed"',
      viewRule: "",
      fields: [{ name: "title", type: "text" }],
    });
    for (const [name, cascadeDelete] of [
      ["comments", true],
      ["likes", false],
    ] as const) {
      await admin.collections.create({
        name,
        ...open,
        fields: [
          {
            name: "post",
            type: "relation",
            collectionId: posts.id,
            maxSelect: 1,
            cascadeDelete,
          },
        ],
      });
    }
    await admin.collections.create({
      name: "loops",
      fields: [{ name: "n", type: "number" }],
    });
    await admin.collections.create({
      name: "docs",
      ...open,
      fields: [{ name: "file", type: "file" }],
    });
    await admin.collections.create({
      name: "users",
      type: "auth",
      phoneSignIn: true,
      identityFields: ["email", "phone"],
      createRule: "",
      viewRule: "id = @request.auth.id",
      fields: [{ name: "note", type: "text", hidden: true }],
    });
    // Signs up by phone, but signs in only once verified by email.
    await admin.collections.create({
      name: "members",
      type: "auth",
      phoneSignIn: true,
      identityFields: ["email", "phone"],
      createRule: "",
      authRule: "emailVerified = true",
    });
    // Only their owner may change or delete them, nobody may view them.
    await admin.collections.create({
      name: "secrets",
      createRule: "",
      updateRule: "owner = @request.auth.id",
      deleteRule: "owner = @request.auth.id",
      fields: [
        { name: "owner", type: "text" },
        { name: "content", type: "text", hidden: true },
      ],
    });
    await admin.collections.create({
      name: "titles",
      type: "view",
      viewQuery: "SELECT p.id, p.title FROM posts p",
      listRule: "",
      viewRule: "",
    });
  });
  afterEach(async () => {
    await flush();
    handlers.clear();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await t.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe("before hooks", () => {
    it("change the input, which is then checked and stored as if sent", async () => {
      hook("posts.beforeCreate", (e) => {
        e.input.slug ??= String(e.input.title).toLowerCase().replace(" ", "-");
      });
      const post = await nextbase
        .client()
        .collection("posts")
        .create({ title: "Hello World" });
      expect(post?.slug).toBe("hello-world");

      hook("posts.beforeCreate", (e) => {
        e.input.title = "x".repeat(51);
      });
      const error = await failure(
        nextbase.client().collection("posts").create({ title: "short" }),
      );
      expect(error.status).toBe(400);
      expect(error.data.title).toMatchObject({
        code: "validation_length_out_of_range",
      });
    });

    it("refuse a write with an ApiError's status, message and data", async () => {
      hook("posts.beforeCreate", () => {
        throw new ApiError(422, "Titles are closed today.", {
          title: { code: "closed", message: "Closed." },
        });
      });
      const error = await failure(
        nextbase.client().collection("posts").create({ title: "Hi" }),
      );
      expect(error.status).toBe(422);
      expect(error.message).toBe("Titles are closed today.");
      expect(error.data).toEqual({
        title: { code: "closed", message: "Closed." },
      });

      const log = logged();
      hook("posts.beforeCreate", () => {
        throw new Error("broken hook");
      });
      expect(
        (await failure(admin.collection("posts").create({ title: "Hi" })))
          .status,
      ).toBe(500);
      expect(String(log.mock.calls[0]?.[1])).toContain("broken hook");
      expect(await count("posts")).toBe(1);
    });

    it("hold no transaction or lock while they run", async () => {
      const post = await admin.collection("posts").create({ title: "a" });
      hook("posts.beforeUpdate", async (e) => {
        if (e.input.title !== "slow") return;
        // Would wait for a lock until the statement timeout if one were held.
        await admin.collection("posts").update(e.record.id, { views: 7 });
      });
      const updated = await admin
        .collection("posts")
        .update(post?.id as string, { title: "slow" });
      expect(updated).toMatchObject({ title: "slow", views: 7 });
    });

    it("run before the rules, which check the changed input", async () => {
      const gated = nextbase.client().collection("gated");
      expect((await failure(gated.create({ title: "other" }))).status).toBe(
        400,
      );
      hook("gated.beforeCreate", (e) => {
        e.input.title = "allowed";
      });
      expect((await gated.create({ title: "other" }))?.title).toBe("allowed");
    });

    it("run before passwords are hashed and files are stored", async () => {
      hook("users.beforeCreate", (e) => {
        expect(e.input.password).toBe(PASSWORD);
        e.input.password = "chosen by the hook";
        e.input.passwordConfirm = "chosen by the hook";
      });
      const users = nextbase.client().collection("users");
      await users.create({
        email: "hashed@example.com",
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      await users.signInWithPassword(
        "hashed@example.com",
        "chosen by the hook",
      );

      let file: unknown;
      hook("docs.beforeCreate", (e) => {
        file = e.input.file;
        throw new ApiError(400, "No files today.");
      });
      const error = await failure(
        nextbase
          .client()
          .collection("docs")
          .create({ file: new File([PNG], "a.png", { type: "image/png" }) }),
      );
      expect(error.message).toBe("No files today.");
      expect(file).toBeInstanceOf(Blob);
      const docs = (await admin.collections.getOne("docs")).id;
      expect(await readdir(join(dir, docs)).catch(() => [])).toEqual([]);
    });

    it("see the stored record on update and delete, hidden fields but no secrets", async () => {
      const record = (await admin.collection("users").create({
        email: "seen@example.com",
        password: PASSWORD,
        passwordConfirm: PASSWORD,
        note: "private",
      })) as RecordModel;
      const seen: AnyEvent[] = [];
      hook("users.beforeUpdate", (e) => {
        seen.push(e);
      });
      hook("users.beforeDelete", (e) => {
        seen.push(e);
      });
      await admin.collection("users").update(record.id, { note: "changed" });
      await admin.collection("users").delete(record.id);
      const [update, remove] = seen;
      expect(update?.record).toMatchObject({
        id: record.id,
        email: "seen@example.com",
        note: "private",
      });
      expect(update?.input).toEqual({ note: "changed" });
      expect(remove?.record.note).toBe("changed");
      for (const e of seen) {
        expect(e.record).not.toHaveProperty("password");
        expect(e.record).not.toHaveProperty("tokenKey");
        expect(e.source).toBe("request");
        expect(e.principal).toEqual({ superuser: true });
      }
    });
  });

  describe("on hooks", () => {
    it("write through e.nextbase in the write's transaction, kept with it", async () => {
      hook("posts.onCreate", async (e) => {
        expect(e.record.title).toBe("Kept");
        await e.nextbase
          .collection("audit")
          .create({ key: newId(), action: "created", post: e.record.id });
      });
      const post = await admin.collection("posts").create({ title: "Kept" });
      const [entry] = await admin
        .collection("audit")
        .getFullList({ filter: `post = "${post?.id}"` });
      expect(entry?.action).toBe("created");
    });

    it("undo the whole write when they throw", async () => {
      const log = logged();
      hook("posts.onCreate", async (e) => {
        await e.nextbase
          .collection("audit")
          .create({ key: newId(), action: "undone", post: e.record.id });
        throw new ApiError(409, "Not this one.");
      });
      const error = await failure(
        admin.collection("posts").create({ title: "Undone" }),
      );
      expect(error.status).toBe(409);
      expect(
        await admin
          .collection("posts")
          .getFullList({ filter: 'title = "Undone"' }),
      ).toEqual([]);
      expect(
        await admin
          .collection("audit")
          .getFullList({ filter: 'action = "undone"' }),
      ).toEqual([]);
      expect(log).not.toHaveBeenCalled();
    });

    it("are undone when the batch they ran in fails later", async () => {
      hook("posts.onCreate", async (e) => {
        await e.nextbase
          .collection("audit")
          .create({ key: newId(), action: "in batch", post: e.record.id });
      });
      const error = await failure(
        admin
          .createBatch()
          .collection("posts")
          .create({ title: "First" })
          .collection("posts")
          .create({ title: "x".repeat(51) })
          .send(),
      );
      expect(error.status).toBe(400);
      expect(
        await admin
          .collection("audit")
          .getFullList({ filter: 'action = "in batch"' }),
      ).toEqual([]);
    });

    it("undo the whole batch when one throws, reported like other batch errors", async () => {
      hook("posts.onUpdate", (e) => {
        if (e.record.title === "refused") {
          throw new ApiError(409, "Refused.", {
            title: { code: "x", message: "X." },
          });
        }
      });
      const post = await admin.collection("posts").create({ title: "a" });
      const id = post?.id as string;
      const error = await failure(
        admin
          .createBatch()
          .collection("posts")
          .create({ title: "batched" })
          .collection("posts")
          .update(id, { title: "refused" })
          .send(),
      );
      expect(error.status).toBe(400);
      expect(error.message).toBe(
        "Request 2 of the batch failed with 409: Refused. Nothing was saved.",
      );
      expect(error.data).toEqual({
        requests: { 1: { title: { code: "x", message: "X." } } },
      });
      expect((await admin.collection("posts").getOne(id)).title).toBe("a");
      expect(
        await admin
          .collection("posts")
          .getFullList({ filter: 'title = "batched"' }),
      ).toEqual([]);

      // A create's hook is reported by its place in the batch too.
      hook("posts.onCreate", (e) => {
        if (e.record.title === "second") throw new ApiError(409, "No.");
      });
      const creates = await failure(
        admin
          .createBatch()
          .collection("posts")
          .create({ title: "first" })
          .collection("posts")
          .create({ title: "second" })
          .send(),
      );
      expect(creates.message).toBe(
        "Request 2 of the batch failed with 409: No. Nothing was saved.",
      );
    });

    it("run before the response is read, and see the write's own changes", async () => {
      hook("posts.onCreate", async (e) => {
        await e.nextbase
          .collection("posts")
          .update(e.record.id, { slug: "set-by-hook" });
      });
      const post = await nextbase
        .client()
        .collection("posts")
        .create({ title: "Slugged" });
      expect(post?.slug).toBe("set-by-hook");
    });

    it("update the record they fire for without a deadlock", async () => {
      hook("posts.onUpdate", async (e) => {
        if (e.record.views !== e.original.views) return;
        await e.nextbase
          .collection("posts")
          .update(e.record.id, { views: Number(e.record.views) + 1 });
      });
      const post = await admin.collection("posts").create({ views: 1 });
      const updated = await admin
        .collection("posts")
        .update(post?.id as string, { title: "viewed" });
      expect(updated?.views).toBe(2);
    });

    it("fire the hooks of their own writes, with source request", async () => {
      const seen: string[] = [];
      hook("posts.onCreate", async (e) => {
        await e.nextbase
          .collection("audit")
          .create({ key: newId(), action: "nested", post: e.record.id });
      });
      hook("audit.onCreate", (e) => {
        seen.push(`on ${e.record.action} ${e.source}`);
      });
      hook("audit.afterCreate", (e) => {
        seen.push(`after ${e.record.action} ${e.source}`);
      });
      await admin.collection("posts").create({ title: "Nested" });
      await flush();
      expect(seen).toEqual(["on nested request", "after nested request"]);
    });

    it("may catch a failed write and go on", async () => {
      await admin.collection("audit").create({ key: "taken" });
      hook("posts.onCreate", async (e) => {
        const error = await failure(
          e.nextbase.collection("audit").create({ key: "taken" }),
        );
        expect(error.status).toBe(400);
        await e.nextbase
          .collection("audit")
          .create({ key: `free-${e.record.id}`, post: e.record.id });
      });
      const post = await admin.collection("posts").create({ title: "Caught" });
      expect(
        await admin
          .collection("audit")
          .getFullList({ filter: `post = "${post?.id}"` }),
      ).toHaveLength(1);
      expect(
        await admin
          .collection("audit")
          .getFullList({ filter: 'key = "taken"' }),
      ).toHaveLength(1);
    });

    it("stop writes nested too deep, so a hook cannot loop forever", async () => {
      const log = logged();
      const loop = await admin.collection("loops").create({ n: 0 });
      const id = loop?.id as string;
      hook("loops.onUpdate", async (e) => {
        await e.nextbase
          .collection("loops")
          .update(e.record.id, { n: Number(e.record.n) + 1 });
      });
      const error = await failure(
        admin.collection("loops").update(id, { n: 1 }),
      );
      expect(error.status).toBe(500);
      const messages = log.mock.calls.map((call) => String(call[1]));
      expect(
        messages.some((m) =>
          m.includes(
            `nest more than 8 deep: ${Array(9).fill("loops.onUpdate").join(" > ")}`,
          ),
        ),
      ).toBe(true);
      expect((await admin.collection("loops").getOne(id)).n).toBe(0);
    });

    it("must await their writes, which cannot outlast them", async () => {
      const log = logged();
      let late: Promise<unknown> | undefined;
      hook("posts.onCreate", (e) => {
        late = e.nextbase
          .collection("audit")
          .create({ key: newId(), action: "late", post: e.record.id });
      });
      expect(
        (await failure(admin.collection("posts").create({ title: "Late" })))
          .status,
      ).toBe(500);
      // It finished in the transaction, which was then rolled back.
      await late;
      expect(String(log.mock.calls[0]?.[1])).toContain(
        "returned before its writes through e.nextbase finished",
      );
      expect(
        await admin
          .collection("audit")
          .getFullList({ filter: 'action = "late"' }),
      ).toEqual([]);

      let kept: NextBaseClient<Collections> | undefined;
      hook("posts.onCreate", (e) => {
        kept = e.nextbase;
      });
      await admin.collection("posts").create({ title: "Kept client" });
      const error = await failure(
        (kept as NextBaseClient<Collections>)
          .collection("audit")
          .create({ key: newId() }),
      );
      expect(error.message).toContain(
        "e.nextbase was used after the posts.onCreate hook returned",
      );
    });

    it("reach only the records API through e.nextbase", async () => {
      hook("posts.onCreate", async (e) => {
        const error = await failure(
          e.nextbase.collection("users").listAuthMethods(),
        );
        expect(error.status).toBe(400);
        // Reads see the transaction's writes.
        expect(
          (await e.nextbase.collection("posts").getOne(e.record.id)).title,
        ).toBe("Read");
      });
      await admin.collection("posts").create({ title: "Read" });
    });
  });

  describe("after hooks", () => {
    it("run in the background once the write is committed", async () => {
      const seen: unknown[] = [];
      hook("posts.afterCreate", async (e) => {
        // A new connection: it sees only what was committed.
        seen.push(
          (await e.nextbase.collection("posts").getOne(e.record.id)).title,
        );
      });
      const before = pending.length;
      await admin.collection("posts").create({ title: "Committed" });
      expect(pending.length).toBe(before + 1);
      await flush();
      expect(seen).toEqual(["Committed"]);
    });

    it("run after the outer commit for writes made in on hooks, in the order of the writes", async () => {
      const seen: unknown[] = [];
      hook("posts.onCreate", async (e) => {
        await e.nextbase
          .collection("audit")
          .create({ key: newId(), action: "outer", post: e.record.id });
      });
      hook("posts.afterCreate", () => {
        seen.push("post");
      });
      hook("audit.afterCreate", async (e) => {
        const post = await e.nextbase
          .collection("posts")
          .getOne(String(e.record.post));
        seen.push(`audit of ${post.title}`);
      });
      await admin.collection("posts").create({ title: "Outer" });
      await flush();
      expect(seen).toEqual(["post", "audit of Outer"]);
    });

    it("never run when the write fails", async () => {
      const log = logged();
      const seen: string[] = [];
      hook("posts.afterCreate", () => {
        seen.push("post");
      });
      hook("audit.afterCreate", () => {
        seen.push("audit");
      });
      hook("posts.onCreate", async (e) => {
        await e.nextbase
          .collection("audit")
          .create({ key: newId(), action: "rolled back", post: e.record.id });
        throw new Error("fails after the audit");
      });
      await failure(admin.collection("posts").create({ title: "Fails" }));
      await failure(
        admin.collection("posts").create({ title: "x".repeat(51) }),
      );
      await flush();
      expect(seen).toEqual([]);
      expect(log).toHaveBeenCalled();
    });

    it("log their errors, which never change the response", async () => {
      const log = logged();
      const seen: string[] = [];
      hook("posts.afterDelete", () => {
        throw new Error("webhook down");
      });
      hook("*.afterDelete", () => {
        seen.push("still runs");
      });
      const post = await admin.collection("posts").create({ title: "Gone" });
      await admin.collection("posts").delete(post?.id as string);
      await flush();
      expect(log).toHaveBeenCalledWith(
        "[nextbase] afterDelete hook for posts failed:",
        expect.objectContaining({ message: "webhook down" }),
      );
      expect(seen).toEqual(["still runs"]);
    });
  });

  describe("coverage", () => {
    it('runs "*" hooks after the collection\'s own', async () => {
      const order: string[] = [];
      for (const name of ["beforeUpdate", "onUpdate", "afterUpdate"]) {
        hook(`posts.${name}`, () => {
          order.push(`posts.${name}`);
        });
        hook(`*.${name}`, (e) => {
          order.push(`*.${name} ${e.collection.name}`);
        });
      }
      const post = await admin.collection("posts").create({ title: "Star" });
      await admin.collection("posts").update(post?.id as string, { views: 3 });
      await flush();
      expect(order).toEqual([
        "posts.beforeUpdate",
        "*.beforeUpdate posts",
        "posts.onUpdate",
        "*.onUpdate posts",
        "posts.afterUpdate",
        "*.afterUpdate posts",
      ]);
    });

    it('runs no "*" hooks for superusers, also written outside the records API', async () => {
      await nextbase.createSuperuser("second@example.com", PASSWORD);
      const seen: string[] = [];
      hook("*.beforeUpdate", (e) => {
        seen.push(e.collection.name);
      });
      hook("*.onUpdate", (e) => {
        seen.push(e.collection.name);
      });
      const second = await admin
        .collection("_superusers")
        .getFirstListItem('email = "second@example.com"');
      await admin
        .collection("_superusers")
        .update(second.id, { emailVisibility: true });
      expect(seen).toEqual([]);
    });

    it("fires for each record a cascade deletes or changes, with source cascade", async () => {
      const seen: string[] = [];
      for (const name of [
        "onDelete",
        "afterDelete",
        "onUpdate",
        "afterUpdate",
      ]) {
        hook(`*.${name}`, (e) => {
          if (e.collection.name === "audit") return;
          const change =
            name.endsWith("Update") &&
            `: ${String(e.original.post)} -> "${String(e.record.post)}"`;
          seen.push(
            `${name} ${e.collection.name} ${e.record.id} ${e.source}${change || ""}`,
          );
        });
      }
      const post = (await admin.collection("posts").create({ title: "Root" }))
        ?.id as string;
      const comments = [newId(), newId()].sort();
      for (const id of comments) {
        await admin.collection("comments").create({ id, post });
      }
      const like = (await admin.collection("likes").create({ post }))?.id;
      const beforeHooks: string[] = [];
      hook("comments.beforeDelete", () => {
        beforeHooks.push("comments");
      });
      hook("likes.beforeUpdate", () => {
        beforeHooks.push("likes");
      });
      await admin.collection("posts").delete(post);
      await flush();
      const [c1, c2] = comments;
      const cleared = `: ${post} -> ""`;
      expect(seen).toEqual([
        `onUpdate likes ${like} cascade${cleared}`,
        `onDelete comments ${c1} cascade`,
        `onDelete comments ${c2} cascade`,
        `onDelete posts ${post} request`,
        `afterUpdate likes ${like} cascade${cleared}`,
        `afterDelete comments ${c1} cascade`,
        `afterDelete comments ${c2} cascade`,
        `afterDelete posts ${post} request`,
      ]);
      expect(beforeHooks).toEqual([]);
      expect(await count("comments")).toBe(0);
    });

    it("fires for NextBase's own writes with source system", async () => {
      const seen: string[] = [];
      for (const name of [
        "onCreate",
        "onUpdate",
        "afterCreate",
        "afterUpdate",
      ]) {
        hook(`users.${name}`, (e) => {
          const changed = name.endsWith("Update")
            ? Object.keys(e.record)
                .filter((k) => e.record[k] !== e.original[k] && k !== "updated")
                .join(",")
            : "";
          seen.push(`${name} ${e.source} ${changed}`.trim());
        });
      }
      const users = nextbase.client().collection("users");
      const phone = "+255712345678";

      await users.requestPhoneCode(phone);
      await flush();
      const code = /\b(\d{6})\b/.exec(texts.at(-1)?.text ?? "")?.[1] ?? "";
      await users.signInWithPhoneCode(phone, code);
      await flush();
      expect(seen.splice(0)).toEqual(["onCreate system", "afterCreate system"]);

      const email = "flows@example.com";
      const nb = nextbase.client();
      await nb
        .collection("users")
        .signUp({ email, password: PASSWORD, passwordConfirm: PASSWORD });
      await flush();
      expect(seen.splice(0)).toEqual([
        "onCreate request",
        "afterCreate request",
      ]);

      await users.requestEmailVerification(email);
      await flush();
      await users.confirmEmailVerification(tokenIn(email));
      await flush();
      expect(seen.splice(0)).toEqual([
        "onUpdate system emailVerified",
        "afterUpdate system emailVerified",
      ]);

      await users.requestPasswordReset(email);
      await flush();
      const sentBefore = mails.length;
      await users.confirmPasswordReset(
        tokenIn(email),
        "a new password 1",
        "a new password 1",
      );
      await flush();
      // The password and token key changed, which hooks never see.
      expect(seen.splice(0)).toEqual(["onUpdate system", "afterUpdate system"]);
      // The owner is told once.
      expect(mails.slice(sentBefore).map((m) => m.subject)).toEqual([
        "Your password was changed",
      ]);

      // The reset ended the sign-up's session.
      const owner = nextbase.client();
      await owner
        .collection("users")
        .signInWithPassword(email, "a new password 1");
      await owner.collection("users").requestEmailChange("moved@example.com");
      await flush();
      await users.confirmEmailChange(
        tokenIn("moved@example.com"),
        "a new password 1",
      );
      await flush();
      expect(seen.splice(0)).toEqual([
        "onUpdate system email",
        "afterUpdate system email",
      ]);

      const moved = nextbase.client();
      await moved
        .collection("users")
        .signInWithPassword("moved@example.com", "a new password 1");
      const newPhone = "+255712345679";
      await moved.collection("users").requestPhoneVerification(newPhone);
      await flush();
      const text = texts.filter((m) => m.to === newPhone).at(-1)?.text ?? "";
      await moved
        .collection("users")
        .confirmPhoneVerification(
          newPhone,
          /\b(\d{6})\b/.exec(text)?.[1] ?? "",
        );
      await flush();
      expect(seen.splice(0)).toEqual([
        "onUpdate system phone,phoneVerified",
        "afterUpdate system phone,phoneVerified",
      ]);
    });
  });

  describe("safety", () => {
    it("runs an on hook's requests one at a time, so Promise.all works", async () => {
      const keys = [newId(), newId()];
      hook("posts.onCreate", async (e) => {
        await Promise.all(
          keys.map((key) =>
            e.nextbase
              .collection("audit")
              .create({ key, action: "together", post: e.record.id }),
          ),
        );
      });
      await admin.collection("posts").create({ title: "Together" });
      expect(
        (
          await admin
            .collection("audit")
            .getFullList({ filter: 'action = "together"' })
        )
          .map((a) => a.key)
          .sort(),
      ).toEqual([...keys].sort());
    });

    it("undoes only the failed one of an on hook's concurrent requests", async () => {
      const taken = newId();
      await admin.collection("audit").create({ key: taken });
      const kept = newId();
      const afterwards: unknown[] = [];
      hook("audit.afterCreate", (e) => {
        afterwards.push(e.record.key);
      });
      hook("posts.onCreate", async (e) => {
        const [failed, created] = await Promise.allSettled([
          e.nextbase.collection("audit").create({ key: taken }),
          e.nextbase
            .collection("audit")
            .create({ key: kept, action: "settled", post: e.record.id }),
        ]);
        expect(failed.status).toBe("rejected");
        expect(created.status).toBe("fulfilled");
      });
      await admin.collection("posts").create({ title: "Settled" });
      await flush();
      expect(
        await admin
          .collection("audit")
          .getFullList({ filter: 'action = "settled"' }),
      ).toHaveLength(1);
      expect(afterwards).toEqual([kept]);
    });

    it("sets the role back after an on hook reads a view", async () => {
      hook("posts.onCreate", async (e) => {
        await e.nextbase.collection("titles").getFullList();
        await e.nextbase
          .collection("audit")
          .create({ key: newId(), action: "after view", post: e.record.id });
      });
      await admin.collection("posts").create({ title: "Viewed" });
      expect(
        await admin
          .collection("audit")
          .getFullList({ filter: 'action = "after view"' }),
      ).toHaveLength(1);
    });

    it("keeps the work of writes committed before the request fails", async () => {
      const created: string[] = [];
      hook("members.afterCreate", (e) => {
        created.push(String(e.record.phone));
      });
      const members = nextbase.client().collection("members");
      const phone = "+255713000001";
      await members.requestPhoneCode(phone);
      await flush();
      const text = texts.filter((m) => m.to === phone).at(-1)?.text ?? "";
      const code = /\b(\d{6})\b/.exec(text)?.[1] ?? "";
      // Signed up, but the auth rule refuses the sign-in.
      expect(
        (await failure(members.signInWithPhoneCode(phone, code))).status,
      ).toBe(403);
      await flush();
      expect(created).toEqual([phone]);

      hook("users.afterCreate", (e) => {
        created.push(String(e.record.email));
      });
      // Created, but the response's expand is refused.
      const response = await nextbase.handle(
        new Request(
          "http://localhost:3000/api/nextbase/collections/users/sign-up?expand=a.b.c.d.e.f.g",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email: "late@example.com",
              password: PASSWORD,
              passwordConfirm: PASSWORD,
            }),
          },
        ),
      );
      expect(response.status).toBe(400);
      await flush();
      expect(created).toEqual([phone, "late@example.com"]);
    });

    it("gives each create of a batch its hooks in turn", async () => {
      const [first, second] = [newId(), newId()];
      const order: string[] = [];
      hook("posts.onCreate", async (e) => {
        order.push(`onCreate ${e.record.title}`);
        if (e.record.id !== first) return;
        // The second is not created yet, as when each is created in turn.
        const error = await failure(
          e.nextbase.collection("posts").getOne(second),
        );
        expect(error.status).toBe(404);
      });
      await admin
        .createBatch()
        .collection("posts")
        .create({ id: first, title: "first" })
        .collection("posts")
        .create({ id: second, title: "second" })
        .send();
      expect(order).toEqual(["onCreate first", "onCreate second"]);
    });

    it("runs update and delete before hooks only for callers the rule allows", async () => {
      const owner = nextbase.client();
      const { record } = (await owner.collection("users").signUp({
        email: "owner@example.com",
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      })) as { record: RecordModel };
      const secret = await admin
        .collection("secrets")
        .create({ owner: record.id, content: "the plan" });
      const id = secret?.id as string;
      const ran: string[] = [];
      for (const name of ["beforeUpdate", "beforeDelete"]) {
        hook(`secrets.${name}`, (e) => {
          ran.push(name);
          throw new ApiError(400, `Keep ${String(e.record.content)}.`);
        });
      }
      const stranger = nextbase.client().collection("secrets");
      // As for a record that does not exist.
      for (const attempt of [
        () => stranger.update(id, { owner: "x" }),
        () => stranger.delete(id),
        () => stranger.delete(newId()),
      ]) {
        const error = await failure(attempt());
        expect([error.status, error.message]).toEqual([
          404,
          "Record not found.",
        ]);
      }
      expect(ran).toEqual([]);
      const error = await failure(owner.collection("secrets").delete(id));
      expect([error.status, error.message]).toEqual([400, "Keep the plan."]);
      expect(ran).toEqual(["beforeDelete"]);
    });

    it("gives hooks a frozen collection without token secrets", async () => {
      const seen: AnyEvent[] = [];
      hook("users.beforeCreate", (e) => {
        seen.push(e);
      });
      hook("users.onCreate", (e) => {
        seen.push(e);
      });
      const users = nextbase.client().collection("users");
      await users.signUp({
        email: "frozen@example.com",
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      const stored = await admin.collections.getOne("users");
      const secrets = Object.values(
        (stored as { tokens: Record<string, { secret: string }> }).tokens,
      ).map((config) => config.secret);
      expect(secrets.every((s) => typeof s === "string" && s !== "")).toBe(
        true,
      );
      for (const e of seen) {
        const text = JSON.stringify(e.collection);
        for (const secret of secrets) expect(text).not.toContain(secret);
        expect(Object.isFrozen(e.collection)).toBe(true);
        expect(() => {
          (e.collection as { createRule: string | null }).createRule = null;
        }).toThrow(TypeError);
      }
      // The collection itself is unchanged: sign-ups still work.
      await users.create({
        email: "after-frozen@example.com",
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
    });

    it("leaves the caller's session headers out of the request", async () => {
      let headers: Record<string, string> = {};
      hook("posts.beforeCreate", (e) => {
        headers = (e as unknown as { request: { headers: typeof headers } })
          .request.headers;
      });
      const response = await nextbase.handle(
        new Request(
          "http://localhost:3000/api/nextbase/collections/posts/records",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: "nextbase_session=abc",
              "x-trace": "t1",
            },
            body: JSON.stringify({ title: "Headers" }),
          },
        ),
      );
      expect(response.status).toBe(200);
      expect(headers["x-trace"]).toBe("t1");
      expect(headers).not.toHaveProperty("cookie");
      expect(headers).not.toHaveProperty("authorization");
    });

    it("stops after hooks that write the records that fire them", async () => {
      const log = logged();
      const loop = await admin.collection("loops").create({ n: 0 });
      const id = loop?.id as string;
      hook("loops.afterUpdate", async (e) => {
        // A bound, so a loop that never stops still ends this test.
        if (Number(e.record.n) >= 20) return;
        await e.nextbase
          .collection("loops")
          .update(e.record.id, { n: Number(e.record.n) + 1 });
      });
      await admin.collection("loops").update(id, { n: 1 });
      await flush();
      expect((await admin.collection("loops").getOne(id)).n).toBe(9);
      expect(
        log.mock.calls.some(
          ([message, error]) =>
            String(message).includes("afterUpdate hook for loops failed") &&
            String(error).includes("nest more than 8 deep"),
        ),
      ).toBe(true);
    });
  });

  it("types hooks and clients from NextBase<Collections>", () => {
    type Hooks = NonNullable<
      ConstructorParameters<typeof NextBase<Collections>>[0]
    >["hooks"];
    const typed: Hooks = {
      posts: {
        beforeCreate(e) {
          expectTypeOf(e.input.title).toEqualTypeOf<string | undefined>();
          e.input.slug ??= "slug";
        },
        async onUpdate(e) {
          expectTypeOf(e.record.views).toEqualTypeOf<number>();
          expectTypeOf(e.original.title).toEqualTypeOf<string>();
          expectTypeOf(e.nextbase.collection("audit")).toEqualTypeOf<
            RecordService<AuditRecord>
          >();
          await e.nextbase.collection("audit").create({ action: "x" });
        },
        afterDelete(e) {
          expectTypeOf(e.source).toEqualTypeOf<HookSource>();
        },
      },
      "*": {
        afterCreate(e) {
          expectTypeOf(e.record).toEqualTypeOf<RecordModel>();
        },
      },
      // @ts-expect-error: no such collection in Collections.
      postz: {},
    };
    expect(typed).toBeDefined();
    expectTypeOf(nextbase.client().collection("posts")).toEqualTypeOf<
      RecordService<PostsRecord>
    >();
    // Without types, any collection name may have hooks.
    expect(
      () =>
        new NextBase({
          hooks: { anything: { beforeCreate: (e) => void e.input } },
        }),
    ).not.toThrow();
  });

  it("refuses hooks that cannot run", () => {
    expect(
      () => new NextBase({ hooks: { _superusers: { onCreate: () => {} } } }),
    ).toThrow(/_superusers/);
    expect(
      () =>
        new NextBase({
          hooks: { posts: { beforeCreated: () => {} } as never },
        }),
    ).toThrow(/beforeCreated is not a hook/);
    expect(
      () => new NextBase({ hooks: { posts: { onCreate: "x" as never } } }),
    ).toThrow(/must be a function/);
  });
});
