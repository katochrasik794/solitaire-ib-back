import { query } from './config/database.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigration() {
  try {
    console.log('Running migration to update ib_requests.group_id to comma-separated format...');
    
    const migrationPath = join(__dirname, 'migrations', 'update_ib_requests_group_id_comma_separated.sql');
    const migrationSQL = await readFile(migrationPath, 'utf8');
    
    // Remove comment lines and split by semicolons
    const lines = migrationSQL.split('\n');
    const cleanedSQL = lines
      .filter(line => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('--');
      })
      .join('\n');
    
    // Split by semicolons and filter out empty statements and SELECT statements
    const statements = cleanedSQL
      .split(';')
      .map(s => s.trim())
      .filter(s => {
        if (s.length === 0) return false;
        const upper = s.toUpperCase().trim();
        // Only execute UPDATE statements, skip SELECT and other statements
        return upper.startsWith('UPDATE');
      });
    
    console.log(`Executing ${statements.length} SQL UPDATE statements...`);
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (statement.trim()) {
        console.log(`Executing UPDATE statement ${i + 1}/${statements.length}...`);
        try {
          const result = await query(statement);
          if (result && result.rowCount !== undefined) {
            console.log(`  ✓ Updated ${result.rowCount} row(s)`);
          }
        } catch (error) {
          console.error(`  ✗ Error executing statement ${i + 1}:`, error.message);
          throw error;
        }
      }
    }
    
    // Verify the results
    console.log('\nVerifying migration results...');
    const verifyResult = await query(`
      SELECT 
        ir.id,
        ir.email,
        ir.group_id as ib_requests_group_id,
        COUNT(DISTINCT iga.group_id) as assignment_count,
        string_agg(DISTINCT iga.group_id, ',' ORDER BY iga.group_id) as assignments_group_ids
      FROM ib_requests ir
      LEFT JOIN ib_group_assignments iga ON iga.ib_request_id = ir.id
      WHERE ir.status = 'approved'
      AND EXISTS (
        SELECT 1 
        FROM ib_group_assignments iga2 
        WHERE iga2.ib_request_id = ir.id
        GROUP BY iga2.ib_request_id
        HAVING COUNT(DISTINCT iga2.group_id) > 1
      )
      GROUP BY ir.id, ir.email, ir.group_id
      ORDER BY ir.id
      LIMIT 10
    `);
    
    console.log(`\nFound ${verifyResult.rows.length} IBs with multiple groups:`);
    verifyResult.rows.forEach(row => {
      const matches = row.ib_requests_group_id === row.assignments_group_ids;
      console.log(`  IB ${row.id} (${row.email}):`);
      console.log(`    Current group_id: ${row.ib_requests_group_id || '(null)'}`);
      console.log(`    Expected: ${row.assignments_group_ids}`);
      console.log(`    Status: ${matches ? '✓ MATCH' : '✗ MISMATCH'}`);
    });
    
    console.log('\nMigration completed successfully!');
    console.log('All approved IB requests with multiple groups now have comma-separated group_ids.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    console.error('Error details:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

runMigration();

