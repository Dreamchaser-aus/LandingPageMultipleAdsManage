const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// JWT 鉴权与管理员账号设置 (优先读取环境变量，提供默认备用值)
const JWT_SECRET = process.env.JWT_SECRET || 'gang_admin_secret_key_2026';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// ================= 中间件配置 =================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 托管 public 静态文件目录
app.use(express.static(path.join(__dirname, 'public')));

// 自动创建并托管 uploads 目录 (用于存放公司 Logo/图片)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// ================= Multer 文件上传配置 =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `company-${uniqueSuffix}${ext}`);
  }
});

// 图片格式过滤器
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp|svg/;
  const extName = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimeType = allowedTypes.test(file.mimetype);

  if (extName && mimeType) {
    return cb(null, true);
  }
  cb(new Error('仅允许上传图片文件 (jpg, jpeg, png, gif, webp, svg)'));
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 限制单个文件最大 5MB
  fileFilter: fileFilter
});

// JWT Token 验证中间件
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // 提取 Bearer <token>

  if (!token) {
    return res.status(401).json({ success: false, message: '未授权，请先登录后台' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: '登录状态已失效，请重新登录' });
    }
    req.user = user;
    next();
  });
};

// ================= 1. 连接 PostgreSQL 数据库 =================
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
    console.error('❌ 连接 PostgreSQL 数据库失败:', err.message);
  } else {
    console.log('⚡ 已成功连接至 PostgreSQL 数据库');
    release();
  }
});

// 初始化数据库表结构
async function initDatabase() {
  try {
    // 1. 用户轨迹表
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

    // 2. 落地页站点卡片表
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

    // 3. 推广链接生成记录表
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

    // 4. 【新增】轮播图表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS slides (
        id SERIAL PRIMARY KEY,
        badge TEXT,
        title TEXT NOT NULL,
        desc_text TEXT,
        btn_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 5. 【新增】关于我们配置表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS about_info (
        id SERIAL PRIMARY KEY,
        title TEXT,
        content TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 初始化默认卡片数据（如果表为空）
    const checkRes = await pool.query(`SELECT COUNT(*) AS count FROM websites`);
    if (parseInt(checkRes.rows[0].count, 10) === 0) {
      await pool.query(
        `INSERT INTO websites (name, desc_text, url, icon_url) VALUES ($1, $2, $3, $4)`,
        ['MegaWin Casino Malaysia', 'Top-tier verified gaming platform offering safe entertainment and instant bonuses.', 'https://google.com', 'https://api.dicebear.com/7.x/identicon/svg?seed=megawin']
      );
      await pool.query(
        `INSERT INTO websites (name, desc_text, url, icon_url) VALUES ($1, $2, $3, $4)`,
        ['Lucky4D Partner Hub', 'Trusted insights and smart play guides curated for professional enthusiasts.', 'https://google.com', 'https://api.dicebear.com/7.x/identicon/svg?seed=lucky4d']
      );
      console.log('💡 已初始化默认落地页卡片数据');
    }
  } catch (err) {
    console.error('❌ 初始化数据表失败:', err.message);
  }
}

initDatabase();

// ================= 2. 静态页面路由 =================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ================= 3. API 接口定义 =================

/**
 * 管理员登录 API (公开)
 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ success: true, token, message: '登录成功' });
  }

  return res.status(401).json({ success: false, message: '账号或密码错误' });
});

/**
 * 图片上传 API (需登录)
 */
app.post('/api/upload', authenticateToken, upload.single('icon'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: '请选择要上传的图片文件' });
  }
  const iconUrl = `/uploads/${req.file.filename}`;
  res.json({
    success: true,
    message: '图片上传成功',
    icon_url: iconUrl
  });
}, (err, req, res, next) => {
  res.status(400).json({ success: false, message: err.message });
});

/**
 * 轨迹打点 API (公开)
 */
app.post('/api/track', async (req, res) => {
  const { visitor_id, target_domain, source, campaign } = req.body;
  
  let ip_address = '127.0.0.1';
  const rawIp = req.headers['x-forwarded-for'];
  if (rawIp) {
    ip_address = rawIp.split(',')[0].trim();
  } else if (req.socket.remoteAddress) {
    ip_address = req.socket.remoteAddress;
  }

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
 * 获取卡片列表 API (公开)
 */
app.get('/api/websites', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM websites ORDER BY id DESC`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 【新增】获取轮播图 API (公开：允许前端展示)
 */
app.get('/api/slides', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM slides ORDER BY id ASC`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 【新增】获取关于我们信息 API (公开：允许前端展示)
 */
app.get('/api/about', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM about_info WHERE id = 1`);
    res.json({ success: true, data: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------- 以下接口均受 JWT 登录保护 -----------------

/**
 * 用户轨迹列表 API (需登录)
 */
app.get('/api/user-journeys', authenticateToken, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
  const offset = (page - 1) * limit;

  try {
    const countResult = await pool.query(`SELECT COUNT(DISTINCT visitor_id) AS total FROM user_tracks`);
    const total = parseInt(countResult.rows[0].total, 10);
    const totalPages = Math.ceil(total / limit) || 1;

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
      pagination: { page, limit, total, totalPages }
    });
  } catch (err) {
    console.error('❌ 获取轨迹失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 报表总览 API (需登录)
 */
app.get('/api/stats', authenticateToken, async (req, res) => {
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
 * 落地页卡片 CRUD (需登录)
 */
app.post('/api/websites', authenticateToken, async (req, res) => {
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

app.put('/api/websites/:id', authenticateToken, async (req, res) => {
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

app.delete('/api/websites/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query(`DELETE FROM websites WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 【新增】轮播图管理 CRUD (需登录)
 */
app.post('/api/slides', authenticateToken, async (req, res) => {
  const { badge, title, desc, btnText } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO slides (badge, title, desc_text, btn_text) VALUES ($1, $2, $3, $4) RETURNING id`,
      [badge, title, desc, btnText]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/slides/:id', authenticateToken, async (req, res) => {
  const { badge, title, desc, btnText } = req.body;
  try {
    await pool.query(
      `UPDATE slides SET badge = $1, title = $2, desc_text = $3, btn_text = $4 WHERE id = $5`,
      [badge, title, desc, btnText, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/slides/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query(`DELETE FROM slides WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 【新增】关于我们管理 API (需登录)
 */
app.post('/api/about', authenticateToken, async (req, res) => {
  const { title, content } = req.body;
  try {
    const check = await pool.query(`SELECT COUNT(*) FROM about_info WHERE id = 1`);
    if (parseInt(check.rows[0].count, 10) === 0) {
      await pool.query(`INSERT INTO about_info (id, title, content) VALUES (1, $1, $2)`, [title, content]);
    } else {
      await pool.query(`UPDATE about_info SET title = $1, content = $2, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, [title, content]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 推广链接历史 API (需登录)
 */
app.get('/api/links', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM generated_links ORDER BY id DESC`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/links', authenticateToken, async (req, res) => {
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
