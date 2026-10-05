import { buildSslOptions } from './pg-ssl';

describe('buildSslOptions', () => {
  it('turns TLS off only when it is not enabled', () => {
    expect(buildSslOptions({ enabled: false })).toBe(false);
  });

  it('verifies the server certificate whenever TLS is on, with or without a custom CA', () => {
    // The break this catches: someone sets rejectUnauthorized to false "to make RDS connect",
    // which keeps encryption but accepts any certificate, including an attacker's.
    const readFile = jest.fn().mockReturnValue('PEM');
    expect(buildSslOptions({ enabled: true })).toMatchObject({ rejectUnauthorized: true });
    expect(buildSslOptions({ enabled: true, caPath: '/ca.pem' }, readFile)).toMatchObject({
      rejectUnauthorized: true,
    });
  });

  it('trusts the given CA file, which is how a certificate signed by the RDS CA is accepted', () => {
    const readFile = jest.fn().mockReturnValue('-----BEGIN CERTIFICATE-----\nABC\n');

    const ssl = buildSslOptions(
      { enabled: true, caPath: '/etc/ssl/rds/global-bundle.pem' },
      readFile,
    );

    expect(readFile).toHaveBeenCalledWith('/etc/ssl/rds/global-bundle.pem');
    expect(ssl).toEqual({ rejectUnauthorized: true, ca: '-----BEGIN CERTIFICATE-----\nABC\n' });
  });

  it('does not read any file when no CA path is given', () => {
    const readFile = jest.fn();

    const ssl = buildSslOptions({ enabled: true }, readFile);

    expect(readFile).not.toHaveBeenCalled();
    expect(ssl).toEqual({ rejectUnauthorized: true });
  });

  it('fails at start-up, naming the variable and the path, when the CA file cannot be read', () => {
    const readFile = jest.fn(() => {
      throw new Error('ENOENT: no such file');
    });

    expect(() => buildSslOptions({ enabled: true, caPath: '/missing.pem' }, readFile)).toThrow(
      /DATABASE_SSL_CA_PATH.*\/missing\.pem/,
    );
  });
});
