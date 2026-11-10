import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TransactionService } from '@database/transaction.service';
import { AuditService } from '@modules/audit';
import { validateRiskConfig } from './risk-config-validation';
import type { RiskConfigListDto, RiskConfigVersionDto } from './risk-config-http.dto';
import type { RiskConfigQuery } from './risk-config-http.query';

const FIELDS = 'version,config,created_by AS "createdBy",created_at AS "createdAt"';
const MAX_VERSION = 2_147_483_647;

@Injectable()
export class RiskConfigHttpService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  async latest(): Promise<RiskConfigVersionDto> {
    const [row] = await this.db.query<RiskConfigVersionDto[]>(
      `SELECT ${FIELDS} FROM risk_rule_sets ORDER BY version DESC LIMIT 1`,
    );
    if (!row) throw new NotFoundException('Risk configuration not found');
    return row;
  }

  async get(version: number): Promise<RiskConfigVersionDto> {
    const [row] = await this.db.query<RiskConfigVersionDto[]>(
      `SELECT ${FIELDS} FROM risk_rule_sets WHERE version=$1`,
      [version],
    );
    if (!row) throw new NotFoundException('Risk configuration not found');
    return row;
  }

  async list(query: RiskConfigQuery): Promise<RiskConfigListDto> {
    const rows = await this.db.query<RiskConfigVersionDto[]>(
      `SELECT ${FIELDS} FROM risk_rule_sets
       WHERE ($1::int IS NULL OR version < $1)
       ORDER BY version DESC LIMIT $2`,
      [query.before, query.limit + 1],
    );
    const items = rows.slice(0, query.limit);
    const nextBefore = rows.length > query.limit ? items[items.length - 1].version : null;
    return { items, nextBefore };
  }

  async create(raw: unknown, actor: string, correlationId: string): Promise<RiskConfigVersionDto> {
    const config = validateRiskConfig(raw);
    return this.tx.run(async manager => {
      // All version writers must acquire this lock before reading the current version.
      await manager.query('SELECT pg_advisory_xact_lock($1::int,$2::int)', [20261110, 160]);
      const [latest] = await manager.query<{ version: number }[]>(
        'SELECT COALESCE(MAX(version),0)::int AS version FROM risk_rule_sets',
      );
      if (latest.version >= MAX_VERSION) throw new ConflictException('Risk version limit reached');
      const [created] = await manager.query<RiskConfigVersionDto[]>(
        `INSERT INTO risk_rule_sets(version,config,created_by) VALUES($1,$2::jsonb,$3)
         RETURNING ${FIELDS}`,
        [latest.version + 1, JSON.stringify(config), actor],
      );
      await this.audit.record(manager, {
        actor,
        role: 'admin',
        action: 'risk_config.create',
        outcome: 'SUCCESS',
        target: { type: 'risk_rule_set', id: String(created.version) },
        correlationId,
      });
      return created;
    });
  }
}
