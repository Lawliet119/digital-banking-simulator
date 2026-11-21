// BL-420: runs inside the one-off ECS task `dbs-db-roles` (pgss.sh overrides its command with this file's text).
// Reads the SQL statements from Q64 (base64 of a JSON array) and the connection of the MASTER credential from the
// variables the task definition injects (DB_HOST, DB_NAME, DB_USER, DB_PASSWORD, DATABASE_SSL_CA_PATH). TLS is always
// verified. Prints, per statement, `SQL> <first 120 characters>` and the rows as one JSON line; never the password.
const { Client } = require('pg');
const fs = require('fs');

(async () => {
  const queries = JSON.parse(Buffer.from(process.env.Q64, 'base64').toString());
  const client = new Client({
    host: process.env.DB_HOST,
    port: 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { ca: fs.readFileSync(process.env.DATABASE_SSL_CA_PATH, 'utf8'), rejectUnauthorized: true },
  });
  await client.connect();
  let failed = false;
  for (const query of queries) {
    console.log('SQL> ' + query.slice(0, 120).replace(/\s+/g, ' '));
    try {
      const result = await client.query(query);
      const rows = Array.isArray(result) ? result.flatMap(r => r.rows) : result.rows;
      console.log(JSON.stringify(rows));
    } catch (error) {
      failed = true;
      console.log('SQLERR> ' + error.message);
    }
  }
  await client.end();
  if (failed) process.exit(1);
})().catch(error => {
  console.log('FATAL ' + error.message);
  process.exit(1);
});
