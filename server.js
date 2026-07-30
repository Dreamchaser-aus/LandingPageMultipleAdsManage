require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path'); // 新增：路径解析模块
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

// 自动初始化数据表
async function initDatabase() {
  const createTableQuery = `
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
  try {
    await pool.query(createTableQuery);
    console.log('Database initialized: traffic_logs table is ready.');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

if (process.env.DATABASE_URL) {
  initDatabase();
}

// ------------------- 核心新增：托管静态文件 -------------------

// 开启 static 中间件
app.use(express.static(path.join(__dirname, 'public')));

// 1. 访问首页 / 直接展示落地页 (index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. 访问 /admin 直接展示后台管理界面 (admin.html)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ------------------- 后端 API 接口 -------------------

// 接口：记录浏览事件 (PV)
app.post('/track/view', async (req, res) => {
  const { website_domain, source, campaign, user_agent } = req.body;
  const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const query = `
      INSERT INTO traffic_logs (domain, source, campaign, ip_address, device, event_type)
      VALUES ($1, $2, $3, $4, $5, 'view')
    `;
    await pool.query(query, [website_domain, source, campaign, ip_address, user_agent]);
    res.status(200).json({ success: true, message: 'View tracked' });
  } catch (error) {
    console.error('Track View Error:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// 接口：记录转化事件 (Lead)
app.post('/track/lead', async (req, res) => {
  const { website_domain, source, campaign, user_agent } = req.body;
  const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  try {
    const query = `
      INSERT INTO traffic_logs (domain, source, campaign, ip_address, device, event_type)
      VALUES ($1, $2, $3, $4, $5, 'lead')
    `;
    await pool.query(query, [website_domain, source, campaign, ip_address, user_agent]);
    res.status(200).json({ success: true, message: 'Lead tracked' });
  } catch (error) {
    console.error('Track Lead Error:', error);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// 接口：获取数据统计报表
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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
