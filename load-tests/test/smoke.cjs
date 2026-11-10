// Run from backend with ts-node/register + tsconfig-paths/register (see README).
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { once } = require('node:events');
const { createServer } = require('node:net');
const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
const backend = resolve(__dirname,'../../backend');
const root = resolve(backend,'..');
process.env.NODE_ENV = 'test';
process.env.APP_ROLE = 'api';
const { startPostgresContainer, stopPostgresContainer } = require('../../backend/test/support/postgres.container.ts');
const { startValkeyContainer } = require('../../backend/test/support/valkey.container.ts');
const { createTempDatabase, migrate } = require('../../backend/test/support/temp-database.ts');
const { generateDevKeys } = require('../../backend/src/scripts/dev-auth.ts');

async function freePort() { const s=createServer(); s.listen(0,'127.0.0.1'); await once(s,'listening'); const port=s.address().port; await new Promise(r=>s.close(r)); return port; }
async function main() {
  let redis, db;
  const apps = [];
  const secretDir = mkdtempSync(join(tmpdir(),'dbs165-auth-'));
  const fixturePath = join(secretDir,'fixture.json');
  let env;
  async function app(performance) {
    const port = await freePort();
    const child = spawn(process.execPath,[join(backend,'dist/main.js')],{cwd:backend,env:{...env,PORT:String(port),
      RATE_LIMIT_TRANSFERS_PER_MINUTE:performance?'1000000':'10',RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE:performance?'1000000':'100'},windowsHide:true,stdio:['ignore','pipe','pipe']});
    apps.push(child);
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    const url=`http://127.0.0.1:${port}`;
    const deadline=Date.now()+60000;
    while(Date.now()<deadline) {
      if(child.exitCode!==null) throw new Error(`AppModule startup failed (exit ${child.exitCode})`);
      try { if((await fetch(`${url}/health/ready`,{signal:AbortSignal.timeout(1000)})).status===200) return {child,url}; } catch {}
      await wait(200);
    }
    throw new Error('AppModule readiness timeout');
  }
  async function stop(child) { if(child.exitCode===null){child.kill();await once(child,'exit');} }
  function run(kind, extra={}, expected=0) {
    const r=spawnSync(process.execPath,[join(root,'load-tests/run.cjs'),kind,'--smoke'],{cwd:root,env:{...env,...extra},encoding:'utf8',windowsHide:true,timeout:260000,maxBuffer:8*1024*1024});
    const output=(r.stdout||'')+(r.stderr||'');
    // No fixture/token/connection string is printed by this driver.
    process.stdout.write(output);
    console.log(`M-165 ${kind} exit=${r.status}; expected=${expected===0?'0':'nonzero'}`);
    if(expected===0)assert.equal(r.status,0,`${kind} smoke failed`);else assert.notEqual(r.status,0);
    assert.match(output,/invariantExit=0/);
  }
  try {
    const pg = await startPostgresContainer();
    process.env.DATABASE_URL=pg.databaseUrl;
    db=await createTempDatabase();await migrate(db.url);
    redis=await startValkeyContainer();
    await generateDevKeys({dir:secretDir});
    env={...process.env,DATABASE_URL:db.url,DATABASE_SSL:'false',REDIS_URL:redis.url,
      AUTH_MODE:'local',AUTH_LOCAL_JWKS_PATH:join(secretDir,'jwks.json'),AUTH_KEY_DIR:secretDir,
      ACCESS_TOKEN_TTL_SECONDS:'14400',LOG_LEVEL:'fatal',METRICS_EMF:'false',
      LOAD_FIXTURE:fixturePath,LOAD_DEDICATED:'1',K6_BIN:process.env.K6_BIN};
    delete env.COGNITO_USER_POOL_ID;delete env.COGNITO_CLIENT_ID;delete env.COGNITO_ISSUER;
    const performance=await app(true);env.BASE_URL=performance.url;
    for(const kind of ['baseline','hot-account','duplicate','stress'])run(kind);
    const f=JSON.parse(readFileSync(fixturePath,'utf8'));
    const offline=join(secretDir,'offline.json');
    const offlineUrl=`http://127.0.0.1:${await freePort()}`;
    writeFileSync(offline,JSON.stringify({...f,baseUrl:offlineUrl}));
    run('baseline',{BASE_URL:offlineUrl,LOAD_FIXTURE:offline},1);
    await stop(performance.child);
    const a=await app(false),b=await app(false);
    env.BASE_URL=a.url;env.API_URL_2=b.url;
    writeFileSync(fixturePath,JSON.stringify({...f,baseUrl:a.url}));
    run('rate-limit');
    await redis.stop();
    run('rate-limit',{},1);
    console.log('M-165-05 isolated Redis stopped: negative control failed as expected; shared Docker untouched');
    await stop(a.child);await stop(b.child);
    await db.drop();db=undefined;
    await stopPostgresContainer();
    // The isolated PostgreSQL is actually down; checker/runner must not claim success.
    const r=spawnSync(process.execPath,[join(root,'load-tests/run.cjs'),'baseline','--smoke'],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:90000});
    assert.notEqual(r.status,0);assert.match((r.stdout||'')+(r.stderr||''),/invariantExit=2/);
    console.log('M-165-06 isolated PostgreSQL stopped: runner nonzero, invariantExit=2');
    console.log('TC-165-03/04 manual smoke and negative controls PASS; local only, no AWS acceptance');
  } finally {
    for(const child of apps) await stop(child);
    if(db)await db.drop();
    if(redis)await redis.stop().catch(()=>{});
    await stopPostgresContainer();
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
