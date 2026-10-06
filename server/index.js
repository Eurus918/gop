/**
 * 随行 GoP · 服务入口
 *
 * 零依赖实现：只用 Node 内置 http / fs / path / url。
 * 这样做的原因很实际——clone 下来直接 `node server/index.js` 就能跑，
 * 不用等 npm install，也不用担心依赖版本问题。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('./config');
const providers = require('./providers');
const planner = require('./planner');
const { CITIES } = require('./data/pois');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) { req.destroy(); reject(new Error('请求体过大')); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* -------------------- 路由 -------------------- */

const routes = {
  'GET /api/status': async () => ({
    ok: true,
    status: providers.status(),
    cities: Object.keys(CITIES),
    hint: providers.status().amap === 'mock'
      ? '未配置 AMAP_KEY，路径规划使用内置估算。在 .env 中配置后即可获得真实车程。'
      : '高德已启用，路径与天气为实时数据。',
  }),

  'GET /api/cities': async () => ({ cities: Object.keys(CITIES).map((k) => ({ name: k, ...CITIES[k] })) }),

  'GET /api/trains': async (params) => providers.searchTrains({
    from: params.get('from'), to: params.get('to'), date: params.get('date'),
  }),

  'GET /api/hotels': async (params) => providers.searchHotels({
    city: params.get('city'), date: params.get('date'),
  }),

  'GET /api/transfer': async (params) => providers.getStationTransfer({ city: params.get('city') }),

  'GET /api/weather': async (params) => {
    const w = await providers.weather({ city: params.get('city') });
    return w || { city: params.get('city'), days: [], unavailable: true };
  },

  'GET /api/plan': async (params) => planner.buildPlan({
    city: params.get('city') || '珲春',
    fromCity: params.get('from') || '延吉',
    date: params.get('date') || todayStr(),
    days: Number(params.get('days') || 2),
    outboundNo: params.get('outboundNo') || undefined,
    returnNo: params.get('returnNo') || undefined,
    includeOptional: params.get('optional') !== '0',
  }),
};

async function handleApi(req, res, pathname, params) {
  const key = `${req.method} ${pathname}`;
  try {
    if (key === 'POST /api/chat') {
      const body = await readBody(req);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const out = await providers.chat({ messages, context: body.context });
      // 与其他接口保持一致的 { ok, data } 结构
      return sendJSON(res, 200, { ok: true, data: out });
    }
    const fn = routes[key];
    if (!fn) return sendJSON(res, 404, { ok: false, error: `未知接口 ${key}` });
    const data = await fn(params);
    return sendJSON(res, 200, { ok: true, data });
  } catch (err) {
    return sendJSON(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* -------------------- 启动 -------------------- */

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = u;

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, searchParams);
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(config.port, () => {
  const st = providers.status();
  const tag = (s, live) => (live === 'live' ? `\x1b[32m${s}\x1b[0m` : `\x1b[33m${s}\x1b[0m`);
  console.log('\n  🐣 随行 GoP 已启动');
  console.log(`     http://localhost:${config.port}\n`);
  console.log(`  数据源状态：`);
  console.log(`     路径/地理 amap   ${tag(st.amap, st.amap)}`);
  console.log(`     AI 小助手 llm    ${tag(st.llm, st.llm)}`);
  console.log(`     车次     train   ${tag(st.train, st.train)}`);
  console.log(`     酒店     hotel   ${tag(st.hotel, st.hotel)}`);
  if (st.amap !== 'live') console.log('\n  提示：cp .env.example .env 并填入 AMAP_KEY 即可获得真实路径规划。');
  console.log('');
});

module.exports = server;
