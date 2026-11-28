import type { Tone } from '../../components/ui';

export const RISK_LEVEL: Record<'MEDIUM' | 'HIGH', string> = {
  MEDIUM: 'Trung bình',
  HIGH: 'Cao',
};

export const RISK_TONE: Record<'MEDIUM' | 'HIGH', Tone> = { MEDIUM: 'warn', HIGH: 'bad' };

export const REVIEW_STATUS: Record<'OPEN' | 'CONFIRMED_FRAUD' | 'FALSE_POSITIVE', string> = {
  OPEN: 'Chưa review',
  CONFIRMED_FRAUD: 'Gian lận thật',
  FALSE_POSITIVE: 'Báo nhầm',
};

export const REVIEW_TONE: Record<'OPEN' | 'CONFIRMED_FRAUD' | 'FALSE_POSITIVE', Tone> = {
  OPEN: 'warn',
  CONFIRMED_FRAUD: 'bad',
  FALSE_POSITIVE: 'ok',
};

export const AUDIT_OUTCOME: Record<'SUCCESS' | 'REJECTED' | 'DENIED', string> = {
  SUCCESS: 'Thành công',
  REJECTED: 'Bị từ chối',
  DENIED: 'Không có quyền',
};

export const AUDIT_TONE: Record<'SUCCESS' | 'REJECTED' | 'DENIED', Tone> = {
  SUCCESS: 'ok',
  REJECTED: 'warn',
  DENIED: 'bad',
};

/** Short names of the six rules of `docs/components/risk`. */
export const RULE_NAME: Record<'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6', string> = {
  R1: 'Quá nhiều lệnh trong thời gian ngắn',
  R2: 'Số tiền bất thường so với thói quen',
  R3: 'Tài khoản mới chuyển số tiền lớn',
  R4: 'Chuyển đi rồi chuyển ngược lại',
  R5: 'Nhiều người nhận mới trong thời gian ngắn',
  R6: 'Chuyển gần hết số dư',
};
