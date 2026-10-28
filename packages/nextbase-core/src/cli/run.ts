import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import pg from "pg";
import { endPool } from "../db/pool.ts";
import { ApiError } from "../errors.ts";
import { NextBase } from "../index.ts";
import { typegen } from "./typegen.ts";

/** Abstracted so the CLI runs in tests without a terminal. */
export interface Io {
  env: Readonly<Record<string, string | undefined>>;
  out(line: string): void;
  err(line: string): void;
  prompt(question: string, hidden: boolean): Promise<string>;
}

const HELP = `Usage: nextbase <command> [options]

Commands:
  migrate               Create or upgrade NextBase's tables
  superuser --email E   Add a superuser; asks for the password, or reads
                        NEXTBASE_SUPERUSER_PASSWORD
  typegen [--out F]     Write TypeScript types for every collection
                        (default: nextbase-types.ts)
  help                  Show this message

Options:
  --database URL        Postgres connection string. Defaults to DATABASE_URL,
                        from the environment, .env.local or .env.`;

/** Returns the process exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err((error as Error).message);
    io.err(HELP);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (command === undefined || command === "help" || values.help) {
    io.out(HELP);
    return 0;
  }
  if (
    rest.length > 0 ||
    !["migrate", "superuser", "typegen"].includes(command)
  ) {
    io.err(`Unknown command: ${positionals.join(" ")}`);
    io.err(HELP);
    return 2;
  }
  const database = values.database ?? io.env.DATABASE_URL;
  if (!database) {
    io.err(
      "No database: set DATABASE_URL (in the environment, .env.local or .env) or pass --database.",
    );
    return 1;
  }

  // Its own pool, ended afterwards, so the process exits promptly.
  const pool = new pg.Pool({ connectionString: database });
  const nextbase = new NextBase({ database: pool });
  try {
    if (command === "migrate") {
      await nextbase.migrate();
      io.out("NextBase's tables are up to date.");
    } else if (command === "superuser") {
      return await superuser(nextbase, values.email, io);
    } else {
      const collections = await nextbase
        .client({ superuser: true })
        .collections.getFullList();
      const file = values.out ?? "nextbase-types.ts";
      await writeFile(file, typegen(collections));
      io.out(`Wrote types for ${collections.length} collections to ${file}.`);
    }
    return 0;
  } catch (error) {
    io.err(describe(error));
    return 1;
  } finally {
    await endPool(pool);
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      database: { type: "string" },
      email: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

async function superuser(
  nextbase: NextBase,
  email: string | undefined,
  io: Io,
): Promise<number> {
  if (!email) {
    io.err(
      "Pass the superuser's email: nextbase superuser --email you@example.com",
    );
    return 2;
  }
  let password = io.env.NEXTBASE_SUPERUSER_PASSWORD;
  if (password === undefined) {
    password = await io.prompt("Password: ", true);
    if ((await io.prompt("Repeat the password: ", true)) !== password) {
      io.err("The passwords do not match.");
      return 1;
    }
  }
  await nextbase.createSuperuser(email, password);
  io.out(`Added the superuser ${email}.`);
  return 0;
}

function describe(error: unknown): string {
  if (!(error instanceof ApiError)) return (error as Error).message;
  const fields = Object.entries(error.data).map(([name, problem]) =>
    "message" in problem
      ? `  ${name}: ${String(problem.message)}`
      : `  ${name}`,
  );
  return [error.message, ...fields].join("\n");
}
