const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件配置
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 托管 public 静态目录（前端页面）
app.use(express.static(path.join(__dirname, 'public')));

// ================= 1. 数据库初始化 =================
const dbPath = path.join(__dirname, 'analytics.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ 连接 SQLite 数据库失败:', err.message);
  } else {
    console.log('⚡ 已成功连接至 SQLite 数据库:', dbPath);
  }
});

// 建表逻辑
db.serialize(() => {
  // 用户轨迹表 (Track Log)
  db.run(`
    CREATE TABLE IF NOT EXISTS user_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      source TEXT DEFAULT 'direct',
      campaign TEXT DEFAULT 'none',
      target_domain TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 创建联合索引提升分页与分组查询性能
  db.run(`CREATE INDEX IF NOT EXISTS idx_visitor_active ON user_tracks(visitor_id, created_at)`);

  // 落地页站点卡片表
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

  // 推广链接生成与导入记录表
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

  // 初始化默认的落地页数据（如果表为空）
  db.get(`SELECT COUNT(*) AS count FROM websites`, (err, row) => {
    if (!err && row.count === 0) {
      const stmt = db.prepare(`INSERT INTO websites (name, desc_text, url, icon_url) VALUES (?, ?, ?, ?)`);
      stmt.run('官方主商城', '全场限时折扣包邮', 'https://example.com/shop', 'https://api.dicebear.com/7.x/identicon/svg?seed=shop');
      stmt.run('客服咨询领卷', '一对一专属客服支持', 'https://example.com/support', 'https://api.dicebear.com/7.x/identicon/svg?seed=support');
      stmt.finalize();
      console.log('💡 已初始化默认落地页卡片数据');
    }
  });
});

// ================= 2. API 路由接口 =================

/**
 * 轨迹打点 API：前端用户点击卡片时调用
 */
app.post('/api/track', (req, res) => {
  const { visitor_id, target_domain, source, campaign } = req.body;
  
  // 获取客户端真实 IP 与 User-Agent
  const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const user_agent = req.headers['user-agent'] || 'Unknown';

  if (!visitor_id || !target_domain) {
    return res.status(400).json({ success: false, message: '缺少必要参数 visitor_id 或 target_domain' });
  }

  const sql = `
    INSERT INTO user_tracks (visitor_id, ip_address, user_agent, source, campaign, target_domain)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  const params = [visitor_id, ip_address, user_agent, source || 'direct', campaign || 'none', target_domain];

  db.run(sql, params, function (err) {
    if (err) {
      console.error('❌ 记录轨迹失败:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
    res.json({ success: true, track_id: this.lastID });
  });
});

/**
 * [核心优化] 用户轨迹列表 API（传统偏移量分页 Offset-based Pagination）
 * GET /api/user-journeys?page=1&limit=20
 */
app.get('/api/user-journeys', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
  const offset = (page - 1) * limit;

  // 第一步：获取独立访客总数 (COUNT)
  const countSql = `SELECT COUNT(DISTINCT visitor_id) AS total FROM user_tracks`;

  db.get(countSql, [], (err, countRow) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }

    const total = countRow ? countRow.total : 0;
    const totalPages = Math.ceil(total / limit) || 1;

    // 第二步：执行 LIMIT ? OFFSET ? 分页查询
    // 聚合同一 visitor_id 的所有点击记录，拼成点击路径 click_path
    const dataSql = `
      SELECT 
        visitor_id, 
        ip_address, 
        user_agent, 
        source, 
        campaign, 
        COUNT(*) AS total_clicks,
        MAX(created_at) AS last_active,
        GROUP_CONCAT(target_domain, ' ➔ ') AS click_path
      FROM user_tracks
      GROUP BY visitor_id
      ORDER BY last_active DESC
      LIMIT ? OFFSET ?
    `;

    db.all(dataSql, [limit, offset], (err, rows) => {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }

      // 返回带有分页元数据的标准 JSON 响应
      res.json({
        success: true,
        data: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages
        }
      });
    });
  });
});

/**
 * 报表总览 API：统计各站点与渠道的引流转化数 (Leads)
 */
app.get('/api/stats', (req, res) => {
  const sql = `
    SELECT 
      target_domain AS domain,
      source,
      COUNT(*) AS leads
    FROM user_tracks
    GROUP BY target_domain, source
    ORDER BY leads DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    res.json({ success: true, data: rows });
  });
});

/**
 * 落地页站点 API（查/增/改/删）
 */
app.get('/api/websites', (req, res) => {
  db.all(`SELECT * FROM websites ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

app.post('/api/websites', (req, res) => {
  const { name, desc_text, url, icon_url } = req.body;
  const sql = `INSERT INTO websites (name, desc_text, url, icon_url) VALUES (?, ?, ?, ?)`;
  db.run(sql, [name, desc_text, url, icon_url], function (err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

app.put('/api/websites/:id', (req, res) => {
  const { name, desc_text, url, icon_url } = req.body;
  const sql = `UPDATE websites SET name = ?, desc_text = ?, url = ?, icon_url = ? WHERE id = ?`;
  db.run(sql, [name, desc_text, url, icon_url, req.params.id], function (err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/websites/:id', (req, res) => {
  db.run(`DELETE FROM websites WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true });
  });
});

/**
 * 推广链接历史记录 API（查/增）
 */
app.get('/api/links', (req, res) => {
  db.all(`SELECT * FROM generated_links ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

app.post('/api/links', (req, res) => {
  const { target_url, source, campaign, full_link } = req.body;
  const sql = `INSERT INTO generated_links (target_url, source, campaign, full_link) VALUES (?, ?, ?, ?)`;
  db.run(sql, [target_url, source, campaign, full_link], function (err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

// ================= 3. 启动服务器 =================
app.listen(PORT, () => {
  console.log(`🚀 服务已成功启动：http://localhost:${PORT}`);
  console.log(`📊 后台管理面板：http://localhost:${PORT}/admin.html`);
});
