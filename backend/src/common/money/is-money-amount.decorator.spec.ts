import { validate } from 'class-validator';
import { MONEY_ACCEPT, MONEY_REJECT, NON_STRING_INPUTS } from '../../../test/support/money-cases';
import { IsMoneyAmount } from './is-money-amount.decorator';

/** The property is `unknown` here only so the test can feed it values a real DTO never types. */
class AmountDto {
  @IsMoneyAmount()
  amount!: unknown;
}

class CustomMessageDto {
  @IsMoneyAmount({ message: 'amount is wrong' })
  amount!: unknown;
}

const dtoWith = (amount: unknown): AmountDto => Object.assign(new AmountDto(), { amount });

/** The constraint keys that failed, per property: stable by contract, unlike the message text. */
async function failedConstraints(dto: object): Promise<Record<string, string[]>> {
  const errors = await validate(dto);
  return Object.fromEntries(errors.map(e => [e.property, Object.keys(e.constraints ?? {})]));
}

describe('@IsMoneyAmount (DBS-22)', () => {
  it('TC-22-18 accepts positive whole-dong strings, 2^53 + 1 and 2^63 - 1 included', async () => {
    for (const [text] of MONEY_ACCEPT.filter(([text]) => text !== '0')) {
      expect(await validate(dtoWith(text))).toEqual([]);
    }
  });

  it('TC-22-19 refuses the DoD list, zero and every rejected string, as isMoneyAmount', async () => {
    const dodList = ['0', '-1', '1.5', '1e3', '01', ' 1', '9223372036854775808'];
    const inputs = [...dodList, ...MONEY_REJECT.map(c => c.input)];
    for (const input of inputs) {
      expect(await failedConstraints(dtoWith(input))).toEqual({ amount: ['isMoneyAmount'] });
    }
  });

  it('TC-22-20 refuses numbers, null, objects, arrays and a missing property', async () => {
    for (const input of NON_STRING_INPUTS) {
      expect(await failedConstraints(dtoWith(input))).toEqual({ amount: ['isMoneyAmount'] });
    }
    // The property is not set at all.
    expect(await failedConstraints(new AmountDto())).toEqual({ amount: ['isMoneyAmount'] });
  });

  it('TC-22-21 honours a custom message and never echoes the refused value', async () => {
    const [custom] = await validate(Object.assign(new CustomMessageDto(), { amount: '1.5' }));
    expect(custom.constraints).toEqual({ isMoneyAmount: 'amount is wrong' });

    const hostile = 'zz-secret-'.padEnd(40, 'x');
    const [errored] = await validate(dtoWith(hostile));
    const message = Object.values(errored.constraints ?? {}).join(' ');
    expect(message).not.toBe('');
    expect(message).not.toContain('secret');
  });
});
