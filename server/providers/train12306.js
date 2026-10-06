/**
 * 12306 实时余票 Provider —— 让这个产品真正可用的关键
 *
 * 用的是 12306 官方网页自己在用的公开查询接口（无需登录即可查余票/票价），
 * 返回的是**真实实时数据**：余票张数、票价、历时，全部当场查出来。
 *
 * ------------------------------------------------------------------
 * 关于合规，必须说清楚（也请使用者遵守）：
 *  1. 这是 12306 的公开查询端点，不是「开放 API」，官方没有承诺稳定性，
 *     字段格式可能变更。代码里做了容错与降级。
 *  2. 仅限个人、低频使用。本项目内置了**最小请求间隔 + 结果缓存**（见 RATE_LIMIT_MS / CACHE_TTL_MS），
 *     请不要调高频率，更不要用于商业爬虫。
 *  3. 商用请走 12306 官方或 OTA 开放平台的正式授权渠道。
 *  4. 不想调用它：在 .env 设 TRAIN_PROVIDER=snapshot 即可完全关闭，回落到内置快照。
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://kyfw.12306.cn/otn';
const CACHE_DIR = path.join(__dirname, '..', 'data', '.cache');
const STATION_FILE = path.join(CACHE_DIR, 'stations.json');

const RATE_LIMIT_MS = 1200;   // 两次请求最小间隔，别调小
const CACHE_TTL_MS = 60 * 1000; // 同一线路 60 秒内复用结果
const TIMEOUT_MS = 12000;

let cookieJar = '';
let stationsPromise = null;
let lastRequestAt = 0;
const resultCache = new Map();

/* -------------------- 基础请求 -------------------- */

async function throttledFetch(url, { referer = true } = {}) {
  const wait = RATE_LIMIT_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const headers = { 'User-Agent': UA, Accept: '*/*' };
  if (cookieJar) headers.Cookie = cookieJar;
  if (referer) headers.Referer = `${BASE}/leftTicket/init`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });

  // 维护 cookie（12306 会下发 JSESSIONID 等）
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (setCookie.length) {
    const pairs = setCookie.map((c) => c.split(';')[0]);
    cookieJar = Array.from(new Set([...cookieJar.split('; ').filter(Boolean), ...pairs])).join('; ');
  }
  return res;
}

/** 首次访问 init 拿 cookie —— 不拿会被风控挡回错误页 */
async function ensureCookie() {
  if (cookieJar) return;
  try {
    await throttledFetch(`${BASE}/leftTicket/init`, { referer: false });
  } catch (e) {
    /* 拿不到也继续，queryG 有时能直连 */
  }
}

/* -------------------- 站点码表 -------------------- */

/**
 * 站点名 → 电报码（如 珲春 → HUL，延吉西 → YXL）
 * 首次从 12306 官方静态资源下载并缓存到本地，之后直接读缓存。
 */
async function loadStations() {
  if (stationsPromise) return stationsPromise;

  stationsPromise = (async () => {
    if (fs.existsSync(STATION_FILE)) {
      try { return JSON.parse(fs.readFileSync(STATION_FILE, 'utf8')); } catch (e) { /* 缓存坏了重新下 */ }
    }
    const res = await throttledFetch(`${BASE}/resources/js/framework/station_name.js`, { referer: false });
    if (!res.ok) throw new Error(`站点码表下载失败 HTTP ${res.status}`);
    const text = await res.text();

    const map = {};
    for (const seg of text.split('@')) {
      const parts = seg.split('|');
      if (parts.length < 3) continue;
      const name = parts[1];
      const code = parts[2];
      if (name && code && /^[A-Z]{3}$/.test(code)) map[name] = code;
    }
    if (Object.keys(map).length < 1000) throw new Error('站点码表解析异常，条目过少');

    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(STATION_FILE, JSON.stringify(map));
    } catch (e) { /* 写不了缓存不影响使用 */ }
    return map;
  })();

  return stationsPromise;
}

/**
 * 站点名解析：精确 → 前缀（"延吉" → "延吉西"）→ 包含
 * 用户不会记得自己要查的站叫「延吉西」还是「延吉」，得兜住。
 */
async function resolveStation(name) {
  const map = await loadStations();
  if (map[name]) return { name, code: map[name] };
  const keys = Object.keys(map);
  const prefix = keys.find((k) => k.startsWith(name));
  if (prefix) return { name: prefix, code: map[prefix] };
  const contains = keys.find((k) => k.includes(name));
  if (contains) return { name: contains, code: map[contains] };
  return null;
}

/* -------------------- 余票查询 -------------------- */

