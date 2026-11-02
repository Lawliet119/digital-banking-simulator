// Real local HTTP + disposable Postgres/Valkey. Run from backend after npm run build.
require('ts-node').register({transpileOnly:true});require('tsconfig-paths/register');
const {execFileSync}=require('node:child_process');
const {resolve}=require('node:path');const {mkdirSync,writeFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const {startReadinessApp}=require('../test/support/readiness-app.ts');
const root=resolve(__dirname,'../..');
const lines=[execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()];
const log=s=>{lines.push(s);console.log(s)};let stack;
async function probe(path,status,redis){
  const response=await fetch(stack.url+path);const body=await response.json();
  assert.equal(response.status,status);if(redis)assert.equal(body.redis,redis);
  log(`GET ${path} -> ${response.status} ${JSON.stringify(body)}`);return body;
}
async function main(){
  stack=await startReadinessApp();await probe('/health/live',200);
  const ready=await probe('/health/ready',200,'up');assert.equal(ready.details.database.status,'up');log('M-78-01 healthy PASS');
  stack.proxy.setDelay(250);try{await probe('/health/ready',200,'degraded')}finally{stack.proxy.setDelay(0)}log('M-78-02 slow Redis PASS');
  await probe('/health/ready',200,'up');log('M-78-03 recovery PASS');
  await stack.stopRedis();await probe('/health/ready',200,'degraded');await probe('/health/live',200);log('M-78-04 Redis stopped PASS');
  await stack.stopPostgres();const down=await probe('/health/ready',503);assert.equal(down.details.database.status,'down');await probe('/health/live',200);log('M-78-05 PostgreSQL stopped PASS');
}
main().catch(error=>{log('FAILED: '+error.name);process.exitCode=1}).finally(async()=>{
  try{await stack?.close();if(!process.exitCode)log('M-78-06 cleanup PASS: app, proxy and owned containers closed')}catch(error){log('Cleanup FAILED: '+error.name);process.exitCode=1}
  const dir=resolve(root,'docs/features/screenshots/DBS-78');mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,'manual-test.txt'),lines.join('\n')+'\n');
});
