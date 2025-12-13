import pg from 'pg';
const { Pool } = pg;

// Use the production DB URL provided by the user
const connectionString = 'postgresql://solitaire_user:uMzSkY2AvyPvziS78wPx3gHbiC4oaglX@dpg-d4k8g363jp1c738m1a1g-a.oregon-postgres.render.com/solitaire';

const pool = new Pool({
    connectionString,
    ssl: {
        rejectUnauthorized: false
    }
});

async function checkAdmin() {
    try {
        console.log('Connecting to database...');
        const result = await pool.query('SELECT id, email, role, is_active, password_hash, created_at FROM ib_admin');
        console.log('Connection successful.');
        console.log(`Found ${result.rows.length} admin users.`);
        console.table(result.rows);
    } catch (err) {
        console.error('Database error:', err);
    } finally {
        await pool.end();
    }
}

checkAdmin();
