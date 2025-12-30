import { query } from '../config/database.js';
import axios from 'axios';

export class GroupManagement {
  static generateGroupName(groupId, index = null) {
    if (!groupId) return 'Unknown Group';

    const upperGroupId = groupId.toUpperCase();

    // Generate sequential letters (A, B, C, D, etc.)
    const getSequentialLetter = (idx) => {
      if (idx === null || idx === undefined) return 'A';
      return String.fromCharCode(65 + (idx % 26)); // 65 is ASCII for 'A'
    };

    // Extract leverage information
    const leverageMatch = upperGroupId.match(/(\d+)X/);
    const leverage = leverageMatch ? leverageMatch[1] + 'x' : '100x';

    // Pattern matching for different account types
    if (upperGroupId.includes('DEMO')) {
      return `Demo${leverage}`;
    }

    if (upperGroupId.includes('REAL') || upperGroupId.includes('LIVE')) {
      return `Live${leverage}`;
    }

    // Check for specific account types
    if (upperGroupId.includes('PRO') || upperGroupId.includes('PROFESSIONAL')) {
      const letter = getSequentialLetter(index);
      return `${letter} Pro Dynamic`;
    }

    if (upperGroupId.includes('STANDARD') || upperGroupId.includes('STD')) {
      const letter = getSequentialLetter(index);
      return `${letter} Standard Dynamic`;
    }

    if (upperGroupId.includes('CENT')) {
      return `Cent${leverage}`;
    }

    if (upperGroupId.includes('VIP') || upperGroupId.includes('PREMIUM')) {
      const letter = getSequentialLetter(index);
      return `${letter} VIP Dynamic`;
    }

    if (upperGroupId.includes('ECN')) {
      const letter = getSequentialLetter(index);
      return `${letter} ECN Dynamic`;
    }

    if (upperGroupId.includes('MICRO')) {
      return `Micro${leverage}`;
    }

    if (upperGroupId.includes('MINI')) {
      return `Mini${leverage}`;
    }

    // For unknown patterns, create a sequential name
    const letter = getSequentialLetter(index);
    return `${letter} Standard Dynamic`;
  }

