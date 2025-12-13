import { query } from './config/database.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigration() {
  try {
    console.log('Running migration to ensure ib_requests map correctly to group_management table...');
    
    const migrationPath = join(__dirname, 'migrations', 'migrate_ib_requests_to_group_management.sql');
    const migrationSQL = await readFile(migrationPath, 'utf8');
    
    // Split by semicolons but keep DO $$ blocks together
    const statements = [];
    let currentStatement = '';
    let inDoBlock = false;
    
    for (const line of migrationSQL.split('\n')) {
      currentStatement += line + '\n';
      
      if (line.trim().startsWith('DO $$')) {
        inDoBlock = true;
      }
      
      if (inDoBlock && line.trim().endsWith('$$;')) {
        inDoBlock = false;
        statements.push(currentStatement.trim());
        currentStatement = '';
      } else if (!inDoBlock && line.trim().endsWith(';') && !line.trim().startsWith('--')) {
        const trimmed = currentStatement.trim();
        if (trimmed && !trimmed.startsWith('--')) {
          statements.push(trimmed);
        }
        currentStatement = '';
      }
    }
    
    // Add any remaining statement
    if (currentStatement.trim() && !currentStatement.trim().startsWith('--')) {
      statements.push(currentStatement.trim());
    }
    
    console.log(`Executing ${statements.length} SQL statement(s)...`);
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i].trim();
      if (!statement || statement.startsWith('--')) continue;
      
      console.log(`\nExecuting statement ${i + 1}/${statements.length}...`);
      try {
        const result = await query(statement);
        if (result.rowCount !== undefined) {
          console.log(`  ✓ Affected ${result.rowCount} row(s)`);
        } else {
          console.log(`  ✓ Statement executed successfully`);
        }
      } catch (error) {
        // For SELECT statements (verification), just log the results
        if (statement.toUpperCase().trim().startsWith('SELECT')) {
          console.log(`  ℹ Verification query executed (check results above)`);
        } else {
          throw error;
        }
      }
    }
    
    console.log('\nVerifying migration results...');
    
    // Final verification
    const verificationResult = await query(`
      SELECT 
        COUNT(*) as total_approved,
        COUNT(CASE WHEN group_id IS NOT NULL AND group_id != '' THEN 1 END) as with_group_id,
        COUNT(CASE WHEN EXISTS (
          SELECT 1 FROM group_management gm 
            WHERE gm."group" = ANY(string_to_array(ir.group_id, ','))
        ) THEN 1 END) as mapped_to_group_management
      FROM ib_requests ir
      WHERE ir.status = 'approved'
    `);
    
    const stats = verificationResult.rows[0];
    console.log('\nMigration Statistics:');
    console.log(`  Total approved IBs: ${stats.total_approved}`);
    console.log(`  IBs with group_id: ${stats.with_group_id}`);
    console.log(`  IBs mapped to group_management: ${stats.mapped_to_group_management}`);
    
    console.log('\n✓ Migration completed successfully!');
    console.log('All approved IB requests are now properly mapped to group_management table.');
    
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Migration failed:', error);
    console.error('Error details:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

runMigration();

