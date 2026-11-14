import { RULE_PARAMS_PROBE_TRANSFER_ID } from '@modules/risk/config/rule-params';
import type { TransferEvent } from '@modules/risk/features/feature-provider';
import { R3NewAccountLargeTransferRule } from '@modules/risk/rules/r3-new-account-large-transfer.rule';

/**
 * Makes R3 throw for every real transfer, while the parameter probe of `parseRuleSet` (BL-188),
 * which scores a synthetic transfer each time a rule set is loaded, still gets the real result.
 * The returned spy counts only the calls for real transfers.
 */
export function failR3ForRealTransfers(message = 'rule bug') {
  const original = R3NewAccountLargeTransferRule.prototype.evaluate;
  const realCalls: TransferEvent[] = [];
  const spy = jest
    .spyOn(R3NewAccountLargeTransferRule.prototype, 'evaluate')
    .mockImplementation(function (
      this: R3NewAccountLargeTransferRule,
      ...args: Parameters<R3NewAccountLargeTransferRule['evaluate']>
    ) {
      const [event] = args;
      if (event.transferId === RULE_PARAMS_PROBE_TRANSFER_ID) return original.apply(this, args);
      realCalls.push(event);
      throw new Error(message);
    });
  return { spy, realCalls };
}
