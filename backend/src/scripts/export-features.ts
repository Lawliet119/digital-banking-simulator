import { resolve } from 'node:path';
import { exportFeaturesFile } from '../modules/risk/features/export-features';

export async function runExportFeatures(args: string[]): Promise<void> {
  let input: string | undefined;
  let output: string | undefined;
  let perTxLimit: bigint | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input') {
      input = args[++i];
    } else if (arg === '--output') {
      output = args[++i];
    } else if (arg === '--per-tx-limit') {
      const val = args[++i];
      if (!val || !/^[1-9]\d*$/.test(val)) {
        throw new Error('Invalid --per-tx-limit: must be a positive integer');
      }
      perTxLimit = BigInt(val);
    } else {
      throw new Error(
        `Unknown option '${arg}'. Usage: export-features --input <file> --output <file> [--per-tx-limit <amount>]`,
      );
    }
  }

  if (!input) {
    throw new Error('Missing required option: --input <path>');
  }
  if (!output) {
    throw new Error('Missing required option: --output <path>');
  }

  const inputPath = resolve(process.cwd(), input);
  const outputPath = resolve(process.cwd(), output);

  const start = performance.now();
  const { rowCount } = await exportFeaturesFile(inputPath, outputPath, perTxLimit);
  const elapsed = ((performance.now() - start) / 1000).toFixed(2);

  console.log(`[export-features] Processed ${rowCount} transactions in ${elapsed}s`);
  console.log(`[export-features] Output written to: ${outputPath}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  await runExportFeatures(args);
}

if (require.main === module) {
  void main().catch(error => {
    console.error(`[export-features] Error: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
