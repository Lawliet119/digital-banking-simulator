import { parse } from 'pg-connection-string';
import { composeDatabaseUrl } from './compose-database-url';

const parts = {
  DB_HOST: 'db.example.internal',
  DB_PORT: '5432',
  DB_NAME: 'dbs',
  DB_USER: 'dbs_master',
  DB_PASSWORD: 'secret',
};

describe('composeDatabaseUrl', () => {
  it('TC-67-01 builds the url from the parts', () => {
    expect(composeDatabaseUrl(parts)).toEqual({
      url: 'postgresql://dbs_master:secret@db.example.internal:5432/dbs',
      invalid: [],
    });
  });

  it('TC-67-02 encodes special characters so the url parses back to the same password', () => {
    const password = 'p@ss:w/o%rd?#x é';
    const { url } = composeDatabaseUrl({ ...parts, DB_PASSWORD: password });
    const parsed = parse(url as string);
    expect(parsed.user).toBe('dbs_master');
    expect(parsed.password).toBe(password);
    expect(parsed.host).toBe('db.example.internal');
    expect(parsed.port).toBe('5432');
    expect(parsed.database).toBe('dbs');
  });

  it('TC-67-03 never overrides an existing DATABASE_URL, but treats an empty one as unset', () => {
    expect(composeDatabaseUrl({ ...parts, DATABASE_URL: 'postgres://x@y/z' })).toEqual({
      invalid: [],
    });
    expect(composeDatabaseUrl({ ...parts, DATABASE_URL: '' }).url).toBeDefined();
  });

  it('TC-67-04 does nothing without DB_HOST and names the missing parts otherwise', () => {
    expect(composeDatabaseUrl({})).toEqual({ invalid: [] });
    const { DB_PASSWORD: _p, DB_USER: _u, ...rest } = parts;
    expect(composeDatabaseUrl(rest)).toEqual({ invalid: ['DB_USER', 'DB_PASSWORD'] });
  });

  it('TC-67-05 rejects bad values by name only, never echoing the password', () => {
    const password = 'TopSecret123';
    const bad = composeDatabaseUrl({
      DB_HOST: 'a/b',
      DB_PORT: 'abc',
      DB_NAME: '',
      DB_USER: ' ',
      DB_PASSWORD: password,
    });
    expect(bad.url).toBeUndefined();
    expect(bad.invalid).toEqual(['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER']);
    expect(JSON.stringify(bad)).not.toContain(password);
    expect(composeDatabaseUrl({ ...parts, DB_PORT: '70000' }).invalid).toEqual(['DB_PORT']);
    expect(composeDatabaseUrl({ ...parts, DB_HOST: 'a b' }).invalid).toEqual(['DB_HOST']);
  });
});
