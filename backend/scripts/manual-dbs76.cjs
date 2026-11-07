// Run from backend after npm run build; only local Compose Valkey is used.
const {resolve}=require('node:path');
const {execFileSync}=require('node:child_process');
const {mkdirSync,writeFileSync}=require('node:fs');
const {randomUUID}=require('node:crypto');
const {setTimeout:wait}=require('node:timers/promises');
const assert=require('node:assert/strict');
require('ts-node').register({transpileOnly:true});
require('tsconfig-paths').register({baseUrl:resolve(__dirname,'../dist'),paths:{'@config/*':['config/*']}});
const {RedisClient,RedisMetrics,RedisUnavailableError}=require('../dist/libs/redis');
const {startLatencyProxy}=require('../test/support/latency-proxy.ts');
const {createClient}=require('redis');
const root=resolve(__dirname,'../..');
const output=[execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()];
const log=s=>{output.push(s);console.log(s)};
const prefix='dbs76-manual:'+randomUUID();const keys=['cache','counter','events'].map(x=>prefix+':'+x);
const admin=createClient({url:'redis://127.0.0.1:6379',socket:{connectTimeout:1000,reconnectStrategy:false}});admin.on('error',()=>undefined);
let proxy,client;let metrics=new RedisMetrics();
async function until(predicate,ms=5000){const end=Date.now()+ms;while(!predicate()){if(Date.now()>end)throw new Error('Condition timed out');await wait(10)}}
async function main(){
  await admin.connect();proxy=await startLatencyProxy('127.0.0.1',6379);client=new RedisClient({url:proxy.url,commandTimeoutMs:50},metrics);await until(()=>client.isReady);
  await client.set(keys[0],'cached',60);assert.equal(await client.get(keys[0]),'cached');
  await client.set(keys[1],'9007199254740992',60);assert.equal(await client.incr(keys[1],60),'9007199254740993');
  assert.equal(await client.zadd(keys[2],100,'transfer-id',60),1);assert.deepEqual(await client.zrangebyscore(keys[2],0,100),['transfer-id']);
  for(const key of keys)assert.ok(await admin.ttl(key)>0);
  log('M-76-01 operations PASS: cache, exact int64 counter string, sorted set and positive TTL');
  await assert.rejects(client.incr(keys[1],0),TypeError);assert.equal(await admin.get(keys[1]),'9007199254740993');assert.equal(await metrics.count(),0);
  log('M-76-02 validation PASS: invalid TTL, no mutation, no fallback increment');
  // Fresh breaker for controlled ten-failure volume measurement.
  client.onModuleDestroy();metrics=new RedisMetrics();client=new RedisClient({url:proxy.url,commandTimeoutMs:50},metrics);await until(()=>client.isReady);
  proxy.setDelay(250);const durations=[];
  for(let i=0;i<10;i++){const start=Date.now();await assert.rejects(client.ping(),error=>error.reason==='TIMEOUT');durations.push(Date.now()-start)}
  assert.equal(client.circuitState,'open');assert.equal(await metrics.count(),10);const bytes=proxy.requestBytes;
  await assert.rejects(client.ping(),error=>error.reason==='CIRCUIT_OPEN');assert.equal(proxy.requestBytes,bytes);assert.equal(await metrics.count(),11);
  log('M-76-03 slow PASS: proxy delay250ms, ten TIMEOUTs, breaker open, next call skipped wire');
  log('Observed command elapsed ms: '+durations.join(','));
  log((await metrics.metrics()).split('\n').find(s=>s.startsWith('redis_fallback_total ')));
  proxy.setDelay(0);await until(()=>client.circuitState==='half-open',6500);assert.equal(await client.ping(),'PONG');assert.equal(client.circuitState,'closed');
  log('M-76-04 recovery PASS: half-open after5seconds, PONG, breaker closed');
  await proxy.stop();await until(()=>!client.isReady);await assert.rejects(client.get(keys[0]),RedisUnavailableError);assert.equal(await metrics.count(),12);
  log('M-76-05 down PASS: network unavailable, explicit error, fallback counter12');
}
main().catch(error=>{log('FAILED: '+error.name);process.exitCode=1}).finally(async()=>{
  client?.onModuleDestroy();try{await proxy?.stop();if(admin.isOpen)await admin.del(keys)}catch(error){log('Cleanup FAILED: '+error.name);process.exitCode=1}
  if(admin.isOpen)admin.destroy();if(!process.exitCode)log('M-76-06 cleanup PASS: owned keys removed, client/proxy closed');
  const dir=resolve(root,'docs/features/screenshots/DBS-76');mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,'manual-test.txt'),output.join('\n')+'\n');
});
