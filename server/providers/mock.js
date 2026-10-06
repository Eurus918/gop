/**
 * Mock Provider —— 开箱即用的默认数据源
 *
 * 设计取舍：这里返回的不是随机假数据，而是**真实采集的快照**。
 * 原因：mock 模式也要能演示真实的决策冲突（例如「17:30 根本没有车次」），
 * 随机数据演示不出产品的价值，也会误导使用者。
 *
 * 所有返回都会带上 source: 'snapshot' 与 snapshotDate，
 * 前端会据此显示「参考值，需核验」的标识。绝不伪装成实时数据。
 */

const sample = require('../data/sample');
const { getCity } = require('../data/pois');

/** 车次查询。目前内置延吉西 ↔ 珲春，其他线路返回空并标注未覆盖 */
async function searchTrains({ from, to, date }) {
  const key = `${from}>${to}`;
  const hit = sample.trains[key];
  if (hit) {
    // 给每班车补上 from/to，排程引擎生成节点标题时要用到
    return {
      ...hit,
      list: hit.list.map((t) => ({ ...t, from: hit.from, to: hit.to })),
      source: 'snapshot',
      live: false,
    };
  }
  return {
    from, to, date, list: [], source: 'snapshot', live: false,
    uncovered: true,
    message: `内置快照暂未覆盖 ${from} → ${to}。可在 .env 配置 TRAIN_API_BASE 接入实时数据源，或提 PR 补充该线路快照。`,
  };
}

async function searchHotels({ city }) {
  if (city === '珲春') {
    return { ...sample.hotels, source: 'snapshot', live: false };
  }
  return { date: '', areaTip: '', list: [], source: 'snapshot', live: false, uncovered: true };
}

async function getStationTransfer({ city }) {
  if (city === '珲春') {
    return { ...sample.stationTransfer, source: 'snapshot', live: false };
  }
  return null;
}

/**
 * 路径规划（降级实现）
 * 有城市 zoneMatrix 就按片区查，查不到就给一个保守的城市内估值。
 */
async function route({ city, fromZone, toZone, origin, destination }) {
  const c = getCity(city);
  if (c && fromZone && toZone) {
    const key = `${fromZone}>${toZone}`;
    const hit = c.zoneMatrix[key] || c.zoneMatrix[`${toZone}>${fromZone}`];
    if (hit) {
      return {
        origin: origin || fromZone,
        destination: destination || toZone,
        distanceKm: null,
        durationMin: hit.min,
        mode: hit.mode,
        cost: hit.cost || '',
        note: hit.note || '',
        source: 'snapshot',
        live: false,
      };
    }
  }
  return {
    origin, destination,
    distanceKm: null,
    durationMin: 20,
    mode: '打车',
    cost: '',
    note: '内置快照未覆盖该段路线，使用城市内保守估值 20 分钟。配置 AMAP_KEY 可获得真实路径规划。',
    source: 'estimate',
    live: false,
  };
}

/** 天气：mock 无法提供，明确返回 null，前端据此不展示天气模块 */
async function weather() {
  return null;
}

module.exports = { searchTrains, searchHotels, getStationTransfer, route, weather, name: 'mock' };
