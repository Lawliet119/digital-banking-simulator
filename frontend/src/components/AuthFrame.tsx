import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Brand } from './ui';

/** The two halves of the sign-in screens: a greeting and a card drawing, then the form. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-art">
        <Link to="/welcome" aria-label="Về trang chủ">
          <Brand />
        </Link>
        <h2>
          Chào mừng
          <br />
          <span className="soft-text">quay lại.</span>
        </h2>
        <div className="balance-card" aria-hidden="true">
          <div className="row between">
            <span>Thanh toán</span>
            <span className="mono">**** 0002</span>
          </div>
          <div className="big">48.000.000 ₫</div>
          <span>NGUYEN MINH ANH</span>
        </div>
      </div>
      <main>
        <div className="auth-form">{children}</div>
      </main>
    </div>
  );
}
