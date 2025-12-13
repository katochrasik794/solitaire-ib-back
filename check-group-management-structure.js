import { query } from './config/database.js';

async function checkTableStructure() {
  try {
    console.log('Checking group_management table structure...');
    
    // Check if table exists
    const tableExists = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'group_management'
      )
    `);
    
    if (!tableExists.rows[0].exists) {
      console.log('Table group_management does not exist');
      process.exit(0);
    }
    
    // Get all columns
    const columns = await query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'group_management' 
      ORDER BY ordinal_position
    `);
    
    console.log('\nColumns in group_management table:');
    console.log(JSON.stringify(columns.rows, null, 2));
    
    // Get a sample row
    const sample = await query('SELECT * FROM group_management LIMIT 1');
    if (sample.rows.length > 0) {
      console.log('\nSample row:');
      console.log(JSON.stringify(sample.rows[0], null, 2));
    } else {
      console.log('\nTable is empty');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkTableStructure();


