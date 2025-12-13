import express from 'express';
import { authenticateAdminToken } from './adminAuth.js';
import { query } from '../config/database.js';

const router = express.Router();

// Helper to coerce a numeric from a row value
const num = (v) => Number(v || 0);

// Helper to calculate date range from period
const getDateRange = (period, fromDate, toDate) => {
  const now = new Date();
  let start, end;

  if (fromDate && toDate) {
    start = new Date(fromDate);
    end = new Date(toDate);
    end.setHours(23, 59, 59, 999);
  } else {
    switch (period) {
      case 'today':
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        end = new Date(now);
        break;
      case '7d':
        start = new Date(now);
        start.setDate(start.getDate() - 7);
        end = new Date(now);
        break;
      case '30d':
        start = new Date(now);
        start.setDate(start.getDate() - 30);
        end = new Date(now);
        break;
      case '90d':
        start = new Date(now);
        start.setDate(start.getDate() - 90);
        end = new Date(now);
        break;
      case 'month':
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = new Date(now);
        break;
      case 'year':
        start = new Date(now.getFullYear(), 0, 1);
        end = new Date(now);
        break;
      default:
        // Default to last 30 days
        start = new Date(now);
        start.setDate(start.getDate() - 30);
        end = new Date(now);
    }
  }

  return { start, end };
};

// Helper to get date grouping SQL
const getDateGrouping = (groupBy, dateColumn = 'created_at') => {
  // Ensure column name is safe (no SQL injection)
  const safeColumn = dateColumn.replace(/[^a-zA-Z0-9_]/g, '');
  switch (groupBy) {
    case 'day':
      return `DATE(${safeColumn})`;
    case 'week':
      return `DATE_TRUNC('week', ${safeColumn})`;
    case 'month':
      return `DATE_TRUNC('month', ${safeColumn})`;
    default:
      return `DATE(${safeColumn})`;
  }
};

