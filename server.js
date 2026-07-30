const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// 中间件配置
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 托管 public 静态目录
app.use(express.static(path.join(__dirname, 'public')));

// ================= 1. 连接 Railway PostgreSQL 数据库 =================
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    }
  : {
      host: process.env.PGHOST,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      port: process.env.PGPORT,
      ssl: { rejectUnauthorized: false }
    };

const pool = new Pool(poolConfig);

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ 连接 PostgreSQL 数据库失败详细原因:', err.message);
  } else {
    console.log('⚡ 已成功连接至 Railway PostgreSQL 数据库');
    release();
  }
});

// 初始化数据库表结构
async function initDatabase() {
  try {
    // 用户轨迹表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_tracks (
        id SERIAL PRIMARY KEY,
        visitor_id TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        source TEXT DEFAULT 'direct',
        campaign TEXT DEFAULT 'none',
        target_domain TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_visitor_active ON user_tracks(visitor_id, created_at)`);

    // 落地页站点卡片表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS websites (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        desc_text TEXT,
        url TEXT NOT NULL,
        icon_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 推广链接生成记录表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS generated_links (
        id SERIAL PRIMARY KEY,
        target_url TEXT NOT NULL,
        source TEXT NOT NULL,
        campaign TEXT NOT NULL,
        full_link TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 初始化默认卡片数据（如果表为空）
    const checkRes = await pool.query(`SELECT COUNT(*) AS count FROM websites`);
    if (parseInt(checkRes.rows[0].count, 10) === 0) {
      await pool.query(
        `INSERT INTO websites (name, desc_text, url, icon_url) VALUES ($1, $2, $3, $4)`,
        ['官方主商城', '全场限时折扣包邮', 'https://example.com/shop', 'https://api.dicebear.com/7.x/identicon/svg?seed=shop']
      );
      await pool.query(
        `INSERT INTO websites (name, desc_text, url, icon_url) VALUES ($1, $2, $3, $4)`,
        ['客服咨询领卷', '一对一专属客服支持', 'https://example.com/support', 'https://api.dicebear.com/7.x/identicon/svg?seed=support']
      );
      console.log('💡 已初始化默认落地页卡片数据');
    }
  } catch (err) {
    console.error('❌ 初始化数据表失败:', err.message);
  }
}

initDatabase();

// ================= 2. 路由：解决 Cannot GET /admin 问题 =================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ================= 3. API 接口 (PostgreSQL 适配版) =================

/**
 * 轨迹打点 API
 */
app.post('/api/track', async (req, res) => {
  const { visitor_id, target_domain, source, campaign } = req.body;
  const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const user_agent = req.headers['user-agent'] || 'Unknown';

  if (!visitor_id || !target_domain) {
    return res.status(400).json({ success: false, message: '缺少必要参数 visitor_id 或 target_domain' });
  }

  try {
    const query = `
      INSERT INTO user_tracks (visitor_id, ip_address, user_agent, source, campaign, target_domain)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `;
    const values = [visitor_id, ip_address, user_agent, source || 'direct', campaign || 'none', target_domain];
    const result = await pool.query(query, values);
    
    res.json({ success: true, track_id: result.rows[0].id });
  } catch (err) {
    console.error('❌ 记录轨迹失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 用户轨迹列表 API（严格按 visitor_id 聚合，确保分页与数据完全正确）
 */
app.get('/api/user-journeys', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
  const offset = (page - 1) * limit;

  try {
    // 1. 获取独立访客总数
    const countResult = await pool.query(`SELECT COUNT(DISTINCT visitor_id) AS total FROM user_tracks`);
    const total = parseInt(countResult.rows[0].total, 10);
    const totalPages = Math.ceil(total / limit) || 1;

    // 2. 严格按 visitor_id 分组查询
    const dataSql = `
      SELECT 
        visitor_id, 
        MAX(ip_address) AS ip_address, 
        MAX(user_agent) AS user_agent, 
        MAX(source) AS source, 
        MAX(campaign) AS campaign, 
        COUNT(*) AS total_clicks,
        MAX(created_at) AS last_active,
        STRING_AGG(target_domain, ' ➔ ' ORDER BY created_at ASC) AS click_path
      FROM user_tracks
      GROUP BY visitor_id
      ORDER BY last_active DESC
      LIMIT $1 OFFSET $2
    `;
    const dataResult = await pool.query(dataSql, [limit, offset]);

    res.json({
      success: true,
      data: dataResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (err) {
    console.error('❌ 获取轨迹失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 报表总览 API
 */
app.get('/api/stats', async (req, res) => {
  try {
    const sql = `
      SELECT 
        target_domain AS domain,
        source,
        COUNT(*) AS leads
      FROM user_tracks
      GROUP BY target_domain, source
      ORDER BY leads DESC
    `;
    const result = await pool.query(sql);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 落地页站点 API（查/增/改/删）
 */
app.get('/api/websites', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM websites ORDER BY id DESC`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/websites', async (req, res) => {
  const { name, desc_text, url, icon_url } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO websites (name, desc_text, url, icon_url) VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, desc_text, url, icon_url]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/websites/:id', async (req, res) => {
  const { name, desc_text, url, icon_url } = req.body;
  try {
    await pool.query(
      `UPDATE websites SET name = $1, desc_text = $2, url = $3, icon_url = $4 WHERE id = $5`,
      [name, desc_text, url, icon_url, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/websites/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM websites WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 推广链接历史记录 API
 */
app.get('/api/links', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM generated_links ORDER BY id DESC`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/links', async (req, res) => {
  const { target_url, source, campaign, full_link } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO generated_links (target_url, source, campaign, full_link) VALUES ($1, $2, $3, $4) RETURNING id`,
      [target_url, source, campaign, full_link]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ================= 4. 启动服务器 =================
app.listen(PORT, () => {
  console.log(`🚀 服务已成功运行在端口：${PORT}`);
});
