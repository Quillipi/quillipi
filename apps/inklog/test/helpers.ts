import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const folders: string[] = [];

/** A fresh empty folder that is deleted after the test. */
export function tempFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inklog-test-'));
  folders.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
