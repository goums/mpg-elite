const { Pool } = require('pg');

// Create a connection pool using environment variable with SSL configuration
const pool = new Pool({
  connectionString: process.env.POSTGRES_URI,
  ssl: {
    // In production with proper certificates, you might want to set this to true
    rejectUnauthorized: false
  }
});

// Store initialization promise to ensure proper sequencing
let dbInitPromise;

// Initialize database - create config table if not exists
async function initDatabase() {
  try {
    const client = await pool.connect();
    try {
      // Check if the config table already exists
      const tableExists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'config'
        )
      `);
      
      // If table exists, assume database is already initialized
      if (tableExists.rows[0].exists) {
        console.log('Database already initialized');
        return;
      }
      
      // Create config table if we get here
      await client.query(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT,
          lastUpdate TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Initialize MPG_TOKEN and MPG_SESSION_TOKEN from environment variables
      const mpgToken = process.env.MPG_TOKEN || '';
      const mpgSessionToken = process.env.MPG_SESSION_TOKEN || '';
      
      // Insert both config values
      await client.query('INSERT INTO config (key, value) VALUES ($1, $2)', ['MPG_TOKEN', mpgToken]);
      await client.query('INSERT INTO config (key, value) VALUES ($1, $2)', ['MPG_SESSION_TOKEN', mpgSessionToken]);
      
      console.log('Database initialized successfully');
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

// Get config value by key
async function getConfig(key) {
  // Wait for database initialization before proceeding
  await dbInitPromise;
  
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT value FROM config WHERE key = $1', [key]);
    return result.rows.length > 0 ? result.rows[0].value : null;
  } finally {
    client.release();
  }
}

// Set config value by key
async function setConfig(key, value) {
  // Wait for database initialization before proceeding
  await dbInitPromise;
  
  const client = await pool.connect();
  try {
    // Use upsert (INSERT ... ON CONFLICT) to handle both insert and update cases
    await client.query(
      'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, value]
    );
    return true;
  } finally {
    client.release();
  }
}

// Initialize database on module load and store the promise
dbInitPromise = initDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

module.exports = {
  getConfig,
  setConfig,
  pool, // Exposing pool can be useful for other database operations
  dbReady: dbInitPromise // Export the initialization promise for external use
};
