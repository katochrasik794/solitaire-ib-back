import { query } from './config/database.js';
import bcrypt from 'bcryptjs';

async function createInternal() {
    try {
        const hash = await bcrypt.hash('Test@123', 12);
        // Use ON CONFLICT DO NOTHING to avoid duplicate key errors if run multiple times
        const res = await query(`
      INSERT INTO ib_requests (full_name, email, password_hash, status, ib_type, referral_code) 
      VALUES ($1, $2, $3, $4, $5, $6) 
      ON CONFLICT (email) DO NOTHING
      RETURNING *
    `, ['Test IB User', 'test@solitaire.com', hash, 'approved', 'standard', 'TESTIB01']);

        if (res.rows.length > 0) {
            console.log('Created IB User:', res.rows[0]);
        } else {
            console.log('IB User already exists (skipped creation).');
        }
        process.exit(0);
    } catch (e) {
        console.error('Error creating IB user:', e);
        process.exit(1);
    }
}

createInternal();
