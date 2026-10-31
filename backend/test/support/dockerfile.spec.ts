import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8');
const ecs = readFileSync(
  resolve(__dirname, '../../../infra/terraform/envs/dev/session/ecs.tf'),
  'utf8',
);
const instructions = dockerfile
  .replace(/\\\n\s*/g, ' ')
  .split('\n')
  .filter(line => !line.trim().startsWith('#'))
  .join('\n');

describe('TC-67-10 Dockerfile: RDS CA bundle and no weakened TLS', () => {
  const add = /^ADD\s+(?<flags>(?:--\S+\s+)*)(?<url>https:\/\/\S+)\s+(?<dest>\S+)\s*$/m.exec(
    instructions,
  );

  it('downloads the RDS bundle with a pinned sha256 and read-only permissions', () => {
    expect(add).not.toBeNull();
    expect(add?.groups?.url).toMatch(
      /^https:\/\/truststore\.pki\.rds\.amazonaws\.com\/global\/global-bundle\.pem$/,
    );
    expect(add?.groups?.flags).toMatch(/--checksum=sha256:[0-9a-f]{64}(\s|$)/);
    expect(add?.groups?.flags).toMatch(/--chmod=0?444(\s|$)/);
  });

  it('puts the bundle where the task definition says DATABASE_SSL_CA_PATH is', () => {
    const configured = /name = "DATABASE_SSL_CA_PATH", value = "([^"]+)"/.exec(ecs)?.[1];
    expect(configured).toBeDefined();
    expect(add?.groups?.dest).toBe(configured);
  });

  it('adds the ADD to the runtime stage and keeps running as the node user', () => {
    const runtime = instructions.split(/^FROM .* AS runtime$/m)[1] ?? '';
    expect(runtime).toContain('ADD ');
    expect(runtime).toMatch(/^USER node$/m);
    expect(runtime.indexOf('ADD ')).toBeLessThan(runtime.indexOf('USER node'));
  });

  it('declares the BuildKit syntax that supports ADD --checksum', () => {
    expect(dockerfile.split('\n')[0]).toMatch(/^# syntax=docker\/dockerfile:1/);
  });

  it('puts no secret or TLS switch in ENV, ARG or the run environment', () => {
    expect(instructions).not.toMatch(/^(ENV|ARG)\s.*(PASSWORD|SECRET|TOKEN)/im);
    expect(instructions).not.toMatch(
      /NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized/,
    );
  });
});
