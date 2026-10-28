import { describe, expect, it } from "vitest";
import {
  hasNul,
  isStorableTime,
  parseDate,
  parseTimestamptz,
  timestampParam,
} from "../src/storable.ts";

describe("storable values", () => {
  it("reads a date and time with no zone as UTC, whatever the server's zone", () => {
    const cases: [string, string][] = [
      ["2020-01-01 00:00:00", "2020-01-01T00:00:00.000Z"],
      ["2020-01-01T10:30", "2020-01-01T10:30:00.000Z"],
      ["2020-01-01 10:30:00.25", "2020-01-01T10:30:00.250Z"],
      ["2020-01-01", "2020-01-01T00:00:00.000Z"],
      ["2020-01-01T00:00:00+03:00", "2019-12-31T21:00:00.000Z"],
      ["2020-01-01 00:00:00Z", "2020-01-01T00:00:00.000Z"],
    ];
    for (const [text, iso] of cases)
      expect(new Date(parseDate(text)).toISOString()).toBe(iso);
    expect(parseDate("not a date")).toBeNaN();
  });

  it("parses timestamptz output exactly, including offsets with seconds, BC and far-future years", () => {
    const cases: [string, string][] = [
      ["4713-01-01 02:27:16+02:27:16 BC", "-004712-01-01T00:00:00.000Z"],
      ["275760-09-13 03:00:00+03", "+275760-09-13T00:00:00.000Z"],
      ["2026-10-18 09:30:00.123456-05:30", "2026-10-18T15:00:00.123Z"],
      ["0001-06-01 00:00:00+00 BC", "0000-06-01T00:00:00.000Z"],
    ];
    for (const [text, iso] of cases)
      expect(parseTimestamptz(text)?.toISOString()).toBe(iso);
    expect(parseTimestamptz("infinity")).toBeUndefined();
  });

  it("writes timestamps in UTC with Postgres's BC notation", () => {
    expect(timestampParam(new Date("-004712-01-01T00:00:00.000Z"))).toBe(
      "4713-01-01 00:00:00.000+00 BC",
    );
    expect(timestampParam(new Date("2026-10-18T09:30:00.123Z"))).toBe(
      "2026-10-18 09:30:00.123+00",
    );
    expect(timestampParam(new Date("+275760-09-13T00:00:00.000Z"))).toBe(
      "275760-09-13 00:00:00.000+00",
    );
  });

  it("flags values Postgres cannot store", () => {
    expect(hasNul("a\u0000b")).toBe(true);
    expect(hasNul("ab")).toBe(false);
    expect(isStorableTime(Date.UTC(-4712, 0, 1))).toBe(true);
    expect(isStorableTime(Date.UTC(-4713, 11, 31))).toBe(false);
    expect(isStorableTime(Number.NaN)).toBe(false);
  });
});
