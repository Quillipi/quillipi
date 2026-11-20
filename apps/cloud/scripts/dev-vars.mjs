// Writes apps/cloud/.dev.vars with the GitHub App's private key, so `wrangler dev` can use the
// GitHub mirror on this computer. The key is copied from its .pem file and never shown.
//   node scripts/dev-vars.mjs "C:\Users\you\secrets\your-app.private-key.pem"
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [pemPath] = process.argv.slice(2);
if (!pemPath) {
  console.error('Say where the .pem file is: node scripts/dev-vars.mjs "C:\\path\\to\\key.pem"');
  process.exit(1);
}
const pem = readFileSync(pemPath, 'utf8').trim();
if (!/^-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) {
  console.error(`${pemPath} is not a private key: it should start with -----BEGIN RSA PRIVATE KEY-----.`);
  process.exit(1);
}
const target = resolve(import.meta.dirname, '..', '.dev.vars');
// Refuse to write the key anywhere Git would pick it up.
try {
  execFileSync('git', ['check-ignore', '-q', target], { cwd: resolve(import.meta.dirname, '..') });
} catch {
  console.error('.dev.vars is not ignored by Git, so the key could be committed. Add .dev.vars* to .gitignore first.');
  process.exit(1);
}
writeFileSync(target, `GITHUB_APP_PRIVATE_KEY="${pem.replace(/\r?\n/g, '\\n')}"\n`);
console.log(`Wrote ${target}. Git ignores it; never commit it or paste it anywhere.`);
