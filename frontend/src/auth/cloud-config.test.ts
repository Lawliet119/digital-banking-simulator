import { describe, expect, it } from 'vitest';
import { parseCloudConfig } from './cloud-config';

const GOOD = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_AbC123xyz',
  userPoolClientId: '1h2j3k4l5m6n7o8p9q0r1s2t3u',
};

describe('parseCloudConfig', () => {
  it('keeps exactly the three fields of a valid file', () => {
    expect(parseCloudConfig({ ...GOOD, extra: 'ignored' })).toEqual(GOOD);
  });

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['a bad region', { ...GOOD, region: 'mars' }],
    ['a pool of another region', { ...GOOD, userPoolId: 'us-east-1_AbC123xyz' }],
    ['a client id with symbols', { ...GOOD, userPoolClientId: '<script>' }],
    ['a missing field', { region: GOOD.region, userPoolId: GOOD.userPoolId }],
  ])('refuses %s', (_label, raw) => {
    expect(parseCloudConfig(raw)).toBeUndefined();
  });
});