  static async createTable() {
    // Note: The table already exists with different column names:
    // - "group" (not group_id)
    // - dedicated_name (not name)
    // This method will only create the table if it doesn't exist
    // If it exists, it won't modify the structure
    const queryText = `
      CREATE TABLE IF NOT EXISTS group_management (
        id SERIAL PRIMARY KEY,
        "group" VARCHAR(255) UNIQUE NOT NULL,
        dedicated_name VARCHAR(255),
        account_type VARCHAR(255),
        server INTEGER,
        currency VARCHAR(255),
        auth_mode INTEGER,
        auth_password_min INTEGER,
        is_active BOOLEAN DEFAULT true,
        synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await query(queryText);
  }

  static async runMigration() {
    try {
      // Read and execute the migration SQL
      const fs = require('fs').promises;
      const path = require('path');
      const migrationPath = path.join(__dirname, '../migrations/alter_group_management.sql');
      const migrationSQL = await fs.readFile(migrationPath, 'utf8');
      
      // Execute the migration
      await query(migrationSQL);
      return { success: true, message: 'Migration completed successfully' };
    } catch (error) {
      console.error('Error running migration:', error);
      throw error;
    }
  }

  static async syncFromAPI(apiUrl = null) {
    try {
      const { getMT5ApiUrl, MT5_ENDPOINTS } = await import('../config/mt5Api.js');
      
      // Use provided URL or default to Groups endpoint
      let fullApiUrl;
      if (apiUrl) {
        // Handle relative URLs - if it starts with /, prepend the base URL
        if (apiUrl.startsWith('/')) {
          const { MT5_API_BASE } = await import('../config/mt5Api.js');
          fullApiUrl = `${MT5_API_BASE}${apiUrl}`;
        } else {
          fullApiUrl = apiUrl;
        }
      } else {
        // Use default Groups endpoint
        fullApiUrl = getMT5ApiUrl(MT5_ENDPOINTS.GROUPS);
      }

      console.log('[SYNC] Fetching groups from:', fullApiUrl);

      let response;
      try {
        response = await axios.get(fullApiUrl, {
          headers: {
            'accept': 'application/json',
            'Content-Type': 'application/json'
          },
          timeout: 30000,
          validateStatus: function (status) {
            return status < 500; // Don't throw for 4xx errors, but do for 5xx
          }
        });
      } catch (axiosError) {
        console.error('[SYNC] Axios error details:', {
          message: axiosError.message,
          code: axiosError.code,
          response: axiosError.response?.data,
          status: axiosError.response?.status
        });
        
        if (axiosError.code === 'ECONNREFUSED') {
          throw new Error(`Cannot connect to API at ${fullApiUrl}. Server may be down.`);
        }
        if (axiosError.code === 'ETIMEDOUT') {
          throw new Error(`API request timed out after 30 seconds`);
        }
        if (axiosError.response) {
          throw new Error(`API returned status ${axiosError.response.status}: ${axiosError.response.statusText}`);
        }
        throw new Error(`Failed to fetch from API: ${axiosError.message}`);
      }

      if (response.status >= 400) {
        throw new Error(`API returned status ${response.status}: ${response.statusText}`);
      }

      const data = response.data;

      if (!data) {
        throw new Error('No data received from API');
      }

      if (!Array.isArray(data)) {
        console.error('[SYNC] Unexpected data format:', typeof data, data);
        // Log first item structure to understand the format
        if (typeof data === 'object' && data !== null) {
          console.error('[SYNC] Data structure:', JSON.stringify(data, null, 2).substring(0, 500));
        }
        throw new Error(`Expected array but got ${typeof data}`);
      }

      console.log(`[SYNC] Received ${data.length} groups from API`);
      
      // Log first group structure to understand the API response format
      if (data.length > 0) {
        console.log('[SYNC] Sample group structure:', JSON.stringify(data[0], null, 2));
      }

      // Use UPSERT to update existing or insert new groups
      if (Array.isArray(data) && data.length > 0) {
        let successCount = 0;
        let errorCount = 0;
        
        for (let i = 0; i < data.length; i++) {
          const group = data[i];
          
          // Validate group data
          if (!group) {
            console.warn(`[SYNC] Skipping null/undefined group at index ${i}`);
            errorCount++;
            continue;
          }
          
          // Try multiple possible field names from API
          const groupId = group.Group || group.group_id || group.name || group.Name || group.group || null;
          
          if (!groupId) {
            console.warn(`[SYNC] Skipping group at index ${i} - no group ID found. Group data:`, JSON.stringify(group, null, 2));
            errorCount++;
            continue;
          }
          
          const generatedName = group.Name || group.name || GroupManagement.generateGroupName(groupId, i);
          const description = group.Description || group.description || `Auto-generated group: ${groupId}`;
          
          console.log(`[SYNC] Processing group ${i + 1}/${data.length}: ${groupId}`);

          // Parse all the fields from API response
          const server = group.Server ?? group.server ?? 1;
          const company = group.Company || group.company || 'OXO Markets Limited';
          const currency = group.Currency ?? group.currency ?? 0;
          const currencyDigits = group.CurrencyDigits ?? group.currency_digits ?? 2;
          const marginCall = group.MarginCall ?? group.margin_call ?? 100.00;
          const stopOut = group.StopOut ?? group.stop_out ?? 50.00;
          const tradeFlags = group.TradeFlags ?? group.trade_flags ?? 16;
          const authMode = group.AuthMode ?? group.auth_mode ?? 0;
          const minPasswordChars = group.MinPassword ?? group.min_password_chars ?? 8;
          const website = group.Website || group.website || null;
          const email = group.Email || group.email || null;
          const supportPage = group.SupportPage || group.support_page || null;
          const supportEmail = group.SupportEmail || group.support_email || null;
          const reportsMode = group.ReportsMode ?? group.reports_mode ?? 1;
          const marginMode = group.MarginMode ?? group.margin_mode ?? 2;
          const demoLeverage = group.DemoLeverage ?? group.demo_leverage ?? 0;
          const newsMode = group.NewsMode ?? group.news_mode ?? 2;
          const marginFreeMode = group.MarginFreeMode ?? group.margin_free_mode ?? 1;
          const demoDeposit = parseFloat(group.DemoDeposit ?? group.demo_deposit ?? 0);
          const mailMode = group.MailMode ?? group.mail_mode ?? 1;
          const marginSOMode = group.MarginSOMode ?? group.margin_so_mode ?? 0;
          const tradeTransferMode = group.TradeTransferMode ?? group.trade_transfer_mode ?? 0;

          // Parse dates - handle different formats
          let createdAt = group.Created || group.created || group.CreatedAt || group.created_at;
          if (createdAt) {
            createdAt = new Date(createdAt).toISOString();
          }

          // Group path is the same as group_id (full path like OXO_A\Classic)
          const groupPath = groupId;

          // Try to insert with all columns first, fallback to minimal if columns don't exist
          try {
            // First, try with all columns - but wrap in transaction-like safety
            const insertQuery = `
              INSERT INTO group_management (
                "group", dedicated_name, account_type, server, currency,
                auth_mode, auth_password_min, synced_at, created_at, updated_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, COALESCE($8::timestamp, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
              )
              ON CONFLICT ("group") 
              DO UPDATE SET
                dedicated_name = EXCLUDED.dedicated_name,
                account_type = EXCLUDED.account_type,
                synced_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            `;
            
            const insertParams = [
              groupId, generatedName, description, server, currency,
              authMode, minPasswordChars, createdAt
            ];
            
            await query(insertQuery, insertParams);
            successCount++;
          } catch (dbError) {
            // If the query fails due to missing columns, use a minimal INSERT
            console.warn(`[SYNC] Failed to insert with all columns for group ${groupId}, using minimal insert.`);
            console.warn(`[SYNC] Database error:`, dbError.message);
            console.warn(`[SYNC] Error code:`, dbError.code);
            
            try {
              // Use minimal INSERT with only required columns that definitely exist
              await query(
                `INSERT INTO group_management ("group", dedicated_name, synced_at, updated_at)
                 VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT ("group") 
                 DO UPDATE SET
                   dedicated_name = EXCLUDED.dedicated_name,
                   synced_at = CURRENT_TIMESTAMP,
                   updated_at = CURRENT_TIMESTAMP
                `,
                [groupId, generatedName]
              );
              successCount++;
              console.log(`[SYNC] Successfully inserted ${groupId} with minimal columns`);
            } catch (minimalError) {
              console.error(`[SYNC] Failed to insert group ${groupId} even with minimal columns:`);
              console.error(`[SYNC] Minimal error message:`, minimalError.message);
              console.error(`[SYNC] Minimal error code:`, minimalError.code);
              console.error(`[SYNC] Minimal error detail:`, minimalError.detail);
              errorCount++;
            }
          }
        }
        
        console.log(`[SYNC] Completed: ${successCount} successful, ${errorCount} failed`);
      }

      const syncedCount = data.length || 0;
      return { 
        success: true, 
        message: syncedCount > 0 
          ? `Synced ${syncedCount} groups successfully` 
          : 'No groups to sync' 
      };
    } catch (error) {
      console.error('[SYNC] Error syncing groups from API:', {
        message: error.message,
        stack: error.stack,
        response: error.response?.data,
        status: error.response?.status
      });
      throw error;
    }
  }

  static async getAll(page = 1, limit = 10) {
    try {
      const offset = (page - 1) * limit;
      // Use COALESCE to handle missing name column gracefully
      const result = await query(
        `SELECT * FROM group_management ORDER BY COALESCE(dedicated_name, "group") ASC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const countResult = await query('SELECT COUNT(*) FROM group_management');
      const totalCount = parseInt(countResult.rows[0].count) || 0;

      return {
        groups: result.rows || [],
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit)
        }
      };
    } catch (error) {
      console.error('[getAll] Error:', error);
      throw error;
    }
  }

  static async getAllWithoutPagination() {
    try {
      const result = await query(`SELECT * FROM group_management ORDER BY COALESCE(dedicated_name, "group") ASC`);
      return result.rows || [];
    } catch (error) {
      console.error('[getAllWithoutPagination] Error:', error);
      return [];
    }
  }

  static async findById(groupId) {
    try {
      const result = await query('SELECT * FROM group_management WHERE "group" = $1', [groupId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('[findById] Error:', error);
      throw error;
    }
  }

  static async findByIdDbId(dbId) {
    try {
      const result = await query('SELECT * FROM group_management WHERE id = $1', [dbId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('[findByIdDbId] Error:', error);
      throw error;
    }
  }

  static async getStats() {
    try {
      const totalResult = await query('SELECT COUNT(*) as count FROM group_management');
      const total = parseInt(totalResult.rows[0].count) || 0;

      // Count groups by server - use safe queries that won't fail
      let serverA = 0;
      let serverB = 0;
      let active = 0;

      try {
        const serverAResult = await query(`SELECT COUNT(*) as count FROM group_management WHERE "group" LIKE 'OXO_A%' OR dedicated_name LIKE 'OXO_A%'`);
        serverA = parseInt(serverAResult.rows[0].count) || 0;
      } catch (error) {
        console.warn('[getStats] Error counting OXO_A groups:', error.message);
      }

      try {
        const serverBResult = await query(`SELECT COUNT(*) as count FROM group_management WHERE "group" LIKE 'OXO_B%' OR dedicated_name LIKE 'OXO_B%'`);
        serverB = parseInt(serverBResult.rows[0].count) || 0;
      } catch (error) {
        console.warn('[getStats] Error counting OXO_B groups:', error.message);
      }

      // Get active groups - check if synced_at column exists first
      try {
        const checkColumn = await query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'group_management' AND column_name = 'synced_at'
        `);
        const hasSyncedAt = checkColumn.rows.length > 0;
        
        if (hasSyncedAt) {
          const activeResult = await query(`SELECT COUNT(*) as count FROM group_management WHERE synced_at > NOW() - INTERVAL '7 days'`);
          active = parseInt(activeResult.rows[0].count) || 0;
        } else {
          // If synced_at doesn't exist, use updated_at or created_at
          const activeResult = await query(`SELECT COUNT(*) as count FROM group_management WHERE updated_at > NOW() - INTERVAL '7 days' OR created_at > NOW() - INTERVAL '7 days'`);
          active = parseInt(activeResult.rows[0].count) || 0;
        }
      } catch (error) {
        console.warn('[getStats] Error counting active groups:', error.message);
        active = total; // Fallback to total if we can't determine active
      }

      return {
        total_groups: total,
        oxo_a_groups: serverA,
        oxo_b_groups: serverB,
        active_groups: active
      };
    } catch (error) {
      console.error('[getStats] Error:', error);
      // Return safe defaults
      return {
        total_groups: 0,
        oxo_a_groups: 0,
        oxo_b_groups: 0,
        active_groups: 0
      };
    }
  }

  static async searchGroups(searchTerm, page = 1, limit = 50) {
    try {
      const offset = (page - 1) * limit;
      let queryText = `SELECT * FROM group_management WHERE 1=1`;
      const params = [];
      let paramIndex = 1;

      if (searchTerm) {
        // Check if group_path column exists, if not, don't include it in search
        const checkColumn = await query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'group_management' AND column_name = 'group_path'
        `);
        const hasGroupPath = checkColumn.rows.length > 0;
        
        if (hasGroupPath) {
          queryText += ` AND (dedicated_name ILIKE $${paramIndex} OR "group" ILIKE $${paramIndex} OR account_type ILIKE $${paramIndex})`;
        } else {
          queryText += ` AND (dedicated_name ILIKE $${paramIndex} OR "group" ILIKE $${paramIndex})`;
        }
        params.push(`%${searchTerm}%`);
        paramIndex++;
      }

      // Use COALESCE for created_at to handle if it doesn't exist, fallback to id
      queryText += ` ORDER BY COALESCE(created_at, updated_at, synced_at) DESC NULLS LAST LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await query(queryText, params);
      
      // Build count query safely
      let countQuery = `SELECT COUNT(*) FROM group_management`;
      let countParams = [];
      
      if (searchTerm) {
        const checkColumn = await query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'group_management' AND column_name = 'group_path'
        `);
        const hasGroupPath = checkColumn.rows.length > 0;
        
        if (hasGroupPath) {
          countQuery = `SELECT COUNT(*) FROM group_management WHERE (dedicated_name ILIKE $1 OR "group" ILIKE $1 OR account_type ILIKE $1)`;
        } else {
          countQuery = `SELECT COUNT(*) FROM group_management WHERE (dedicated_name ILIKE $1 OR "group" ILIKE $1)`;
        }
        countParams = [`%${searchTerm}%`];
      }
      
      const countResult = await query(countQuery, countParams);
      const totalCount = parseInt(countResult.rows[0].count);

      return {
        groups: result.rows,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit)
        }
      };
    } catch (error) {
      console.error('[searchGroups] Error:', error);
      throw error;
    }
  }

  static async regenerateAllNames() {
    try {
      const groups = await GroupManagement.getAllWithoutPagination();

      // Update each group with sequential naming
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const newName = GroupManagement.generateGroupName(group.group_id, i);
        await query(
          'UPDATE group_management SET dedicated_name = $1, updated_at = CURRENT_TIMESTAMP WHERE "group" = $2',
          [newName, group.group_id]
        );
      }

      return { success: true, message: `Regenerated names for ${groups.length} groups` };
    } catch (error) {
      console.error('Error regenerating group names:', error);
      throw error;
    }
  }

  static async updateGroupName(groupId, customName) {
    try {
      console.log('GroupManagement.updateGroupName called:', { groupId, customName });

      if (!customName || !customName.trim()) {
        throw new Error('Group name cannot be empty');
      }

      if (!groupId) {
        throw new Error('Group ID is required');
      }

      const trimmedName = customName.trim();
      console.log('Updating group in database:', { groupId, trimmedName });

      // First check if the group exists
      const existingGroup = await GroupManagement.findById(groupId);
      if (!existingGroup) {
        throw new Error('Group not found in database');
      }

      const result = await query(
        'UPDATE group_management SET dedicated_name = $1, updated_at = CURRENT_TIMESTAMP WHERE "group" = $2',
        [trimmedName, groupId]
      );

      console.log('Database update result:', result);

      if (result.rowCount === 0) {
        throw new Error('Failed to update group name');
      }

      return { success: true, message: 'Group name updated successfully' };
    } catch (error) {
      console.error('Error updating group name:', error);
      throw error;
    }
  }
}

