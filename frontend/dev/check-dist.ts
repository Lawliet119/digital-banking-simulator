// A production build must not contain the developer sign-in (role and subject form, dev token
// route). Run after `npm run build`; Node runs this file with its built-in type stripping.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = ['Mã người dùng (sub)', '__dev-auth', 'LocalDevSource'];
const dir = fileURLToPath(new URL('../dist/assets/', import.meta.url));
const found: string[] = [];
for (const name of readdirSync(dir).filter(file => file.endsWith('.js'))) {
  const text = readFileSync(dir + name, 'utf8');
  for (const word of FORBIDDEN) if (text.includes(word)) found.push(`${name}: ${word}`);
}
if (found.length > 0) {
  console.error(`dev sign-in found in the build:\n${found.join('\n')}`);
  process.exit(1);
}
console.log('build has no dev sign-in');
