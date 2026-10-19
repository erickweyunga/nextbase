import { expect } from "vitest";
import { Api } from "./client.ts";
import type { Server } from "./server.ts";

/**
 * Creates the first superuser of a fresh server, as an operator does it: the
 * setup token is only in the server log. Returns the superuser's client.
 */
export async function firstSuperuser(server: Server): Promise<Api> {
  const anonymous = new Api(server.api);
  expect((await anonymous.send("GET", "/setup")).body).toEqual({
    required: true,
  });
  let token: string | undefined;
  for (let i = 0; i < 50 && !token; i++) {
    token = /"token":"([^"]+)"/.exec(server.output())?.[1];
    if (!token) await new Promise((r) => setTimeout(r, 100));
  }
  expect(token).toBeDefined();
  const setup = await anonymous.send("POST", "/setup", {
    token,
    email: "admin@example.com",
    password: "admin password 123",
  });
  expect(setup.status).toBe(200);
  return anonymous.login(
    "_superusers",
    "admin@example.com",
    "admin password 123",
  );
}
