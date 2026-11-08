import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';

function validDocument(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return (
    typeof doc.openapi === 'string' &&
    /^3\./.test(doc.openapi) &&
    !!doc.info &&
    typeof doc.info === 'object' &&
    !Array.isArray(doc.info) &&
    !!doc.paths &&
    typeof doc.paths === 'object' &&
    !Array.isArray(doc.paths)
  );
}

/** Replaces the previous artifact only after receiving and validating the complete document. */
export async function exportOpenApi(options: {
  url: string;
  destination: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const url = new URL(options.url);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/docs-json'
  )
    throw new Error('Expected a local /docs-json endpoint');
  const response = await (options.fetchImpl ?? fetch)(url, {
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (response.status !== 200) throw new Error('OpenAPI endpoint did not return HTTP 200');
  const document: unknown = await response.json();
  if (!validDocument(document)) throw new Error('Invalid OpenAPI document');
  const destination = resolve(options.destination);
  const temporary = resolve(dirname(destination), '.openapi-' + randomUUID() + '.tmp');
  try {
    await fs.writeFile(temporary, JSON.stringify(document, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let url = 'http://127.0.0.1:3000/docs-json';
  let destination = resolve(__dirname, '../../../docs/deliverables/openapi.json');
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value || !['--url', '--destination'].includes(args[i]))
      throw new Error('Invalid arguments');
    if (args[i] === '--url') url = value;
    else destination = resolve(value);
  }
  await exportOpenApi({ url, destination });
  console.log('OpenAPI artifact exported');
}
if (require.main === module) {
  void main().catch(() => {
    console.error('OpenAPI export failed; artifact not replaced');
    process.exitCode = 1;
  });
}
