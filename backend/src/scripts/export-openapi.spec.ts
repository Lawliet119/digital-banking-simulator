import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportOpenApi } from './export-openapi';

describe('DBS-72 generated OpenAPI export', () => {
  let dir: string;
  const document = {
    openapi: '3.0.0',
    info: { title: 'Bank API', version: '1' },
    paths: { '/v1/transfers': { post: {} } },
  };
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'dbs72-export-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const reply = (body: unknown, status = 200) =>
    jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status }));
  it('TC-72-01 writes the generated document as UTF-8 JSON', async () => {
    const destination = join(dir, 'openapi.json');
    await exportOpenApi({
      url: 'http://127.0.0.1:3000/docs-json',
      destination,
      fetchImpl: reply(document),
    });
    expect(JSON.parse(await fs.readFile(destination, 'utf8'))).toEqual(document);
    expect(await fs.readdir(dir)).toEqual(['openapi.json']);
  });
  it.each([
    ['HTTP failure', 500, document],
    ['invalid schema', 200, {}],
    ['array', 200, []],
  ])('TC-72-02 preserves the previous file on %s', async (_name, status, body) => {
    const destination = join(dir, 'openapi.json');
    await fs.writeFile(destination, 'previous');
    await expect(
      exportOpenApi({
        url: 'http://localhost:3000/docs-json',
        destination,
        fetchImpl: reply(body, status),
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(destination, 'utf8')).toBe('previous');
    expect(await fs.readdir(dir)).toEqual(['openapi.json']);
  });
  it('TC-72-02 malformed JSON preserves the previous file', async () => {
    const destination = join(dir, 'openapi.json');
    await fs.writeFile(destination, 'previous');
    const fetchImpl = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response('{'));
    await expect(
      exportOpenApi({ url: 'http://localhost:3000/docs-json', destination, fetchImpl }),
    ).rejects.toThrow();
    expect(await fs.readFile(destination, 'utf8')).toBe('previous');
  });
  it('TC-72-02 rename failure cleans the temporary file and preserves the previous artifact', async () => {
    const destination = join(dir, 'openapi.json');
    await fs.writeFile(destination, 'previous');
    jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('failure'));
    await expect(
      exportOpenApi({
        url: 'http://localhost:3000/docs-json',
        destination,
        fetchImpl: reply(document),
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(destination, 'utf8')).toBe('previous');
    expect(await fs.readdir(dir)).toEqual(['openapi.json']);
  });
});
