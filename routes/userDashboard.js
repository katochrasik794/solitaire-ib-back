import express from 'express';
import { authenticateToken } from './auth.js';
import { query } from '../config/database.js';
import { IBWithdrawal } from '../models/IBWithdrawal.js';
import { IBCommission } from '../models/IBCommission.js';
import { SymbolsWithCategories } from '../models/SymbolsWithCategories.js';
import { GroupManagement } from '../models/GroupManagement.js';

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    
    // Get IB request by email
    const ibResult = await query(
      `SELECT id, full_name, email, referral_code, ib_type, approved_at 
       FROM ib_requests 
       WHERE LOWER(email) = LOWER($1) AND status = 'approved'`,
      [userEmail]
    );
    
    if (ibResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          balance: 0,
          totalProfit: 0,
          totalEarning: 0,
          totalEarnings: 0,
          fixedCommission: 0,
          spreadCommission: 0,
          commissionStructures: [],
          referralCode: null,
          referralLink: null
        }
      });
    }
    
    const ib = ibResult.rows[0];
    
    // Get commission structures (groups) - same as commission-analytics
    const groupsResult = await query(
      `SELECT group_id, group_name, structure_name, usd_per_lot, spread_share_percentage
       FROM ib_group_assignments
       WHERE ib_request_id = $1`,
      [ib.id]
    );
    
    // Helper: Get IB's own user_id to exclude
    const getIBUserId = async (ibId) => {
      try {
        const ibRes = await query('SELECT email FROM ib_requests WHERE id = $1', [ibId]);
        if (ibRes.rows.length === 0) return null;
        const userRes = await query('SELECT id FROM "User" WHERE email = $1', [ibRes.rows[0].email]);
        return userRes.rows.length > 0 ? String(userRes.rows[0].id) : null;
      } catch {
        return null;
      }
    };

    // Helper: Get list of referred user_ids (from ib_referrals and ib_requests)
    const getReferredUserIds = async (ibId) => {
      const userIds = new Set();
      try {
        // Get user_ids from ib_referrals
        const refRes = await query(
          'SELECT user_id FROM ib_referrals WHERE ib_request_id = $1 AND user_id IS NOT NULL',
          [ibId]
        );
        refRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });

        // Get user_ids from ib_requests where referred_by = ibId
        const ibRefRes = await query(
          `SELECT u.id as user_id 
           FROM ib_requests ir
           JOIN "User" u ON u.email = ir.email
           WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
          [ibId]
        );
        ibRefRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });
      } catch (error) {
        console.error('Error getting referred user IDs:', error);
      }
      return Array.from(userIds);
    };

    // Get IB's user_id for ib_commission table
    const ibUserResult = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [ib.email]);
    const ibUserId = ibUserResult.rows[0]?.id ? String(ibUserResult.rows[0].id) : null;

    // Always calculate commission from trade history to ensure fresh data
    // Then update the database with the calculated values
    let balance = 0;
    let fixedCommission = 0;
    let spreadCommission = 0;
    
    // Get IB's own user_id to exclude
    const ibUserIdForExclusion = await getIBUserId(ib.id);
    // Get referred user_ids to include
    const referredUserIds = await getReferredUserIds(ib.id);

    // Always calculate from trades (don't use cache) to ensure accuracy
    if (referredUserIds.length > 0) {
        // Build WHERE clause to exclude IB's own trades and only include referred users' trades
        let userFilter = '';
        const params = [ib.id];
        if (ibUserIdForExclusion) {
          params.push(ibUserIdForExclusion);
          userFilter = `AND user_id != $${params.length}`;
        }
        params.push(referredUserIds);
        const userInClause = `AND user_id = ANY($${params.length}::text[])`;

        // Get approved groups map for spread calculation
        const normalize = (gid) => {
          if (!gid) return '';
          const s = String(gid).toLowerCase().trim();
          const parts = s.split(/[\\/]/);
          return parts[parts.length - 1] || s;
        };
        const approvedMap = new Map();
        for (const row of groupsResult.rows) {
          const keys = [
            String(row.group_id || '').toLowerCase(),
            String(row.group_name || '').toLowerCase(),
            normalize(row.group_id)
          ].filter(k => k);
          for (const k of keys) {
            approvedMap.set(k, {
              spreadSharePercentage: Number(row.spread_share_percentage || 0),
              usdPerLot: Number(row.usd_per_lot || 0)
            });
          }
        }

        // Fetch trades from referred users only
        const tradesRes = await query(
          `SELECT 
             group_id,
             COALESCE(SUM(volume_lots), 0) AS total_volume_lots,
             COALESCE(SUM(ib_commission), 0) AS total_ib_commission
           FROM ib_trade_history
           WHERE ib_request_id = $1 
             AND close_price IS NOT NULL 
             AND close_price != 0 
             AND profit != 0
             ${userFilter}
             ${userInClause}
           GROUP BY group_id`,
          params
        );

        // Calculate fixed and spread commission
        for (const row of tradesRes.rows) {
          const groupId = row.group_id || '';
          const normGroup = normalize(groupId);
          const assignment = approvedMap.get(normGroup) || approvedMap.get(String(groupId).toLowerCase()) || { spreadSharePercentage: 0, usdPerLot: 0 };
          
          const lots = Number(row.total_volume_lots || 0);
          const fixed = Number(row.total_ib_commission || 0);
          const spread = lots * (assignment.spreadSharePercentage / 100);
          
          fixedCommission += fixed;
          spreadCommission += spread;
        }
      }

    balance = fixedCommission + spreadCommission;

    // Always save/update commission in ib_commission table with fresh calculated values
    if (ibUserId) {
      try {
        // Calculate total trades and lots for complete data
        let totalTrades = 0;
        let totalLots = 0;
        if (referredUserIds.length > 0) {
          let userFilter = '';
          const params = [ib.id];
          if (ibUserIdForExclusion) {
            params.push(ibUserIdForExclusion);
            userFilter = `AND user_id != $${params.length}`;
          }
          params.push(referredUserIds);
          const userInClause = `AND user_id = ANY($${params.length}::text[])`;
          
          const statsRes = await query(
            `SELECT COUNT(*)::int AS total_trades, COALESCE(SUM(volume_lots), 0) AS total_lots
             FROM ib_trade_history
             WHERE ib_request_id = $1 
               AND close_price IS NOT NULL 
               AND close_price != 0 
               AND profit != 0
               ${userFilter}
               ${userInClause}`,
            params
          );
          
          if (statsRes.rows.length > 0) {
            totalTrades = Number(statsRes.rows[0].total_trades || 0);
            totalLots = Number(statsRes.rows[0].total_lots || 0);
          }
        }
        
        await IBCommission.upsertCommission(ib.id, ibUserId, {
          totalCommission: balance,
          fixedCommission: fixedCommission || 0,
          spreadCommission: spreadCommission || 0,
          totalTrades: totalTrades || 0,
          totalLots: totalLots || 0
        });
        console.log(`[Dashboard] Updated ib_commission table: total=${balance}, fixed=${fixedCommission}, spread=${spreadCommission}`);
      } catch (error) {
        console.error('Error saving commission to ib_commission table:', error);
        // Don't fail the request if table doesn't exist yet
      }
    }
    
    // Get withdrawal summary to calculate available balance and total earned
    // Use IBWithdrawal.getSummary for consistent calculation across all pages
    let availableBalance = balance;
    let totalEarned = balance;
    let totalPaid = 0;
    try {
      const withdrawalSummary = await IBWithdrawal.getSummary(ib.id);
      // Use totalEarned from withdrawal summary (which uses ib_commission table or calculates from trades)
      totalEarned = Number(withdrawalSummary.totalEarned || balance);
      totalPaid = Number(withdrawalSummary.totalPaid || 0);
      // Available balance = total earned - total paid
      availableBalance = Number(withdrawalSummary.available || Math.max(totalEarned - totalPaid, 0));
      console.log(`[Dashboard] Withdrawal summary: totalEarned=${totalEarned}, totalPaid=${totalPaid}, available=${availableBalance}`);
    } catch (error) {
      console.warn('[Dashboard] Could not fetch withdrawal summary:', error.message);
      // Use calculated balance as fallback
      totalEarned = balance;
      availableBalance = balance;
      totalPaid = 0;
    }
    
    // Get referral link
    const referralLink = ib.referral_code 
      ? `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?referralCode=${ib.referral_code}`
      : null;
    
    // Format commission structures
    const structures = groupsResult.rows.map(g => ({
      groupId: g.group_id,
      groupName: g.group_name,
      name: g.structure_name,
      usdPerLot: Number(g.usd_per_lot || 0),
      spreadShare: Number(g.spread_share_percentage || 0)
    }));
    
    res.json({
      success: true,
      data: {
        balance: availableBalance, // Available balance (withdrawable)
        totalProfit: totalEarned, // Total earned (all time)
        totalEarning: totalEarned, // Add totalEarning field for clarity
        totalEarnings: totalEarned, // Alternative field name
        availableBalance, // Explicit available balance
        totalEarned, // Explicit total earned
        totalPaid, // Total paid withdrawals (for consistency)
        fixedCommission,
        spreadCommission,
        ibType: ib.ib_type,
        commissionStructures: structures,
        referralCode: ib.referral_code,
        referralLink,
        approvedDate: ib.approved_at
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch dashboard data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/user/dashboard/sync - Force sync commission data
router.post('/sync', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    
    // Get IB request by email
    const ibResult = await query(
      `SELECT id, full_name, email, referral_code, ib_type, approved_at 
       FROM ib_requests 
       WHERE LOWER(email) = LOWER($1) AND status = 'approved'`,
      [userEmail]
    );
    
    if (ibResult.rows.length === 0) {
      return res.json({
        success: false,
        message: 'IB profile not found'
      });
    }
    
    const ib = ibResult.rows[0];
    
    // Helper: Get IB's own user_id to exclude
    const getIBUserId = async (ibId) => {
      try {
        const ibRes = await query('SELECT email FROM ib_requests WHERE id = $1', [ibId]);
        if (ibRes.rows.length === 0) return null;
        const userRes = await query('SELECT id FROM "User" WHERE email = $1', [ibRes.rows[0].email]);
        return userRes.rows.length > 0 ? String(userRes.rows[0].id) : null;
      } catch {
        return null;
      }
    };

    // Helper: Get list of referred user_ids (from ib_referrals and ib_requests)
    const getReferredUserIds = async (ibId) => {
      const userIds = new Set();
      try {
        // Get user_ids from ib_referrals
        const refRes = await query(
          'SELECT user_id FROM ib_referrals WHERE ib_request_id = $1 AND user_id IS NOT NULL',
          [ibId]
        );
        refRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });

        // Get user_ids from ib_requests where referred_by = ibId
        const ibRefRes = await query(
          `SELECT u.id as user_id 
           FROM ib_requests ir
           JOIN "User" u ON u.email = ir.email
           WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
          [ibId]
        );
        ibRefRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });
      } catch (error) {
        console.error('Error getting referred user IDs:', error);
      }
      return Array.from(userIds);
    };

    // Get commission structures (groups)
    const groupsResult = await query(
      `SELECT group_id, group_name, structure_name, usd_per_lot, spread_share_percentage
       FROM ib_group_assignments
       WHERE ib_request_id = $1`,
      [ib.id]
    );

    // Get IB's user_id for ib_commission table
    const ibUserResult = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [ib.email]);
    const ibUserId = ibUserResult.rows[0]?.id ? String(ibUserResult.rows[0].id) : null;

    // Get IB's own user_id to exclude
    const ibUserIdForExclusion = await getIBUserId(ib.id);
    // Get referred user_ids to include
    const referredUserIds = await getReferredUserIds(ib.id);

    // Calculate commission from referred users' trades only (excluding IB's own trades)
    let balance = 0;
    let fixedCommission = 0;
    let spreadCommission = 0;

    if (referredUserIds.length > 0) {
      // Build WHERE clause to exclude IB's own trades and only include referred users' trades
      let userFilter = '';
      const params = [ib.id];
      if (ibUserIdForExclusion) {
        params.push(ibUserIdForExclusion);
        userFilter = `AND user_id != $${params.length}`;
      }
      params.push(referredUserIds);
      const userInClause = `AND user_id = ANY($${params.length}::text[])`;

      // Get approved groups map for spread calculation
      const normalize = (gid) => {
        if (!gid) return '';
        const s = String(gid).toLowerCase().trim();
        const parts = s.split(/[\\/]/);
        return parts[parts.length - 1] || s;
      };
      const approvedMap = new Map();
      for (const row of groupsResult.rows) {
        const keys = [
          String(row.group_id || '').toLowerCase(),
          String(row.group_name || '').toLowerCase(),
          normalize(row.group_id)
        ].filter(k => k);
        for (const k of keys) {
          approvedMap.set(k, {
            spreadSharePercentage: Number(row.spread_share_percentage || 0),
            usdPerLot: Number(row.usd_per_lot || 0)
          });
        }
      }

      // Fetch trades from referred users only
      const tradesRes = await query(
        `SELECT 
           group_id,
           COALESCE(SUM(volume_lots), 0) AS total_volume_lots,
           COALESCE(SUM(ib_commission), 0) AS total_ib_commission
         FROM ib_trade_history
         WHERE ib_request_id = $1 
           AND close_price IS NOT NULL 
           AND close_price != 0 
           AND profit != 0
           ${userFilter}
           ${userInClause}
         GROUP BY group_id`,
        params
      );

      // Calculate fixed and spread commission
      for (const row of tradesRes.rows) {
        const groupId = row.group_id || '';
        const normGroup = normalize(groupId);
        const assignment = approvedMap.get(normGroup) || approvedMap.get(String(groupId).toLowerCase()) || { spreadSharePercentage: 0, usdPerLot: 0 };
        
        const lots = Number(row.total_volume_lots || 0);
        const fixed = Number(row.total_ib_commission || 0);
        const spread = lots * (assignment.spreadSharePercentage / 100);
        
        fixedCommission += fixed;
        spreadCommission += spread;
      }
    }

    balance = fixedCommission + spreadCommission;

    // Save/update commission in ib_commission table
    if (ibUserId) {
      try {
        await IBCommission.upsertCommission(ib.id, ibUserId, {
          totalCommission: balance,
          fixedCommission: fixedCommission || 0,
          spreadCommission: spreadCommission || 0,
          totalTrades: 0,
          totalLots: 0
        });
      } catch (error) {
        console.error('Error saving commission to ib_commission table:', error);
        return res.status(500).json({
          success: false,
          message: 'Error saving commission data'
        });
      }
    }

    res.json({
      success: true,
      message: 'Commission synced successfully',
      data: {
        balance,
        totalProfit: balance,
        totalEarning: balance,
        totalEarnings: balance,
        fixedCommission,
        spreadCommission
      }
    });
  } catch (error) {
    console.error('Error syncing commission:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to sync commission'
    });
  }
});

