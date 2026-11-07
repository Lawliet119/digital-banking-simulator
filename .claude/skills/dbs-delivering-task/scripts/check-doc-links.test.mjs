// Tests for check-doc-links.mjs. Run: node --test .claude/skills/dbs-delivering-task/scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import { slug, keepFile } from './check-doc-links.mjs';

test('TC-SKILL-05 slug keeps underscores like GitHub', () => {
  assert.equal(slug('4.4 `ledger_entries`'), '44-ledger_entries');
  assert.equal(slug('4.7 `audit_log`'), '47-audit_log');
  assert.equal(slug('2. Hành vi'), '2-hành-vi');
  assert.equal(slug('Link [docs/03](../03.md) here'), 'link-docs03-here');
  assert.equal(slug('**Bold** and ~strike~'), 'bold-and-strike');
});

test('TC-SKILL-05 keepFile skips the fraud dataset, node_modules and templates', () => {
  assert.equal(keepFile('docs/README.md'), true);
  assert.equal(keepFile('load-tests/fraud-dataset/README.md'), false);
  assert.equal(keepFile('load-tests/README.md'), true);
  assert.equal(keepFile('backend/node_modules/x/README.md'), false);
  assert.equal(keepFile('.claude/skills/dbs-delivering-task/templates/feature-doc.md'), false);
});
