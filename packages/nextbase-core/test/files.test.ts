import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientError, type NextBaseClient } from "@nextbasejs/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextBase } from "../src/index.ts";
import { call, origin } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

const PASSWORD = "password 123 456";
/** The smallest valid PNG: a 1x1 transparent pixel. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A multiple file field's names. */
const listOf = (value: unknown): string[] => value as string[];

const png = (name = "photo.png") =>
  new File([PNG], name, { type: "image/png" });

describe("file uploads with local storage", () => {
  let t: TestDatabase;
  let dir: string;
  let nextbase: NextBase;
  let admin: NextBaseClient;

  const pending: Promise<unknown>[] = [];
  /** The names of the files stored for a record, once deletions finished. */
  const stored = async (collectionId: string, recordId: string) => {
    await Promise.all(pending.splice(0));
    return readdir(join(dir, collectionId, recordId)).catch(
      () => [] as string[],
    );
  };

  const failure = async (promise: Promise<unknown>): Promise<ClientError> => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    return error as ClientError;
  };

  const get = (path: string, headers: Record<string, string> = {}) =>
    nextbase.handle(new Request(`${origin}${path}`, { headers }));

  const signedIn = async (email: string) => {
    const nb = nextbase.client();
    await nb
      .collection("users")
      .signUp({ email, password: PASSWORD, passwordConfirm: PASSWORD });
    return nb;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), "nextbase-files-"));
    nextbase = new NextBase({
      database: t.pool,
      storage: { dir },
      waitUntil: (promise) => pending.push(promise),
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: "users",
      type: "auth",
      createRule: "",
      viewRule: "id = @request.auth.id",
      updateRule: "id = @request.auth.id",
      fields: [
        {
          name: "avatar",
          type: "file",
          mimeTypes: ["image/png", "image/jpeg"],
          maxSize: 1024 * 1024,
        },
        { name: "papers", type: "file", maxSelect: 3, protected: true },
      ],
    });
    await admin.collections.create({
      name: "posts",
      type: "base",
      createRule: "",
      viewRule: "",
      updateRule: "",
      deleteRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "cover", type: "file", maxSize: 10 * 1024 * 1024 },
        { name: "extras", type: "file", maxSelect: 5 },
      ],
    });
  });
  afterAll(async () => {
    await t.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("stores a file sent with a record under a generated name, and serves it", async () => {
    const nb = nextbase.client();
    const post = await nb
      .collection("posts")
      .create({ title: "Hello", cover: png("My Holiday Photo.PNG") });
    expect(post?.title).toBe("Hello");
    const name = post?.cover as string;
    expect(name).toMatch(/^my_holiday_photo_[a-z0-9]{10}\.png$/);
    expect(
      await stored(post?.collectionId as string, post?.id as string),
    ).toEqual([name]);

    const url = nb.files.getUrl(
      post as { id: string; collectionId: string },
      name,
    );
    const response = await get(new URL(url, origin).pathname);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    );
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toContain("public");

    const download = await get(`${new URL(url, origin).pathname}?download=1`);
    expect(download.headers.get("content-disposition")).toBe(
      `attachment; filename="${name}"`,
    );
  });

  it("never lets a shared cache keep a session cookie sent with a public file", async () => {
    await signedIn("cass@example.com");
    const signIn = await nextbase.handle(
      new Request(
        `${origin}/api/nextbase/collections/users/auth-with-password`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            identity: "cass@example.com",
            password: PASSWORD,
            cookie: true,
          }),
        },
      ),
    );
    const token = /nextbase_session=([^;]*)/.exec(
      signIn.headers.get("set-cookie") ?? "",
    )?.[1];
    await t.db
      .newQuery(
        "UPDATE nextbase._sessions SET expires = now() + interval '1 hour'",
      )
      .execute();
    const nb = nextbase.client();
    const post = await nb.collection("posts").create({ cover: png() });
    const path = new URL(
      nb.files.getUrl(
        post as { id: string; collectionId: string },
        post?.cover as string,
      ),
      origin,
    ).pathname;

    // Renewing the session sets its cookie, so no shared cache may store the file.
    const renewed = await get(path, { cookie: `nextbase_session=${token}` });
    expect(renewed.headers.get("set-cookie")).toContain(
      `nextbase_session=${token};`,
    );
    expect(renewed.headers.get("cache-control")).toBe("private, no-store");
    // So does removing a cookie whose session ended.
    const cleared = await get(path, { cookie: "nextbase_session=ended" });
    expect(cleared.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(cleared.headers.get("cache-control")).toBe("private, no-store");
    // Without a cookie to set, the file stays cacheable.
    const plain = await get(path, { cookie: `nextbase_session=${token}` });
    expect(plain.headers.get("set-cookie")).toBeNull();
    expect(plain.headers.get("cache-control")).toBe("public, max-age=604800");
  });

  it("checks the type from the file's bytes, not its label", async () => {
    const nb = await signedIn("ann@example.com");
    const id = nb.authStore.record?.id as string;
    const fake = new File(["<script>alert(1)</script>"], "x.png", {
      type: "image/png",
    });
    const error = await failure(
      nb.collection("users").update(id, { avatar: fake }),
    );
    expect(error.data.avatar?.code).toBe("validation_invalid_mime_type");
    const updated = await nb.collection("users").update(id, { avatar: png() });
    expect(updated?.avatar).toMatch(/\.png$/);
  });

  it("serves files that could run scripts as downloads", async () => {
    const post = await nextbase
      .client()
      .collection("posts")
      .create({
        cover: new File(["<script>alert(1)</script>"], "page.html", {
          type: "text/html",
        }),
      });
    // The XML detector reads this markup as XML; served as a download either way.
    expect(post?.cover).toMatch(/^page_[a-z0-9]{10}\.xml$/);
    const response = await get(
      `/api/nextbase/files/${post?.collectionId}/${post?.id}/${post?.cover}`,
    );
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("serves byte ranges, so video players can seek", async () => {
    const post = await nextbase
      .client()
      .collection("posts")
      .create({ cover: png() });
    const path = `/api/nextbase/files/${post?.collectionId}/${post?.id}/${post?.cover}`;
    const part = await get(path, { range: "bytes=1-3" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 1-3/${PNG.length}`);
    expect(part.headers.get("content-length")).toBe("3");
    expect(Buffer.from(await part.arrayBuffer())).toEqual(PNG.subarray(1, 4));

    const tail = await get(path, { range: "bytes=-4" });
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(PNG.subarray(-4));

    const beyond = await get(path, { range: `bytes=${PNG.length + 10}-` });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${PNG.length}`);

    // Several ranges, a malformed header, or If-Range: the whole file.
    for (const headers of <Record<string, string>[]>[
      { range: "bytes=0-1,5-6" },
      { range: "pages=1-2" },
      { range: "bytes=0-1", "if-range": '"some-etag"' },
    ]) {
      const whole = await get(path, headers);
      expect(whole.status).toBe(200);
      expect(Buffer.from(await whole.arrayBuffer())).toEqual(PNG);
    }
  });

  it("recognizes SVG and XML from their bytes, whatever their label", async () => {
    await admin.collections.create({
      name: "notes",
      type: "base",
      createRule: "",
      fields: [
        { name: "text", type: "file", mimeTypes: ["text/plain"] },
        { name: "logo", type: "file", mimeTypes: ["image/svg+xml"] },
      ],
    });
    const notes = nextbase.client().collection("notes");
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    // An SVG labeled as plain text is still an SVG.
    const disguised = await failure(
      notes.create({ text: new File([svg], "a.txt", { type: "text/plain" }) }),
    );
    expect(disguised.data.text?.code).toBe("validation_invalid_mime_type");
    // A label of SVG counts only if the bytes are SVG.
    const fake = await failure(
      notes.create({
        logo: new File(["hello"], "a.svg", { type: "image/svg+xml" }),
      }),
    );
    expect(fake.data.logo?.code).toBe("validation_invalid_mime_type");
    // Created; nobody may view the collection, so the result is null.
    const real = await notes.create({
      logo: new File([svg], "logo.svg", { type: "image/svg+xml" }),
      text: new File(["hello"], "a.txt", { type: "text/plain" }),
    });
    expect(real).toBeNull();
  });

  it("enforces size and count limits", async () => {
    const nb = nextbase.client();
    const big = new File([new Uint8Array(1024 * 1024 + 1)], "big.png", {
      type: "image/png",
    });
    const user = await signedIn("bo@example.com");
    const tooBig = await failure(
      user
        .collection("users")
        .update(user.authStore.record?.id as string, { avatar: big }),
    );
    expect(tooBig.data.avatar?.code).toBe("validation_file_too_large");
    const tooMany = await failure(
      nb.collection("posts").create({
        extras: [1, 2, 3, 4, 5, 6].map((i) => png(`${i}.png`)),
      }),
    );
    expect(tooMany.data.extras?.code).toBe("validation_too_many");
  });

  it("limits form data to 1000 parts, counted before it is parsed", async () => {
    const send = (parts: number) => {
      const form = new FormData();
      for (let i = 0; i < parts; i++) form.append("extras", png(`${i}.png`));
      return nextbase.handle(
        new Request(`${origin}/api/nextbase/collections/posts/records`, {
          method: "POST",
          body: form,
        }),
      );
    };
    const many = await send(1001);
    expect(many.status).toBe(400);
    expect(await many.json()).toMatchObject({
      message: "The request body has more than 1000 parts.",
    });
    // Up to the limit, the record's own checks apply.
    const allowed = await send(1000);
    expect(allowed.status).toBe(400);
    expect(
      ((await allowed.json()) as { data: { extras?: { code: string } } }).data
        .extras?.code,
    ).toBe("validation_too_many");

    // Repeating a key used to copy its list on every part, so 32 MiB of
    // tiny parts held the event loop for minutes.
    const boundary = "b0undary";
    const part = `--${boundary}\r\ncontent-disposition: form-data; name="title"\r\n\r\nx\r\n`;
    const started = performance.now();
    const huge = await nextbase.handle(
      new Request(`${origin}/api/nextbase/collections/posts/records`, {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body: `${part.repeat(500_000)}--${boundary}--\r\n`,
      }),
    );
    expect(huge.status).toBe(400);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("adds, keeps and removes files, deleting removed ones", async () => {
    const posts = nextbase.client().collection("posts");
    const post = await posts.create({ extras: [png("a.png"), png("b.png")] });
    const id = post?.id as string;
    const [a, b] = listOf(post?.extras);
    const added = await posts.update(id, { "extras+": png("c.png") });
    const c = listOf(added?.extras)[2] as string;
    expect(added?.extras).toEqual([a, b, c]);

    // `+extras` puts new files first, as for selects and relations.
    const first = await posts.update(id, { "+extras": png("z.png") });
    const z = listOf(first?.extras)[0] as string;
    expect(first?.extras).toEqual([z, a, b, c]);
    await posts.update(id, { "extras-": z });

    const removed = await posts.update(id, { "extras-": a });
    expect(removed?.extras).toEqual([b, c]);
    // Replacing lists the names to keep, in their new order.
    const replaced = await posts.update(id, { extras: [c, png("d.png")] });
    const d = listOf(replaced?.extras)[1] as string;
    expect(replaced?.extras).toEqual([c, d]);
    expect((await stored(post?.collectionId as string, id)).sort()).toEqual(
      [c, d].sort(),
    );

    const unknown = await failure(posts.update(id, { extras: ["nope.png"] }));
    expect(unknown.data.extras?.code).toBe("validation_invalid_value");
    await posts.update(id, { extras: [] });
    expect(await stored(post?.collectionId as string, id)).toEqual([]);
  });

  it("removes stored files again when a write fails", async () => {
    // Files are stored once the write is allowed; a duplicate value fails
    // the insert after that, and the files must go again.
    const created = await admin.collections.create({
      name: "slugs",
      type: "base",
      createRule: "",
      fields: [
        { name: "slug", type: "text" },
        { name: "image", type: "file" },
      ],
    });
    const slugField = created.fields.find((f) => f.name === "slug")?.id ?? "";
    await admin.collections.update("slugs", {
      indexes: [
        {
          name: "slugs_slug",
          unique: true,
          fields: [slugField],
          type: "btree",
        },
      ],
    });
    const slugs = nextbase.client().collection("slugs");
    await slugs.create({ slug: "taken", image: png() });
    const duplicate = await failure(
      slugs.create({ slug: "taken", image: png() }),
    );
    expect(duplicate.data.slug?.code).toBe("validation_not_unique");
    await Promise.all(pending.splice(0));
    const { id: slugsId } = await admin.collections.getOne("slugs");
    expect(await readdir(join(dir, slugsId))).toHaveLength(1);

    // A user may not change someone else's avatar: nothing is stored.
    const owner = await signedIn("cy@example.com");
    const ownerId = owner.authStore.record?.id as string;
    const intruder = await signedIn("dee@example.com");
    const error = await failure(
      intruder.collection("users").update(ownerId, { avatar: png() }),
    );
    expect(error.status).toBe(404);
    const users = await admin.collections.getOne("users");
    expect(await stored(users.id, ownerId)).toEqual([]);
  });

  it("deletes a record's files with the record, a field and the collection", async () => {
    const posts = nextbase.client().collection("posts");
    const post = await posts.create({ cover: png(), extras: [png()] });
    const collection = post?.collectionId as string;
    await posts.delete(post?.id as string);
    expect(await stored(collection, post?.id as string)).toEqual([]);

    const again = await posts.create({ cover: png(), extras: [png()] });
    const definition = await admin.collections.getOne("posts");
    await admin.collections.update("posts", {
      fields: definition.fields.filter((f) => f.name !== "extras"),
    });
    expect(await stored(collection, again?.id as string)).toEqual([
      again?.cover,
    ]);
    await admin.collections.delete("posts");
    await Promise.all(pending.splice(0));
    await expect(readdir(join(dir, collection))).rejects.toThrow();
  });

  it("serves protected files only to callers the view rule allows", async () => {
    const owner = await signedIn("eve@example.com");
    const id = owner.authStore.record?.id as string;
    const record = await owner.collection("users").update(id, {
      papers: [new File(["secret"], "notes.txt", { type: "text/plain" })],
    });
    const name = listOf(record?.papers)[0] as string;
    const path = `/api/nextbase/files/${record?.collectionId}/${id}/${name}`;

    expect((await get(path)).status).toBe(404);
    const viaBearer = await get(path, {
      authorization: `Bearer ${owner.authStore.token}`,
    });
    expect(viaBearer.status).toBe(200);
    expect(await viaBearer.text()).toBe("secret");
    expect(viaBearer.headers.get("cache-control")).toBe("private, no-store");

    const token = await owner.files.getToken();
    const url = owner.files.getUrl(
      record as { id: string; collectionId: string },
      name,
      { token },
    );
    expect(
      (await get(new URL(url, origin).pathname + new URL(url, origin).search))
        .status,
    ).toBe(200);

    const stranger = await signedIn("fay@example.com");
    const theirs = await stranger.files.getToken();
    expect((await get(`${path}?token=${theirs}`)).status).toBe(404);
    expect((await get(`${path}?token=forged`)).status).toBe(404);
  });

  it("serves only generated names of files a record has", async () => {
    for (const path of [
      "/api/nextbase/files/users/abcdefghijklmno/..%2F..%2Fetc%2Fpasswd",
      "/api/nextbase/files/users/abcdefghijklmno/photo_abcdefghij.png",
      "/api/nextbase/files/nope/abcdefghijklmno/photo_abcdefghij.png",
      "/api/nextbase/files/users/..%2F/photo_abcdefghij.png",
    ]) {
      expect((await get(path)).status).toBe(404);
    }
  });

  it("falls back to sending a large file with the record when there is no bucket", async () => {
    const big = new File([PNG, new Uint8Array(5 * 1024 * 1024)], "big.png", {
      type: "image/png",
    });
    const posts = nextbase.client().collection("posts");
    await admin.collections.create({
      name: "posts",
      type: "base",
      createRule: "",
      viewRule: "",
      fields: [{ name: "cover", type: "file", maxSize: 10 * 1024 * 1024 }],
    });
    const post = await posts.create({ cover: big });
    expect(post?.cover).toMatch(/^big_[a-z0-9]{10}\.png$/);
    const direct = await call(
      nextbase,
      "POST",
      "/collections/posts/upload-url",
      {
        body: {
          field: "cover",
          filename: "a.png",
          size: 10,
          type: "image/png",
        },
      },
    );
    expect(direct.status).toBe(400);
  });

  it("refuses local uploads on Vercel, which keeps no files", async () => {
    vi.stubEnv("VERCEL", "1");
    try {
      const error = await failure(
        nextbase.client().collection("posts").create({ cover: png() }),
      );
      expect(error.message).toMatch(/storage\.s3/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads the files of a stored file it serves from disk", async () => {
    const post = await nextbase
      .client()
      .collection("posts")
      .create({ cover: png() });
    const bytes = await readFile(
      join(
        dir,
        post?.collectionId as string,
        post?.id as string,
        post?.cover as string,
      ),
    );
    expect(bytes).toEqual(PNG);
  });
});
