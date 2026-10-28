const createClientMock = jest.fn();
jest.mock('redis', () => ({ createClient: createClientMock }));

const GenericContainerMock = jest.fn();
jest.mock('testcontainers', () => {
  const actual = jest.requireActual<typeof import('testcontainers')>('testcontainers');
  return { ...actual, GenericContainer: GenericContainerMock };
});

const assertDockerAvailableMock = jest.fn();
jest.mock('./postgres.container', () => {
  const actual = jest.requireActual<typeof import('./postgres.container')>('./postgres.container');
  return { ...actual, assertDockerAvailable: assertDockerAvailableMock };
});

import { startValkeyContainer } from './valkey.container';

describe('startValkeyContainer Docker-down short-circuit (TC-40-09, DBS-40 vòng 2)', () => {
  beforeEach(() => {
    assertDockerAvailableMock.mockReset();
    GenericContainerMock.mockClear();
    createClientMock.mockClear();
  });

  it('không tạo GenericContainer hoặc Redis client khi Docker không có sẵn', async () => {
    assertDockerAvailableMock.mockRejectedValue(
      new Error('[Testcontainers] Docker is not running or unreachable.'),
    );

    await expect(startValkeyContainer()).rejects.toThrow('Docker is not running');

    expect(GenericContainerMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
