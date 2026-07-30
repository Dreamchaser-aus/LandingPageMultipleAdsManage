const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件配置
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 数据库初始化
const db = new sqlite3.Database('./tracker.db', (err) => {
  if (err) console.error('数据库连接失败:', err.message);
  else console.log('已成功连接到 SQLite 数据库 (tracker.db)');
});

// 建表逻辑
db.serialize(() => {
  // 1. 落地页卡片站点表
  db.run(`
    CREATE TABLE IF NOT EXISTS websites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      desc_text TEXT,
      url TEXT NOT NULL,
      icon_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. 点击与用户轨迹日志表 (含 IP 与 User-Agent)
  db.run(`
    CREATE TABLE IF NOT EXISTS click_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_id TEXT NOT NULL,
      website_id INTEGER,
      website_name TEXT NOT NULL,
      source TEXT DEFAULT 'direct',
      campaign TEXT DEFAULT 'none',
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. 推广链接历史记录表
  db.run(`
    CREATE TABLE IF NOT EXISTS generated_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_url TEXT NOT NULL,
      source TEXT NOT NULL,
      campaign TEXT NOT NULL,
      full_link TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// ==================== 路由接口 API ====================

// 后台入口重定向
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 1. 获取所有配置卡片
app.get('/api/websites', (req, res) => {
  db.all(`SELECT * FROM websites ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: rows });
  });
});

// 2. 新增卡片
app.post('/api/websites', (req, res) => {
  const { name, desc_text, url, icon_url } = req.body;
  if (!name || !url) return res.status(400).json({ success: false, error: '名称和 URL 不能为空' });

  db.run(
    `INSERT INTO websites (name, desc_text, url, icon_url) VALUES (?, ?, ?, ?)`,
    [name, desc_text, url, icon_url],
    function (err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// 3. 编辑卡片
app.put('/api/websites/:id', (req, res) => {
  const { name, desc_text, url, icon_url } = req.body;
  const { id } = req.params;

  db.run(
    `UPDATE websites SET name = ?, desc_text = ?, url = ?, icon_url = ? WHERE id = ?`,
    [name, desc_text, url, icon_url, id],
    function (err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, changes: this.changes });
    }
  );
});

// 4. 删除卡片
app.delete('/api/websites/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM websites WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, changes: this.changes });
  });
});

// 5. 点击轨迹上报接口 (自动提取 IP 与 User-Agent)
app.post('/api/track-click', (req, res) => {
  const { visitor_id, website_id, website_name, source, campaign } = req.body;

  // 提取 IP (兼容反向代理与 CDN，如 Nginx 或 Cloudflare)
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
                   req.ip ||
                   req.socket.remoteAddress ||
                   'Unknown';

  // 提取 User-Agent
  const userAgent = req.headers['user-agent'] || 'Unknown';

  db.run(
    `INSERT INTO click_logs (visitor_id, website_id, website_name, source, campaign, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [visitor_id, website_id, website_name, source || 'direct', campaign || 'none', clientIp, userAgent],
    function (err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true });
    }
  );
});

// 6. 统计数据总览 API
app.get('/api/stats', (req, res) => {
  const sql = `
    SELECT website_name as domain, source, COUNT(*) as leads
    FROM click_logs
    GROUP BY website_name, source
    ORDER BY leads DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: rows });
  });
});

// 7. 用户点击轨迹与设备 IP 明细 API
app.get('/api/user-journeys', (req, res) => {
  const sql = `
    SELECT 
      visitor_id,
      source,
      campaign,
      COUNT(*) as total_clicks,
      GROUP_CONCAT(website_name, ' ➔ ') as click_path,
      MAX(created_at) as last_active,
      ip_address,
      user_agent
    FROM click_logs
    GROUP BY visitor_id
    ORDER BY last_active DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: rows });
  });
});

// 8. 获取与新增推广链接
app.get('/api/links', (req, res) => {
  db.all(`SELECT * FROM generated_links ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: rows });
  });
});

app.post('/api/links', (req, res) => {
  const { target_url, source, campaign, full_link } = req.body;
  db.run(
    `INSERT INTO generated_links (target_url, source, campaign, full_link) VALUES (?, ?, ?, ?)`,
    [target_url, source, campaign, full_link],
    function (err) {
      if (err) return res.status(500).json({ success: false, error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 服务已启动，访问端口: http://localhost:${PORT}`);
  console.log(`📊 管理后台地址: http://localhost:${PORT}/admin`);
});
