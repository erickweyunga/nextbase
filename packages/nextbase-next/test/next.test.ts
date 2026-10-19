import { NextBase } from "nextbasejs";
import { describe, expect, it } from "vitest";
import { newNextHandler } from "../src/index.ts";

describe("@nextbasejs/next", () => {
  it("mounts NextBase as App Router route handlers", async () => {
    const handlers = newNextHandler(new NextBase({ database: "unused" }));
    expect(Object.keys(handlers)).toEqual([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]);
    const health = await handlers.GET(
      new Request("http://localhost/api/nextbase/health"),
    );
    expect(await health.json()).toEqual({ status: "ok" });
    const put = await handlers.PUT(
      new Request("http://localhost/api/nextbase/health", { method: "PUT" }),
    );
    expect(put.status).toBe(405);
  });
});