// GET /api/user/dashboard/calculator-data - Get data for commission calculator
router.get('/calculator-data', authenticateToken, async (req, res) => {
  console.log('[CALCULATOR-DATA] Endpoint called');
  try {
    const email = req.user.email;
    console.log('[CALCULATOR-DATA] User email:', email);
    
    // Get IB request with group_id and ib_type
    const ibResult = await query(
      `SELECT id, full_name, email, referral_code, ib_type, group_id 
       FROM ib_requests 
       WHERE LOWER(email) = LOWER($1) AND status = 'approved'`,
      [email]
    );
    
    console.log('[CALCULATOR-DATA] IB query result:', ibResult.rows.length, 'rows');
    
    if (ibResult.rows.length === 0) {
      console.log('[CALCULATOR-DATA] No approved IB found for email:', email);
      return res.json({
        success: true,
        data: {
          accountTypes: [],
          instruments: [],
          commissionLevels: []
        }
      });
    }
    
    const ib = ibResult.rows[0];
    const ibId = ib.id;
    const ibType = ib.ib_type; // This is the structure_name(s) - can be comma-separated
    const groupIdsString = ib.group_id || ''; // Comma-separated group_ids
    
    console.log('[CALCULATOR-DATA] IB ID:', ibId, 'IB Type:', ibType, 'Group IDs:', groupIdsString);
    
    // Parse comma-separated group_ids from ib_requests
    const groupIds = groupIdsString
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);
    
    console.log('[CALCULATOR-DATA] Parsed group IDs:', groupIds);
    
    if (groupIds.length === 0) {
      console.log('[CALCULATOR-DATA] No group IDs found, returning empty result');
      return res.json({
        success: true,
        data: {
          accountTypes: [],
          instruments: [],
          commissionLevels: [],
          ibType: ibType
        }
      });
    }
    
    // Get group names from group_management table
    // The 'name' column is the dedicated_name
    // Use ANY array for PostgreSQL
    let groupsResult;
    try {
      console.log('[CALCULATOR-DATA] Querying group_management for group_ids:', groupIds);
      groupsResult = await query(
        `SELECT "group" as group_id, dedicated_name as name, account_type as description 
         FROM group_management 
         WHERE "group" = ANY($1::text[])`,
        [groupIds]
      );
      console.log('[CALCULATOR-DATA] group_management query result:', groupsResult.rows.length, 'rows');
      if (groupsResult.rows.length > 0) {
        console.log('[CALCULATOR-DATA] Found groups:', groupsResult.rows.map(r => ({ id: r.group_id, name: r.name })));
      }
    } catch (groupError) {
      console.error('[CALCULATOR-DATA] Error querying group_management:', groupError);
      console.error('Error fetching groups from group_management:', groupError);
      console.error('Error details:', {
        message: groupError.message,
        code: groupError.code,
        detail: groupError.detail,
        hint: groupError.hint
      });
      console.error('Group IDs being queried:', groupIds);
      
      // If table doesn't exist, try to create it and retry
      if (groupError.message && groupError.message.includes('does not exist')) {
        try {
          console.warn('group_management table does not exist, creating it...');
          await GroupManagement.createTable();
          // Retry the query
          groupsResult = await query(
            `SELECT "group" as group_id, dedicated_name as name, account_type as description 
             FROM group_management 
             WHERE "group" = ANY($1::text[])`,
            [groupIds]
          );
        } catch (createError) {
          console.error('Error creating group_management table:', createError);
          // Return empty result instead of failing
          return res.json({
            success: true,
            data: {
              accountTypes: [],
              instruments: [],
              commissionLevels: [],
              ibType: ibType,
              error: process.env.NODE_ENV !== 'production' ? `Error: ${createError.message}` : undefined
            }
          });
        }
      } else {
        // Return empty result for other errors
        return res.json({
          success: true,
          data: {
            accountTypes: [],
            instruments: [],
            commissionLevels: [],
            ibType: ibType,
            error: process.env.NODE_ENV !== 'production' ? `Error fetching groups: ${groupError.message}` : undefined
          }
        });
      }
    }
    
    // Check if we got any groups
    if (!groupsResult || !groupsResult.rows || groupsResult.rows.length === 0) {
      console.warn('No groups found in group_management for group_ids:', groupIds);
      console.warn('IB group_id from ib_requests:', groupIdsString);
      
      // Fallback: Try to get groups from ib_group_assignments instead
      console.log('Attempting fallback: fetching groups from ib_group_assignments...');
      try {
        const fallbackGroupsResult = await query(
          `SELECT DISTINCT 
             iga.group_id, 
             iga.group_name,
             iga.structure_name,
             iga.usd_per_lot,
             iga.spread_share_percentage,
             COALESCE(gm.dedicated_name, iga.group_name) as name
           FROM ib_group_assignments iga
           LEFT JOIN group_management gm ON gm."group" = iga.group_id
           WHERE iga.ib_request_id = $1
           ORDER BY iga.group_id ASC`,
          [ibId]
        );
        
        if (fallbackGroupsResult.rows && fallbackGroupsResult.rows.length > 0) {
          console.log(`Found ${fallbackGroupsResult.rows.length} groups from ib_group_assignments, using as fallback`);
          // Use the fallback result
          groupsResult = fallbackGroupsResult;
        } else {
          console.warn('No groups found in ib_group_assignments either');
          // Return empty result
          return res.json({
            success: true,
            data: {
              accountTypes: [],
              instruments: [],
              commissionLevels: [],
              ibType: ibType,
              debug: process.env.NODE_ENV !== 'production' ? {
                message: 'No groups found in group_management or ib_group_assignments',
                groupIds: groupIds,
                groupIdsString: groupIdsString
              } : undefined
            }
          });
        }
      } catch (fallbackError) {
        console.error('Error in fallback query:', fallbackError);
        return res.json({
          success: true,
          data: {
            accountTypes: [],
            instruments: [],
            commissionLevels: [],
            ibType: ibType
          }
        });
      }
    } else {
      console.log(`Found ${groupsResult.rows.length} groups in group_management for IB ${ibId}`);
    }
    
    // Parse ib_type (can be comma-separated structure names)
    const ibTypes = ibType 
      ? ibType.split(',').map(t => t.trim()).filter(t => t.length > 0)
      : [];
    
    // Build account types from groups with their names from group_management
    const accountTypes = [];
    
    // Get the IB's structure_name(s) - this is the unified commission structure
    // Commission levels should be based on IB's structure_name only, not per group
    const primaryStructureName = ibTypes[0] || ibType || null;
    
    console.log(`[CALCULATOR-DATA] IB structure_name(s): ${ibTypes.join(', ')}, Primary: ${primaryStructureName}`);
    
    // Fetch UNIFIED commission levels based on IB's structure_name only
    // These levels apply to ALL groups uniformly
    const unifiedCommissionLevels = new Map(); // Use Map to deduplicate by level_order
    
    if (primaryStructureName) {
      // Get unified commission structures for this IB's structure_name
      // These levels apply uniformly across ALL groups for this IB
      // We use DISTINCT ON to get one structure per level_order
      const allStructuresResult = await query(
        `SELECT DISTINCT ON (gcs.level_order)
           gcs.level_order,
           gcs.structure_name,
           gcs.usd_per_lot,
           gcs.spread_share_percentage
         FROM group_commission_structures gcs
         INNER JOIN ib_group_assignments iga ON iga.group_id = gcs.group_id 
           AND LOWER(iga.structure_name) = LOWER(gcs.structure_name)
         WHERE iga.ib_request_id = $1
           AND LOWER(gcs.structure_name) = LOWER($2)
         ORDER BY gcs.level_order ASC, gcs.id ASC`,
        [ibId, primaryStructureName]
      );
      
      // If no structures found with exact match, try to get any structures for this IB
      if (allStructuresResult.rows.length === 0) {
        console.log('[CALCULATOR-DATA] No structures found with exact match, trying fallback...');
        const fallbackResult = await query(
          `SELECT DISTINCT ON (gcs.level_order)
             gcs.level_order,
             gcs.structure_name,
             gcs.usd_per_lot,
             gcs.spread_share_percentage
           FROM group_commission_structures gcs
           INNER JOIN ib_group_assignments iga ON iga.group_id = gcs.group_id
           WHERE iga.ib_request_id = $1
           ORDER BY gcs.level_order ASC, gcs.id ASC`,
          [ibId]
        );
        
        fallbackResult.rows.forEach(struct => {
          const level = Number(struct.level_order || 1);
          if (!unifiedCommissionLevels.has(level)) {
            unifiedCommissionLevels.set(level, {
              level: level,
              levelName: `Level ${level}`,
              structureName: struct.structure_name || primaryStructureName,
              usdPerLot: Number(struct.usd_per_lot || 0),
              spreadSharePercentage: Number(struct.spread_share_percentage || 0)
            });
          }
        });
      } else {
        allStructuresResult.rows.forEach(struct => {
          const level = Number(struct.level_order || 1);
          if (!unifiedCommissionLevels.has(level)) {
            unifiedCommissionLevels.set(level, {
              level: level,
              levelName: `Level ${level}`,
              structureName: struct.structure_name || primaryStructureName,
              usdPerLot: Number(struct.usd_per_lot || 0),
              spreadSharePercentage: Number(struct.spread_share_percentage || 0)
            });
          }
        });
      }
    }
    
    console.log(`[CALCULATOR-DATA] Unified commission levels: ${unifiedCommissionLevels.size} levels found`);
    
    // Convert Map to array and sort by level
    const commissionLevels = Array.from(unifiedCommissionLevels.values()).sort((a, b) => a.level - b.level);
    
    // Build account types for each group (for dropdown selection)
    for (let i = 0; i < groupsResult.rows.length; i++) {
      const group = groupsResult.rows[i];
      const groupId = group.group_id;
      // Get dedicated_name from group_management table (this is the name we show in the dropdown)
      const groupName = group.name || group.group_name || groupId;
      
      console.log(`[CALCULATOR-DATA] Processing group ${i + 1}/${groupsResult.rows.length}: groupId=${groupId}, groupName=${groupName}`);
      
      // Get the corresponding ib_type (structure_name) for this group
      let structureName = null;
      const assignmentResult = await query(
        `SELECT structure_name, structure_id
         FROM ib_group_assignments
         WHERE ib_request_id = $1 AND group_id = $2
         LIMIT 1`,
        [ibId, groupId]
      );
      
      if (assignmentResult.rows.length > 0 && assignmentResult.rows[0].structure_name) {
        structureName = assignmentResult.rows[0].structure_name;
      } else {
        // Fallback: If ib_type is comma-separated, match by index or use first one
        structureName = ibTypes[i] || ibTypes[0] || primaryStructureName;
      }
      
      // Determine commission type based on group name (for display purposes only)
      const groupNameLower = groupName.toLowerCase();
      const isFixedPerLot = groupNameLower.includes('zero') || 
                           groupNameLower.includes('raw') || 
                           groupNameLower.includes('standard plus');
      const isVariableSpread = groupNameLower.includes('standard') || 
                              groupNameLower.includes('pro') ||
                              groupNameLower.includes('cent');
      
      // Get the first level's rates for this account type (for reference, but calculation uses unified levels)
      const firstLevel = commissionLevels[0] || {
        usdPerLot: 0,
        spreadSharePercentage: 0
      };
      
      // Add account type
      accountTypes.push({
        id: groupId,
        name: groupName,
        groupId: groupId,
        ibType: structureName,
        usdPerLot: Number(firstLevel.usdPerLot || 0),
        spreadSharePercentage: Number(firstLevel.spreadSharePercentage || 0),
        structureName: structureName || primaryStructureName || 'Default',
        commissionType: isFixedPerLot ? 'fixed' : isVariableSpread ? 'variable' : 'fixed',
        description: isFixedPerLot 
          ? 'Commission for these accounts is fixed per traded lot.'
          : 'Commission for these accounts may vary as spreads fluctuate.'
      });
    }
    
    // Get instruments from symbols database (symbols_with_categories table)
    // Fetch ALL active symbols (no limit) for the calculator
    let instruments = [];
    try {
      // First, get the total count to determine if we need pagination
      const countResult = await query(
        'SELECT COUNT(*) as total FROM symbols_with_categories WHERE status = $1',
        ['active']
      );
      const totalSymbols = parseInt(countResult.rows[0]?.total || 0);
      
      console.log(`[CALCULATOR-DATA] Total active symbols: ${totalSymbols}`);
      
      // Fetch all active symbols without pagination limit
      const symbolsResult = await query(
        `SELECT symbol, category, group_name 
         FROM symbols_with_categories 
         WHERE status = 'active' 
         ORDER BY symbol ASC`,
        []
      );
      
      if (symbolsResult && symbolsResult.rows && Array.isArray(symbolsResult.rows)) {
        instruments = symbolsResult.rows.map(symbol => ({
          id: symbol.symbol || '',
          name: symbol.symbol || '',
          category: symbol.category || 'Other'
        })).filter(inst => inst.id && inst.id.length > 0); // Filter out empty symbols
        
        console.log(`[CALCULATOR-DATA] Fetched ${instruments.length} instruments from database`);
      }
    } catch (error) {
      console.error('Error fetching instruments from database:', error);
      // Fallback to common instruments if database fetch fails
      instruments = [
        { id: 'EURUSD', name: 'EURUSD', category: 'Forex' },
        { id: 'GBPUSD', name: 'GBPUSD', category: 'Forex' },
        { id: 'USDJPY', name: 'USDJPY', category: 'Forex' },
        { id: 'AUDUSD', name: 'AUDUSD', category: 'Forex' },
        { id: 'USDCAD', name: 'USDCAD', category: 'Forex' },
        { id: 'XAUUSD', name: 'XAUUSD', category: 'Metals' },
        { id: 'XAGUSD', name: 'XAGUSD', category: 'Metals' },
        { id: 'BTCUSD', name: 'BTCUSD', category: 'Crypto' },
        { id: 'ETHUSD', name: 'ETHUSD', category: 'Crypto' }
      ];
    }
    
    console.log('[CALCULATOR-DATA] Final result - Account Types:', accountTypes.length, 'Instruments:', instruments.length, 'Commission Levels:', commissionLevels.length);
    if (accountTypes.length > 0) {
      console.log('[CALCULATOR-DATA] Account Types:', accountTypes.map(at => ({ id: at.id, name: at.name })));
    } else {
      console.warn('[CALCULATOR-DATA] WARNING: No account types found!');
    }
    
    res.json({
      success: true,
      data: {
        accountTypes,
        instruments,
        commissionLevels: commissionLevels.sort((a, b) => a.level - b.level),
        ibType: ibType // Include ib_type for reference
      }
    });
  } catch (error) {
    console.error('Error fetching calculator data:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch calculator data',
      error: process.env.NODE_ENV !== 'production' ? {
        message: error.message,
        stack: error.stack,
        details: String(error)
      } : undefined
    });
  }
});

