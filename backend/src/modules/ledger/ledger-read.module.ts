import { Module } from '@nestjs/common';
import { LedgerLineReader } from './ledger-line.reader';

/** Read helpers of the ledger for other modules, without the ledger's controllers or posting. */
@Module({
  providers: [LedgerLineReader],
  exports: [LedgerLineReader],
})
export class LedgerReadModule {}
