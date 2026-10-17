// Public surface of @common/money. Import from here (`import { parsePositiveMoney } from
// '@common/money'`), never from a file inside the folder.
//
// Not exported on purpose: `parseWholeNumber` (internal, shared by money.ts and balance.ts) and
// `bigint-json.bootstrap` (a side-effect file, imported once by main.ts).
export {
  BALANCE_ZERO,
  creditBalance,
  debitBalance,
  formatBalance,
  parseBalance,
  toBalance,
  type Balance,
} from './balance';
export { installBigIntJson } from './bigint-json';
export { IsMoneyAmount } from './is-money-amount.decorator';
export {
  MONEY_MAX,
  MONEY_ZERO,
  MoneyError,
  addMoney,
  formatMoney,
  parseMoney,
  parsePositiveMoney,
  subtractMoney,
  toMoney,
  tryParseMoney,
  type Money,
  type MoneyErrorReason,
} from './money';
