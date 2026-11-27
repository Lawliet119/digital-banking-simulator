export const RISK_LEVEL: Record<'MEDIUM' | 'HIGH', string> = {
  MEDIUM: 'Trung bình',
  HIGH: 'Cao',
};

export const REVIEW_STATUS: Record<'OPEN' | 'CONFIRMED_FRAUD' | 'FALSE_POSITIVE', string> = {
  OPEN: 'Chưa review',
  CONFIRMED_FRAUD: 'Gian lận thật',
  FALSE_POSITIVE: 'Báo nhầm',
};

export const AUDIT_OUTCOME: Record<'SUCCESS' | 'REJECTED' | 'DENIED', string> = {
  SUCCESS: 'Thành công',
  REJECTED: 'Bị từ chối',
  DENIED: 'Không có quyền',
};
