import { dropStaleTestDatabases } from './postgres.ts';

/** Runs once before the suite: removes what interrupted runs left behind. */
export async function setup(): Promise<void> {
  await dropStaleTestDatabases();
}
