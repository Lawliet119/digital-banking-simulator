const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  console.log('=== BẮT ĐẦU TEST THỦ CÔNG DBS-137 ===');
  console.log(`Thời gian: ${new Date().toISOString()}`);

  const rootDir = path.resolve(__dirname, '../..');
  const openApiPath = path.join(rootDir, 'docs/deliverables/openapi.json');

  // M-137-01 & M-137-02: Run openapi-spec test suite which spins up the real AppModule and exports openapi.json
  console.log('\n[M-137-01 & M-137-02] Khởi tạo AppModule, kiểm tra /docs-json và xuất docs/deliverables/openapi.json:');
  const testOutput = execFileSync(
    'npm',
    ['--prefix', 'backend', 'run', 'test:db', '--', 'openapi-spec.db-spec.ts'],
    { cwd: rootDir, encoding: 'utf8', timeout: 90000 }
  );
  console.log(testOutput.trim());

  // M-137-03: Kiểm tra nội dung đặc tả OpenAPI
  console.log('\n[M-137-03] Kiểm tra nội dung docs/deliverables/openapi.json:');
  if (!fs.existsSync(openApiPath)) {
    throw new Error(`File ${openApiPath} không tồn tại`);
  }
  const text = fs.readFileSync(openApiPath, 'utf8');
  const doc = JSON.parse(text);

  console.log(`OpenAPI Version: ${doc.openapi}`);
  console.log(`Title: ${doc.info.title}`);
  console.log(`API Description: ${doc.info.description}`);

  const paths = Object.keys(doc.paths).sort();
  console.log(`Tổng số paths: ${paths.length}`);
  paths.forEach((p, idx) => {
    const methods = Object.keys(doc.paths[p]).filter(m => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map(m => m.toUpperCase()).join(', ');
    console.log(`  ${String(idx + 1).padStart(2, '0')}. ${methods} ${p}`);
  });

  // Verify BearerAuth
  const securityScheme = doc.components?.securitySchemes?.['access-token'];
  console.log(`\nSecurity Scheme 'access-token': ${JSON.stringify(securityScheme)}`);

  // Verify Idempotency-Key
  const transferParams = doc.paths['/v1/transfers']?.post?.parameters || [];
  const transferIdem = transferParams.find(p => p.name === 'Idempotency-Key');
  console.log(`Idempotency-Key trên POST /v1/transfers: in=${transferIdem?.in}, required=${transferIdem?.required}`);

  const depositParams = doc.paths['/v1/operator/deposits']?.post?.parameters || [];
  const depositIdem = depositParams.find(p => p.name === 'Idempotency-Key');
  console.log(`Idempotency-Key trên POST /v1/operator/deposits: in=${depositIdem?.in}, required=${depositIdem?.required}`);

  // Check 14 ErrorCodes
  const all14Codes = [
    'ACCOUNT_NOT_ACTIVE',
    'LIMIT_PER_TX_EXCEEDED',
    'LIMIT_PER_DAY_EXCEEDED',
    'INSUFFICIENT_FUNDS',
    'IDEMPOTENCY_KEY_REQUIRED',
    'IDEMPOTENCY_KEY_REUSED',
    'ACCOUNT_LIMIT_REACHED',
    'UNAUTHENTICATED',
    'TOKEN_EXPIRED',
    'FORBIDDEN',
    'SESSION_REVOKED',
    'FLAG_ALREADY_REVIEWED',
    'RATE_LIMITED',
    'SERVICE_TEMPORARILY_UNAVAILABLE',
  ];

  const foundCodes = new Set();
  for (const p of Object.values(doc.paths)) {
    for (const op of Object.values(p)) {
      if (!op.responses) continue;
      for (const resp of Object.values(op.responses)) {
        const examples = resp.content?.['application/problem+json']?.examples;
        if (examples) {
          for (const ex of Object.values(examples)) {
            if (ex?.value?.errorCode) foundCodes.add(ex.value.errorCode);
          }
        }
      }
    }
  }

  console.log(`\nKiểm tra 14 mã ErrorCode trong các problem+json examples:`);
  all14Codes.forEach(code => {
    const present = foundCodes.has(code);
    console.log(`  - [${present ? 'PASS' : 'FAIL'}] ${code}`);
  });

  if (foundCodes.size !== 14) {
    throw new Error(`Thiếu mã lỗi: tìm thấy ${foundCodes.size}/14 mã`);
  }

  // M-137-04: Kiểm tra tính hoàn thiện của Schemas
  console.log('\n[M-137-04] Kiểm tra các schema quan trọng:');
  const schemas = Object.keys(doc.components?.schemas || {}).sort();
  console.log(`Tổng số schemas: ${schemas.length}`);
  console.log(`  - ProblemDetailsDto: ${doc.components.schemas.ProblemDetailsDto ? 'CÓ' : 'KHÔNG'}`);
  console.log(`  - AuthenticatedUserDto: ${doc.components.schemas.AuthenticatedUserDto ? 'CÓ' : 'KHÔNG'}`);
  console.log(`  - TransferDto: ${doc.components.schemas.TransferDto ? 'CÓ' : 'KHÔNG'}`);
  console.log(`  - DepositDto: ${doc.components.schemas.DepositDto ? 'CÓ' : 'KHÔNG'}`);

  console.log('\n=== KẾT THÚC TEST THỦ CÔNG DBS-137: TẤT CẢ ĐẠT (PASS) ===');
}

main().catch(err => {
  console.error('\n[LỖI TEST THỦ CÔNG]:', err);
  process.exit(1);
});
