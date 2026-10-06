/**
 * Provider 统一出口
 *
 * 核心约定：**任何真实数据源失败，都静默降级到 mock，并在返回里标注 degraded 与原因。**
 * 这样开源使用者即使一个 key 都没配，也能跑通完整流程；
 * 配了 key 但接口抽风，也不会白屏。
 */

const config = require('../config');
const mock = require('./mock');
const amap = require('./amap');
const llm = require('./llm');

const TIMEOUT_MS = 8000;

function degrade(base, err) {
  return { ...base, degraded: true, error: String(err && err.message ? err.message : err) };
}

/* ---------------- 车次 ---------------- */

/**
 * 若配置了 TRAIN_API_BASE，会按其约定格式调用：
 *   GET {TRAIN_API_BASE}?from=&to=&date=
 *   期望返回 { list: [{ no, dep, arr, durMin, price2, price1, seats2, note }] }
 * 不符合约定或调用失败则降级到内置快照。
 */
async function searchTrains({ from, to, date }) {
  if (config.train.base) {
    try {
      const url = new URL(config.train.base);
      url.searchParams.set('from', from);
      url.searchParams.set('to', to);
      url.searchParams.set('date', date);
      const headers = {};
      if (config.train.key) headers.Authorization = `Bearer ${config.train.key}`;
      const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`车次接口 HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data.list)) throw new Error('车次接口返回格式不符合约定（需要 { list: [...] }）');
      return { from, to, date, ...data, source: 'live', live: true };
    } catch (err) {
      return degrade(await mock.searchTrains({ from, to, date }), err);
    }
  }
  return mock.searchTrains({ from, to, date });
}

/* ---------------- 酒店 ---------------- */

/** 约定同车次：GET {HOTEL_API_BASE}?city=&date= → { list: [...] } */
async function searchHotels({ city, date }) {
  if (config.hotel.base) {
    try {
      const url = new URL(config.hotel.base);
      url.searchParams.set('city', city);
      url.searchParams.set('date', date || '');
      const headers = {};
      if (config.hotel.key) headers.Authorization = `Bearer ${config.hotel.key}`;
      const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`酒店接口 HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data.list)) throw new Error('酒店接口返回格式不符合约定（需要 { list: [...] }）');
      return { ...data, source: 'live', live: true };
    } catch (err) {
      return degrade(await mock.searchHotels({ city, date }), err);
    }
  }
  return mock.searchHotels({ city, date });
}

/* ---------------- 高铁站 → 市区 ---------------- */

async function getStationTransfer({ city }) {
  const base = await mock.getStationTransfer({ city });
  if (!base) return null;

  // 有高德就用真实路径规划把「距离 / 时长」校准一遍，文案仍用快照里的人工整理
  if (amap.enabled() && base.stops && base.stops.length >= 2) {
    try {
      const start = base.stops[0].name;
      const end = base.stops[base.stops.length - 1].name;
      const [drive, bus] = await Promise.all([
        amap.driving({ origin: start, destination: end, city }).catch(() => null),
        amap.transit({ origin: start, destination: end, city }).catch(() => null),
      ]);
      if (drive || bus) {
        base.distance = (drive || bus).distanceKm ? `${(drive || bus).distanceKm} km（高德实测）` : base.distance;
        if (drive) {
          const w = base.ways.find((x) => x.name.includes('打车'));
          if (w) { w.timeMin = drive.durationMin; w.cost = drive.cost || w.cost; }
        }
        if (bus) {
          const w = base.ways.find((x) => x.name.includes('公交'));
          if (w) { w.timeMin = bus.durationMin; }
        }
        base.source = 'amap+mock';
        base.live = true;
      }
    } catch (err) {
      return degrade(base, err);
    }
  }
  return base;
}

/* ---------------- 路径规划 ---------------- */

async function route(params) {
  if (amap.enabled()) {
    try {
      return params.mode === 'transit'
        ? await amap.transit(params)
        : await amap.driving(params);
    } catch (err) {
      return degrade(await mock.route(params), err);
    }
  }
  return mock.route(params);
}

/* ---------------- 天气 ---------------- */

async function weather({ city }) {
  if (amap.enabled()) {
    try {
      return await amap.weather({ city });
    } catch (err) {
      return null; // 天气拿不到就不展示，绝不编造预报
    }
  }
  return null;
}

/* ---------------- 小助手 ---------------- */

async function chat(opts) {
  return llm.chat(opts);
}

/* ---------------- 状态 ---------------- */

function status() {
  return {
    amap: amap.enabled() ? 'live' : 'mock',
    llm: llm.enabled() ? 'live' : 'rule',
    train: config.train.base ? 'live' : 'snapshot',
    hotel: config.hotel.base ? 'live' : 'snapshot',
  };
}

module.exports = {
  searchTrains,
  searchHotels,
  getStationTransfer,
  route,
  weather,
  chat,
  status,
  searchPOI: (p) => (amap.enabled() ? amap.searchPOI(p) : Promise.resolve([])),
};
