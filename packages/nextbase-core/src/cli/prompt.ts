import { emitKeypressEvents } from 'node:readline';
import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { ReadStream } from 'node:tty';

export interface Prompter {
  prompt(question: string, hidden: boolean): Promise<string>;
  /** Stops reading the input, so the process can exit. */
  close(): void;
}

/**
 * On a terminal, hidden input uses raw mode so nothing is echoed. Piped input uses one
 * interface for the whole run, since readline reads ahead and would lose later answers.
 */
export function newPrompter(
  input: Readable & { isTTY?: boolean },
  output: Writable,
): Prompter {
  let lines: Interface | undefined;
  let next: AsyncIterator<string> | undefined;
  return {
    async prompt(question, hidden) {
      if (input.isTTY) {
        if (hidden) return readHidden(input as ReadStream, output, question);
        // A terminal sends what is typed after the question, so nothing is
        // read ahead; closing the interface keeps it out of hidden input.
        const terminal = createInterface({ input, output });
        try {
          return await terminal.question(question);
        } finally {
          terminal.close();
        }
      }
      lines ??= createInterface({ input, terminal: false });
      // The iterator keeps lines that arrive before they are asked for.
      next ??= lines[Symbol.asyncIterator]();
      output.write(question);
      const line = await next.next();
      if (line.done) {
        throw new Error('The input ended before every question was answered.');
      }
      return line.value;
    },
    close() {
      lines?.close();
    },
  };
}

function readHidden(
  stdin: ReadStream,
  stdout: Writable,
  question: string,
): Promise<string> {
  stdout.write(question);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (finish: () => void): void => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      finish();
    };
    const onKey = (
      text: string | undefined,
      key: { name?: string; ctrl?: boolean },
    ): void => {
      if (key.ctrl && key.name === 'c')
        done(() => reject(new Error('Canceled.')));
      else if (key.name === 'return' || key.name === 'enter')
        done(() => resolve(value));
      else if (key.name === 'backspace')
        value = [...value].slice(0, -1).join('');
      else if (text && !key.ctrl) value += text;
    };
    stdin.on('keypress', onKey);
  });
}
