require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors()); 
app.use(express.json());

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 自动初始化数据表（增加 websites 站点管理表）
async function initDatabase() {
  const createLogsTable = `
    CREATE TABLE IF NOT EXISTS traffic_logs (
      id SERIAL PRIMARY KEY,
      domain VARCHAR(255) NOT NULL,
      source VARCHAR(100) DEFAULT 'organic',
      campaign VARCHAR(255) DEFAULT 'none',
      ip_address VARCHAR(45),
      device TEXT,
      event_type VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createLinksTable = `
    CREATE TABLE IF NOT EXISTS tracking_links (
      id SERIAL PRIMARY KEY,
      target_url TEXT NOT NULL,
      source VARCHAR(100) NOT NULL,
      campaign VARCHAR(255) NOT NULL,
      full_link TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createWebsitesTable = `
    CREATE TABLE IF NOT EXISTS websites (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      desc_text TEXT,
      url TEXT NOT NULL,
      icon_url TEXT,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    await pool.query(createLogsTable);
    await pool.query(createLinksTable);
    await pool.query(createWebsitesTable);
    console.log('Database initialized: All tables are ready.');

    // 检查是否有数据，若没有则插入示例数据
    const checkRes = await pool.query(`SELECT COUNT(*) FROM websites`);
    if (parseInt(checkRes.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO websites (name, desc_text, url, icon_url, sort_order) VALUES
        ('官方主站', '获取最新产品资讯与核心服务', 'https://example.com', 'https://api.dicebear.com/7.x/identicon/svg?seed=site1', 1),
        ('优惠商城', '限时特惠产品与领券中心', 'https://example.com', 'https://api.dicebear.com/7.x/identicon/svg?seed=site2', 2);
      `);
      console.log('Initial sample websites added.');
    }
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

if (process.env.DATABASE_URL) {
  initDatabase();
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ------------------- 站点配置 API (新增) -------------------

// 获取所有站点配置
app.get('/api/websites', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM websites ORDER BY sort_order ASC, id ASC`);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// 添加新站点
app.post('/api/websites', async (req, res) => {
  const { name, desc_text, url, icon_url } = req.body;
  try {
    const query = `
      INSERT INTO websites (name, desc_text, url, icon_url)
      VALUES ($1, $2, $3, $4) RETURNING *
    `;
    const result = await pool.query(query, [name, desc_text, url, icon_url]);
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// 编辑已有站点
app.put('/api/websites/:id', async (req, res) => {
  const { id } = req.params;
  const { name, desc_text, url, icon_url } = req.body;
  try {
    const query = `
      UPDATE websites 
      SET name = $1, desc_text = $2, url = $3, icon_url = $4
      WHERE id = $5 RETURNING *
    `;
    const result = await pool.query(query, [name, desc_text, url, icon_url, id]);
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// 删除站点
app.delete('/api/websites/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(`DELETE FROM websites WHERE id = $1`, [id]);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// ------------------- 打点与统计 API -------------------

app.post('/track/view', async (req, res) => {
  const { website_domain, source, campaign, user_agent } = req.body;
  const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const query = `INSERT INTO traffic_logs (domain, source, campaign, ip_address, device, event_type) VALUES ($1, $2, $3, $4, $5, 'view')`;
    await pool.query(query, [website_domain, source, campaign, ip_address, user_agent]);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.post('/track/lead', async (req, res) => {
  const { website_domain, source, campaign, user_agent } = req.body;
  const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const query = `INSERT INTO traffic_logs (domain, source, campaign, ip_address, device, event_type) VALUES ($1, $2, $3, $4, $5, 'lead')`;
    await pool.query(query, [website_domain, source, campaign, ip_address, user_agent]);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const query = `
      SELECT domain, source, 
        COUNT(*) FILTER (WHERE event_type = 'view') as views,
        COUNT(*) FILTER (WHERE event_type = 'lead') as leads
      FROM traffic_logs GROUP BY domain, source ORDER BY views DESC
    `;
    const result = await pool.query(query);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/links', async (req, res) => {
  const { target_url, source, campaign, full_link } = req.body;
  try {
    const query = `INSERT INTO tracking_links (target_url, source, campaign, full_link) VALUES ($1, $2, $3, $4) RETURNING *`;
    const result = await pool.query(query, [target_url, source, campaign, full_link]);
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/links', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM tracking_links ORDER BY created_at DESC`);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
