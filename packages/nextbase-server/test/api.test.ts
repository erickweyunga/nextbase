import { hash } from "@nextbasejs/dbx";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.ts";
import { NextBase } from "../src/index.ts";
import {
  type CallOptions,
  origin,
  type Reply,
  call as request,
} from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

describe("HTTP API", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let token = "";

  const call = (
    method: string,
    path: string,
    { instance, ...options }: CallOptions & { instance?: NextBase } = {},
  ): Promise<Reply> => request(instance ?? nextbase, method, path, options);

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
  });
  afterAll(() => t.close());

  describe("first-run setup", () => {
    let setupToken = "";

    it("reports that setup is required and logs a one-time token", async () => {
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        expect(await call("GET", "/setup")).toEqual({
          status: 200,
          body: { required: true },
        });
        const message = String(log.mock.calls[0]?.[0]);
        expect(message).toContain(`${origin}/api/nextbase/setup`);
        setupToken = /"token":"([^"]+)"/.exec(message)?.[1] ?? "";
        expect(setupToken).not.toBe("");
        // Rate-limited: not logged again on the next request.
        await call("GET", "/setup");
        expect(log).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    });

    it("needs the token and valid credentials", async () => {
      const credentials = {
        email: "admin@example.com",
        password: "a long enough password",
      };
      expect(
        (
          await call("POST", "/setup", {
            body: { ...credentials, token: "forged" },
          })
        ).status,
      ).toBe(403);
      expect(
        await call("POST", "/setup", {
          body: { token: setupToken, email: "nope", password: "short" },
        }),
      ).toMatchObject({
        status: 400,
        body: {
          data: {
            email: { code: "validation_invalid_email" },
            password: { code: "validation_length_out_of_range" },
          },
        },
      });

      const created = await call("POST", "/setup", {
        body: { ...credentials, token: setupToken },
      });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({
        collectionName: "_superusers",
        email: "admin@example.com",
        verified: true,
      });
      expect(created.body).not.toHaveProperty("password");
      expect(created.body).not.toHaveProperty("tokenKey");
    });

    it("is over once a superuser exists", async () => {
      const again = await call("POST", "/setup", {
        body: {
          token: setupToken,
          email: "second@example.com",
          password: "a long enough password",
        },
      });
      expect(again.status).toBe(404);
      expect(await call("GET", "/setup")).toEqual({
        status: 200,
        body: { required: false },
      });
    });
  });

  describe("superuser login", () => {
    it("rejects wrong credentials with one generic error", async () => {
      for (const body of [
        { identity: "admin@example.com", password: "wrong password!" },
        { identity: "nobody@example.com", password: "a long enough password" },
      ]) {
        expect(
          await call("POST", "/collections/_superusers/auth-with-password", {
            body,
          }),
        ).toMatchObject({
          status: 400,
          body: { message: "Failed to authenticate.", data: {} },
        });
      }
    });

    it("returns a token and the record, matching email regardless of case", async () => {
      const reply = await call(
        "POST",
        "/collections/_superusers/auth-with-password",
        {
          body: {
            identity: "ADMIN@example.com",
            password: "a long enough password",
          },
        },
      );
      expect(reply.status).toBe(200);
      expect(reply.body.record).toMatchObject({ email: "admin@example.com" });
      token = reply.body.token as string;
      // An opaque session token: 32 random bytes.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("refreshes a valid token", async () => {
      const reply = await call(
        "POST",
        "/collections/_superusers/auth-refresh",
        { token },
      );
      expect(reply.status).toBe(200);
      expect(
        (
          await call("GET", "/collections", {
            token: reply.body.token as string,
          })
        ).status,
      ).toBe(200);
      expect(
        (await call("POST", "/collections/_superusers/auth-refresh")).status,
      ).toBe(401);
    });

    it("throttles an identity after 10 failures, even with the right password", async () => {
      await nextbase.createSuperuser(
        "target@example.com",
        "the right password",
      );
      const attempt = (password: string): Promise<Reply> =>
        call("POST", "/collections/_superusers/auth-with-password", {
          body: { identity: "target@example.com", password },
        });
      for (let i = 0; i < 10; i++)
        expect((await attempt("wrong")).status).toBe(400);
      expect((await attempt("the right password")).status).toBe(429);
      // Other identities are unaffected.
      const other = await call(
        "POST",
        "/collections/_superusers/auth-with-password",
        {
          body: {
            identity: "admin@example.com",
            password: "a long enough password",
          },
        },
      );
      expect(other.status).toBe(200);
    });

    it("rejects duplicate superuser emails", async () => {
      await expect(
        nextbase.createSuperuser("Admin@Example.com", "a long enough password"),
      ).rejects.toMatchObject({
        status: 400,
        data: { email: { code: "validation_not_unique" } },
      });
    });
  });

  describe("authorization", () => {
    it("requires a valid superuser token for the collections API", async () => {
      expect((await call("GET", "/collections")).status).toBe(401);
      expect(
        (await call("GET", "/collections", { token: "garbage" })).status,
      ).toBe(401);
      expect(
        (
          await call("GET", "/collections", {
            headers: { authorization: "Basic abc" },
          })
        ).status,
      ).toBe(401);
    });

    it("revokes tokens when the record's tokenKey rotates", async () => {
      const login = await call(
        "POST",
        "/collections/_superusers/auth-with-password",
        {
          body: {
            identity: "admin@example.com",
            password: "a long enough password",
          },
        },
      );
      const stale = login.body.token as string;
      await t.db
        .update(
          "nextbase._superusers",
          { tokenKey: "rotated-key-rotated-key-rotated-key" },
          hash({ email: "admin@example.com" }),
        )
        .execute();
      expect((await call("GET", "/collections", { token: stale })).status).toBe(
        401,
      );
      const fresh = await call(
        "POST",
        "/collections/_superusers/auth-with-password",
        {
          body: {
            identity: "admin@example.com",
            password: "a long enough password",
          },
        },
      );
      token = fresh.body.token as string;
      expect((await call("GET", "/collections", { token })).status).toBe(200);
    });

    it("lets other auth collections log in, but not manage collections", async () => {
      const users = await call("POST", "/collections", {
        token,
        body: { name: "users", type: "auth" },
      });
      expect(users.status).toBe(200);
      await t.db
        .insert("nextbase.users", {
          id: "user00000000001",
          email: "ann@example.com",
          password: await hashPassword("ann's long password"),
          tokenKey: "ann-token-key-ann-token-key-ann-token",
        })
        .execute();
      const login = await call(
        "POST",
        "/collections/users/auth-with-password",
        {
          body: {
            identity: "ann@example.com",
            password: "ann's long password",
          },
        },
      );
      expect(login.status).toBe(200);
      expect(
        (
          await call("GET", "/collections", {
            token: login.body.token as string,
          })
        ).status,
      ).toBe(403);
      // A users token is not a superusers token, even for a record with the same id.
      expect(
        (
          await call("POST", "/collections/_superusers/auth-refresh", {
            token: login.body.token as string,
          })
        ).status,
      ).toBe(401);
    });
  });

  describe("collections API", () => {
    it("creates, reads, updates and deletes collections", async () => {
      const created = await call("POST", "/collections", {
        token,
        body: {
          name: "posts",
          fields: [{ id: "title00000", name: "title", type: "text" }],
        },
      });
      expect(created).toMatchObject({
        status: 200,
        body: { name: "posts", type: "base" },
      });

      const list = await call("GET", "/collections", { token });
      expect(
        (list.body.items as { name: string }[]).map((c) => c.name),
      ).toEqual(["_superusers", "users", "posts"]);
      expect(list.body).toMatchObject({ page: 1, totalItems: 3 });

      expect(
        await call("GET", `/collections/${created.body.id}`, { token }),
      ).toMatchObject({ body: { name: "posts" } });
      expect(
        await call("PATCH", "/collections/posts", {
          token,
          body: { name: "articles" },
        }),
      ).toMatchObject({
        status: 200,
        body: { name: "articles" },
      });
      expect(
        (await call("DELETE", "/collections/articles", { token })).status,
      ).toBe(204);
      expect(
        (await call("GET", "/collections/articles", { token })).status,
      ).toBe(404);
    });

    it("returns every validation error at once", async () => {
      expect(
        await call("POST", "/collections", {
          token,
          body: { name: "bad name", fields: [{ name: "x", type: "nope" }] },
        }),
      ).toMatchObject({
        status: 400,
        body: {
          data: {
            name: { code: "validation_invalid_name" },
            fields: { 0: { type: { code: "validation_invalid_value" } } },
          },
        },
      });
    });

    it("reports existing data that blocks a change as a 400", async () => {
      await call("POST", "/collections", {
        token,
        body: {
          name: "tags",
          fields: [{ id: "label00000", name: "label", type: "text" }],
        },
      });
      await t.db
        .insert("nextbase.tags", { id: "tag000000000001", label: "x" })
        .execute();
      await t.db
        .insert("nextbase.tags", { id: "tag000000000002", label: "x" })
        .execute();
      const reply = await call("PATCH", "/collections/tags", {
        token,
        body: {
          indexes: [
            { name: "tags_label", unique: true, fields: ["label00000"] },
          ],
        },
      });
      expect(reply.status).toBe(400);
      expect(reply.body.message).toMatch(/conflicts with existing records/);
    });

    it("sees schema changes made by other instances", async () => {
      const other = new NextBase({ database: t.pool });
      await call("POST", "/collections", {
        token,
        instance: other,
        body: { name: "fromOther" },
      });
      expect(
        (await call("GET", "/collections/fromOther", { token })).status,
      ).toBe(200);
    });
  });

  describe("request handling", () => {
    it("rejects non-JSON bodies, oversized bodies and malformed URLs", async () => {
      expect(
        (
          await call("POST", "/collections", {
            token,
            body: "name=x",
            headers: { "content-type": "text/plain" },
          })
        ).status,
      ).toBe(415);
      expect(
        (await call("POST", "/collections", { token, body: "{not json" }))
          .status,
      ).toBe(400);
      expect(
        (
          await call("POST", "/collections", {
            token,
            body: JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) }),
          })
        ).status,
      ).toBe(413);
      expect(
        (await call("GET", "/collections/%E0%A4%A", { token })).status,
      ).toBe(400);
    });

    it("answers unknown routes with 404, and other methods of known ones with 405 and Allow", async () => {
      expect((await call("GET", "/nope")).status).toBe(404);
      const raw = (method: string, path: string, headers = {}) =>
        nextbase.handle(
          new Request(`${origin}/api/nextbase${path}`, { method, headers }),
        );
      const put = await raw("PUT", "/collections");
      expect(put.status).toBe(405);
      expect(put.headers.get("allow")).toBe("GET, POST, HEAD");
      expect(await put.json()).toMatchObject({ status: 405 });
      expect((await raw("DELETE", "/health")).headers.get("allow")).toBe(
        "GET, HEAD",
      );
      expect(
        (await raw("PUT", "/collections/x/records/y")).headers.get("allow"),
      ).toBe("GET, PATCH, DELETE, HEAD");
    });

    it("marks every API response uncacheable and its content type final", async () => {
      for (const response of [
        await nextbase.handle(new Request(`${origin}/api/nextbase/health`)),
        await nextbase.handle(new Request(`${origin}/api/nextbase/nope`)),
        await nextbase.handle(
          new Request(`${origin}/api/nextbase/collections`, {
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
      ]) {
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      }
      // RFC 9110: a 401 names the scheme that would be accepted.
      const anonymous = await nextbase.handle(
        new Request(`${origin}/api/nextbase/collections`),
      );
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    });

    it("answers HEAD like GET, as Next.js routes it to the GET handler", async () => {
      expect((await call("HEAD", "/health")).status).toBe(200);
      expect((await call("HEAD", "/collections", { token })).status).toBe(200);
    });
  });
});