// GET /api/admin/ib-reports/summary
router.get('/summary', authenticateAdminToken, async (req, res) => {
  try {
    const { period = '30d', fromDate, toDate } = req.query;
    const { start, end } = getDateRange(period, fromDate, toDate);

    const [ibTotals, commissionTotals, volumeTotals, clientTotals, withdrawalTotals, rewardTotals] = await Promise.all([
      // IB Statistics - Count all IBs (not just created in period)
      query(`
        SELECT 
          COUNT(*)::int AS total_ibs,
          COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'approved')::int AS active_ibs,
          COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'pending')::int AS pending_ibs,
          COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'rejected')::int AS rejected_ibs,
          COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'banned')::int AS banned_ibs
        FROM ib_requests
      `),
      
      // Commission Statistics - Sum all commissions updated in period
      query(`
        SELECT 
          COALESCE(SUM(total_commission), 0) AS total_commission,
          COALESCE(SUM(fixed_commission), 0) AS fixed_commission,
          COALESCE(SUM(spread_commission), 0) AS spread_commission,
          COUNT(DISTINCT ib_request_id)::int AS ibs_with_commission
        FROM ib_commission
        WHERE last_updated >= $1 AND last_updated <= $2
      `, [start, end]),
      
      // Trading Volume - Sum all trades in period
      query(`
        SELECT 
          COALESCE(SUM(volume_lots), 0) AS total_lots,
          COALESCE(SUM(volume_lots * 100000), 0) AS total_volume_usd,
          COUNT(DISTINCT ib_request_id)::int AS ibs_with_trades,
          COUNT(*)::int AS total_trades
        FROM ib_trade_history
        WHERE created_at >= $1 AND created_at <= $2
          AND volume_lots > 0
          AND close_price IS NOT NULL
      `, [start, end]),
      
      // Client Growth - Count new clients linked in period AND total active clients
      // Include clients from ib_client_linking, ib_referrals, and ib_requests.referred_by
      query(`
        WITH client_linking_clients AS (
          SELECT DISTINCT 
            user_id::text AS user_id, 
            assigned_ib_id::text AS assigned_ib_id, 
            linked_at::timestamp AS linked_at, 
            status
          FROM ib_client_linking
          WHERE status = 'active'
        ),
        referral_clients AS (
          SELECT DISTINCT 
            user_id::text AS user_id, 
            ib_request_id::text AS assigned_ib_id, 
            created_at::timestamp AS linked_at, 
            'active'::text AS status
          FROM ib_referrals
          WHERE user_id IS NOT NULL
        ),
        ib_referral_clients AS (
          SELECT DISTINCT 
            u.id::text AS user_id, 
            ir.referred_by::text AS assigned_ib_id, 
            ir.submitted_at::timestamp AS linked_at, 
            'active'::text AS status
          FROM ib_requests ir
          JOIN "User" u ON u.email = ir.email
          WHERE ir.referred_by IS NOT NULL AND u.id IS NOT NULL
        ),
        all_clients AS (
          SELECT user_id, assigned_ib_id, linked_at, status FROM client_linking_clients
          UNION
          SELECT user_id, assigned_ib_id, linked_at, status FROM referral_clients
          UNION
          SELECT user_id, assigned_ib_id, linked_at, status FROM ib_referral_clients
        )
        SELECT 
          COUNT(DISTINCT user_id) FILTER (WHERE linked_at >= $1 AND linked_at <= $2)::int AS new_clients_in_period,
          COUNT(DISTINCT assigned_ib_id) FILTER (WHERE linked_at >= $1 AND linked_at <= $2)::int AS ibs_with_new_clients,
          COUNT(DISTINCT user_id) FILTER (WHERE status = 'active')::int AS total_active_clients,
          COUNT(DISTINCT assigned_ib_id) FILTER (WHERE status = 'active')::int AS ibs_with_active_clients
        FROM all_clients
      `, [start, end]),
      
      // Withdrawal Statistics
      query(`
        SELECT 
          COALESCE(SUM(amount), 0) AS total_withdrawal,
          COALESCE(SUM(amount) FILTER (WHERE LOWER(status) = 'pending'), 0) AS withdrawal_pending,
          COALESCE(SUM(amount) FILTER (WHERE LOWER(status) IN ('paid','completed')), 0) AS withdrawal_paid,
          COUNT(*) FILTER (WHERE LOWER(status) = 'pending')::int AS pending_count
        FROM ib_withdrawal_requests
        WHERE created_at >= $1 AND created_at <= $2
      `, [start, end]),
      
      // Reward Claims
      query(`
        SELECT 
          COUNT(*)::int AS total_claims,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_claims,
          COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_claims,
          COUNT(*) FILTER (WHERE status = 'fulfilled')::int AS fulfilled_claims
        FROM ib_reward_claims
        WHERE claimed_at >= $1 AND claimed_at <= $2
      `, [start, end])
    ]);

    const ibStats = ibTotals.rows[0];
    const commissionStats = commissionTotals.rows[0];
    const volumeStats = volumeTotals.rows[0];
    const clientStats = clientTotals.rows[0];
    const withdrawalStats = withdrawalTotals.rows[0];
    const rewardStats = rewardTotals.rows[0];

    res.json({
      success: true,
      data: {
        ibs: {
          total: num(ibStats.total_ibs),
          active: num(ibStats.active_ibs),
          pending: num(ibStats.pending_ibs),
          rejected: num(ibStats.rejected_ibs),
          banned: num(ibStats.banned_ibs)
        },
        commission: {
          total: num(commissionStats.total_commission),
          fixed: num(commissionStats.fixed_commission),
          spread: num(commissionStats.spread_commission),
          ibsWithCommission: num(commissionStats.ibs_with_commission)
        },
        volume: {
          totalLots: num(volumeStats.total_lots),
          totalUsd: num(volumeStats.total_volume_usd),
          ibsWithTrades: num(volumeStats.ibs_with_trades),
          totalTrades: num(volumeStats.total_trades)
        },
        clients: {
          total: num(clientStats.total_active_clients),
          newInPeriod: num(clientStats.new_clients_in_period),
          ibsWithClients: num(clientStats.ibs_with_active_clients),
          ibsWithNewClients: num(clientStats.ibs_with_new_clients)
        },
        withdrawals: {
          total: num(withdrawalStats.total_withdrawal),
          pending: num(withdrawalStats.withdrawal_pending),
          paid: num(withdrawalStats.withdrawal_paid),
          pendingCount: num(withdrawalStats.pending_count)
        },
        rewards: {
          total: num(rewardStats.total_claims),
          pending: num(rewardStats.pending_claims),
          approved: num(rewardStats.approved_claims),
          fulfilled: num(rewardStats.fulfilled_claims)
        }
      }
    });
  } catch (error) {
    console.error('IB Reports summary error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch report summary', error: error.message });
  }
});

