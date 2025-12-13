import { query } from './config/database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  try {
    console.log('Running migration: alter_ib_client_linking_user_id_to_text.sql');
    
    const migrationPath = path.join(__dirname, 'migrations', 'alter_ib_client_linking_user_id_to_text.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    // Execute the entire SQL file as one block (DO blocks need to be executed together)
    try {
      await query(sql);
      console.log('✓ Migration SQL executed');
    } catch (err) {
      // Some statements might fail if already applied, that's okay
      if (err.message.includes('already') || err.message.includes('does not exist') || err.message.includes('already TEXT')) {
        console.log('⚠ Migration may have already been applied:', err.message);
      } else {
        throw err;
      }
    }
    
    console.log('\n✅ Migration completed successfully!');
    console.log('\nVerifying migration...');
    
    // Verify the migration
    const checkResult = await query(`
      SELECT data_type 
      FROM information_schema.columns 
      WHERE table_name = 'ib_client_linking' AND column_name = 'user_id'
    `);
    
    if (checkResult.rows.length > 0) {
      const dataType = checkResult.rows[0].data_type;
      console.log(`Current user_id type: ${dataType}`);
      if (dataType === 'text') {
        console.log('✅ Migration verified: user_id is now TEXT');
      } else {
        console.log('⚠ Warning: user_id is still', dataType, '- migration may not have applied');
      }
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigration();

