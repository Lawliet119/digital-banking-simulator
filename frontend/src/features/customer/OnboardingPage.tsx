import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { call } from '../../api/client';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Field } from '../../components/Field';
import { keys, useProfile } from './queries';

/** `/onboarding`: the full name, once. A second submit returns the existing profile unchanged. */
export function OnboardingPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const profile = useProfile();
  const [fullName, setFullName] = useState('');
  const create = useMutation({
    mutationFn: (name: string) => call(api.POST('/v1/customers/me', { body: { fullName: name } })),
    onSuccess: data => {
      queryClient.setQueryData(keys.profile, data);
      void navigate('/accounts', { replace: true });
    },
  });

  if (profile.data) return <Navigate to="/accounts" replace />;

  const trimmed = fullName.trim();
  const error =
    fullName && (trimmed.length === 0 || trimmed.length > 200) ? 'Từ 1 đến 200 ký tự.' : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || error) return;
    create.mutate(trimmed);
  }

  return (
    <section className="panel narrow">
      <h1>Tạo hồ sơ</h1>
      <p className="muted">
        Người chuyển tiền cho bạn sẽ thấy tên này để xác nhận. Không đổi được sau khi tạo.
      </p>
      <form className="col" onSubmit={submit}>
        <Field
          label="Họ và tên"
          value={fullName}
          onChange={event => setFullName(event.target.value)}
          error={error}
          autoComplete="name"
          maxLength={200}
          required
        />
        <div className="balance-card" aria-hidden="true">
          <span>Xem trước</span>
          <div className="big">{(trimmed || 'Họ và tên').toLocaleUpperCase('vi-VN')}</div>
          <span className="mono">**** **** ****</span>
        </div>
        <ErrorBanner error={create.error} />
        <button type="submit" disabled={create.isPending || !trimmed || Boolean(error)}>
          {create.isPending ? 'Đang tạo…' : 'Tạo hồ sơ'}
        </button>
      </form>
    </section>
  );
}