// Quick reports: day-wise IB commission and registrations with range filters
router.get('/quick-reports', authenticateToken, async (req, res) => {
  try {
    const email = req.user.email;
    const ibRes = await query('SELECT id, approved_at FROM ib_requests WHERE LOWER(email)=LOWER($1) AND status = \"approved\"', [email]);
    if (!ibRes.rows.length) return res.json({ success: true, data: { commission: [], registrations: [] } });
    const ibId = ibRes.rows[0].id;

    const range = String(req.query.range || 'month').toLowerCase();
    const now = new Date();
    let from = req.query.from ? new Date(req.query.from) : null;
    let to = req.query.to ? new Date(req.query.to) : now;
    if (!from || isNaN(from.getTime())) {
      if (range === 'day') from = new Date(now.getTime() - 1 * 24*60*60*1000);
      else if (range === 'week') from = new Date(now.getTime() - 7 * 24*60*60*1000);
      else if (range === 'year') from = new Date(now.getTime() - 365 * 24*60*60*1000);
      else from = new Date(now.getTime() - 30 * 24*60*60*1000); // month default
    }

    // Build approved group map for spread share calculation
    const assignments = await query(
      `SELECT group_id, group_name, spread_share_percentage
       FROM ib_group_assignments WHERE ib_request_id = $1`,
      [ibId]
    );
    const norm = (gid) => {
      if (!gid) return '';
      const s = String(gid).toLowerCase();
      const parts = s.split(/[\\/]/);
      return parts[parts.length-1] || s;
    };
    const spreadPct = new Map();
    for (const r of assignments.rows) {
      const keys = [String(r.group_id||'').toLowerCase(), String(r.group_name||'').toLowerCase(), norm(r.group_id)];
      for (const k of keys) { if (k) spreadPct.set(k, Number(r.spread_share_percentage || 0)); }
    }

    // Commission per day: aggregate lots and fixed by day and group then compute spread by JS to honor normalized match
    const trades = await query(
      `SELECT date_trunc('day', synced_at)::date AS day, group_id,
              COALESCE(SUM(volume_lots),0) AS lots,
              COALESCE(SUM(ib_commission),0) AS fixed
       FROM ib_trade_history
       WHERE ib_request_id = $1
         AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
         AND synced_at >= $2 AND synced_at <= $3
       GROUP BY day, group_id
       ORDER BY day`,
      [ibId, from.toISOString(), to.toISOString()]
    );
    const byDay = new Map();
    for (const r of trades.rows) {
      const k = norm(r.group_id) || String(r.group_id || '').toLowerCase();
      const pct = spreadPct.get(k) || 0;
      const spread = Number(r.lots || 0) * (pct / 100);
      const fixed = Number(r.fixed || 0);
      const key = String(r.day);
      const prev = byDay.get(key) || { day: key, fixed: 0, spread: 0, total: 0 };
      prev.fixed += fixed; prev.spread += spread; prev.total += (fixed + spread);
      byDay.set(key, prev);
    }
    const commissionSeries = Array.from(byDay.values()).sort((a,b)=> new Date(a.day)-new Date(b.day));

    // Registrations per day (referrals)
    const regs = await query(
      `SELECT date_trunc('day', submitted_at)::date AS day, COUNT(*)::int AS count
       FROM ib_requests
       WHERE referred_by = $1 AND submitted_at >= $2 AND submitted_at <= $3
       GROUP BY day ORDER BY day`,
      [ibId, from.toISOString(), to.toISOString()]
    );
    const registrationSeries = regs.rows.map(r => ({ day: String(r.day), count: Number(r.count || 0) }));

    res.json({ success: true, data: { commission: commissionSeries, registrations: registrationSeries } });
  } catch (e) {
    console.error('Quick reports error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch quick reports' });
  }
});

export default router;
