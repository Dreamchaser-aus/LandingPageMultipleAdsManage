require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
// 允许所有域名跨域提交打点数据
app.use(cors()); 
app.use(express.json());

// 获取 Railway 提供的动态端口
const PORT = process.env.PORT || 3000;

// 配置 PostgreSQL 数据库连接 (Railway 会自动注入 DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // 生产环境下 Railway 的 PG 数据库通常需要 SSL
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

// 启动时建表
if (process.env.DATABASE_URL) {
  initDatabase();
} else {
  console.warn('Warning: DATABASE_URL is not set. Database operations will fail.');
}

// 接口：健康检查 (Railway 部署时会调用)
app.get('/', (req, res) => {
  res.send('Tracking API is running successfully on Railway!');
});

// 接口：记录浏览事件 (PV)
app.post('/track/view', async (req, res) => {
  const { website_domain, source, campaign, user_agent } = req.body;
  // 获取真实的客户端 IP
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

// 接口：记录转化事件 (Lead/Sale)
app.post('/track/lead', async (req, res) => {
  const { website_domain, source, campaign, user_agent, extra_data } = req.body;
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

// 接口：获取简单的数据统计报表 (供你的管理后台调用)
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
