import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { finalize, type Observable } from 'rxjs';

/**
 * The HTTP handlers running in this process. The server alone cannot tell: when a caller (or the
 * load balancer) closes its connection the handler goes on, still inside its database transaction,
 * while `server.close()` already sees nothing left to wait for (BL-381).
 */
@Injectable()
export class InflightRequests {
  private readonly responses = new Set<ServerResponse>();
  private waiters: (() => void)[] = [];
  private draining = false;

  get count(): number {
    return this.responses.size;
  }

  /** Counts one handler until the returned function is called. */
  begin(response: ServerResponse): () => void {
    this.responses.add(response);
    if (this.draining) closeAfter(response);
    return () => {
      if (!this.responses.delete(response)) return;
      if (this.draining) closeAfter(response);
      if (this.responses.size === 0) this.waiters.splice(0).forEach(resolve => resolve());
    };
  }

  /** From now on every answer tells the caller not to reuse its connection. */
  startDraining(): void {
    this.draining = true;
    this.responses.forEach(closeAfter);
  }

  /** Resolves when no handler is running. */
  idle(): Promise<void> {
    if (this.responses.size === 0) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

function closeAfter(response: ServerResponse): void {
  if (!response.headersSent) response.setHeader('Connection', 'close');
}

@Injectable()
export class InflightRequestsInterceptor implements NestInterceptor {
  constructor(private readonly requests: InflightRequests) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const done = this.requests.begin(context.switchToHttp().getResponse<ServerResponse>());
    return next.handle().pipe(finalize(done));
  }
}
