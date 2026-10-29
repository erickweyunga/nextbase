import type { NextBaseClient } from "@nextbasejs/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextBase } from "../src/index.ts";
import { type FakeS3, startFakeS3 } from "./fake-s3.ts";
import { call } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";
import { waitFor } from "./wait.ts";

/** The smallest valid PNG: a 1x1 transparent pixel. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const png = () => new File([PNG], "a.png", { type: "image/png" });

describe("files are stored before the write's transaction", () => {
  let t: TestDatabase;
  let s3: FakeS3;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const pending: Promise<unknown>[] = [];
  const settle = () => Promise.all(pending.splice(0));
  const puts = () => s3.requests.filter((r) => r.startsWith("PUT ")).length;

  beforeAll(async () => {
    s3 = await startFakeS3();
    t = await createTestDatabase();
    nextbase = new NextBase({
      database: t.pool,
      storage: {
        s3: {
          bucket: s3.bucket,
          endpoint: s3.endpoint,
          region: "us-east-1",
          accessKeyId: "test",
          secretAccessKey: "test",
          forcePathStyle: true,
        },
      },
      waitUntil: (promise) => pending.push(promise),
    });
    admin = nextbase.client({ superuser: true });
    await admin.collections.create({
      name: "clips",
      createRule: "",
      viewRule: "",
      // Only signed-in callers, so anonymous updates are refused.
      updateRule: '@request.auth.id != ""',
      fields: [{ name: "video", type: "file", mimeTypes: ["image/png"] }],
    });
  });

  afterAll(async () => {
    await nextbase.flush();
    await t.close();
    await s3.stop();
  });

  it("holds no lock and no transaction while a file is stored", async () => {
    const clip = await admin.collection("clips").create({});
    let release = () => {};
    s3.hold = new Promise((resolve) => {
      release = resolve;
    });
    const before = puts();
    const update = admin
      .collection("clips")
      .update(clip?.id ?? "", { video: png() });
    try {
      await waitFor(() => puts() > before, "the file to be stored");
      const other = await t.pool.connect();
      try {
        // Waits for no one: the record is not locked meanwhile.
        await other.query("BEGIN");
        await other.query(
          "SELECT 1 FROM nextbase.clips WHERE id = $1 FOR UPDATE NOWAIT",
          [clip?.id],
        );
        await other.query("ROLLBACK");
        const { rows } = await other.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'",
        );
        expect(rows[0].n).toBe(0);
      } finally {
        other.release();
      }
    } finally {
      s3.hold = undefined;
      release();
    }
    expect((await update)?.video).toMatch(/\.png$/);
  });

  it("stores no file for a caller the update rule refuses", async () => {
    const clip = await admin.collection("clips").create({});
    const before = puts();
    const form = new FormData();
    form.append("video", png());
    const response = await nextbase.handle(
      new Request(
        `http://localhost:3000/api/nextbase/collections/clips/records/${clip?.id}`,
        { method: "PATCH", body: form },
      ),
    );
    expect(response.status).toBe(404);
    expect(puts()).toBe(before);
  });

  it("stores no file for a caller the create rule or a body-reading update rule refuses", async () => {
    await admin.collections.create({
      name: "photos",
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != "" && @request.body.title:isset = false',
      fields: [
        { name: "title", type: "text" },
        { name: "image", type: "file", mimeTypes: ["image/png"] },
      ],
    });
    const photo = await admin.collection("photos").create({});
    const before = puts();
    const anonymous = nextbase.client().collection("photos");
    await expect(anonymous.create({ image: png() })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      anonymous.update(photo?.id ?? "", { image: png() }),
    ).rejects.toMatchObject({ status: 404 });
    expect(puts()).toBe(before);
  });

  it("claims a direct upload once, even when two writes read it", async () => {
    const upload = await call(
      nextbase,
      "POST",
      "/collections/clips/upload-url",
      {
        body: {
          field: "video",
          filename: "a.png",
          size: PNG.length,
          type: "image/png",
        },
      },
    );
    await fetch(upload.body.url as string, { method: "PUT", body: PNG });
    const token = upload.body.token as string;
    const before = new Set(s3.objects.keys());

    // Both writes read the upload before the batch's transaction; the second
    // finds it already claimed by the first.
    const reply = await call(nextbase, "POST", "/batch", {
      body: {
        requests: [
          {
            method: "POST",
            url: "/collections/clips/records",
            body: { video: token },
          },
          {
            method: "POST",
            url: "/collections/clips/records",
            body: { video: token },
          },
        ],
      },
    });
    expect(reply.status).toBe(400);
    expect(reply.body.message).toMatch(/^Request 2 of the batch failed/);
    expect(reply.body.data).toMatchObject({
      requests: { 1: { video: { code: "validation_invalid_upload" } } },
    });
    // Nothing was saved: the upload is still there, and both copies are gone.
    await settle();
    expect(new Set(s3.objects.keys())).toEqual(before);
    const { rows } = await t.pool.query(
      "SELECT count(*)::int AS n FROM nextbase._uploads",
    );
    expect(rows[0].n).toBe(1);
  });
});
