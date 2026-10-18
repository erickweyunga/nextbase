import { describe, expect, it } from "vitest";
import { ClientError, NextBaseClient } from "../src/client/index.ts";
import { NextBase } from "../src/server/index.ts";

const origin = "http://localhost:3000";

describe("route handler", () => {
  const { handle } = new NextBase();

  it("reports health", async () => {
    const response = await handle(new Request(`${origin}/api/nextbase/health`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves the embedded admin UI", async () => {
    const response = await handle(new Request(`${origin}/api/nextbase/_`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(await response.text()).toContain("NextBase");
  });

  it("serves the admin UI with a trailing slash without redirecting", async () => {
    const response = await handle(new Request(`${origin}/api/nextbase/_/`));
    expect(response.status).toBe(200);
  });

  it("returns the error shape for unknown routes", async () => {
    const response = await handle(new Request(`${origin}/api/nextbase/nope`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      status: 404,
      message: "Not found.",
      data: {},
    });
  });

  it("honours a custom base path", async () => {
    const custom = new NextBase({ basePath: "/backend/" });
    const response = await custom.handle(
      new Request(`${origin}/backend/health`),
    );
    expect(response.status).toBe(200);
  });
});

describe("client", () => {
  const { handle } = new NextBase();
  // Calls the handler in-process: the same path server components will use.
  const client = new NextBaseClient({
    baseUrl: `${origin}/api/nextbase`,
    fetch: (input, init) => handle(new Request(input, init)),
  });

  it("calls health", async () => {
    await expect(client.health()).resolves.toEqual({ status: "ok" });
  });

  it("throws ClientError with the API error body", async () => {
    const broken = new NextBaseClient({
      baseUrl: `${origin}/api/nextbase/missing`,
      fetch: (input, init) => handle(new Request(input, init)),
    });
    const err = await broken.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientError);
    expect(err).toMatchObject({ status: 404, message: "Not found." });
  });
});