// GET /api/admin/ib-reports/commission-trends
router.get('/commission-trends', authenticateAdminToken, async (req, res) => {
  try {
    const { period = '30d', fromDate, toDate, groupBy = 'day' } = req.query;
    const { start, end } = getDateRange(period, fromDate, toDate);
    const dateGroup = getDateGrouping(groupBy, 'last_updated');

    const result = await query(`
      SELECT 
        ${dateGroup} AS date_period,
        COALESCE(SUM(total_commission), 0) AS total_commission,
        COALESCE(SUM(fixed_commission), 0) AS fixed_commission,
        COALESCE(SUM(spread_commission), 0) AS spread_commission,
        COUNT(DISTINCT ib_request_id)::int AS ib_count
      FROM ib_commission
      WHERE last_updated IS NOT NULL
        AND last_updated >= $1 AND last_updated <= $2
      GROUP BY ${dateGroup}
      ORDER BY date_period ASC
    `, [start, end]);

    const trends = result.rows.map(row => ({
      date: row.date_period ? (row.date_period instanceof Date ? row.date_period.toISOString().split('T')[0] : String(row.date_period).split('T')[0]) : '',
      total: num(row.total_commission),
      fixed: num(row.fixed_commission),
      spread: num(row.spread_commission),
      ibCount: num(row.ib_count)
    }));

    res.json({ success: true, data: { trends } });
  } catch (error) {
    console.error('Commission trends error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch commission trends', error: error.message });
  }
});

// GET /api/admin/ib-reports/trading-volume
router.get('/trading-volume', authenticateAdminToken, async (req, res) => {
  try {
    const { period = '30d', fromDate, toDate, groupBy = 'day' } = req.query;
    const { start, end } = getDateRange(period, fromDate, toDate);
    const dateGroup = getDateGrouping(groupBy, 'created_at');

    const result = await query(`
      SELECT 
        ${dateGroup} AS date_period,
        COALESCE(SUM(volume_lots), 0) AS total_lots,
        COALESCE(SUM(volume_lots * 100000), 0) AS total_volume_usd,
        COUNT(*)::int AS trade_count,
        COUNT(DISTINCT ib_request_id)::int AS ib_count,
        COUNT(DISTINCT symbol)::int AS symbol_count
      FROM ib_trade_history
      WHERE created_at IS NOT NULL
        AND created_at >= $1 AND created_at <= $2
        AND volume_lots > 0
        AND close_price IS NOT NULL
      GROUP BY ${dateGroup}
      ORDER BY date_period ASC
    `, [start, end]);

    const trends = result.rows.map(row => ({
      date: row.date_period ? (row.date_period instanceof Date ? row.date_period.toISOString().split('T')[0] : String(row.date_period).split('T')[0]) : '',
      lots: num(row.total_lots),
      volumeUsd: num(row.total_volume_usd),
      tradeCount: num(row.trade_count),
      ibCount: num(row.ib_count),
      symbolCount: num(row.symbol_count)
    }));

    res.json({ success: true, data: { trends } });
  } catch (error) {
    console.error('Trading volume error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch trading volume', error: error.message });
  }
});

