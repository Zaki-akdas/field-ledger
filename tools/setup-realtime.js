/**
 * Create PostgreSQL triggers for LISTEN/NOTIFY realtime updates.
 * Run once: node tools/setup-realtime.js
 */
import pg from 'pg';
const { Client } = pg;

// Credentials come from the environment — never commit connection strings.
const DB_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('Set SUPABASE_DB_URL (or DATABASE_URL) to the PostgreSQL connection string.');
  process.exit(1);
}
const c = new Client({
  connectionString: DB_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

await c.connect();
console.log('Connected to Supabase PostgreSQL\n');

const tables = ['collections', 'bills', 'cancellations', 'short_items'];

for (const table of tables) {
  const fnName = `notify_${table}_change`;

  // Create the trigger function
  await c.query(`
    CREATE OR REPLACE FUNCTION ${fnName}() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify(
        'realtime_${table}',
        json_build_object(
          'operation', TG_OP,
          'table', TG_TABLE_NAME,
          'old', CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN row_to_json(OLD) ELSE NULL END,
          'new', CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN row_to_json(NEW) ELSE NULL END
        )::text
      );
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
  `);
  console.log(`✓ Created function ${fnName}`);

  // Drop existing trigger if any, then create
  await c.query(`DROP TRIGGER IF EXISTS trg_notify_${table} ON ${table}`);
  await c.query(`
    CREATE TRIGGER trg_notify_${table}
    AFTER INSERT OR UPDATE OR DELETE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION ${fnName}()
  `);
  console.log(`✓ Created trigger trg_notify_${table}`);
}

// Verify triggers exist
const { rows } = await c.query(`
  SELECT trigger_name, event_object_table
  FROM information_schema.triggers
  WHERE trigger_name LIKE 'trg_notify_%'
  ORDER BY event_object_table
`);
console.log('\nVerified triggers:');
for (const r of rows) {
  console.log(`  ${r.event_object_table} → ${r.trigger_name}`);
}

await c.end();
console.log('\n✅ Realtime triggers ready!');
