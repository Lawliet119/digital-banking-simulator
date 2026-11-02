// Run from backend/: node scripts/manual-dbs96.cjs
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
const dir = resolve(root, 'docs/features/screenshots/DBS-96');
const db = 'dbs_manual_96_' + randomBytes(6).toString('hex');
const run = (exe, args, opts = {}) => execFileSync(exe, args, { cwd: root, encoding: 'utf8', ...opts });
const user = run('docker', ['compose','exec','-T','postgres','printenv','POSTGRES_USER']).trim();
const password = run('docker', ['compose','exec','-T','postgres','printenv','POSTGRES_PASSWORD']).trim();
const env = { ...process.env, DATABASE_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:5432/${db}` };
const lines = [run('git',['rev-parse','HEAD']).trim(), 'DBS-96 manual on isolated Docker Compose database: '+db];
function step(label, fn) { lines.push('\n> '+label); const result = fn(); lines.push(result); process.stdout.write(label+' PASS\n'); }
const sql = (text, database = db) => run('docker',['compose','exec','-T','postgres','psql','-X','-U',user,'-d',database,'-v','ON_ERROR_STOP=1'],{input:text});
const cli = direction => run(process.execPath,[resolve(root,'backend/node_modules/typeorm/cli.js'),'-d','src/database/data-source.ts',direction],{cwd:resolve(root,'backend'),env:{...env,NODE_OPTIONS:'-r ts-node/register -r tsconfig-paths/register'}});
try {
  step('create isolated database',()=>sql(`CREATE DATABASE ${db};`,'postgres'));
  step('migration:run',()=>cli('migration:run'));
  step('schema and BR-13 comment',()=>sql("\\d notification_log\nSELECT col_description('notification_log'::regclass,5);"));
  step('valid rows and rejection probes',()=>sql(`
INSERT INTO notification_log(event_id,kind,message) VALUES(gen_random_uuid(),'transfer_completed','Giao dich da hoan tat'),(gen_random_uuid(),'account_status_changed','Trang thai tai khoan da thay doi');
SELECT id,kind,user_id,message FROM notification_log;
DO $$ BEGIN
 BEGIN INSERT INTO notification_log(event_id,kind,message) VALUES(gen_random_uuid(),'other','Thong bao'); RAISE EXCEPTION 'invalid kind accepted'; EXCEPTION WHEN check_violation THEN IF SQLSTATE <> '23514' THEN RAISE; END IF; END;
 BEGIN INSERT INTO notification_log(event_id,kind,message) VALUES(gen_random_uuid(),'transfer_completed',NULL); RAISE EXCEPTION 'NULL message accepted'; EXCEPTION WHEN not_null_violation THEN IF SQLSTATE <> '23502' THEN RAISE; END IF; END;
END $$;
SELECT 'rejections 23514 and 23502 PASS' AS result;`));
  step('migration:revert',()=>cli('migration:revert'));
  step('revert preserves users and removes notification_log',()=>sql("DO $$ BEGIN IF to_regclass('notification_log') IS NOT NULL OR to_regclass('users') IS NULL THEN RAISE EXCEPTION 'bad revert'; END IF; END $$; SELECT to_regclass('notification_log'),to_regclass('users');"));
  step('migration:run again',()=>cli('migration:run'));
  step('table restored',()=>sql('SELECT count(*) FROM notification_log;'));
} catch (error) { lines.push(String(error),String(error.stdout || ''),String(error.stderr || '')); process.exitCode=1; }
finally {
  try { step('drop isolated database',()=>sql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`,'postgres')); } catch(error) { lines.push(String(error)); process.exitCode=1; }
  mkdirSync(dir,{recursive:true}); writeFileSync(resolve(dir,'manual-test.txt'),lines.join('\n').replace(/[ \t]+$/gm,''));
}