// GET /api/admin/ib-reports/client-growth
router.get('/client-growth', authenticateAdminToken, async (req, res) => {
  try {
    const { period = '30d', fromDate, toDate, groupBy = 'day' } = req.query;
    const { start, end } = getDateRange(period, fromDate, toDate);
    const dateGroup = getDateGrouping(groupBy, 'linked_at');

    const result = await query(`
      SELECT 
        ${dateGroup} AS date_period,
        COUNT(DISTINCT user_id)::int AS new_clients,
        COUNT(DISTINCT assigned_ib_id)::int AS ibs_with_new_clients
      FROM ib_client_linking
      WHERE status = 'active'
        AND linked_at IS NOT NULL
        AND linked_at >= $1 AND linked_at <= $2
      GROUP BY ${dateGroup}
      ORDER BY date_period ASC
    `, [start, end]);

    const growth = result.rows.map(row => ({
      date: row.date_period ? (row.date_period instanceof Date ? row.date_period.toISOString().split('T')[0] : String(row.date_period).split('T')[0]) : '',
      newClients: num(row.new_clients),
      ibsWithNewClients: num(row.ibs_with_new_clients)
    }));

    res.json({ success: true, data: { growth } });
  } catch (error) {
    console.error('Client growth error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch client growth', error: error.message });
  }
});

// GET /api/admin/ib-reports/withdrawals
router.get('/withdrawals', authenticateAdminToken, async (req, res) => {
  try {
    const { period = '30d', fromDate, toDate, groupBy = 'day' } = req.query;
    const { start, end } = getDateRange(period, fromDate, toDate);
    const dateGroup = getDateGrouping(groupBy, 'created_at');

    const result = await query(`
      SELECT 
        ${dateGroup} AS date_period,
        LOWER(status) AS status,
        COALESCE(SUM(amount), 0) AS total_amount,
        COUNT(*)::int AS request_count
      FROM ib_withdrawal_requests
      WHERE created_at IS NOT NULL
        AND created_at >= $1 AND created_at <= $2
      GROUP BY ${dateGroup}, LOWER(status)
      ORDER BY date_period ASC, status ASC
    `, [start, end]);

    // Group by date and status
    const grouped = {};
    result.rows.forEach(row => {
      const dateStr = row.date_period ? (row.date_period instanceof Date ? row.date_period.toISOString().split('T')[0] : String(row.date_period).split('T')[0]) : '';
      if (!dateStr) return;
      if (!grouped[dateStr]) {
        grouped[dateStr] = { date: dateStr, pending: 0, paid: 0, completed: 0, rejected: 0, total: 0 };
      }
      const status = row.status || 'pending';
      grouped[dateStr][status] = num(row.total_amount);
      grouped[dateStr].total += num(row.total_amount);
    });

    const trends = Object.values(grouped);

    res.json({ success: true, data: { trends } });
  } catch (error) {
    console.error('Withdrawals error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch withdrawals', error: error.message });
  }
});

