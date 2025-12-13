import express from 'express';
import { authenticateToken } from './auth.js';
import { query } from '../config/database.js';

const router = express.Router();

// Get clients for logged-in IB user
router.get('/', authenticateToken, async (req, res) => {
  try {
    // req.user.id is already the IB request ID from authenticateToken
    const ibRequestId = req.user.id;

    // Get current IB's details (the referrer for all clients)
    const currentIBResult = await query(
      `SELECT id, full_name, email, referral_code FROM ib_requests WHERE id = $1`,
      [ibRequestId]
    );
    const currentIB = currentIBResult.rows[0] || null;

    // Best-effort: fetch current IB phone from User table using flexible column mapping
    let currentIBPhone = null;
    if (currentIB?.email) {
      try {
        const phoneRes = await query('SELECT * FROM "User" WHERE LOWER(email) = LOWER($1) LIMIT 1', [currentIB.email]);
        if (phoneRes.rows.length) {
          const u = phoneRes.rows[0];
          currentIBPhone = u.phone || u.phone_number || u.phonenumber || u.mobile || u.mobile_number || u.contact_number || null;
        }
      } catch {}
    }

    // Get clients referred by this IB (from ib_requests.referred_by)
    // Include all referral details from database
    // Only count trades from referred users, excluding IB's own trades
    const clientsResult = await query(`
      SELECT 
        ib.id as ib_id,
        ib.full_name as user_name,
        ib.email as user_email,
        ib.submitted_at,
        ib.approved_at,
        ib.ib_type,
        ib.status,
        ib.referral_code,
        ib.referred_by,
        ib.usd_per_lot,
        ib.spread_percentage_per_lot,
        ib.country as ib_country,
        COALESCE(SUM(CASE WHEN th.user_id = u.id 
                          AND th.close_price IS NOT NULL 
                          AND th.close_price != 0 
                          AND th.profit != 0 
                     THEN th.volume_lots ELSE 0 END), 0) as direct_volume_lots,
        COALESCE(SUM(CASE WHEN th.user_id = u.id 
                          AND th.close_price IS NOT NULL 
                          AND th.close_price != 0 
                          AND th.profit != 0 
                     THEN th.ib_commission ELSE 0 END), 0) as direct_commission,
        COUNT(DISTINCT CASE WHEN ma."accountType" = 'real' THEN ma."accountId" END) as account_count
      FROM ib_requests ib
      LEFT JOIN "User" u ON u.email = ib.email
      LEFT JOIN "MT5Account" ma ON ma."userId" = u.id
      LEFT JOIN ib_trade_history th ON th.user_id = u.id AND th.ib_request_id = $1
      WHERE ib.referred_by = $1
      GROUP BY ib.id, ib.full_name, ib.email, ib.submitted_at, ib.approved_at, 
               ib.ib_type, ib.status, ib.referral_code, ib.referred_by, 
               ib.usd_per_lot, ib.spread_percentage_per_lot, ib.country, u.id
      ORDER BY ib.submitted_at DESC
    `, [ibRequestId]);

    // Map clients and fetch account IDs using email → User → MT5Account flow
    const clients = [];
    for (const row of clientsResult.rows) {
      let accountId = null;
      // Start with country from ib_requests (if available)
      let country = row.ib_country || '-';
      
      // Use email from ib_requests to search User table, then MT5Account
      if (row.user_email) {
        try {
          // Step 1: Search User table by email to get user_id and country
          console.log(`[userClients] Looking up User for email: ${row.user_email}`);
          const userResult = await query(
            'SELECT id FROM "User" WHERE LOWER(email) = LOWER($1) LIMIT 1',
            [row.user_email]
          );
          
          if (userResult.rows.length > 0) {
            const userId = userResult.rows[0].id;
            console.log(`[userClients] Found User with id: ${userId} for email: ${row.user_email}`);
            
            // Get country from User table (try multiple column names)
            // Only override if User table has country and ib_requests doesn't
            if (!country || country === '-') {
              try {
                // First try to get all possible country columns
                const countryResult = await query(
                  'SELECT * FROM "User" WHERE id = $1 LIMIT 1',
                  [userId]
                );
                if (countryResult.rows.length > 0) {
                  const u = countryResult.rows[0];
                  // Try all possible country column names
                  const userCountry = u.country || u.country_code || u.nationality || u.Country || u.CountryCode || u.Nationality || null;
                  if (userCountry && userCountry !== '-') {
                    country = userCountry;
                    console.log(`[userClients] Country for ${row.user_email}: ${country} (from User table)`);
                  }
                  console.log(`[userClients] Available User columns:`, Object.keys(u).filter(k => k.toLowerCase().includes('country') || k.toLowerCase().includes('nationality')));
                }
              } catch (countryErr) {
                console.warn(`[userClients] Could not fetch country for ${row.user_email}:`, countryErr.message);
              }
            } else {
              console.log(`[userClients] Using country from ib_requests for ${row.user_email}: ${country}`);
            }
            
            // Step 2: Use user_id to search MT5Account table for accountId
            console.log(`[userClients] Looking up MT5Account for user_id: ${userId}`);
            // Try real/live first, then any account type
            let accountResult = await query(
              `SELECT "accountId" FROM "MT5Account" 
               WHERE "userId" = $1 
                 AND ("accountType" = 'real' OR "accountType" = 'live')
               ORDER BY "accountId" LIMIT 1`,
              [userId]
            );
            
            // If no real/live account, try any account type
            if (accountResult.rows.length === 0) {
              console.log(`[userClients] No real/live account found, trying any account type for user_id: ${userId}`);
              accountResult = await query(
                `SELECT "accountId" FROM "MT5Account" 
                 WHERE "userId" = $1 
                 ORDER BY "accountId" LIMIT 1`,
                [userId]
              );
            }
            
            if (accountResult.rows.length > 0) {
              accountId = String(accountResult.rows[0].accountId);
              console.log(`[userClients] ✓ Found MT5 Account ${accountId} for email ${row.user_email} (user_id: ${userId})`);
            } else {
              console.log(`[userClients] ✗ No MT5 Account found for email ${row.user_email} (user_id: ${userId})`);
            }
          } else {
            console.log(`[userClients] ✗ No User found for email ${row.user_email}`);
          }
        } catch (err) {
          console.error(`[userClients] Error fetching user/account for email ${row.user_email}:`, err.message);
          console.error(`[userClients] Error stack:`, err.stack);
        }
      }
      
      
      clients.push({
        id: row.ib_id,
        userId: row.ib_id,
        name: row.user_name,
        email: row.user_email,
        accountId: accountId || '-', // MT5 Account ID from MT5Account table via User table
        joinDate: row.submitted_at,
        approvedDate: row.approved_at,
        totalLots: Number(row.direct_volume_lots || 0),
        commission: Number(row.direct_commission || 0),
        accountCount: parseInt(row.account_count || 0),
        ibType: row.ib_type || 'N/A',
        status: row.status || 'pending',
        referralCode: row.referral_code || 'N/A',
        referredById: row.referred_by,
        referredByName: currentIB ? currentIB.full_name : 'You',
        referredByEmail: currentIB ? currentIB.email : null,
        referredByPhone: currentIBPhone,
        referredByCode: currentIB ? currentIB.referral_code : null,
        usdPerLot: Number(row.usd_per_lot || 0),
        spreadPercentage: Number(row.spread_percentage_per_lot || 0),
        country: country, // Country from User table
        lastTrade: null
      });
    }

    // 2) Include CRM-referred traders from ib_referrals (non-IB clients)
    const crmResult = await query(`
      SELECT 
        r.id as ref_id,
        r.user_id,
        r.email as user_email,
        r.created_at as submitted_at,
        COUNT(DISTINCT CASE WHEN ma."accountType" = 'real' OR ma."accountType" = 'live' THEN ma."accountId" END) as account_count,
        COALESCE(SUM(th.volume_lots), 0) as direct_volume_lots,
        COALESCE(SUM(th.ib_commission), 0) as direct_commission
      FROM ib_referrals r
      -- Cast to text for compatibility when User.id is uuid
      LEFT JOIN "User" u ON (u.id::text = r.user_id)
      LEFT JOIN "MT5Account" ma ON ma."userId" = u.id
      LEFT JOIN ib_trade_history th ON th.ib_request_id = $1 AND th.user_id = r.user_id 
        AND th.close_price IS NOT NULL AND th.close_price != 0 AND th.profit IS NOT NULL AND th.profit != 0
      WHERE r.ib_request_id = $1
      GROUP BY r.id, r.user_id, r.email, r.created_at
      ORDER BY r.created_at DESC
    `, [ibRequestId]);

    for (const row of crmResult.rows) {
      // Avoid duplicating if the same email is already in IB applicants list
      const exists = clients.find(c => (c.email || '').toLowerCase() === (row.user_email || '').toLowerCase());
      if (exists) continue;
      
      // Step 1: Get user_id from User table using email from ib_referrals
      let userId = null;
      let accountId = null;
      let country = '-';
      
      try {
        // Step 1: Search User table by email from ib_referrals to get user_id
        console.log(`[userClients] [ib_referrals] Looking up User for email: ${row.user_email}`);
        const userResult = await query(
          'SELECT id FROM "User" WHERE LOWER(email) = LOWER($1) LIMIT 1',
          [row.user_email]
        );
        
        if (userResult.rows.length > 0) {
          userId = String(userResult.rows[0].id);
          console.log(`[userClients] [ib_referrals] Found User with id: ${userId} for email: ${row.user_email}`);
          
          // Get country from User table (try multiple column names)
          try {
            // Get all columns to check what's available
            const countryResult = await query(
              'SELECT * FROM "User" WHERE id = $1 LIMIT 1',
              [userResult.rows[0].id]
            );
            if (countryResult.rows.length > 0) {
              const u = countryResult.rows[0];
              // Try all possible country column names
              country = u.country || u.country_code || u.nationality || u.Country || u.CountryCode || u.Nationality || '-';
              console.log(`[userClients] [ib_referrals] Country for ${row.user_email}: ${country} (from User table)`);
              console.log(`[userClients] [ib_referrals] Available User columns:`, Object.keys(u).filter(k => k.toLowerCase().includes('country') || k.toLowerCase().includes('nationality')));
            }
          } catch (countryErr) {
            console.warn(`[userClients] [ib_referrals] Could not fetch country for ${row.user_email}:`, countryErr.message);
          }
          
          // Step 2: Use user_id to search MT5Account table for accountId
          console.log(`[userClients] [ib_referrals] Looking up MT5Account for user_id: ${userId}`);
          // Try real/live first, then any account type
          let accountResult = await query(
            `SELECT "accountId" FROM "MT5Account" 
             WHERE "userId" = $1 
               AND ("accountType" = 'real' OR "accountType" = 'live')
             ORDER BY "accountId" LIMIT 1`,
            [userResult.rows[0].id]
          );
          
          // If no real/live account, try any account type
          if (accountResult.rows.length === 0) {
            console.log(`[userClients] [ib_referrals] No real/live account found, trying any account type for user_id: ${userId}`);
            accountResult = await query(
              `SELECT "accountId" FROM "MT5Account" 
               WHERE "userId" = $1 
               ORDER BY "accountId" LIMIT 1`,
              [userResult.rows[0].id]
            );
          }
          
          if (accountResult.rows.length > 0) {
            accountId = String(accountResult.rows[0].accountId);
            console.log(`[userClients] [ib_referrals] ✓ Found MT5 Account ${accountId} for email ${row.user_email} (user_id: ${userId})`);
          } else {
            console.log(`[userClients] [ib_referrals] ✗ No MT5 Account found for email ${row.user_email} (user_id: ${userId})`);
          }
        } else {
          console.log(`[userClients] [ib_referrals] ✗ No User found for email ${row.user_email}`);
        }
      } catch (err) {
        console.error(`[userClients] Error fetching user/account for ib_referrals email ${row.user_email}:`, err.message);
        console.error(`[userClients] Error stack:`, err.stack);
      }
      
      clients.push({
        id: row.ref_id,
        userId: userId || row.user_id || row.ref_id,
        name: row.user_email, // we may only have email; CRM can send name later if desired
        email: row.user_email,
        accountId: accountId || '-', // MT5 Account ID from MT5Account table via User table
        joinDate: row.submitted_at,
        approvedDate: null,
        totalLots: Number(row.direct_volume_lots || 0),
        commission: Number(row.direct_commission || 0),
        accountCount: parseInt(row.account_count || 0),
        ibType: 'Trader',
        status: 'trader',
        referralCode: null,
        referredById: ibRequestId,
        referredByName: currentIB ? currentIB.full_name : 'You',
        referredByEmail: currentIB ? currentIB.email : null,
        referredByPhone: currentIBPhone,
        referredByCode: currentIB ? currentIB.referral_code : null,
        usdPerLot: 0,
        spreadPercentage: 0,
        country: country, // Country from User table
        lastTrade: null
      });
    }

    // Get last trade date for each client
    // Get IB's user_id to exclude from last trade query
    const ibUserResult = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [currentIB?.email]);
    const ibUserId = ibUserResult.rows[0]?.id ? String(ibUserResult.rows[0].id) : null;
    
    for (const client of clients) {
      // Get user_id for this client
      const clientUserResult = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [client.email]);
      if (clientUserResult.rows.length === 0) continue;
      const clientUserId = String(clientUserResult.rows[0].id);
      
      // Only get trades from this client (referred user), excluding IB's own trades
      let lastTradeQuery = `
        SELECT MAX(synced_at) as last_trade
        FROM ib_trade_history
        WHERE ib_request_id = $1
          AND user_id = $2
          AND close_price IS NOT NULL 
          AND close_price != 0 
          AND profit != 0
      `;
      const lastTradeParams = [ibRequestId, clientUserId];
      
      if (ibUserId && ibUserId !== clientUserId) {
        lastTradeQuery += ` AND user_id != $3`;
        lastTradeParams.push(ibUserId);
      }
      
      const lastTradeResult = await query(lastTradeQuery, lastTradeParams);

      if (lastTradeResult.rows[0]?.last_trade) {
        client.lastTrade = lastTradeResult.rows[0].last_trade;
      }
    }

    // Calculate stats
    const stats = {
      totalClients: clients.length,
      totalVolume: clients.reduce((sum, c) => sum + c.totalLots, 0),
      totalCommission: clients.reduce((sum, c) => sum + c.commission, 0),
      activeTraders: clients.filter(c => c.lastTrade !== null).length
    };

    // Log first client for debugging
    if (clients.length > 0) {
      console.log(`[userClients] Returning ${clients.length} clients. First client:`, {
        email: clients[0].email,
        accountId: clients[0].accountId,
        country: clients[0].country,
        id: clients[0].id
      });
    }
    
    res.json({
      success: true,
      data: {
        clients,
        stats
      }
    });
  } catch (error) {
    console.error('Error fetching user clients:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch clients',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

export default router;

// Dedicated list of CRM-referred traders for the logged-in IB
router.get('/traders', authenticateToken, async (req, res) => {
  try {
    const ibRequestId = req.user.id;

    // Resolve current IB for contact details
    const ibRes = await query('SELECT id, full_name, email FROM ib_requests WHERE id = $1', [ibRequestId]);
    const currentIB = ibRes.rows[0] || null;

    // Pull traders from ib_referrals with best-effort name/phone from User
    const tradersRes = await query(`
      SELECT r.id AS ref_id, r.user_id, r.email AS trader_email, r.created_at,
             r.referral_code,
             u.*
      FROM ib_referrals r
      LEFT JOIN "User" u ON (u.id::text = r.user_id)
      WHERE r.ib_request_id = $1
      ORDER BY r.created_at DESC
    `, [ibRequestId]);

    const mapPhone = (u) => (u?.phone || u?.phone_number || u?.phonenumber || u?.mobile || u?.mobile_number || u?.contact_number || null);
    const mapName = (u) => (u?.name || u?.full_name || ((u?.first_name && u?.last_name) ? `${u.first_name} ${u.last_name}` : null) || ((u?.firstName && u?.lastName) ? `${u.firstName} ${u.lastName}` : null) || null);

    const traders = tradersRes.rows.map(r => ({
      id: r.ref_id,
      email: r.trader_email,
      name: mapName(r),
      phone: mapPhone(r),
      referralCode: r.referral_code,
      createdAt: r.created_at,
      referredByName: currentIB?.full_name || 'You',
      referredByEmail: currentIB?.email || null
    }));

    res.json({ success: true, data: { traders } });
  } catch (e) {
    console.error('Error fetching traders list:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch traders' });
  }
});
