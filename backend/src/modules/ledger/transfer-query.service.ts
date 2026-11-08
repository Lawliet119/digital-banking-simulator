import { Injectable, NotFoundException } from '@nestjs/common';
import { TransactionService } from '@database/transaction.service';
import { AuditReason, AuditService } from '@modules/audit';
import { TransferStatusDto } from './transfer-status.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION = 'transfer.read';

interface Row {
  id: string;
  type: 'TRANSFER' | 'DEPOSIT';
  status: 'COMPLETED' | 'REJECTED';
  rejectReason: string | null;
  amount: string;
  fromAccountId: string;
  toAccountId: string | null;
  createdAt: string;
  senderUserId: string | null;
  recipientUserId: string | null;
}

/** The two owners are read with the transfer, in one statement; nothing else of them is selected. */
const TRANSFER_SQL = `SELECT t.id, t.type, t.status, t.reject_reason AS "rejectReason",
  t.amount::text AS amount, t.from_account_id AS "fromAccountId", t.to_account_id AS "toAccountId",
  to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
  fc.user_id AS "senderUserId", tc.user_id AS "recipientUserId"
FROM transfers t
JOIN accounts fa ON fa.id = t.from_account_id
LEFT JOIN customers fc ON fc.id = fa.customer_id
LEFT JOIN accounts ta ON ta.id = t.to_account_id
LEFT JOIN customers tc ON tc.id = ta.customer_id
WHERE t.id = $1::uuid`;

@Injectable()
export class TransferQueryService {
  constructor(
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * UC-7. Who may read: the sender in every status; the recipient only once the transfer is
   * COMPLETED. Everyone else, and a transfer that does not exist, get the same 404 and a DENIED
   * audit row written outside the read transaction (so it survives the 404). A REJECTED transfer
   * carries no destination id, so it cannot reveal what the destination was (BL-175).
   */
  async get(userId: string, transferId: string, correlationId: string): Promise<TransferStatusDto> {
    const id = UUID.test(transferId) ? transferId.toLowerCase() : undefined;
    const found = await this.tx.run(async manager => {
      if (!id) return undefined;
      const [row]: Row[] = await manager.query(TRANSFER_SQL, [id]);
      if (!row) return undefined;
      const isSender = row.senderUserId === userId;
      const isRecipient = row.status === 'COMPLETED' && row.recipientUserId === userId;
      if (!isSender && !isRecipient) return undefined;
      const view = toView(row);
      await this.audit.record(manager, {
        actor: userId,
        role: 'customer',
        action: ACTION,
        outcome: 'SUCCESS',
        target: { type: 'transfer', id: row.id },
        correlationId,
        metadata: { id: row.id },
      });
      return view;
    });
    if (found) return found;
    // Outside the read transaction. The path value is only stored once it is a valid UUID.
    await this.audit.recordDenied({
      actor: userId,
      role: 'customer',
      action: ACTION,
      target: id ? { type: 'transfer', id } : { type: 'user', id: userId },
      correlationId,
      metadata: { reason: AuditReason.NOT_OWNER },
    });
    throw new NotFoundException('Transfer not found');
  }
}

function toView(row: Row): TransferStatusDto {
  const view: TransferStatusDto = {
    transferId: row.id,
    type: row.type,
    status: row.status,
    amount: row.amount,
    createdAt: row.createdAt,
  };
  if (row.status === 'REJECTED' && row.rejectReason) view.rejectReason = row.rejectReason;
  // The funding account is the source of every DEPOSIT and belongs to no customer.
  if (row.type === 'TRANSFER') view.fromAccountId = row.fromAccountId;
  if (row.status === 'COMPLETED' && row.toAccountId) view.toAccountId = row.toAccountId;
  return view;
}
