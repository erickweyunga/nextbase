import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DB } from '@nextbasejs/dbx';
import pg from 'pg';
import { endPool } from '../db/pool.ts';
import { ApiError } from '../errors.ts';
import { NextBase } from '../index.ts';
import {
  createMigration,
  DEFAULT_DIR,
  snapshotMigration,
  syncHistory,
} from '../migrations/commands.ts';
import { typegen } from './typegen.ts';

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
  migrate create NAME   Write a blank migration of the app's to fill in
  migrate collections   Write a migration with a snapshot of every collection,
                        counted as applied in this database
  migrate history-sync  Forget applied migrations whose file is gone
  superuser --email E   Add a superuser; asks for the password, or reads
                        NEXTBASE_SUPERUSER_PASSWORD
  superuser mfa-setup E Set up an authenticator app for the superuser with
                        email E; needs NEXTBASE_SECRET_KEY
  superuser mfa-reset E Remove the authenticator app and recovery codes of
                        the superuser with email E
  typegen [--out F]     Write TypeScript types for every collection
                        (default: nextbase-types.ts)
  help                  Show this message

Options:
  --dir D               The app's migrations folder (default:
                        nextbase/migrations)
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
  if (command === undefined || command === 'help' || values.help) {
    io.out(HELP);
    return 0;
  }
  const mfaCommand =
    command === 'superuser' &&
    (rest[0] === 'mfa-reset' || rest[0] === 'mfa-setup') &&
    rest.length === 2
      ? rest[0]
      : undefined;
  const migrateCommand =
    command === 'migrate' &&
    ((rest[0] === 'create' && rest.length === 2) ||
      ((rest[0] === 'collections' || rest[0] === 'history-sync') &&
        rest.length === 1))
      ? rest[0]
      : undefined;
  if (
    (rest.length > 0 &&
      mfaCommand === undefined &&
      migrateCommand === undefined) ||
    !['migrate', 'superuser', 'typegen'].includes(command)
  ) {
    io.err(`Unknown command: ${positionals.join(' ')}`);
    io.err(HELP);
    return 2;
  }
  const dir = values.dir ?? DEFAULT_DIR;
  // A blank migration needs no database.
  if (migrateCommand === 'create') {
    const path = await createMigration(process.cwd(), dir, rest[1] as string);
    io.out(`Wrote ${path}.`);
    return 0;
  }
  const database = values.database ?? io.env.DATABASE_URL;
  if (!database) {
    io.err(
      'No database: set DATABASE_URL (in the environment, .env.local or .env) or pass --database.',
    );
    return 1;
  }

  // Its own pool, ended afterwards, so the process exits promptly.
  const pool = new pg.Pool({ connectionString: database });
  const nextbase = new NextBase({ database: pool });
  try {
    if (migrateCommand !== undefined) {
      await nextbase.migrate();
      const db = new DB(pool);
      if (migrateCommand === 'collections') {
        io.out(`Wrote ${await snapshotMigration(db, process.cwd(), dir)}.`);
      } else {
        const forgotten = await syncHistory(db, process.cwd(), dir);
        io.out(
          forgotten.length === 0
            ? 'Every applied migration has its file.'
            : `Forgot ${forgotten.length} applied migrations without a file: ${forgotten.join(', ')}.`,
        );
      }
    } else if (command === 'migrate') {
      await nextbase.migrate();
      io.out("NextBase's tables are up to date.");
    } else if (mfaCommand === 'mfa-setup') {
      return await mfaSetup(nextbase, rest[1] as string, io);
    } else if (mfaCommand === 'mfa-reset') {
      const email = rest[1] as string;
      if (!(await nextbase.resetSuperuserMfa(email))) {
        io.err(`No superuser has the email ${email}.`);
        return 1;
      }
      io.out(
        `Removed the authenticator app and recovery codes of the superuser ${email}.`,
      );
    } else if (command === 'superuser') {
      return await superuser(nextbase, values.email, io);
    } else {
      const collections = await nextbase
        .client({ superuser: true })
        .collections.getFullList();
      const file = values.out ?? 'nextbase-types.ts';
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
      database: { type: 'string' },
      email: { type: 'string' },
      out: { type: 'string' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
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
    password = await io.prompt('Password: ', true);
    if ((await io.prompt('Repeat the password: ', true)) !== password) {
      io.err('The passwords do not match.');
      return 1;
    }
  }
  await nextbase.createSuperuser(email, password);
  io.out(`Added the superuser ${email}.`);
  return 0;
}

// Anyone with database access and the secret key gets here, so no password is needed:
// it is how a superuser who must take a second step gets their first app.
async function mfaSetup(
  nextbase: NextBase,
  email: string,
  io: Io,
): Promise<number> {
  const setup = await nextbase.startSuperuserTotp(email);
  if (!setup) {
    io.err(`No superuser has the email ${email}.`);
    return 1;
  }
  io.out('Add this to your authenticator app, by its URI or its secret:');
  io.out(setup.uri);
  io.out(`Secret: ${setup.secret}`);
  const code = await io.prompt('Code from the app: ', false);
  const codes = await nextbase.confirmSuperuserTotp(email, code.trim());
  io.out('The app is on. Keep these recovery codes somewhere safe:');
  for (const recovery of codes) io.out(recovery);
  return 0;
}

function describe(error: unknown): string {
  if (!(error instanceof ApiError)) return (error as Error).message;
  const fields = Object.entries(error.data).map(([name, problem]) =>
    'message' in problem
      ? `  ${name}: ${String(problem.message)}`
      : `  ${name}`,
  );
  return [error.message, ...fields].join('\n');
}
