/** Words shown to a customer. No field about fraud flags, scores or AI exists here (AC-10.2). */

export const ACCOUNT_TYPE: Record<'CHECKING' | 'SAVINGS', string> = {
  CHECKING: 'Thanh toán',
  SAVINGS: 'Tiết kiệm',
};

export const ACCOUNT_STATUS: Record<'ACTIVE' | 'LOCKED', string> = {
  ACTIVE: 'Hoạt động',
  LOCKED: 'Bị khóa',
};

export const TRANSFER_STATUS: Record<'COMPLETED' | 'REJECTED', string> = {
  COMPLETED: 'Hoàn tất',
  REJECTED: 'Bị từ chối',
};

export const TRANSFER_TYPE: Record<'TRANSFER' | 'DEPOSIT', string> = {
  TRANSFER: 'Chuyển tiền',
  DEPOSIT: 'Nạp tiền',
};

export const REJECT_REASON: Record<string, string> = {
  ACCOUNT_NOT_ACTIVE: 'Tài khoản nguồn hoặc tài khoản nhận đang bị khóa.',
  LIMIT_PER_TX_EXCEEDED: 'Vượt hạn mức cho một giao dịch.',
  LIMIT_PER_DAY_EXCEEDED: 'Vượt hạn mức chuyển trong ngày.',
  INSUFFICIENT_FUNDS: 'Số dư không đủ.',
};

export const NOTIFICATION_KIND: Record<'transfer_completed' | 'account_status_changed', string> = {
  transfer_completed: 'Giao dịch',
  account_status_changed: 'Tài khoản',
};
