import { ApiProperty } from '@nestjs/swagger';

const money = (example: string, description: string) =>
  ApiProperty({ type: String, example, description });

export class TransferLimitsDto {
  @money('20000000', 'Largest single transfer, whole VND (BR-06)')
  perTransaction!: string;

  @money('80000000', 'Largest total a source account may send per day, Vietnam time')
  perDay!: string;

  @money('2000000', 'What this account has sent today')
  sentToday!: string;

  @money('78000000', 'perDay minus sentToday, never below zero')
  remainingToday!: string;
}

export class AccountFlowDto {
  @ApiProperty({ format: 'uuid', example: '8b3609fb-96a7-434b-a7ba-2ba171955e6d' })
  accountId!: string;

  @ApiProperty({ type: String, pattern: '^[0-9]{12}$', example: '100000000002' })
  accountNumber!: string;

  @money('3000000', 'Money into this account in the window')
  moneyIn!: string;

  @money('2000000', 'Money out of this account in the window')
  moneyOut!: string;

  @ApiProperty({ type: 'integer', example: 2 })
  transactions!: number;
}

export class CustomerSummaryDto {
  @ApiProperty({ type: 'integer', enum: [1, 30], example: 30 })
  days!: number;

  @money('3000000', 'Money in from outside the customer’s own accounts')
  totalIn!: string;

  @money('2000000', 'Money out to accounts that are not the customer’s own')
  totalOut!: string;

  @ApiProperty({ type: [AccountFlowDto] })
  accounts!: AccountFlowDto[];
}

export class RecentRecipientDto {
  @ApiProperty({ format: 'uuid', example: 'bf9c3419-51ff-4e55-b03c-3296f0419c03' })
  accountId!: string;

  @ApiProperty({ type: String, pattern: '^[0-9]{12}$', example: '100000000004' })
  accountNumber!: string;

  @ApiProperty({ type: String, example: 'Trần Thu Hà' })
  ownerName!: string;

  @ApiProperty({ type: String, format: 'date-time', example: '2026-03-15T02:30:00.000Z' })
  lastTransferAt!: string;
}

export class RecentRecipientsDto {
  @ApiProperty({ type: [RecentRecipientDto], description: 'Newest first, at most 5' })
  items!: RecentRecipientDto[];
}
