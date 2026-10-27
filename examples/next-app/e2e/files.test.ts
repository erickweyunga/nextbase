import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Api } from "./client.ts";
import { type Server, startServer } from "./server.ts";
import { firstSuperuser } from "./setup.ts";

// File uploads through the built example app: form data through the Next.js
// route handler, and the file served back.

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let server: Server;
let admin: Api;

beforeAll(async () => {
  server = await startServer();
  admin = await firstSuperuser(server);
  const created = await admin.send("POST", "/collections", {
    name: "photos",
    type: "base",
    createRule: "",
    viewRule: "",
    fields: [
      { name: "caption", type: "text" },
      { name: "image", type: "file", mimeTypes: ["image/png"] },
    ],
  });
  expect(created.status).toBe(200);
});

afterAll(() => server?.stop());

describe("file uploads in the example app", () => {
  it("uploads a file as form data and serves it back", async () => {
    const form = new FormData();
    form.append("@jsonPayload", JSON.stringify({ caption: "Sunset" }));
    form.append("image", new File([PNG], "sunset.png", { type: "image/png" }));
    const response = await fetch(`${server.api}/collections/photos/records`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    const photo = (await response.json()) as Record<string, string>;
    expect(photo.caption).toBe("Sunset");
    expect(photo.image).toMatch(/^sunset_[a-z0-9]{10}\.png$/);

    const file = await fetch(
      `${server.api}/files/${photo.collectionId}/${photo.id}/${photo.image}`,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
  });

  it("refuses a file whose bytes are not an allowed type", async () => {
    const form = new FormData();
    form.append(
      "image",
      new File(["<html></html>"], "fake.png", { type: "image/png" }),
    );
    const response = await fetch(`${server.api}/collections/photos/records`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { data: Record<string, { code: string }> })
        .data.image?.code,
    ).toBe("validation_invalid_mime_type");
  });
});
