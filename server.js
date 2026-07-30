const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL 数据库连接
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// 强化 JSON 解析，兼容 sendBeacon 和普通 fetch 格式
app.use(express.json({ type: ['application/json', 'text/plain', '*/*'] }));

// 静态文件服务：配置 extensions: ['html']
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// 页面路由拦截：确保直接访问 /admin 能够成功渲染 admin.html
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 数据库建表与修复初始化
async function initDB() {
  try {
    // 1. 落地页站点表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS websites (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        desc_text VARCHAR(255),
        url TEXT NOT NULL,
        icon_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. 推广链接历史表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS links (
        id SERIAL PRIMARY KEY,
        target_url TEXT NOT NULL,
        source VARCHAR(50) NOT NULL,
        campaign VARCHAR(50) NOT NULL,
        full_link TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. 统计报表表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stats (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(255) NOT NULL,
        source VARCHAR(50) NOT NULL,
        views INT DEFAULT 0,
        leads INT DEFAULT 0,
        CONSTRAINT unique_domain_source UNIQUE(domain, source)
      );
    `);

    // 尝试添加唯一约束 (防止旧表缺少约束导致 ON CONFLICT 报错)
    try {
      await pool.query(`ALTER TABLE stats ADD CONSTRAINT unique_domain_source UNIQUE(domain, source);`);
    } catch (e) {
      // 约束若已存在会触发此捕获，属正常情况
    }

    // 4. 用户点击日志轨迹表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS click_logs (
        id SERIAL PRIMARY KEY,
        visitor_id VARCHAR(100) NOT NULL,
        website_id INT,
        website_name VARCHAR(100),
        source VARCHAR(50),
        campaign VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('数据库初始化/检查完成');
  } catch (err) {
    console.error('数据库初始化错误:', err);
  }
}

initDB();

// ------------------- API 路由 -------------------

// 1. 获取所有落地页站点
app.get('/api/websites', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM websites ORDER BY id ASC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 新增站点
app.post('/api/websites', async (req, res) => {
  const { name, desc_text, url, icon_url } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO websites (name, desc_text, url, icon_url) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, desc_text, url, icon_url]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 修改站点
app.put('/api/websites/:id', async (req, res) => {
  const { id } = req.params;
  const { name, desc_text, url, icon_url } = req.body;
  try {
    const result = await pool.query(
      'UPDATE websites SET name=$1, desc_text=$2, url=$3, icon_url=$4 WHERE id=$5 RETURNING *',
      [name, desc_text, url, icon_url, id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 删除站点
app.delete('/api/websites/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM websites WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. 推广链接生成与查询（增加了缺省降级查询）
app.get('/api/links', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM links ORDER BY id DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('获取历史链接失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/links', async (req, res) => {
  const { target_url, source, campaign, full_link } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO links (target_url, source, campaign, full_link) VALUES ($1, $2, $3, $4) RETURNING *',
      [target_url, source, campaign, full_link]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. 数据报表统计
app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM stats ORDER BY leads DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. 记录用户跨站点点击轨迹 (增加了容错防刷逻辑)
app.post('/api/track-click', async (req, res) => {
  let bodyData = req.body;
  
  // 处理字符串 Body 兼容性
  if (typeof bodyData === 'string') {
    try { bodyData = JSON.parse(bodyData); } catch (e) {}
  }

  const { visitor_id, website_id, website_name, source, campaign } = bodyData || {};

  if (!website_name) {
    return res.status(400).json({ success: false, error: '参数不完整' });
  }

  try {
    // 写入日志
    await pool.query(
      `INSERT INTO click_logs (visitor_id, website_id, website_name, source, campaign) 
       VALUES ($1, $2, $3, $4, $5)`,
      [visitor_id || 'unknown', website_id || 0, website_name, source || 'direct', campaign || 'none']
    );

    // 更新汇总统计
    await pool.query(
      `INSERT INTO stats (domain, source, views, leads) 
       VALUES ($1, $2, 0, 1)
       ON CONFLICT (domain, source) 
       DO UPDATE SET leads = stats.leads + 1`,
      [website_name, source || 'direct']
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Track Click Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. 获取用户点击轨迹列表
app.get('/api/user-journeys', async (req, res) => {
  try {
    const query = `
      SELECT 
        visitor_id,
        source,
        campaign,
        COUNT(*) as total_clicks,
        STRING_AGG(website_name, ' ➔ ' ORDER BY id ASC) as click_path,
        MAX(created_at) as last_active
      FROM click_logs
      GROUP BY visitor_id, source, campaign
      ORDER BY last_active DESC
      LIMIT 100;
    `;
    const result = await pool.query(query);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`服务启动成功，端口: ${PORT}`);
});
