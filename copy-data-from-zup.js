/**
 * Database Migration Script: Copy data from zup-ib-back to solitaire-ib-back
 * 
 * This script copies all data from the zup-ib-back database to the solitaire-ib-back database.
 * 
 * Usage:
 *   1. Set environment variables:
 *      - ZUP_DATABASE_URL: Connection string for zup-ib-back (source) database
 *      - DATABASE_URL: Connection string for solitaire-ib-back (destination) database
 * 
 *   2. Run the script:
 *      node copy-data-from-zup.js
 * 
 *   3. Or set environment variables inline:
 *      ZUP_DATABASE_URL="postgresql://..." DATABASE_URL="postgresql://..." node copy-data-from-zup.js
 * 
 * The script will:
 *   - Copy all tables in dependency order (respecting foreign keys)
 *   - Handle conflicts by updating existing rows based on primary keys
 *   - Reset sequences after copying to avoid ID conflicts
 *   - Show progress for each table
 * 
 * Note: Make sure both databases have the same schema before running this script.
 */

import pkg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file (if it exists)
// This will load from solitaire-ib-back/.env by default
dotenv.config({ path: `${__dirname}/.env` });

// Source database (zup-ib-back)
// You can set ZUP_DATABASE_URL in .env file or as environment variable
const zupDbUrl = process.env.ZUP_DATABASE_URL;
if (!zupDbUrl) {
  console.error('❌ Error: ZUP_DATABASE_URL environment variable is not set!');
  console.error('\nTo set it, you can:');
  console.error('1. Create a .env file in solitaire-ib-back/ directory with:');
  console.error('   ZUP_DATABASE_URL="postgresql://user:password@host:port/database"');
  console.error('   DATABASE_URL="postgresql://user:password@host:port/database"');
  console.error('\n2. Or set it inline when running:');
  console.error('   ZUP_DATABASE_URL="..." DATABASE_URL="..." node copy-data-from-zup.js');
  process.exit(1);
}

