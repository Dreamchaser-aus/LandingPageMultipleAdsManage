require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors()); 
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 配置 PostgreSQL 数据库连接
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 自动初始化数据表（日志表 + 链接历史表）
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

  try {
    await pool.query(createLogsTable);
    await pool.query(createLinksTable);
    console.log('Database initialized: traffic_logs and tracking_links tables are ready.');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

if (process.env.DATABASE_URL) {
  initDatabase();
}

// ------------------- 托管前端页面 -------------------

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ------------------- 后端 API 接口 -------------------

// 1. 记录浏览事件 (PV)
app.post('/track/view', async (req, res) => {
  const { website_domain, source, campaign, user_agent } = req.body;
  const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const query = `
      INSERT INTO traffic_logs (domain, source, campaign, ip_address, device, event_type)
      VALUES ($1, $2, $3, $4, $5, 'view')
    `;
    await pool.query(query, [website_domain, source, campaign, ip_address, user_agent]);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Track View Error:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// 2. 记录转化事件 (Lead)
app.post('/track/lead', async (req, res) => {
  const { website_domain, source, campaign, user_agent } = req.body;
  const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const query = `
      INSERT INTO traffic_logs (domain, source, campaign, ip_address, device, event_type)
      VALUES ($1, $2, $3, $4, $5, 'lead')
    `;
    await pool.query(query, [website_domain, source, campaign, ip_address, user_agent]);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Track Lead Error:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// 3. 获取数据统计报表
app.get('/api/stats', async (req, res) => {
  try {
    const query = `
      SELECT 
        domain, 
        source, 
        COUNT(*) FILTER (WHERE event_type = 'view') as views,
        COUNT(*) FILTER (WHERE event_type = 'lead') as leads
      FROM traffic_logs
      GROUP BY domain, source
      ORDER BY views DESC
    `;
    const result = await pool.query(query);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Stats Error:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// 4. 保存生成的推广链接 (新增)
app.post('/api/links', async (req, res) => {
  const { target_url, source, campaign, full_link } = req.body;
  try {
    const query = `
      INSERT INTO tracking_links (target_url, source, campaign, full_link)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const result = await pool.query(query, [target_url, source, campaign, full_link]);
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Save Link Error:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// 5. 获取所有生成过的推广链接 (新增)
app.get('/api/links', async (req, res) => {
  try {
    const query = `SELECT * FROM tracking_links ORDER BY created_at DESC`;
    const result = await pool.query(query);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get Links Error:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
