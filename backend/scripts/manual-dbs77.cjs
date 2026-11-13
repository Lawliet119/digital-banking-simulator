// From backend/: npm run build && node scripts/manual-dbs77.cjs
const {resolve}=require('node:path');
const {execFileSync}=require('node:child_process');
const {mkdirSync,writeFileSync}=require('node:fs');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
require('tsconfig-paths').register({baseUrl:resolve(__dirname,'../dist'),paths:{'@config/*':['config/*']}});
const {SqsClient}=require('../dist/libs/sqs');
const {SQSClient,CreateQueueCommand,DeleteQueueCommand}=require('@aws-sdk/client-sqs');
const root=resolve(__dirname,'../..');
const lines=[execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()];
const log=s=>{lines.push(s);console.log(s)};
const endpoint='http://localhost:9324';
process.env.AWS_ACCESS_KEY_ID='local';process.env.AWS_SECRET_ACCESS_KEY='local';
const sdk=new SQSClient({endpoint,region:'us-east-1',credentials:{accessKeyId:'local',secretAccessKey:'local'}});
const client=new SqsClient({endpoint,region:'us-east-1'});
const queues=[];
const opts={waitTimeSeconds:1,visibilityTimeout:0};
async function main(){
  const create=async()=>{const name='dbs77-manual-'+randomUUID();const r=await sdk.send(new CreateQueueCommand({QueueName:name}));const url=new URL(new URL(r.QueueUrl).pathname,endpoint).toString();queues.push(url);log('Created isolated queue '+name);return url};
  const source=await create(),dlq=await create();
  await client.send(source,'{"amount":"9007199254740993"}',{correlationId:'manual-server-77'});
  const [message]=await client.receive(source,opts);
  assert.equal(message.Body,'{"amount":"9007199254740993"}');assert.equal(message.MessageAttributes.correlationId.StringValue,'manual-server-77');assert.ok(message.ReceiptHandle);
  log('M-77-01 roundtrip PASS: exact body, correlationId attribute, receipt handle');
  const success=await client.processBatch(source,dlq,async value=>assert.equal(value.amount,'9007199254740993'),opts);
  assert.equal(success[0].status,'acknowledged');assert.deepEqual(await client.receive(source,opts),[]);
  log('M-77-02 success PASS: handler completed, acknowledged, source empty');
  await client.send(source,'{"mode":"retry"}');
  const failed=await client.processBatch(source,dlq,async()=>{throw new Error('manual transient error')},opts);
  assert.equal(failed[0].status,'failed');const [retry]=await client.receive(source,opts);assert.equal(retry.MessageId,failed[0].messageId);await client.acknowledge(source,retry);
  log('M-77-03 redelivery PASS: failed handler message returned with identical MessageId');
  await client.send(source,'{');let called=false;
  const malformed=await client.processBatch(source,dlq,async()=>{called=true},opts);
  assert.equal(called,false);assert.equal(malformed[0].status,'dead-lettered');assert.deepEqual(await client.receive(source,opts),[]);const [bad]=await client.receive(dlq,opts);assert.equal(bad.Body,'{');
  log('M-77-04 malformed PASS: handler not called, raw body in DLQ, source empty');
  await assert.rejects(client.receive(source,{maxMessages:11}),RangeError);
  log('M-77-05 boundary PASS: batch 11 rejected with RangeError');
}
main().catch(error=>{log('FAILED: '+error.name);process.exitCode=1}).finally(async()=>{
  for(const queue of queues){try{await sdk.send(new DeleteQueueCommand({QueueUrl:queue}));log('Deleted isolated queue '+new URL(queue).pathname)}catch(error){log('Cleanup FAILED: '+error.name);process.exitCode=1}}
  client.onApplicationShutdown();sdk.destroy();if(!process.exitCode)log('M-77-06 cleanup PASS');
  const dir=resolve(root,'docs/features/screenshots/DBS-77');mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,'manual-test.txt'),lines.join('\n')+'\n');
});
