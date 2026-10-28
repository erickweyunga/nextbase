import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextBase } from "../src/index.ts";
import { call } from "./http.ts";
import { createTestDatabase, type TestDatabase } from "./postgres.ts";

describe("comparisons between multi-valued sides, and JSON dates, over real data", () => {
  let t: TestDatabase;
  let nextbase: NextBase;
  let admin = "";
  const ids: Record<string, string> = {};

  const send = async (method: string, path: string, body?: unknown) => {
    const reply = await call(nextbase, method, path, { token: admin, body });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return reply.body;
  };
  const names = async (filter: string, token = admin): Promise<string[]> => {
    const reply = await call(
      nextbase,
      "GET",
      `/collections/docs/records?sort=name&filter=${encodeURIComponent(filter)}`,
      { token },
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return (reply.body.items as { name: string }[]).map((r) => r.name);
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    nextbase = new NextBase({ database: t.pool });
    await nextbase.createSuperuser("admin@example.com", "admin password 123");
    admin = (
      await call(
        nextbase,
        "POST",
        "/collections/_superusers/auth-with-password",
        {
          body: {
            identity: "admin@example.com",
            password: "admin password 123",
          },
        },
      )
    ).body.token as string;

    ids.users = (
      await send("POST", "/collections", {
        name: "users",
        type: "auth",
        listRule: "",
        viewRule: "",
        fields: [{ name: "name", type: "text" }],
      })
    ).id as string;
    ids.teams = (
      await send("POST", "/collections", {
        name: "teams",
        listRule: "",
        viewRule: "",
        fields: [
          { name: "name", type: "text" },
          {
            name: "members",
            type: "relation",
            collectionId: ids.users,
            maxSelect: 10,
          },
          {
            name: "lead",
            type: "relation",
            collectionId: ids.users,
            maxSelect: 1,
          },
        ],
      })
    ).id as string;
    const select = { type: "select", values: ["a", "b", "c"], maxSelect: 3 };
    await send("POST", "/collections", {
      name: "docs",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "name", type: "text" },
        { name: "tags", ...select },
        { name: "wanted", ...select },
        {
          name: "owner",
          type: "relation",
          collectionId: ids.users,
          maxSelect: 1,
        },
        {
          name: "reviewers",
          type: "relation",
          collectionId: ids.users,
          maxSelect: 10,
        },
        {
          name: "team",
          type: "relation",
          collectionId: ids.teams,
          maxSelect: 1,
        },
        { name: "due", type: "date" },
        { name: "meta", type: "json" },
      ],
    });

    for (const name of ["ann", "bob", "cy", "dee"]) {
      ids[name] = (
        await send("POST", "/collections/users/records", {
          name,
          email: `${name}@example.com`,
          password: "password12345678",
          passwordConfirm: "password12345678",
        })
      ).id as string;
    }
    ids.red = (
      await send("POST", "/collections/teams/records", {
        name: "red",
        members: [ids.ann, ids.bob],
        lead: ids.ann,
      })
    ).id as string;
    ids.blue = (
      await send("POST", "/collections/teams/records", {
        name: "blue",
        members: [ids.cy],
        lead: ids.cy,
      })
    ).id as string;

    const docs: Record<string, unknown>[] = [
      // Overlapping tags; the owner leads the team; one reviewer is a member.
      {
        name: "d1",
        tags: ["a", "b"],
        wanted: ["b", "c"],
        owner: ids.ann,
        team: ids.red,
        reviewers: [ids.bob, ids.cy],
        due: "2026-03-01 00:00:00.000Z",
        meta: { due: "2026-03-01", note: "date only, so UTC midnight" },
      },
      // Identical single values; no reviewer is a member.
      {
        name: "d2",
        tags: ["a"],
        wanted: ["a"],
        owner: ids.bob,
        team: ids.red,
        reviewers: [ids.cy, ids.dee],
        due: "2026-03-01 00:00:00.000Z",
        meta: { due: "2026-03-01T02:00:00+02:00" },
      },
      // Disjoint values; every reviewer is a member.
      {
        name: "d3",
        tags: ["c"],
        wanted: ["a", "b"],
        owner: ids.cy,
        team: ids.blue,
        reviewers: [ids.cy],
        due: "2026-03-01 00:00:00.000Z",
        meta: { due: "2020-01-01T00:00:00Z" },
      },
      // Empty sides.
      {
        name: "d4",
        tags: [],
        wanted: ["a"],
        owner: ids.dee,
        team: ids.blue,
        reviewers: [],
        meta: { due: "2999-12-31T23:59:59.999Z" },
      },
      // JSON that is not a usable date.
      { name: "d5", tags: ["a"], wanted: [], meta: { due: "2026-02-30" } },
      { name: "d6", meta: { due: "now" } },
      { name: "d7", meta: { due: 1_700_000_000 } },
      { name: "d8", meta: { due: "2026-03-01T00:00:00" } },
      { name: "d9", meta: {} },
    ];
    for (const doc of docs)
      await send("POST", "/collections/docs/records", doc);
  });
  afterAll(() => t.close());

  describe("two sides with several values", () => {
    it("?op: some pair of values matches", async () => {
      expect(await names("tags ?= wanted")).toEqual(["d1", "d2"]);
      expect(await names("wanted ?= tags")).toEqual(["d1", "d2"]);
      expect(await names("tags ?!= wanted")).toEqual(["d1", "d3"]);
    });

    it("op: both sides have values and every pair matches", async () => {
      expect(await names("tags = wanted")).toEqual(["d2"]);
      expect(await names("tags != wanted")).toEqual(["d3"]);
      // Empty on either side never matches, unlike vacuous truth.
      expect(await names("tags = wanted || tags != wanted")).not.toContain(
        "d4",
      );
      expect(await names("tags = wanted || tags != wanted")).not.toContain(
        "d5",
      );
    });

    it("lowers each value of a field with several values", async () => {
      await send("POST", "/collections", {
        name: "notes",
        listRule: "",
        fields: [
          { name: "name", type: "text" },
          {
            name: "labels",
            type: "select",
            values: ["Red", "blue"],
            maxSelect: 2,
          },
        ],
      });
      for (const [name, labels] of [
        ["n1", ["Red"]],
        ["n2", ["blue"]],
        ["n3", ["Red", "blue"]],
        ["n4", []],
      ] as const) {
        await send("POST", "/collections/notes/records", { name, labels });
      }
      const notes = async (filter: string) => {
        const reply = await call(
          nextbase,
          "GET",
          `/collections/notes/records?sort=name&filter=${encodeURIComponent(filter)}`,
          { token: admin },
        );
        expect(reply.status, JSON.stringify(reply.body)).toBe(200);
        return (reply.body.items as { name: string }[]).map((r) => r.name);
      };
      expect(await notes('labels:lower ?= "red"')).toEqual(["n1", "n3"]);
      expect(await notes('labels:lower = "red"')).toEqual(["n1"]);
      expect(await notes('labels:lower = ""')).toEqual(["n4"]);
    });

    it("compares relation paths on both sides", async () => {
      // Some reviewer belongs to the doc's team.
      expect(await names("reviewers ?= team.members")).toEqual(["d1", "d3"]);
      expect(await names("reviewers.name ?= team.members.name")).toEqual([
        "d1",
        "d3",
      ]);
      // Every reviewer is in the team (and there are reviewers).
      expect(
        await names(
          "reviewers.id ?= team.members.id && reviewers.id = team.lead",
        ),
      ).toEqual(["d3"]);
      // Single relation paths on both sides: the owner leads the team.
      expect(await names("owner.name = team.lead.name")).toEqual(["d1", "d3"]);
      expect(await names("team.lead.name = owner.name")).toEqual(["d1", "d3"]);
      // A path with several values against a single path.
      expect(await names("team.members.name ?= owner.name")).toEqual([
        "d1",
        "d2",
        "d3",
      ]);
    });

    it("respects view rules on both sides of a client filter", async () => {
      await send("PATCH", "/collections/teams", {
        viewRule: "lead = @request.auth.id",
      });
      const ann = (
        await call(nextbase, "POST", "/collections/users/auth-with-password", {
          body: { identity: "ann@example.com", password: "password12345678" },
        })
      ).body.token as string;
      // Ann can view only the red team, so only red-team docs can match.
      expect(await names("reviewers ?= team.members", ann)).toEqual(["d1"]);
      await send("PATCH", "/collections/teams", { viewRule: "" });
    });
  });

  describe("JSON values compared with dates", () => {
    it("reads ISO 8601 strings, with or without a zone (UTC), as dates", async () => {
      // Blank equals blank, so docs without a due date are left out here.
      expect(await names('meta.due = due && due != ""')).toEqual(["d1", "d2"]);
      expect(await names("meta.due < due")).toEqual(["d3"]);
      // A string literal is text, so a date comparison needs a date: a date
      // field or a macro such as @now.
      expect(await names('meta.due < "2026"')).toEqual(["d3", "d7"]);
    });

    it("treats anything else as no value instead of failing", async () => {
      expect(await names("meta.due < @now")).toEqual(["d1", "d2", "d3", "d8"]);
      expect(await names("meta.due > @now")).toEqual(["d4"]);
      // Impossible dates, words Postgres would accept, numbers and missing
      // keys are no date at all: neither before nor after any moment.
      expect(await names("meta.due <= @now || meta.due > @now")).toEqual([
        "d1",
        "d2",
        "d3",
        "d4",
        "d8",
      ]);
    });
  });
});
