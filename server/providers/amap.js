/**
 * 高德开放平台 Provider —— 真实数据源
 *
 * 免费申请：https://console.amap.com/dev/key/app
 * 选「Web服务」类型即可获得 key，个人开发者有免费额度。
 *
 * 它解决的是本产品最关键的一件事：**分钟级排程需要真实的车程**。
 * 「高铁站到酒店多久」「景点之间多久」这类数字如果靠拍脑袋，
 * 整条时间轴就不可信。配了 key 之后这些全部来自真实路径规划。
 *
 * 任何失败都会抛出，由 providers/index.js 统一降级到 mock，不会让服务崩。
 */

const config = require('../config');

const TIMEOUT_MS = 6000;

async function getJSON(path, params) {
  const url = new URL(config.amap.base + path);
  url.searchParams.set('key', config.amap.key);
  url.searchParams.set('output', 'JSON');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`高德接口 HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== '1') throw new Error(`高德接口返回错误：${data.info || '未知错误'}`);
  return data;
}

/** 地理编码：地址/地名 → 经纬度。景点名通常能直接解析，因此不需要硬编码坐标 */
async function geocode(address, city) {
  const d = await getJSON('/geocode/geo', { address, city });
  const first = (d.geocodes || [])[0];
  if (!first || !first.location) throw new Error(`无法解析地址：${address}`);
  const [lng, lat] = first.location.split(',').map(Number);
  return { lng, lat, formatted: first.formatted_address || address };
}

async function resolvePoint(point, city) {
  if (point && point.lng && point.lat) return point;
  if (typeof point === 'string' && /^[\d.]+,[\d.]+$/.test(point)) {
    const [lng, lat] = point.split(',').map(Number);
    return { lng, lat };
  }
  return geocode(point, city);
}

/**
 * 驾车路径规划
 * @returns {{distanceKm:number, durationMin:number, mode:string, source:string, live:boolean}}
 */
async function driving({ origin, destination, city }) {
  const o = await resolvePoint(origin, city);
  const d = await resolvePoint(destination, city);
  const data = await getJSON('/direction/driving', {
    origin: `${o.lng},${o.lat}`,
    destination: `${d.lng},${d.lat}`,
    strategy: 10, // 躲避拥堵 + 不走高速优先
  });
  const path = (data.route && data.route.paths && data.route.paths[0]) || null;
  if (!path) throw new Error('未获取到驾车路线');
  return {
    origin: typeof origin === 'string' ? origin : '起点',
    destination: typeof destination === 'string' ? destination : '终点',
    distanceKm: Number((Number(path.distance) / 1000).toFixed(1)),
    durationMin: Math.round(Number(path.duration) / 60),
    mode: '驾车',
    cost: data.route.taxi_cost ? `打车约 ${data.route.taxi_cost} 元` : '',
    note: '',
    source: 'amap',
    live: true,
  };
}

/**
 * 公交换乘路径规划
 * 高铁站 → 酒店这种场景用它更贴合实际
 */
async function transit({ origin, destination, city }) {
  const o = await resolvePoint(origin, city);
  const d = await resolvePoint(destination, city);
  const data = await getJSON('/direction/transit/integrated', {
    origin: `${o.lng},${o.lat}`,
    destination: `${d.lng},${d.lat}`,
    city,
    nightflag: 0,
  });
  const route = data.route || {};
  const trans = (route.transits || [])[0];
  if (!trans) throw new Error('未获取到公交方案');
  const walking = Number(route.distance || 0);
  return {
    origin: typeof origin === 'string' ? origin : '起点',
    destination: typeof destination === 'string' ? destination : '终点',
    distanceKm: Number((Number(trans.distance || walking) / 1000).toFixed(1)),
    durationMin: Math.round(Number(trans.duration || 0) / 60),
    mode: '公交',
    cost: trans.cost ? (trans.cost.transit_fee || '') : '',
    note: '来自高德公交方案',
    source: 'amap',
    live: true,
  };
}

/** 天气（extensions=all 可拿未来 3 天预报） */
async function weather({ city }) {
  const data = await getJSON('/weather/weatherInfo', { city, extensions: 'all' });
  const arr = data.forecasts || (data.lives ? [data.lives[0]] : []);
  const days = arr.map((f) => ({
    date: f.date,
    dayWeather: f.dayweather || f.weather,
    nightWeather: f.nightweather || '',
    dayTemp: f.daytemp || f.temperature,
    nightTemp: f.nighttemp || '',
    wind: f.daypower || f.winddirection || '',
  }));
  return { city, days, source: 'amap', live: true };
}

/** POI 搜索：可以用来扩展景点库 / 找酒店 */
async function searchPOI({ keywords, city, types }) {
  const data = await getJSON('/place/text', { keywords, city, types, offset: 20, page: 1 });
  return (data.pois || []).map((p) => ({
    name: p.name,
    address: p.address,
    type: p.type,
    location: p.location,
  }));
}

module.exports = {
  name: 'amap',
  enabled: () => Boolean(config.amap.key),
  geocode,
  driving,
  transit,
  route: driving,
  weather,
  searchPOI,
};