// GET /api/admin/ib-reports/top-performers
router.get('/top-performers', authenticateAdminToken, async (req, res) => {
  try {
    const { period = '30d', fromDate, toDate, limit = 10, sortBy = 'commission' } = req.query;
    const { start, end } = getDateRange(period, fromDate, toDate);
    const limitNum = Math.min(parseInt(limit) || 10, 100);

    let orderBy;
    switch (sortBy) {
      case 'volume':
        orderBy = 'total_volume_usd DESC';
        break;
      case 'clients':
        orderBy = 'total_clients DESC';
        break;
      case 'trades':
        orderBy = 'total_trades DESC';
        break;
      default:
        orderBy = 'total_commission DESC';
    }

    const result = await query(`
      WITH ib_stats AS (
        SELECT 
          ir.id AS ib_id,
          ir.full_name AS ib_name,
          ir.email AS ib_email,
          ir.status AS ib_status,
          COALESCE(ic.total_commission, 0) AS total_commission,
          COALESCE(ic.fixed_commission, 0) AS fixed_commission,
          COALESCE(ic.spread_commission, 0) AS spread_commission,
          COALESCE(SUM(ith.volume_lots), 0) AS total_volume_lots,
          COALESCE(SUM(ith.volume_lots * 100000), 0) AS total_volume_usd,
          COALESCE(icl.client_count, 0)::int + COALESCE(irf.referral_count, 0)::int + COALESCE(irr.ib_referral_count, 0)::int AS total_clients,
          COUNT(DISTINCT ith.order_id)::int AS total_trades
        FROM ib_requests ir
        LEFT JOIN (
          SELECT 
            ib_request_id,
            SUM(total_commission) AS total_commission,
            SUM(fixed_commission) AS fixed_commission,
            SUM(spread_commission) AS spread_commission
          FROM ib_commission
          WHERE last_updated >= $1 AND last_updated <= $2
          GROUP BY ib_request_id
        ) ic ON ir.id = ic.ib_request_id
        LEFT JOIN ib_trade_history ith ON ir.id = ith.ib_request_id 
          AND ith.created_at >= $1 AND ith.created_at <= $2
          AND ith.volume_lots > 0
          AND ith.close_price IS NOT NULL
        LEFT JOIN (
          SELECT 
            assigned_ib_id,
            COUNT(DISTINCT user_id)::int AS client_count
          FROM ib_client_linking
          WHERE status = 'active'
          GROUP BY assigned_ib_id
        ) icl ON ir.id = icl.assigned_ib_id
        LEFT JOIN (
          SELECT 
            ib_request_id,
            COUNT(DISTINCT user_id)::int AS referral_count
          FROM ib_referrals
          WHERE user_id IS NOT NULL
          GROUP BY ib_request_id
        ) irf ON ir.id = irf.ib_request_id
        LEFT JOIN (
          SELECT 
            referred_by,
            COUNT(DISTINCT id)::int AS ib_referral_count
          FROM ib_requests
          WHERE referred_by IS NOT NULL
          GROUP BY referred_by
        ) irr ON ir.id = irr.referred_by
        WHERE ir.created_at <= $2
        GROUP BY ir.id, ir.full_name, ir.email, ir.status, ic.total_commission, ic.fixed_commission, ic.spread_commission, icl.client_count, irf.referral_count, irr.ib_referral_count
        HAVING (
          COALESCE(ic.total_commission, 0) > 0 OR
          COALESCE(SUM(ith.volume_lots), 0) > 0 OR
          COALESCE(icl.client_count, 0) + COALESCE(irf.referral_count, 0) + COALESCE(irr.ib_referral_count, 0) > 0
        )
      )
      SELECT * FROM ib_stats
      ORDER BY ${orderBy}
      LIMIT $3
    `, [start, end, limitNum]);

    const performers = result.rows.map(row => ({
      ibId: num(row.ib_id),
      ibName: row.ib_name || row.ib_email || 'Unknown',
      ibEmail: row.ib_email,
      ibStatus: row.ib_status,
      totalCommission: num(row.total_commission),
      fixedCommission: num(row.fixed_commission),
      spreadCommission: num(row.spread_commission),
      totalVolumeLots: num(row.total_volume_lots),
      totalVolumeUsd: num(row.total_volume_usd),
      totalClients: num(row.total_clients),
      totalTrades: num(row.total_trades)
    }));

    res.json({ success: true, data: { performers } });
  } catch (error) {
    console.error('Top performers error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch top performers', error: error.message });
  }
});

// GET /api/admin/ib-reports/reward-claims
router.get('/reward-claims', authenticateAdminToken, async (req, res) => {
  try {
    const { period = '30d', fromDate, toDate } = req.query;
    const { start, end } = getDateRange(period, fromDate, toDate);

    const result = await query(`
      SELECT 
        status,
        COUNT(*)::int AS claim_count,
        COALESCE(SUM(total_volume_mln), 0) AS total_volume_mln
      FROM ib_reward_claims
      WHERE claimed_at IS NOT NULL
        AND claimed_at >= $1 AND claimed_at <= $2
      GROUP BY status
      ORDER BY status ASC
    `, [start, end]);

    const stats = result.rows.map(row => ({
      status: row.status || 'pending',
      count: num(row.claim_count),
      totalVolumeMln: num(row.total_volume_mln)
    }));

    res.json({ success: true, data: { stats } });
  } catch (error) {
    console.error('Reward claims error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch reward claims', error: error.message });
  }
});

