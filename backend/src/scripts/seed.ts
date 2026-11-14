import { DEFAULT_KEY_DIR, mintDevToken } from './dev-auth';
import {
  runSeed as coreRunSeed,
  runSeedCli as coreRunSeedCli,
  resolveTokens as coreResolveTokens,
  type LocalTokenMinter,
  type SeedCliIo,
} from './seed-core';

/**
 * Điểm vào của máy dev (`npm run seed`, ts-node): lõi ở `seed-core.ts` cộng đường `--auth local` ký token bằng
 * `dev-auth`. File này (và `dev-auth*`) bị loại khỏi bản build production (tsconfig.build.json): image không được
 * mang công cụ ký token. Seed chạy trong task ECS dùng `seed-cloud.ts` (BL-252).
 *
 * Mọi export của lõi được chuyển tiếp; ba hàm có đường local được bọc để tự tiêm `mintLocalToken`.
 */
export * from './seed-core';

const mintLocalToken: LocalTokenMinter = (role, sub, keyDir) =>
  mintDevToken({ role, sub, dir: keyDir ?? DEFAULT_KEY_DIR });

export const resolveTokens: typeof coreResolveTokens = (options, cliCloudTokens) =>
  coreResolveTokens({ mintLocalToken, ...options }, cliCloudTokens);

export const runSeed: typeof coreRunSeed = (options, cliCloudTokens) =>
  coreRunSeed({ mintLocalToken, ...options }, cliCloudTokens);

export const runSeedCli = (argv: string[], io?: SeedCliIo): Promise<number> =>
  coreRunSeedCli(argv, { mintLocalToken, ...io });

if (require.main === module) {
  void runSeedCli(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
