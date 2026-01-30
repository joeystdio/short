const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const { nanoid } = require('nanoid');
const geoip = require('geoip-lite');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Middleware
app.use(express.json());
app.use(cookieParser());

// Auth check for main page - redirect if not logged in
app.get('/', (req, res, next) => {
  const sessionCookie = req.cookies['__Secure-next-auth.session-token'] || 
                        req.cookies['next-auth.session-token'];
  if (!sessionCookie) {
    return res.redirect('https://auth.jdms.nl/login?callbackUrl=https://short.jdms.nl');
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

// Initialize database
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      slug VARCHAR(50) UNIQUE NOT NULL,
      url TEXT NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS clicks (
      id SERIAL PRIMARY KEY,
      link_id INTEGER REFERENCES links(id) ON DELETE CASCADE,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      referrer TEXT,
      user_agent TEXT,
      country VARCHAR(10),
      ip_hash VARCHAR(64)
    );
    
    CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug);
    CREATE INDEX IF NOT EXISTS idx_links_user ON links(user_id);
    CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(link_id);
  `);
  console.log('Database initialized');
}

// SSO Auth middleware
async function requireAuth(req, res, next) {
  const sessionCookie = req.cookies['__Secure-next-auth.session-token'] || 
                        req.cookies['next-auth.session-token'];
  
  if (!sessionCookie) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    const response = await fetch('https://auth.jdms.nl/api/validate', {
      method: 'GET',
      headers: {
        'Cookie': `__Secure-next-auth.session-token=${sessionCookie}; next-auth.session-token=${sessionCookie}`
      }
    });
    
    if (!response.ok) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    
    const data = await response.json();
    if (!data.valid) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    req.user = data.user;
    next();
  } catch (err) {
    console.error('Auth validation error:', err);
    return res.status(401).json({ error: 'Auth service unavailable' });
  }
}

// API: Get current user
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// API: Create short link
app.post('/api/links', requireAuth, async (req, res) => {
  try {
    const { url, slug: customSlug } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const slug = customSlug || nanoid(7);
    const userId = req.user.id || req.user.sub || req.user.email;
    
    // Check if custom slug exists
    if (customSlug) {
      const existing = await pool.query('SELECT id FROM links WHERE slug = $1', [slug]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Slug already taken' });
      }
    }
    
    const result = await pool.query(
      'INSERT INTO links (slug, url, user_id) VALUES ($1, $2, $3) RETURNING *',
      [slug, url, userId]
    );
    
    res.json({ 
      link: result.rows[0],
      shortUrl: `https://short.jdms.nl/${slug}`
    });
  } catch (err) {
    console.error('Create link error:', err);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// API: Get user's links with stats
app.get('/api/links', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.sub || req.user.email;
    
    const result = await pool.query(`
      SELECT 
        l.*,
        COUNT(c.id)::int as click_count,
        MAX(c.timestamp) as last_click
      FROM links l
      LEFT JOIN clicks c ON c.link_id = l.id
      WHERE l.user_id = $1
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `, [userId]);
    
    res.json({ links: result.rows });
  } catch (err) {
    console.error('Get links error:', err);
    res.status(500).json({ error: 'Failed to fetch links' });
  }
});

// API: Get link details with click stats
app.get('/api/links/:slug/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.sub || req.user.email;
    const { slug } = req.params;
    
    const linkResult = await pool.query(
      'SELECT * FROM links WHERE slug = $1 AND user_id = $2',
      [slug, userId]
    );
    
    if (linkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }
    
    const link = linkResult.rows[0];
    
    const clicksResult = await pool.query(`
      SELECT timestamp, referrer, user_agent, country
      FROM clicks
      WHERE link_id = $1
      ORDER BY timestamp DESC
      LIMIT 100
    `, [link.id]);
    
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*)::int as total_clicks,
        COUNT(DISTINCT DATE(timestamp))::int as unique_days,
        COUNT(DISTINCT country) FILTER (WHERE country IS NOT NULL)::int as countries
      FROM clicks
      WHERE link_id = $1
    `, [link.id]);
    
    const countryStats = await pool.query(`
      SELECT country, COUNT(*)::int as count
      FROM clicks
      WHERE link_id = $1 AND country IS NOT NULL
      GROUP BY country
      ORDER BY count DESC
      LIMIT 10
    `, [link.id]);
    
    res.json({
      link,
      stats: statsResult.rows[0],
      countries: countryStats.rows,
      recentClicks: clicksResult.rows
    });
  } catch (err) {
    console.error('Get stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// API: Delete link
app.delete('/api/links/:slug', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.sub || req.user.email;
    const { slug } = req.params;
    
    const result = await pool.query(
      'DELETE FROM links WHERE slug = $1 AND user_id = $2 RETURNING *',
      [slug, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Delete link error:', err);
    res.status(500).json({ error: 'Failed to delete link' });
  }
});

// Public: Redirect short link (no auth required)
app.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    // Skip API and static routes
    if (slug === 'api' || slug === 'favicon.ico') {
      return res.status(404).send('Not found');
    }
    
    const result = await pool.query(
      'SELECT * FROM links WHERE slug = $1',
      [slug]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).send('Link not found');
    }
    
    const link = result.rows[0];
    
    // Track click (async, don't wait)
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const geo = geoip.lookup(ip);
    const country = geo?.country || null;
    
    pool.query(
      'INSERT INTO clicks (link_id, referrer, user_agent, country, ip_hash) VALUES ($1, $2, $3, $4, $5)',
      [link.id, req.headers.referer || null, req.headers['user-agent'] || null, country, hashIP(ip)]
    ).catch(err => console.error('Click tracking error:', err));
    
    res.redirect(302, link.url);
  } catch (err) {
    console.error('Redirect error:', err);
    res.status(500).send('Error');
  }
});

// Simple IP hash for privacy
function hashIP(ip) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(ip + process.env.IP_SALT || 'salt').digest('hex').substring(0, 16);
}

// Start server
initDB().then(() => {
  app.listen(port, () => {
    console.log(`Short running on port ${port}`);
  });
}).catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});
