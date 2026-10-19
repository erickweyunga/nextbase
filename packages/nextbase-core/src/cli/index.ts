#!/usr/bin/env node
import { existsSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { type Io, run } from "./run.ts";

// .env.local first: loadEnvFile keeps variables already set, so the
// environment wins, then .env.local, then .env, as in Next.js.
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const io: Io = {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  prompt,
};

process.exitCode = await run(process.argv.slice(2), io);

/**
 * Reads one line. Hidden input switches the terminal to raw mode and reads
 * keypresses itself, so nothing is echoed; piped input is read as a line.
 */
async function prompt(question: string, hidden: boolean): Promise<string> {
  const { stdin, stdout } = process;
  if (!hidden || !stdin.isTTY) {
    const lines = createInterface({ input: stdin, output: stdout });
    try {
      return await lines.question(question);
    } finally {
      lines.close();
    }
  }
  stdout.write(question);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (finish: () => void): void => {
      stdin.off("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      finish();
    };
    const onKey = (
      text: string | undefined,
      key: { name?: string; ctrl?: boolean },
    ): void => {
      if (key.ctrl && key.name === "c")
        done(() => reject(new Error("Canceled.")));
      else if (key.name === "return" || key.name === "enter")
        done(() => resolve(value));
      else if (key.name === "backspace")
        value = [...value].slice(0, -1).join("");
      else if (text && !key.ctrl) value += text;
    };
    stdin.on("keypress", onKey);
  });
}
