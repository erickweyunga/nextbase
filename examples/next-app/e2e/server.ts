import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const adminUrl =
  process.env.NEXTBASE_TEST_DATABASE_URL ??
  'postgres://localhost/nextbase_test';

// Run Next.js's CLI directly: package-manager wrappers do not reliably pass
// signals on, which would leave servers running after the tests.
const nextCli = createRequire(import.meta.url).resolve('next/dist/bin/next');

export const DATABASE_PREFIX = 'nextbase_e2e';

export interface Server {
  /** The app's origin, e.g. http://localhost:4123. */
  origin: string;
  /** Base URL of the NextBase API, e.g. http://localhost:4123/api/nextbase. */
  api: string;
  /** Everything the server printed so far. */
  output(): string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() =>
        resolve(typeof address === 'object' && address ? address.port : 0),
      );
    });
  });
}

/**
 * Starts the built example app (`next start`) against a fresh, empty database,
 * the way it runs in production.
 */
export async function startServer({
  env = () => ({}),
}: {
  /** Extra environment variables, given the app's origin. */
  env?: (origin: string) => Record<string, string>;
} = {}): Promise<Server> {
  // The creation time, in base 36, lets a later run tell a database left by an
  // interrupted run from one in use (see global-setup.ts).
  const name = `${DATABASE_PREFIX}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const database = new URL(adminUrl);
  database.pathname = `/${name}`;

  const storageDir = await mkdtemp(join(tmpdir(), 'nextbase-e2e-storage-'));
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  let output = '';
  const child: ChildProcess = spawn(
    process.execPath,
    [nextCli, 'start', '-p', String(port)],
    {
      cwd: new URL('..', import.meta.url).pathname,
      // Its own process group, so stopping it also stops any workers it starts.
      detached: true,
      env: {
        ...process.env,
        DATABASE_URL: database.toString(),
        NODE_ENV: 'production',
        // Uploads of this run, kept apart from development files.
        STORAGE_DIR: storageDir,
        ...env(origin),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));

  const api = `${origin}/api/nextbase`;
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(`${api}/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (attempt > 100 || child.exitCode !== null) {
      await stop(child);
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
      throw new Error(`next start did not come up:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    origin,
    api,
    output: () => output,
    async stop() {
      await stop(child);
      await rm(storageDir, { recursive: true, force: true });
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Stops the server's process group: gracefully, or forcibly after 5 seconds. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-(child.pid as number), name);
    } catch {
      // Already gone.
    }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}
