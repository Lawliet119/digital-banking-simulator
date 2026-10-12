import { SnakeNamingStrategy } from './snake-naming.strategy';

// TC-20-16. Hand-written SQL in the transfer flow and the entities must name the same columns;
// a mismatch only shows up at runtime as "column does not exist".
describe('SnakeNamingStrategy', () => {
  const naming = new SnakeNamingStrategy();

  it('maps a camelCase property to its snake_case column', () => {
    expect(naming.columnName('sessionsRevokedAt', undefined, [])).toBe('sessions_revoked_at');
    expect(naming.columnName('cognitoSub', undefined, [])).toBe('cognito_sub');
  });

  it('keeps a column name that was given explicitly', () => {
    expect(naming.columnName('balance', 'balance_minor', [])).toBe('balance_minor');
  });

  it('prefixes the columns of an embedded entity with its snake_case path', () => {
    expect(naming.columnName('createdAt', undefined, ['audit'])).toBe('audit_created_at');
    expect(naming.columnName('createdAt', undefined, ['reviewInfo'])).toBe(
      'review_info_created_at',
    );
  });

  it('names the foreign key column of a relation <relation>_<referenced column>', () => {
    expect(naming.joinColumnName('customer', 'id')).toBe('customer_id');
    expect(naming.joinColumnName('fromAccount', 'id')).toBe('from_account_id');
  });

  it('keeps an explicit table name and snake_cases a class name otherwise', () => {
    expect(naming.tableName('Account', 'accounts')).toBe('accounts');
    expect(naming.tableName('LedgerEntry', undefined)).toBe('ledger_entry');
  });

  it('snake_cases relation and join-table names', () => {
    expect(naming.relationName('fromAccount')).toBe('from_account');
    expect(naming.joinTableName('fraud_flags', 'rule_hits', 'ruleHits', 'flags')).toBe(
      'fraud_flags_rule_hits_rule_hits',
    );
    expect(naming.joinTableColumnName('fraud_flags', 'transferId')).toBe('fraud_flags_transfer_id');
  });
});
