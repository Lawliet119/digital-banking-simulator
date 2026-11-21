#!/usr/bin/env bash
# Chạy các câu SQL bằng credential master trong một task ECS một lần (task def dbs-db-roles, ghi đè command).
# Dùng: dbtask.sh <file.sql-json>   (file là mảng JSON các chuỗi SQL). In kết quả JSON từng câu.
export AWS_PROFILE=dbs AWS_DEFAULT_REGION=ap-southeast-1 MSYS_NO_PATHCONV=1 PYTHONUTF8=1
SP='F:/tmp/claude/claude/b40605182e8b32f5/f51d1485-2744-499d-9ed7-465b3e3fa60b/scratchpad'
export PATH="/f/tmp/claude/claude/b40605182e8b32f5/f51d1485-2744-499d-9ed7-465b3e3fa60b/scratchpad/bin:$PATH"
QUERIES="$1"
B64Q=$(python -c 'import base64,sys; print(base64.b64encode(open(sys.argv[1],"rb").read()).decode())' "$QUERIES")
cat > "$SP/dbtask-runner.js" <<'EOF'
const { Client } = require('pg');
const fs = require('fs');
(async () => {
  const queries = JSON.parse(Buffer.from(process.env.Q64, 'base64').toString());
  const c = new Client({
    host: process.env.DB_HOST, port: 5432, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    ssl: { ca: fs.readFileSync(process.env.DATABASE_SSL_CA_PATH, 'utf8'), rejectUnauthorized: true },
  });
  await c.connect();
  let hot = null;
  for (const q0 of queries) {
    const q = hot ? q0.replace(/\{\{HOT\}\}/g, hot) : q0;
    try {
      const r = await c.query(q);
      const rows = Array.isArray(r) ? r.flatMap(x => x.rows) : r.rows;
      if (hot === null && rows[0]) hot = String(Object.values(rows[0])[0]);
      console.log('SQL> ' + q.slice(0, 120).replace(/\s+/g, ' '));
      console.log(JSON.stringify(rows));
    } catch (e) { console.log('SQLERR> ' + q.slice(0, 80) + ' :: ' + e.message); }
  }
  await c.end();
})().catch(e => { console.log('FATAL ' + e.message); process.exit(1); });
EOF
B64R=$(python -c 'import base64,sys; print(base64.b64encode(open(sys.argv[1],"rb").read()).decode())' "$SP/dbtask-runner.js")
SVC=$(aws ecs describe-services --cluster dbs-dev --services api --query 'services[0].networkConfiguration' --output json)
python - "$SVC" "$B64R" "$B64Q" > "$SP/dbtask-args.json" <<'EOF'
import json,sys
net=json.loads(sys.argv[1])
cmd=["node","-e","eval(Buffer.from('"+sys.argv[2]+"','base64').toString())"]
ov={"containerOverrides":[{"name":"db-roles","command":cmd,"environment":[{"name":"Q64","value":sys.argv[3]}]}]}
json.dump({"net":net,"ov":ov},sys.stdout)
EOF
python -c 'import json,sys; d=json.load(open(sys.argv[1])); json.dump(d["net"],open(sys.argv[2],"w")); json.dump(d["ov"],open(sys.argv[3],"w"))' "$SP/dbtask-args.json" "$SP/dbtask-net.json" "$SP/dbtask-ov.json"
ARN=$(aws ecs run-task --cluster dbs-dev --task-definition dbs-db-roles --launch-type FARGATE --count 1 \
  --network-configuration "file://$SP/dbtask-net.json" --overrides "file://$SP/dbtask-ov.json" --query 'tasks[0].taskArn' --output text)
TID="${ARN##*/}"
echo "[task $TID]"
for i in $(seq 1 60); do
  S=$(aws ecs describe-tasks --cluster dbs-dev --tasks "$TID" --query 'tasks[0].lastStatus' --output text)
  [ "$S" = "STOPPED" ] && break
  sleep 5
done
aws ecs describe-tasks --cluster dbs-dev --tasks "$TID" --query 'tasks[0].containers[0].[exitCode,reason]' --output text
sleep 3
aws logs get-log-events --log-group-name /dbs/dev/api --log-stream-name "db-roles/db-roles/$TID" --start-from-head --query 'events[].message' --output text
