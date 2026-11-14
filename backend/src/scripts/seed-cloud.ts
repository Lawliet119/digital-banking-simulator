import { runSeedCli } from './seed-core';

/**
 * BL-252: điểm vào của seed trên cloud, biên dịch vào `dist/scripts/seed-cloud.js` và chạy trong task ECS một lần
 * `dbs-seed` (trong VPC, gọi thẳng task api qua HTTP cổng 3000, không qua ALB nên không dính chứng chỉ tự ký):
 *
 *   node dist/scripts/seed-cloud.js --auth cloud --url http://<ip-task-api>:3000 --quiet
 *
 * Token lấy từ DBS_OPERATOR_TOKEN và DBS_CUSTOMER_{1,2,3}_TOKEN. File này chỉ import `seed-core` nên không kéo
 * `dev-auth` (công cụ ký token) vào image; `--auth local` ở đây báo lỗi. Script chạy tay: infra/scripts/seed-cloud.sh.
 */
if (require.main === module) {
  void runSeedCli(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
