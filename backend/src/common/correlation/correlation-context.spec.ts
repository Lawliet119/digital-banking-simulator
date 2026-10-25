import { createLoggingOptions } from '../logging/logging.options';
import pino from 'pino';
import { Writable } from 'node:stream';
import { CorrelationContext } from './correlation-context';
import { validateEvent } from '../events/validate-event';

const MESSAGE_ID = '6e8b7df0-7abf-40a5-8f57-2bb1a239bb7e';

describe('DBS-43 correlation context', () => {
  const context = new CorrelationContext();

  it('TC-43-01 exposes the current id to nested services across awaits', async () => {
    expect(context.getCorrelationId()).toBeUndefined();
    await context.run(MESSAGE_ID, 'api', async () => {
      await Promise.resolve();
      expect(new CorrelationContext().getCorrelationId()).toBe(MESSAGE_ID);
    });
    expect(context.getCorrelationId()).toBeUndefined();
  });

  it('TC-43-02 scopes overlapping worker messages and restores no outer context', async () => {
    const observed = await Promise.all([
      context.runForMessage({ correlationId: MESSAGE_ID }, async () => {
        await new Promise(resolve => setImmediate(resolve));
        return context.getCorrelationId();
      }),
      context.runForMessage({}, async () => {
        await new Promise(resolve => setImmediate(resolve));
        return context.getCorrelationId();
      }),
    ]);
    expect(observed[0]).toBe(MESSAGE_ID);
    expect(observed[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(observed[1]).not.toBe(MESSAGE_ID);
    expect(context.getCorrelationId()).toBeUndefined();
  });

  it('TC-43-03 rejects an untrusted message id for tracing and logs worker role in both mode', () => {
    let output = '';
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString();
        done();
      },
    });
    const logger = pino(createLoggingOptions({ role: 'both', logLevel: 'log' }), stream);
    context.runForMessage({ correlationId: 'forged\nlog' }, () => {
      logger.info('Consumer handling message');
    });
    const row = JSON.parse(output) as Record<string, unknown>;
    expect(row.role).toBe('worker');
    expect(row.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.correlationId).not.toBe('forged\nlog');
  });

  it('TC-43-05 traces a missing id before validation without repairing the event', () => {
    const message = { eventType: 'TransferCompleted' };
    const result = context.runForMessage(message, () => ({
      traceId: context.getCorrelationId(),
      validation: validateEvent(message),
    }));
    expect(result.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.validation).toMatchObject({ ok: false });
    if (!result.validation.ok) {
      expect(result.validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'correlationId', code: 'MISSING_FIELD' }),
        ]),
      );
    }
    expect(message).not.toHaveProperty('correlationId');
  });
});
