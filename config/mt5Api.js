/**
 * MT5 API Configuration
 * Centralized configuration for MT5 API endpoints
 */

// MT5 API Base URL - can be overridden via environment variable
export const MT5_API_BASE = process.env.MT5_API_BASE_URL || 'http://13.43.216.232:5003';

// Helper function to build full API URL
export const getMT5ApiUrl = (endpoint) => {
  // Remove leading slash if present to avoid double slashes
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  // Ensure base URL doesn't end with slash
  const cleanBase = MT5_API_BASE.endsWith('/') ? MT5_API_BASE.slice(0, -1) : MT5_API_BASE;
  return `${cleanBase}/${cleanEndpoint}`;
};

// Common MT5 API endpoints
export const MT5_ENDPOINTS = {
  // Authentication
  LOGIN: 'api/client/ClientAuth/login',
  
  // User/Account endpoints
  GET_CLIENT_PROFILE: (accountId) => `api/Users/${accountId}/getClientProfile`,
  GET_CLIENT_BALANCE: (accountId) => `api/Users/${accountId}/getClientBalance`,
  
  // Trade History
  TRADES: 'api/client/tradehistory/trades',
  TRADES_CLOSED: 'api/client/tradehistory/trades-closed',
  
  // Groups
  GROUPS: 'api/Groups',
  
  // Symbols
  SYMBOLS: 'api/Symbols',
  SYMBOLS_CATEGORIES: 'api/Symbols/categories',
};

export default {
  MT5_API_BASE,
  getMT5ApiUrl,
  MT5_ENDPOINTS
};

