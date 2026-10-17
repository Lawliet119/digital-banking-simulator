import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  BALANCE_ZERO,
  IsMoneyAmount,
  MONEY_MAX,
  addMoney,
  debitBalance,
  formatBalance,
  formatMoney,
  parsePositiveMoney,
} from '@common/money';

export class MoneyProbeDto {
  /** A string on purpose: the validator refuses a JSON number, even an exact one. */
  @IsMoneyAmount()
  amount!: string;
}

/**
 * A stand-in for the first endpoint that will take money (transfer, deposit), living only in
 * test code (`test/money.e2e-spec.ts` and the manual-test driver). It is not a stub of an
 * unfinished task: it is never shipped, and it exists to put the REAL global pipe, filter and
 * serializer of `configureHttpApp` in front of `@common/money`.
 */
@Controller('probe')
export class MoneyProbeController {
  /** How many times a handler body ran. A refused request must leave it untouched. */
  calls = 0;
  /** Set by the manual-test driver to print each call; a refused request never reaches it. */
  onCall?: (dto: MoneyProbeDto) => void;

  @Post('money')
  money(@Body() dto: MoneyProbeDto): Record<string, unknown> {
    this.calls += 1;
    this.onCall?.(dto);
    const amount = parsePositiveMoney(dto.amount);
    return {
      received: formatMoney(amount),
      // Returned as a bare bigint on purpose: the global toJSON must turn it into a string.
      plusOne: addMoney(amount, parsePositiveMoney('1')),
      // The funding account goes negative when it pays a deposit (ADR-09).
      fundingAfter: formatBalance(debitBalance(BALANCE_ZERO, amount)),
    };
  }

  /** A handler that forgot to format: bare bigints nested in an object and an array. */
  @Get('raw-bigint')
  rawBigint(): Record<string, unknown> {
    return { a: 9_007_199_254_740_993n, list: [1n], nested: { max: MONEY_MAX } };
  }

  /** What an arithmetic overflow looks like to a client: a generic 500, nothing leaked. */
  @Post('overflow')
  overflow(): never {
    addMoney(MONEY_MAX, parsePositiveMoney('1'));
    throw new Error('unreachable: the line above must throw');
  }
}