const sourcePool = new Pool({
  connectionString: zupDbUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

// Destination database (solitaire-ib-back)
const solitaireDbUrl = process.env.DATABASE_URL;
if (!solitaireDbUrl) {
  console.error('❌ Error: DATABASE_URL environment variable is not set!');
  console.error('\nTo set it, you can:');
  console.error('1. Create a .env file in solitaire-ib-back/ directory with:');
  console.error('   ZUP_DATABASE_URL="postgresql://user:password@host:port/zup_database"');
  console.error('   DATABASE_URL="postgresql://user:password@host:port/solitaire_database"');
  console.error('\n2. Or set it inline when running:');
  console.error('   ZUP_DATABASE_URL="..." DATABASE_URL="..." node copy-data-from-zup.js');
  process.exit(1);
}

const destPool = new Pool({
  connectionString: solitaireDbUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

// Define table copy order to respect foreign key dependencies
// Tables with no dependencies first, then dependent tables
const TABLE_ORDER = [
  'ib_admin',
  'symbols',
  'symbols_with_categories',
  'group_commission_structures',
  'group_management',
  'ib_requests',
  'ib_client_linking',
  'ib_client_linking_history',
  'ib_group_assignments',
  'ib_referrals',
  'ib_commission',
  'ib_trade_history',
  'ib_reward_claims',
  'ib_withdrawal_requests',
  'User' // Note: zup uses "User" with capital U
];

// Tables to exclude from copying (comma-separated list or array)
const EXCLUDE_TABLES = ['ib_requests', 'ib_referrals'];

// Tables to include (if specified, only these tables will be copied)
// Set to empty array [] to copy all tables except excluded ones
const INCLUDE_TABLES = [
  'ib_commission', 
  'symbols', 
  'symbols_with_categories',
  'group_management',
  'group_commission_structures'
];

/**
 * Get all tables from source database
 */
async function getAllTables(sourcePool) {
  const result = await sourcePool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map(row => row.table_name);
}

/**
 * Get column names for a table
 */
async function getTableColumns(pool, tableName) {
  const result = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = $1
    AND table_schema = 'public'
    ORDER BY ordinal_position
  `, [tableName]);
  return result.rows;
}

/**
 * Check if table exists in destination
 */
async function tableExists(pool, tableName) {
  const result = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = $1
    )
  `, [tableName]);
  return result.rows[0].exists;
}

/**
 * Reset sequence for a table (to avoid ID conflicts)
 */
async function resetSequence(destPool, tableName, columnName = 'id') {
  try {
    // Check if sequence exists
    const seqResult = await destPool.query(`
      SELECT pg_get_serial_sequence($1, $2) as seq_name
    `, [`"${tableName}"`, columnName]);
    
    if (seqResult.rows[0] && seqResult.rows[0].seq_name) {
      // Get max ID from the table
      const maxResult = await destPool.query(`
        SELECT COALESCE(MAX(${columnName}), 0) as max_id
        FROM "${tableName}"
      `);
      
      const maxId = parseInt(maxResult.rows[0].max_id) || 0;
      
      // Reset sequence to max + 1
      await destPool.query(`
        SELECT setval($1, $2, false)
      `, [seqResult.rows[0].seq_name, maxId]);
      
      console.log(`  ✅ Reset sequence for ${tableName}.${columnName} to ${maxId + 1}`);
    }
  } catch (error) {
    // Sequence might not exist, that's okay
    console.log(`  ⚠️  Could not reset sequence for ${tableName}.${columnName}: ${error.message}`);
  }
}

/**
 * Get a random ib_request_id from destination ib_requests table
 */
async function getRandomIBRequestId(destPool) {
  try {
    const result = await destPool.query(`
      SELECT id FROM ib_requests ORDER BY RANDOM() LIMIT 1
    `);
    if (result.rows.length > 0) {
      return result.rows[0].id;
    }
    return null;
  } catch (error) {
    console.error(`     ⚠️  Could not get random ib_request_id: ${error.message}`);
    return null;
  }
}

/**
 * Validate and fix ib_request_id for ib_commission rows
 */
async function fixIBRequestIds(destPool, rows, ibRequestIdColumnName) {
  try {
    // Get all existing ib_request_ids from destination
    const existingIdsResult = await destPool.query('SELECT id FROM ib_requests');
    const existingIds = existingIdsResult.rows.map(row => row.id);
    
    if (existingIds.length === 0) {
      console.log(`     ⚠️  No ib_requests found in destination. Cannot copy ib_commission data.`);
      return null;
    }
    
    // Get a random ID to use as fallback
    const randomId = existingIds[Math.floor(Math.random() * existingIds.length)];
    
    let fixedCount = 0;
    const fixedRows = rows.map(row => {
      const currentId = row[ibRequestIdColumnName];
      
      // If the ib_request_id doesn't exist in destination, replace with random one
      if (!existingIds.includes(currentId)) {
        fixedCount++;
        // Create a new row object with the fixed id
        return { ...row, [ibRequestIdColumnName]: randomId };
      }
      return row;
    });
    
    if (fixedCount > 0) {
      console.log(`     🔄 Fixed ${fixedCount} rows with non-existent ib_request_id (using random existing ID: ${randomId})`);
    }
    
    return fixedRows;
  } catch (error) {
    console.error(`     ⚠️  Error fixing ib_request_ids: ${error.message}`);
    return null;
  }
}

/**
 * Copy data from source table to destination table
 */
async function copyTable(sourcePool, destPool, tableName) {
  try {
    // Check if table exists in destination
    const destExists = await tableExists(destPool, tableName);
    if (!destExists) {
      console.log(`  ⚠️  Table ${tableName} does not exist in destination database. Skipping...`);
      return { copied: 0, skipped: 0 };
    }

    // Get columns from both tables
    const sourceColumns = await getTableColumns(sourcePool, tableName);
    const destColumns = await getTableColumns(destPool, tableName);
    
    if (sourceColumns.length === 0) {
      console.log(`  ⚠️  Table ${tableName} has no columns in source. Skipping...`);
      return { copied: 0, skipped: 0 };
    }

    // Find common columns
    const sourceColNames = sourceColumns.map(c => c.column_name);
    const destColNames = destColumns.map(c => c.column_name);
    const commonColumns = sourceColNames.filter(col => destColNames.includes(col));
    
    if (commonColumns.length === 0) {
      console.log(`  ⚠️  No common columns between source and destination for ${tableName}. Skipping...`);
      return { copied: 0, skipped: 0 };
    }

    console.log(`  📋 Copying ${tableName}...`);
    console.log(`     Common columns: ${commonColumns.join(', ')}`);

    // Get data from source
    const columnsStr = commonColumns.map(col => `"${col}"`).join(', ');
    let sourceData = await sourcePool.query(`SELECT ${columnsStr} FROM "${tableName}"`);
    
    if (sourceData.rows.length === 0) {
      console.log(`     ℹ️  No data to copy from ${tableName}`);
      return { copied: 0, skipped: 0 };
    }

    console.log(`     📊 Found ${sourceData.rows.length} rows in source`);

    // Special handling for ib_commission table: fix ib_request_id foreign keys
    if (tableName === 'ib_commission' && commonColumns.includes('ib_request_id')) {
      const fixedRows = await fixIBRequestIds(destPool, sourceData.rows, 'ib_request_id');
      if (fixedRows) {
        sourceData.rows = fixedRows;
      } else {
        console.log(`     ⚠️  Could not fix ib_request_ids. Skipping ib_commission copy.`);
        return { copied: 0, skipped: 0 };
      }
    }

    // Prepare insert statement with ON CONFLICT handling
    // Try to find primary key or unique constraint
    let conflictClause = '';
    let useUpdate = false;
    try {
      const pkResult = await destPool.query(`
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass
        AND i.indisprimary
      `, [tableName]);
      
      if (pkResult.rows.length > 0) {
        const pkColumns = pkResult.rows.map(r => r.attname);
        const commonPkColumns = pkColumns.filter(col => commonColumns.includes(col));
        if (commonPkColumns.length > 0) {
          const pkStr = commonPkColumns.map(col => `"${col}"`).join(', ');
          const updateColumns = commonColumns
            .filter(col => !commonPkColumns.includes(col))
            .map(col => `"${col}" = EXCLUDED."${col}"`);
          
          if (updateColumns.length > 0) {
            conflictClause = ` ON CONFLICT (${pkStr}) DO UPDATE SET ${updateColumns.join(', ')}`;
            useUpdate = true;
          } else {
            conflictClause = ` ON CONFLICT (${pkStr}) DO NOTHING`;
          }
        }
      }
    } catch (error) {
      // If we can't determine primary key, use DO NOTHING
      console.log(`     ⚠️  Could not determine primary key, using DO NOTHING for conflicts`);
      conflictClause = ' ON CONFLICT DO NOTHING';
    }

    // Insert data in batches using bulk insert
    let copied = 0;
    let skipped = 0;
    const batchSize = 500; // Increased batch size for better performance

    for (let i = 0; i < sourceData.rows.length; i += batchSize) {
      const batch = sourceData.rows.slice(i, i + batchSize);
      
      // Build bulk insert query
      const valuePlaceholders = [];
      const allValues = [];
      
      batch.forEach((row, rowIndex) => {
        const rowPlaceholders = commonColumns.map((_, colIndex) => {
          const paramIndex = rowIndex * commonColumns.length + colIndex + 1;
          return `$${paramIndex}`;
        });
        valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
        
        commonColumns.forEach(col => {
          allValues.push(row[col]);
        });
      });

      const bulkInsertQuery = `
        INSERT INTO "${tableName}" (${columnsStr})
        VALUES ${valuePlaceholders.join(', ')}
        ${conflictClause || 'ON CONFLICT DO NOTHING'}
      `;

      try {
        const result = await destPool.query(bulkInsertQuery, allValues);
        copied += result.rowCount || 0;
        skipped += batch.length - (result.rowCount || 0);
      } catch (error) {
        // If bulk insert fails, fall back to individual inserts
        console.log(`     ⚠️  Bulk insert failed, falling back to individual inserts: ${error.message}`);
        
        for (const row of batch) {
          const values = commonColumns.map((_, index) => `$${index + 1}`);
          const rowValues = commonColumns.map(col => row[col]);
          
          const insertQuery = `
            INSERT INTO "${tableName}" (${columnsStr})
            VALUES (${values.join(', ')})
            ${conflictClause || 'ON CONFLICT DO NOTHING'}
          `;

          try {
            const result = await destPool.query(insertQuery, rowValues);
            if (result.rowCount > 0) {
              copied++;
            } else {
              skipped++;
            }
          } catch (rowError) {
            console.error(`     ❌ Error inserting row:`, rowError.message);
            skipped++;
          }
        }
      }
      
      if ((i + batchSize) % 1000 === 0 || (i + batchSize) >= sourceData.rows.length) {
        process.stdout.write(`     Progress: ${Math.min(i + batchSize, sourceData.rows.length)}/${sourceData.rows.length} rows processed\r`);
      }
    }

    console.log(`     ✅ Copied ${copied} rows, skipped ${skipped} rows from ${tableName}`);

    // Reset sequence after copying
    await resetSequence(destPool, tableName);

    return { copied, skipped };
  } catch (error) {
    console.error(`  ❌ Error copying table ${tableName}:`, error.message);
    throw error;
  }
}

/**
 * Main function to copy all data
 */
async function copyAllData() {
  console.log('🔄 Starting data migration from zup-ib-back to solitaire-ib-back...\n');

  try {
    // Test connections
    console.log('🔌 Testing database connections...');
    await sourcePool.query('SELECT NOW()');
    console.log('✅ Source database (zup-ib-back) connected');
    
    await destPool.query('SELECT NOW()');
    console.log('✅ Destination database (solitaire-ib-back) connected\n');

    // Get all tables from source
    console.log('📋 Getting tables from source database...');
    const allTables = await getAllTables(sourcePool);
    console.log(`Found ${allTables.length} tables in source database\n`);

    // Filter tables based on INCLUDE_TABLES and EXCLUDE_TABLES
    let tablesToCopy = [...allTables];
    
    // If INCLUDE_TABLES is specified and not empty, only include those tables
    if (INCLUDE_TABLES && INCLUDE_TABLES.length > 0) {
      tablesToCopy = allTables.filter(table => INCLUDE_TABLES.includes(table));
      console.log(`📌 Only copying specified tables: ${INCLUDE_TABLES.join(', ')}`);
    }
    
    // Exclude tables from EXCLUDE_TABLES list
    tablesToCopy = tablesToCopy.filter(table => !EXCLUDE_TABLES.includes(table));
    
    if (EXCLUDE_TABLES.length > 0) {
      console.log(`🚫 Excluding tables: ${EXCLUDE_TABLES.join(', ')}`);
    }

    // Use defined order for tables that are in TABLE_ORDER
    const orderedTables = [];
    const remainingTables = [...tablesToCopy];

    for (const table of TABLE_ORDER) {
      if (tablesToCopy.includes(table)) {
        orderedTables.push(table);
        remainingTables.splice(remainingTables.indexOf(table), 1);
      }
    }

    // Add remaining tables that aren't in TABLE_ORDER
    orderedTables.push(...remainingTables);

    console.log('📊 Tables to copy (in order):');
    orderedTables.forEach((table, index) => {
      console.log(`   ${index + 1}. ${table}`);
    });
    console.log('');

    // Copy each table
    let totalCopied = 0;
    let totalSkipped = 0;

    for (const table of orderedTables) {
      console.log(`\n🔄 Processing table: ${table}`);
      try {
        const result = await copyTable(sourcePool, destPool, table);
        totalCopied += result.copied;
        totalSkipped += result.skipped;
      } catch (error) {
        console.error(`❌ Failed to copy table ${table}:`, error.message);
        // Continue with other tables
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Migration completed!');
    console.log(`📊 Total rows copied: ${totalCopied}`);
    console.log(`⏭️  Total rows skipped: ${totalSkipped}`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  } finally {
    await sourcePool.end();
    await destPool.end();
    console.log('\n🔌 Database connections closed');
  }
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
                     import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` ||
                     process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMainModule || process.argv[1] && process.argv[1].endsWith('copy-data-from-zup.js')) {
  copyAllData()
    .then(() => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}

export { copyAllData };

