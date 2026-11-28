import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { call } from '../../api/client';
import { ApiProblem } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { PageHead } from '../../components/ui';
import { parseConfig, readRules, withWeight } from '../../lib/risk-config';
import { RULE_NAME } from './labels';
import { useLatestRiskConfig } from './RiskConfigPage';

/**
 * `/admin/risk-config/new`: a new version, starting from the one in force. The sliders edit the
 * weights inside the JSON text, which is what is sent. The screen checks only that the text is a
 * JSON object; every business rule is the server's, and its 400 messages are shown as they come.
 */
export function RiskConfigNewPage() {
  const latest = useLatestRiskConfig();
  if (latest.isPending) return <p aria-busy="true">Đang tải…</p>;
  if (latest.isError) return <ErrorBanner error={latest.error} />;
  return (
    <ConfigEditor initial={latest.data ? JSON.stringify(latest.data.config, null, 2) : '{}'} />
  );
}

function ConfigEditor({ initial }: { initial: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [text, setText] = useState(initial);
  const [parseError, setParseError] = useState<string | undefined>();
  const rules = readRules(parseConfig(text));

  const create = useMutation({
    mutationFn: (config: Record<string, unknown>) =>
      call(api.POST('/v1/admin/risk-config/versions', { body: { config } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'risk-config'] });
      void navigate('/admin/risk-config');
    },
  });

  function submit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return setParseError('Không phải JSON hợp lệ.');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return setParseError('Cấu hình phải là một object JSON.');
    }
    setParseError(undefined);
    create.mutate(parsed as Record<string, unknown>);
  }

  const fieldErrors = create.error instanceof ApiProblem ? create.error.errors : [];

  return (
    <>
      <PageHead title="Tạo phiên bản cấu hình mới">
        <Link to="/admin/risk-config" className="button secondary">
          Hủy
        </Link>
        <button type="button" disabled={create.isPending || !text.trim()} onClick={submit}>
          {create.isPending ? 'Đang lưu…' : 'Lưu phiên bản mới'}
        </button>
      </PageHead>
      <p role="note" className="warning" data-testid="freeze-warning">
        Phiên bản mới áp dụng cho mọi giao dịch từ lúc lưu. Không tạo phiên bản mới trong giai đoạn
        đóng băng cấu hình.
      </p>
      {parseError && (
        <p role="alert" className="error">
          {parseError}
        </p>
      )}
      <ErrorBanner error={create.error} />
      {fieldErrors.length > 0 && (
        <ul className="error" data-testid="config-errors">
          {fieldErrors.map(message => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      <div className="split">
        <section className="panel">
          <h2>Trọng số từng luật</h2>
          {rules.length === 0 && (
            <p className="muted">Cấu hình bên cạnh chưa có luật nào đọc được.</p>
          )}
          <ul className="items">
            {rules.map(rule => (
              <li key={rule.id} className="item">
                <span className="tile info">{rule.id}</span>
                <div className="grow">
                  <b>{RULE_NAME[rule.id]}</b>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={rule.weight}
                    aria-label={`Trọng số ${rule.id}`}
                    onChange={event =>
                      setText(withWeight(text, rule.id, Number(event.target.value)))
                    }
                  />
                </div>
                <output>{rule.weight}</output>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel">
          <div className="field">
            <label htmlFor="config">Cấu hình (JSON)</label>
            <textarea
              id="config"
              rows={24}
              className="code"
              spellCheck={false}
              value={text}
              onChange={event => setText(event.target.value)}
            />
          </div>
        </section>
      </div>
    </>
  );
}
