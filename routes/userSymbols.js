import express from 'express';
import { SymbolsWithCategories } from '../models/SymbolsWithCategories.js';
// Removed authenticateToken - symbols list is public data
// import { authenticateToken } from './auth.js';

const router = express.Router();

// Get all active symbols for user (public endpoint - symbols are not sensitive data)
router.get('/', async (req, res) => {
  try {
    const filters = {
      page: 1,
      limit: 1000, // Get all symbols for dropdown
      category: req.query.category || 'all',
      status: 'active', // Only active symbols
      search: req.query.search || '',
      sortBy: 'symbol',
      sortDir: 'ASC'
    };

    console.log('Fetching symbols with filters:', filters);
    const result = await SymbolsWithCategories.findAll(filters);
    console.log(`Found ${result.symbols?.length || 0} symbols`);

    res.json({ 
      success: true, 
      data: result.symbols || []
    });
  } catch (error) {
    console.error('Fetch symbols error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Unable to fetch symbols', 
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined 
    });
  }
});

export default router;


