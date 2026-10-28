import type { ErrorData, FieldError } from "@nextbasejs/client";
import { unstorableText } from "../storable.ts";

export type Path = readonly (string | number)[];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldError(value: FieldError | ErrorData): value is FieldError {
  return typeof value.code === "string" && typeof value.message === "string";
}

// The first error at a path wins; nothing is recorded below a failed path.
export class Issues {
  readonly data: ErrorData = {};

  add(path: Path, code: string, message: string): void {
    const keys = path.map(String);
    const last = keys.pop();
    if (last === undefined) throw new Error("Issues.add needs a path.");
    let node = this.data;
    for (const key of keys) {
      const child = node[key];
      if (child === undefined) {
        const next: ErrorData = {};
        node[key] = next;
        node = next;
      } else if (isFieldError(child)) {
        return;
      } else {
        node = child;
      }
    }
    node[last] ??= { code, message };
  }

  get empty(): boolean {
    return Object.keys(this.data).length === 0;
  }
}

// A missing or mistyped property yields the fallback (mistyped also records an
// issue), so validation reports every problem at once.
export class Reader {
  readonly input: Record<string, unknown>;
  readonly path: Path;
  readonly issues: Issues;

  constructor(input: Record<string, unknown>, path: Path, issues: Issues) {
    this.input = input;
    this.path = path;
    this.issues = issues;
  }

  has(key: string): boolean {
    return Object.hasOwn(this.input, key) && this.input[key] !== undefined;
  }

  fail(key: string | number, code: string, message: string): void {
    this.issues.add([...this.path, key], code, message);
  }

  string(key: string, fallback: string): string {
    if (!this.has(key)) return fallback;
    const value = this.input[key];
    if (typeof value === "string") return this.#storable(key, value, fallback);
    this.fail(key, "validation_invalid_type", "Must be a string.");
    return fallback;
  }

  stringOrNull(key: string, fallback: string | null): string | null {
    if (!this.has(key)) return fallback;
    const value = this.input[key];
    if (value === null) return value;
    if (typeof value === "string") return this.#storable(key, value, fallback);
    this.fail(key, "validation_invalid_type", "Must be a string or null.");
    return fallback;
  }

  boolean(key: string, fallback: boolean): boolean {
    if (!this.has(key)) return fallback;
    const value = this.input[key];
    if (typeof value === "boolean") return value;
    this.fail(key, "validation_invalid_type", "Must be a boolean.");
    return fallback;
  }

  integer(key: string, fallback: number, min: number, max: number): number {
    if (!this.has(key)) return fallback;
    const value = this.input[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      this.fail(key, "validation_invalid_type", "Must be an integer.");
      return fallback;
    }
    if (value < min || value > max) {
      this.fail(
        key,
        "validation_out_of_range",
        `Must be between ${min} and ${max}.`,
      );
      return fallback;
    }
    return value;
  }

  numberOrNull(key: string, fallback: number | null): number | null {
    if (!this.has(key)) return fallback;
    const value = this.input[key];
    if (value === null) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    this.fail(
      key,
      "validation_invalid_type",
      "Must be a finite number or null.",
    );
    return fallback;
  }

  strings(key: string, fallback: readonly string[]): string[] {
    if (!this.has(key)) return [...fallback];
    const value = this.input[key];
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      const problem = value.map(unstorableText).find(Boolean);
      if (!problem) return value;
      this.fail(key, "validation_invalid_value", problem);
      return [...fallback];
    }
    this.fail(key, "validation_invalid_type", "Must be an array of strings.");
    return [...fallback];
  }

  // Schemas are stored in Postgres, so their strings must be storable too.
  #storable<T>(key: string, value: string, fallback: T): string | T {
    const problem = unstorableText(value);
    if (!problem) return value;
    this.fail(key, "validation_invalid_value", problem);
    return fallback;
  }
}
