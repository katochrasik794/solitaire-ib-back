import pg from 'pg';
import bcrypt from 'bcryptjs';
const { Pool } = pg;

// Production DB URL
const connectionString = 'postgresql://solitaire_user:uMzSkY2AvyPvziS78wPx3gHbiC4oaglX@dpg-d4k8g363jp1c738m1a1g-a.oregon-postgres.render.com/solitaire';

const pool = new Pool({
    connectionString,
    ssl: {
        rejectUnauthorized: false
    }
});

const DEFAULT_ADMIN_EMAIL = 'admin_ib@solitaire-ib.com';
const DEFAULT_ADMIN_PASSWORD = 'Admin@000';

async function fixAdmin() {
    try {
        console.log('Connecting to database...');

        // Hash the password
        const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 12);

        // Check if user exists
        const checkRes = await pool.query('SELECT id, email FROM ib_admin WHERE email = $1', [DEFAULT_ADMIN_EMAIL]);

        if (checkRes.rows.length === 0) {
            console.log('Admin user NOT found. Creating...');
            await pool.query(
                'INSERT INTO ib_admin (email, password_hash, role, is_active) VALUES ($1, $2, $3, $4)',
                [DEFAULT_ADMIN_EMAIL, passwordHash, 'admin', true]
            );
            console.log('Admin user CREATED successfully.');
        } else {
            console.log('Admin user FOUND. Resetting password...');
            await pool.query(
                'UPDATE ib_admin SET password_hash = $1, is_active = $2 WHERE email = $3',
                [passwordHash, true, DEFAULT_ADMIN_EMAIL]
            );
            console.log('Admin user password RESET successfully.');
        }

        // Verify
        const verifyRes = await pool.query('SELECT id, email, role, is_active, created_at FROM ib_admin WHERE email = $1', [DEFAULT_ADMIN_EMAIL]);
        console.log('Verification Result:');
        console.log(JSON.stringify(verifyRes.rows[0], null, 2));

    } catch (err) {
        console.error('Database error:', err);
    } finally {
        await pool.end();
    }
}

fixAdmin();