function num(v) {
  if (!v) return 0;
  if (v === '有' || v === '候补') return -1; // -1 表示「有票/可候补」但不给具体张数
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseTrainRow(row) {
  const f = row.split('|');
  if (f.length < 30) return null;
  return {
    trainNo: f[2],          // 用于查票价
    no: f[3],               // 车次 C1037
    fromStation: f[6],
    toStation: f[7],
    dep: f[8],
    arr: f[9],
    durRaw: f[10],
    fromStationNo: f[16],
    toStationNo: f[17],
    seatTypes: f[35] || '',
    wz: f[26],              // 无座
    ze: f[30],              // 二等座
    zy: f[31],              // 一等座
    swz: f[32],             // 商务座
  };
}

function durToMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * 查某班车的真实票价（12306 官方接口）
 * 同一班车的票价基本不变，缓存 24 小时，避免每次都串行打 N 次接口。
 */
const priceCache = new Map();
const PRICE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PRICE_LOOKUPS = 6; // 单次最多查前 6 班，其余标「待核验」，避免请求过密

async function queryPrice(t, date) {
  if (!t.trainNo || !t.seatTypes) return null;
  const key = `${t.trainNo}|${t.fromStationNo}>${t.toStationNo}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.data;
  try {
    const url = `${BASE}/leftTicket/queryTicketPrice?train_no=${encodeURIComponent(t.trainNo)}` +
      `&from_station_no=${t.fromStationNo}&to_station_no=${t.toStationNo}` +
      `&seat_types=${encodeURIComponent(t.seatTypes)}&train_date=${date}`;
    const res = await throttledFetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    const d = j && j.data;
    if (!d || typeof d !== 'object') return null;
    const money = (v) => {
      if (!v) return null;
      const n = Number(String(v).replace(/[^\d.]/g, ''));
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const data = {
      price2: money(d.O),     // 二等座
      price1: money(d.M),     // 一等座
      priceWz: money(d.WZ),   // 无座
      priceBiz: money(d.A9),  // 商务座
    };
    priceCache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    return null; // 票价拿不到不影响余票，标为待核验即可
  }
}

/**
 * 查询某线路某日期的全部车次（真实余票 + 真实票价）
 */
async function query({ from, to, date }) {
  const cacheKey = `${from}>${to}@${date}`;
  const hit = resultCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const a = await resolveStation(from);
  const b = await resolveStation(to);
  if (!a || !b) {
    throw new Error(`无法识别车站「${!a ? from : to}」，请填写准确的车站名（如「延吉西」「珲春」）`);
  }

  await ensureCookie();
  const url = `${BASE}/leftTicket/queryG?leftTicketDTO.train_date=${date}` +
    `&leftTicketDTO.from_station=${a.code}&leftTicketDTO.to_station=${b.code}&purpose_codes=ADULT`;

  const res = await throttledFetch(url);
  if (!res.ok) throw new Error(`12306 查询失败 HTTP ${res.status}`);
  const j = await res.json();
  const rows = (j && j.data && j.data.result) || [];

  const list = [];
  for (const row of rows) {
    const t = parseTrainRow(row);
    if (!t) continue;
    // 票价限量查询：余票是决策关键必须全查，票价只查前几班，其余前端标「待核验」
    const price = list.length < MAX_PRICE_LOOKUPS ? await queryPrice(t, date) : null;
    list.push({
      no: t.no,
      dep: t.dep,
      arr: t.arr,
      from: a.name,
      to: b.name,
      durMin: durToMin(t.durRaw),
      price2: price ? price.price2 : null,
      price1: price ? price.price1 : null,
      priceBiz: price ? price.priceBiz : null,
      seats2: num(t.ze),
      seats1: num(t.zy),
      seatsWz: num(t.wz),
      note: '',
      // 保留原始字段，供「被选中的班次」补查票价
      _raw: { trainNo: t.trainNo, fromStationNo: t.fromStationNo, toStationNo: t.toStationNo, seatTypes: t.seatTypes },
    });
  }
  list.sort((x, y) => x.dep.localeCompare(y.dep));

  const data = {
    from: a.name, to: b.name, date,
    list,
    source: '12306',
    live: true,
    queriedAt: new Date().toISOString(),
  };
  resultCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

/** 卖票窗口：12306 通常只售 15 天内 */
function dateInRange(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.round((d - now) / 86400000);
  return diff >= 0 && diff <= 15;
}

/**
 * 补查某一班的票价。
 * 因为限速保护，列表里靠后的班次票价是 null；一旦排程引擎选中了它，
 * 就必须把票价查出来——用户总得知道自己要花多少钱。
 */
async function fillPrice(train, date) {
  if (!train || train.price2 != null || !train._raw) return train;
  const price = await queryPrice(train._raw, date);
  if (price) {
    train.price2 = price.price2;
    train.price1 = price.price1;
    train.priceBiz = price.priceBiz;
  }
  return train;
}

module.exports = {
  name: '12306',
  query,
  fillPrice,
  resolveStation,
  dateInRange,
  enabled: () => config.train.provider !== 'snapshot',
};
