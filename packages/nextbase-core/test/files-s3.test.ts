import type { NextBaseClient } from "@nextbasejs/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextBase } from "../src/index.ts";
import { type FakeS3, startFakeS3 } from "./fake-s3.ts";
import { call, origin } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("file uploads to an S3-compatible bucket", () => {
  let t: TestDatabase;
  let s3: FakeS3;
  let nextbase: NextBase;
  let admin: NextBaseClient;
  const pending: Promise<unknown>[] = [];
  const settle = () => Promise.all(pending.splice(0));
  const keys = () => [...s3.objects.keys()].sort();

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
      name: "videos",
      type: "base",
      createRule: "",
      viewRule: "",
      updateRule: "",
      deleteRule: "",
      fields: [
        {
          name: "clip",
          type: "file",
          maxSize: 20 * 1024 * 1024,
          mimeTypes: ["image/png"],
        },
      ],
    });
  });
  afterAll(async () => {
    await t.close();
    await s3.stop();
  });

  it("stores a small file in the bucket and redirects downloads to a signed URL", async () => {
    const nb = nextbase.client();
    const video = await nb
      .collection("videos")
      .create({ clip: new File([PNG], "a.png", { type: "image/png" }) });
    const key = `${video?.collectionId}/${video?.id}/${video?.clip}`;
    expect(s3.objects.get(key)?.body).toEqual(PNG);
    expect(s3.objects.get(key)?.contentType).toBe("image/png");

    const response = await nextbase.handle(
      new Request(
        new URL(
          nb.files.getUrl(
            video as { id: string; collectionId: string },
            video?.clip as string,
          ),
          origin,
        ),
      ),
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe(s3.endpoint);
    expect(location.searchParams.get("X-Amz-Expires")).toBe("300");
    const download = await fetch(location);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(PNG);
  });

  it("uploads a large file straight to the bucket, then moves it into the record", async () => {
    const big = new File([PNG, new Uint8Array(5 * 1024 * 1024)], "big.png", {
      type: "image/png",
    });
    const video = await nextbase
      .client()
      .collection("videos")
      .create({ clip: big });
    await settle();
    const key = `${video?.collectionId}/${video?.id}/${video?.clip}`;
    // The file never went through the API: the SDK PUT it to a signed URL.
    expect(
      s3.requests.some((r) => r.startsWith(`PUT /${s3.bucket}/_uploads/`)),
    ).toBe(true);
    expect(s3.objects.get(key)?.body.length).toBe(big.size);
    expect(keys().filter((k) => k.startsWith("_uploads/"))).toEqual([]);
    const { rows } = await t.pool.query(
      "SELECT count(*)::int AS n FROM nextbase._uploads",
    );
    expect(rows[0].n).toBe(0);
  });

  it("refuses an upload that is unfinished, of another size, type or field, or expired", async () => {
    const start = async (body: Record<string, unknown>) =>
      call(nextbase, "POST", "/collections/videos/upload-url", { body });
    const upload = await start({
      field: "clip",
      filename: "x.png",
      size: PNG.length,
      type: "image/png",
    });
    expect(upload.status).toBe(200);
    expect(upload.body).toMatchObject({
      method: "PUT",
      headers: { "content-type": "image/png" },
    });
    const token = upload.body.token as string;
    // The size and type are part of the signature: the bucket refuses others.
    const signed = new URL(upload.body.url as string).searchParams.get(
      "X-Amz-SignedHeaders",
    );
    expect(signed?.split(";")).toEqual(
      expect.arrayContaining(["content-length", "content-type"]),
    );
    const create = (clip: string) =>
      call(nextbase, "POST", "/collections/videos/records", { body: { clip } });

    // Nothing was PUT yet.
    expect((await create(token)).body.data).toMatchObject({
      clip: { code: "validation_invalid_upload" },
    });
    // A different size than signed for.
    await fetch(upload.body.url as string, {
      method: "PUT",
      body: Buffer.concat([PNG, PNG]),
    });
    expect((await create(token)).body.data).toMatchObject({
      clip: { code: "validation_invalid_upload" },
    });
    // The right size, but not the type the field allows.
    await fetch(upload.body.url as string, {
      method: "PUT",
      body: Buffer.alloc(PNG.length),
    });
    expect((await create(token)).body.data).toMatchObject({
      clip: { code: "validation_invalid_mime_type" },
    });
    await fetch(upload.body.url as string, { method: "PUT", body: PNG });
    await t.pool.query(
      "UPDATE nextbase._uploads SET expires = now() - interval '1 second'",
    );
    expect((await create(token)).body.data).toMatchObject({
      clip: { code: "validation_invalid_upload" },
    });

    const tooBig = await start({
      field: "clip",
      filename: "x.png",
      size: 21 * 1024 * 1024,
      type: "image/png",
    });
    expect(tooBig.body.data).toMatchObject({
      size: { code: "validation_file_too_large" },
    });
    const noField = await start({
      field: "nope",
      filename: "x.png",
      size: 1,
      type: "image/png",
    });
    expect(noField.body.data).toMatchObject({
      field: { code: "validation_invalid_value" },
    });
    // Starting a new upload clears expired ones and their files.
    const expiredKey = `_uploads/${token.slice("upload:".length)}`;
    expect(keys()).toContain(expiredKey);
    await start({
      field: "clip",
      filename: "y.png",
      size: 1,
      type: "image/png",
    });
    await settle();
    expect(keys()).not.toContain(expiredKey);
  });

  it("refuses uploads to collections nobody may write to", async () => {
    await admin.collections.create({
      name: "locked",
      type: "base",
      fields: [{ name: "doc", type: "file" }],
    });
    const response = await call(
      nextbase,
      "POST",
      "/collections/locked/upload-url",
      {
        body: { field: "doc", filename: "a.txt", size: 1, type: "text/plain" },
      },
    );
    expect(response.status).toBe(403);
  });

  it("deletes a record's and a collection's files from the bucket", async () => {
    const videos = nextbase.client().collection("videos");
    const one = await videos.create({
      clip: new File([PNG], "a.png", { type: "image/png" }),
    });
    await videos.delete(one?.id as string);
    await settle();
    expect(keys().some((k) => k.includes(one?.id as string))).toBe(false);

    await videos.create({
      clip: new File([PNG], "b.png", { type: "image/png" }),
    });
    const { id } = await admin.collections.getOne("videos");
    await admin.collections.delete("videos");
    expect(keys().some((k) => k.startsWith(`${id}/`))).toBe(false);
  });

  it("does not need the Vercel guard with a bucket", async () => {
    vi.stubEnv("VERCEL", "1");
    try {
      await admin.collections.create({
        name: "photos",
        type: "base",
        createRule: "",
        fields: [{ name: "img", type: "file" }],
      });
      const photo = await nextbase
        .client({ superuser: true })
        .collection("photos")
        .create({ img: new File([PNG], "a.png", { type: "image/png" }) });
      expect(photo?.img).toMatch(/\.png$/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
