import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { MoneyError, parsePositiveMoney } from './money';

/**
 * DTO guard for the amount of a transfer or deposit: the property must be a STRING of whole dong,
 * greater than zero, in canonical form (no sign, no leading zero, no decimals, no exponent, no
 * spaces), at most 2^63 - 1. It uses the same parser as the service (`parsePositiveMoney`), so the
 * DTO and the domain cannot disagree about what an amount is.
 *
 * Keep the DTO field typed `string` and convert with `parsePositiveMoney` in the service. Do not
 * use a class-transformer `@Transform` for it: that runs BEFORE validation, so the validator would
 * see a bigint instead of what the client sent.
 *
 * A JSON number is refused even when it is exact (`1000`): `JSON.parse` has already rounded
 * everything above 2^53 by the time a number reaches us, and one rule ("money is a string") is
 * easier to hold than "money is a number, unless it is big". The refusal is a plain 400 with the
 * `errors` list of the global ValidationPipe; no extra `ErrorCode` (the client can only fix the
 * value and resend).
 *
 * The constraint key is `isMoneyAmount`. The message never repeats the value it refused.
 */
export function IsMoneyAmount(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isMoneyAmount',
      target: target.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          try {
            parsePositiveMoney(value as string);
            return true;
          } catch (error) {
            if (error instanceof MoneyError) return false;
            throw error;
          }
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a whole number of dong greater than zero, written as a string of digits (no sign, leading zero, decimals or exponent), at most 9223372036854775807`;
        },
      },
    });
  };
}
