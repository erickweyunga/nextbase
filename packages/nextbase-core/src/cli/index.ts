#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { newPrompter } from './prompt.ts';
import { type Io, run } from './run.ts';

// loadEnvFile keeps set variables, so precedence is env, .env.local, .env (as in Next.js).
for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const prompter = newPrompter(process.stdin, process.stdout);
const io: Io = {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  prompt: prompter.prompt,
};

try {
  process.exitCode = await run(process.argv.slice(2), io);
} finally {
  prompter.close();
}