// GET /api/admin/ib-reports/export
router.get('/export', authenticateAdminToken, async (req, res) => {
  try {
    const { period = '30d', fromDate, toDate, type = 'summary' } = req.query;
    const { start, end } = getDateRange(period, fromDate, toDate);

    let data, filename;
    
    switch (type) {
      case 'top-performers': {
        const result = await query(`
          SELECT 
            ir.id AS ib_id,
            ir.full_name AS ib_name,
            ir.email AS ib_email,
            ir.status AS ib_status,
            COALESCE(SUM(ic.total_commission), 0) AS total_commission,
            COALESCE(SUM(ith.volume_lots), 0) AS total_volume_lots,
            COALESCE(SUM(ith.volume_lots * 100000), 0) AS total_volume_usd,
            COUNT(DISTINCT icl.user_id)::int AS total_clients,
            COUNT(DISTINCT ith.id)::int AS total_trades
          FROM ib_requests ir
          LEFT JOIN ib_commission ic ON ir.id = ic.ib_request_id 
            AND ic.last_updated >= $1 AND ic.last_updated <= $2
          LEFT JOIN ib_trade_history ith ON ir.id = ith.ib_request_id 
            AND ith.created_at >= $1 AND ith.created_at <= $2
          LEFT JOIN ib_client_linking icl ON ir.id = icl.assigned_ib_id 
            AND icl.status = 'active'
          WHERE ir.created_at <= $2
          GROUP BY ir.id, ir.full_name, ir.email, ir.status
          ORDER BY total_commission DESC
        `, [start, end]);
        
        data = result.rows;
        filename = `ib-top-performers-${start.toISOString().split('T')[0]}-${end.toISOString().split('T')[0]}.csv`;
        break;
      }
      
      case 'commission': {
        const result = await query(`
          SELECT 
            ir.id AS ib_id,
            ir.full_name AS ib_name,
            ir.email AS ib_email,
            COALESCE(SUM(ic.total_commission), 0) AS total_commission,
            COALESCE(SUM(ic.fixed_commission), 0) AS fixed_commission,
            COALESCE(SUM(ic.spread_commission), 0) AS spread_commission,
            COUNT(DISTINCT ic.user_id)::int AS user_count
          FROM ib_requests ir
          LEFT JOIN ib_commission ic ON ir.id = ic.ib_request_id 
            AND ic.last_updated >= $1 AND ic.last_updated <= $2
          WHERE ir.created_at <= $2
          GROUP BY ir.id, ir.full_name, ir.email
          HAVING COALESCE(SUM(ic.total_commission), 0) > 0
          ORDER BY total_commission DESC
        `, [start, end]);
        
        data = result.rows;
        filename = `ib-commission-breakdown-${start.toISOString().split('T')[0]}-${end.toISOString().split('T')[0]}.csv`;
        break;
      }
      
      default: {
        // Summary export
        const [summary, trends] = await Promise.all([
          query(`SELECT * FROM ib_requests WHERE created_at >= $1 AND created_at <= $2`, [start, end]),
          query(`SELECT * FROM ib_commission WHERE last_updated >= $1 AND last_updated <= $2`, [start, end])
        ]);
        
        data = { summary: summary.rows, trends: trends.rows };
        filename = `ib-reports-summary-${start.toISOString().split('T')[0]}-${end.toISOString().split('T')[0]}.csv`;
      }
    }

    // Convert to CSV
    let csv = '';
    if (Array.isArray(data) && data.length > 0) {
      // Get headers from first row
      const headers = Object.keys(data[0]);
      csv += headers.join(',') + '\n';
      
      // Add rows
      data.forEach(row => {
        const values = headers.map(header => {
          const value = row[header];
          // Escape commas and quotes in CSV
          if (value === null || value === undefined) return '';
          const str = String(value);
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        });
        csv += values.join(',') + '\n';
      });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ success: false, message: 'Unable to export data', error: error.message });
  }
});

export default router;

