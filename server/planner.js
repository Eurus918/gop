/**
 * 分钟级排程引擎 —— 本项目的核心
 *
 * 它做的事，用一句话说：
 *   把「景点开放时间 / 停止入园 / 末班车 / 发车时间」这些硬约束，
 *   和「景点之间真实车程」放在一起，倒推出每个节点的**最晚出发时间**，
 *   冲突的地方标红。
 *
 * 这是它和普通攻略网站的根本区别：
 *   攻略给你一段文字，改一个字你得自己重算全程；
 *   这里每个节点都是算出来的，改任意一个输入，全链路自动重排。
 *
 * 算法分三步：
 *   1. 选车次（去程/返程）—— 返程从「游玩结束时间」往后找最早可行班次
 *   2. 贪心排景点 —— 按优先级 + 开放时间窗，时间不够就砍，重复景观只留一个
 *   3. 倒推赶车链 —— 发车时间往前倒推安检、到站车程、取行李，得出最晚出发时刻
 */

const { getCity } = require('./data/pois');
const providers = require('./providers');

/* -------------------- 时间工具 -------------------- */

const toMin = (hhmm) => {
  if (typeof hhmm !== 'string') return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const toStr = (min) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const fmtDur = (min) => {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
};

/* -------------------- 缓冲常量 --------------------
 * 这些数字来自真实经验，不是拍的：
 *  - 安检 20 分钟：珲春这类小站够用，大站要 40
 *  - 叫车 30 分钟：实际车程常常只有 10–15 分钟，但等车 + 找不到车是真实风险，
 *    赶车场景宁可多留。引擎会在节点描述里解释为什么要多留。
 */
const BUFFER = {
  security: 20,      // 进站安检
  stationTransit: 30, // 酒店 → 车站（含叫车等待）
  hotelPickup: 25,   // 回酒店取行李 + 退房
  meal: 80,          // 正餐
};

/* -------------------- 主入口 -------------------- */

/**
 * @param {object} opts
 * @param {string} opts.city      目的城市（需在 pois.js 中登记）
 * @param {string} opts.fromCity  出发城市
 * @param {string} opts.date      出发日期 YYYY-MM-DD
 * @param {number} opts.days      行程天数（1 或 2）
 * @param {string} [opts.outboundNo] 指定去程车次，不指定则自动推荐
 * @param {string} [opts.returnNo]   指定返程车次
 * @param {boolean} [opts.includeOptional] 是否纳入 optional 景点
 */
/**
 * 动态构建城市：景点库里没有的城市，用高德 POI 真实景点现搭一个。
 * 代价是缺失精细约束（开放时间、停止入园、网友避坑），只能给默认值——
 * 前端会如实标注「动态生成」。精品人工库仍然优先。
 */
async function buildDynamicCity(name) {
  let raw = [];
  try {
    raw = await providers.searchPOI({ keywords: `${name} 风景名胜`, city: name, types: '风景名胜' });
  } catch (e) {
    return null;
  }
  if (!raw || raw.length < 2) return null;

  return {
    city: name,
    province: '',
    intro: '景点由高德 POI 动态生成，约束为默认值。',
    railStation: `${name}站`,
    hotelAreas: [],
    dynamic: true,
    zoneMatrix: {}, // 留空 → 让 transitBetween 走高德真实路径规划
    cityRules: [],
    pois: raw.slice(0, 12).map((p, i) => ({
      id: `poi_${i}_${p.name}`,
      name: p.name,
      zone: '市区',
      address: p.address || '',
      durationMin: 90,
      priority: 8 - Math.floor(i / 3), // 高德返回顺序本身带一定相关性
      ticket: { price: 0 },
      hours: { open: '09:00', close: '17:00', lastEntry: '16:00' },
      tips: [p.type ? `类型：${p.type}` : ''].filter(Boolean),
      pitfalls: [],
    })),
  };
}

async function buildPlan(opts) {
  let city = getCity(opts.city);
  let dynamic = false;

  if (!city) {
    city = await buildDynamicCity(opts.city);
    if (!city) {
      return {
        error: `暂不支持城市「${opts.city}」。两条路可以解决：① 在 .env 配置 AMAP_KEY，系统会用高德真实 POI 动态生成行程；② 在 server/data/pois.js 里补充该城市的景点库（欢迎提 PR）。`,
      };
    }
    dynamic = true;
  }

  const days = Number(opts.days || 2);
  const fromCity = opts.fromCity || '延吉';

  /* --- 1. 车次 --- */
  const outData = await providers.searchTrains({ from: `${fromCity}西`, to: opts.city, date: opts.date });
  const backData = await providers.searchTrains({ from: opts.city, to: `${fromCity}西`, date: opts.date });

  const outbound = pickTrain(outData, opts.outboundNo, days);
  if (!outbound.train) {
    return {
      error: `没有查到 ${fromCity} → ${opts.city} 的车次。${outData.message || ''}`,
      trains: { outbound: outData, inbound: backData },
    };
  }

  /* --- 2. 高铁站 → 市区 --- */
  const transfer = await providers.getStationTransfer({ city: opts.city });

  /* --- 3. 天气（有就有，没有就不展示） --- */
  const wx = await providers.weather({ city: opts.city });

  /* --- 4. 排每一天 --- */
  const planDays = [];
  const skipped = [];
  const conflicts = [];
  const usedPoiIds = new Set();

  let arriveMin = toMin(outbound.train.arr);

  // 去程链：出门 → 安检 → 发车 → 抵达
  const outboundChain = buildOutboundChain(outbound.train, opts.city, fromCity);

  if (days >= 2) {
    // Day 1：抵达 → 酒店 → 市区慢逛
    const d1 = await scheduleDay({
      city, pois: city.pois.filter((p) => p.zone === '市区'),
      startMin: arriveMin,
      startZone: '市区',
      endMin: 20 * 60,
      includeOptional: opts.includeOptional !== false,
      usedPoiIds, skipped, cityName: opts.city,
      hotelFirst: true,
      transfer,
    });
    planDays.push({
      day: 1, date: opts.date, weekday: weekdayOf(opts.date),
      title: '抵达 · 市区慢逛',
      summary: '高铁进城，酒店放行李，市区河景 + 欧式街，晚上吃海鲜',
      nodes: [...outboundChain, ...d1.nodes],
    });

    // Day 2：核心景区（上午光线最好）→ 返程
    arriveMin = 8 * 60; // 第二天早上 8:00 从酒店出发
  }

  // 先定返程班次的候选，再倒推「游玩截止线」——这样时间才用得满。
  // 反过来做（先排景点再挑车次）会导致景点早早排完、下午干等两小时。
  const preferredNo = opts.returnNo
    || ((backData.list || []).find((t) => t.recommend) || {}).no
    || null;

  let dayEndMin = 15 * 60 + 30; // 兜底截止线
  const preferredTrain = preferredNo && (backData.list || []).find((t) => t.no === preferredNo);
  if (preferredTrain) {
    dayEndMin = toMin(preferredTrain.dep)
      - BUFFER.security        // 安检
      - BUFFER.stationTransit  // 酒店 → 车站
      - BUFFER.hotelPickup     // 取行李退房
      - 12;                    // 市区 → 酒店
  }

  const d2 = await scheduleDay({
    city,
    pois: city.pois.filter((p) => (days >= 2 ? p.zone !== '市区' : true)),
    startMin: arriveMin,
    startZone: '市区',
    endMin: dayEndMin,
    // 交给引擎自己取舍：时间够就排进去，不够会被硬约束砍掉（并在「引擎帮你砍掉的」里说明原因）
    includeOptional: true,
    usedPoiIds, skipped, cityName: opts.city,
    hotelFirst: false,
    transfer,
  });

  /* --- 5. 返程倒推（核心） --- */
  const returnPick = pickReturn(backData, d2.cursor, opts.returnNo, preferredNo);
  const train = returnPick.train;

  // 被选中的班次必须有票价——列表里靠后的班次因限速没查价，这里补上
  await providers.fillTrainPrice(outbound.train, opts.date);
  if (train) await providers.fillTrainPrice(train, opts.date);

  const returnChain = train ? buildReturnChain(train, d2.cursor, transfer) : null;
  if (returnChain) {
    d2.nodes.push(...returnChain.nodes);
    conflicts.push(...returnChain.conflicts);
  }

  planDays.push({
    day: days >= 2 ? 2 : 1,
    date: days >= 2 ? nextDate(opts.date) : opts.date,
    weekday: weekdayOf(days >= 2 ? nextDate(opts.date) : opts.date),
    title: days >= 2 ? '核心景区 · 赶车返程' : '当天往返 · 赶车返程',
    summary: train
      ? `上午进核心景区，${toStr(d2.cursor)} 回市区，${train.dep} 高铁返 ${fromCity}`
      : '未找到合适返程车次',
    nodes: d2.nodes,
  });

  /* --- 6. 关键节点 & 预算 --- */
  const keyNodes = planDays
    .flatMap((d) => d.nodes.filter((n) => n.risk === 'high').map((n) => ({ time: n.time, title: n.title })));

  const budget = estimateBudget({ outbound: outbound.train, return: train, days, pois: city.pois, usedPoiIds });

  return {
    meta: {
      dest: opts.city,
      province: city.province,
      intro: city.intro,
      departCity: fromCity,
      dateStart: opts.date,
      dateEnd: days >= 2 ? nextDate(opts.date) : opts.date,
      days, nights: days - 1,
      generatedAt: nowStr(),
      dynamic, // true 表示景点是 POI 动态生成的，不是人工维护的精品库
      dataStatus: providers.status(),
    },
    trains: { outbound: outData, inbound: backData, chosen: { outbound: outbound.train, return: train } },
    transfer,
    weather: wx,
    days: planDays,
    keyNodes,
    conflicts,
    skipped,
    cityRules: city.cityRules,
    pitfalls: collectPitfalls(city.pois),
    checklist: buildChecklist(city, usedPoiIds),
    budget,
  };
}

/* -------------------- 车次选择 -------------------- */

/**
 * 选去程班次。
 * 快照里带 recommend 标记就直接用它；实时数据没有这个标记，
 * 就按「多日行程挑上午出发的、当日往返挑最早的」来选 —— 最早一班往往是 6 点，
 * 直接选它只会让人起不来。
 */
function pickTrain(data, wantedNo, days) {
  const list = data.list || [];
  if (!list.length) return { train: null };
  if (wantedNo) {
    const hit = list.find((t) => t.no === wantedNo);
    if (hit) return { train: hit };
  }
  const rec = list.find((t) => t.recommend);
  if (rec) return { train: rec };

  if (days > 1) {
    // 8 点之后出发：6、7 点的车能赶但人起不来，不把它当默认
    const morning = list.filter((t) => toMin(t.dep) >= 8 * 60 && toMin(t.dep) <= 10 * 60 + 30);
    if (morning.length) return { train: morning[0] };
    const after8 = list.filter((t) => toMin(t.dep) >= 8 * 60);
    if (after8.length) return { train: after8[0] };
  }
  return { train: list[0] };
}

/**
 * 从「游玩结束时间」往后找最早可行的返程车次
 * preferredNo：优先想坐的那班（通常是推荐班次），只要来得及就用它
 */
function pickReturn(data, endMin, wantedNo, preferredNo) {
  const list = (data.list || []).slice().sort((a, b) => toMin(a.dep) - toMin(b.dep));
  if (!list.length) return { train: null };
  if (wantedNo) {
    const hit = list.find((t) => t.no === wantedNo);
    if (hit) return { train: hit };
  }
  // 需要留出：回酒店取行李 + 酒店到站（含叫车）+ 安检
  const needMin = BUFFER.hotelPickup + BUFFER.stationTransit + BUFFER.security;

  if (preferredNo) {
    const p = list.find((t) => t.no === preferredNo);
    if (p && toMin(p.dep) - needMin >= endMin) return { train: p };
  }
  // 默认选「来得及的最晚一班」：出来玩的人通常想玩够，而不是赶最早的车回家。
  // 但不超过 20:00——再晚就不是游玩而是受罪了。想早走可以在界面上改。
  const feasible = list.filter((t) => toMin(t.dep) - needMin >= endMin && toMin(t.dep) <= 20 * 60);
  if (feasible.length) return { train: feasible[feasible.length - 1] };
  // 实在来不及就坐当天最晚一班，并由调用方给出冲突提示
  return { train: list[list.length - 1] };
}

/* -------------------- 去程链 -------------------- */

function buildOutboundChain(train, cityName, fromCity) {
  const dep = toMin(train.dep);
  return [
    {
      time: toStr(dep - 50), icon: 'walk', type: 'move',
      title: `出门去 ${train.from}`,
      desc: `按 ${train.dep} 发车倒推。市区到车站打车约 20 分钟，预留 50 分钟稳妥。`,
      dur: '25 分钟',
      tip: '提前一天买好票，热门班次二等座余票偏紧',
    },
    {
      time: toStr(dep - 25), icon: 'check', type: 'warn',
      title: '到站 · 安检进站',
      desc: '支线车站提前 20–25 分钟到足够，不用像枢纽大站那样提前 40 分钟。',
      dur: '25 分钟',
      tip: '带身份证，电子客票直接刷证进站',
      risk: 'high',
    },
    {
      time: train.dep, icon: 'train', type: 'transport',
      title: `${train.no} ${train.from} → ${train.to}`,
      desc: `二等座 ¥${train.price2}${train.price1 ? ` / 一等座 ¥${train.price1}` : ''}，${fmtDur(train.durMin)}。`,
      dur: fmtDur(train.durMin),
      book: { label: '去 12306 核验余票', url: 'https://kyfw.12306.cn/otn/leftTicket/init' },
      risk: 'high',
    },
    {
      time: train.arr, icon: 'station', type: 'transport',
      title: `抵达 ${train.to}`,
      desc: '出站就是站前广场，公交出租车都在门口。',
      dur: '—',
    },
  ];
}

/* -------------------- 赶车倒推链 -------------------- */

function buildReturnChain(train, activityEndMin, transfer) {
  const nodes = [];
  const conflicts = [];
  const departMin = toMin(train.dep);

  // 倒推
  const arriveStationBy = departMin - BUFFER.security;              // 最晚到站
  const leaveHotelBy = arriveStationBy - BUFFER.stationTransit;     // 最晚从酒店出发
  const pickupStart = leaveHotelBy - BUFFER.hotelPickup;            // 最晚回酒店取行李

  if (activityEndMin > pickupStart) {
    conflicts.push({
      level: 'high',
      title: '当前行程赶不上这班车',
      detail: `游玩要到 ${toStr(activityEndMin)} 才结束，但 ${toStr(pickupStart)} 就得回酒店取行李。建议：砍掉一个景点，或者改乘更晚的班次。`,
    });
  }

  // 此刻人已在酒店（scheduleDay 收尾的「回到市区 · 打车去酒店」已把这段算进去）
  // 如果到得比必须取行李的时间早，把这段富余显式排出来 —— 时间轴不能留没有交代的空白
  const slack = pickupStart - activityEndMin;
  if (slack >= 20) {
    nodes.push({
      time: toStr(activityEndMin),
      icon: 'rest', type: 'rest',
      title: '酒店休整 / 自由时间',
      desc: `距必须出发还有 ${slack} 分钟。可以在酒店喘口气，或者去附近补点特产——但别走远。`,
      dur: fmtDur(slack),
    });
  }

  // 回酒店取行李
  nodes.push({
    time: toStr(pickupStart),
    icon: 'hotel', type: 'hotel',
    title: '取行李 + 结算退房',
    desc: `提前跟前台说过要赶车，退房手续可以很快。${BUFFER.hotelPickup} 分钟足够。`,
    dur: `${BUFFER.hotelPickup} 分钟`,
    tip: '行李前一晚就收好，别现收拾',
    risk: 'high',
  });

  // 出发去车站 —— 全链路最关键的一环
  const hotelToStationReal = transfer && transfer.ways.find((w) => w.name.includes('打车'));
  nodes.push({
    time: toStr(leaveHotelBy),
    icon: 'taxi', type: 'move',
    title: '★ 从酒店出发去车站',
    desc: `这就是全链路最关键的一环：酒店到站实际车程${hotelToStationReal ? `约 ${hotelToStationReal.timeMin} 分钟` : '通常 10–15 分钟'}，` +
          `但算上叫车等待 + 安检缓冲，必须按 ${BUFFER.stationTransit} 分钟预留。` +
          `${train.dep} 发车，晚走 20 分钟就赶不上。`,
    dur: `${BUFFER.stationTransit} 分钟`,
    tip: '上车前就让网约车在门口等',
    risk: 'high',
  });

  nodes.push({
    time: toStr(arriveStationBy),
    icon: 'check', type: 'warn',
    title: '到站 · 安检进站',
    desc: '支线小站提前 20 分钟足够；枢纽大站请按 40 分钟预留。',
    dur: `${BUFFER.security} 分钟`,
    risk: 'high',
  });

  nodes.push({
    time: train.dep,
    icon: 'train', type: 'transport',
    title: `${train.no} ${train.from} → ${train.to}`,
    desc: `二等座 ¥${train.price2}${train.price1 ? ` / 一等座 ¥${train.price1}` : ''}，${fmtDur(train.durMin)}。`,
    dur: fmtDur(train.durMin),
    book: { label: '去 12306 核验余票', url: 'https://kyfw.12306.cn/otn/leftTicket/init' },
    risk: 'high',
  });

  nodes.push({
    time: train.arr,
    icon: 'station', type: 'transport',
    title: `抵达 ${train.to || '终点站'}`,
    desc: '行程结束。',
    dur: '—',
  });

  return { nodes, conflicts };
}

/* -------------------- 单日排程 -------------------- */

async function scheduleDay({
  city, pois, startMin, startZone, endMin,
  includeOptional, usedPoiIds, skipped, cityName, hotelFirst, transfer,
}) {
  const nodes = [];
  let cursor = startMin;
  let zone = startZone;

  // 排序策略：**先按片区聚类，组内再按优先级**。
  // 纯按优先级贪心会导致「防川 → 沿途 → 再回防川」这种来回跑，白白多花 1 小时车程。
  const ZONE_ORDER = { 防川: 0, 沿途: 1, 市区: 2 };
  const candidates = pois
    .filter((p) => !usedPoiIds.has(p.id))
    .filter((p) => includeOptional || !p.optional)
    .sort((a, b) => {
      const za = ZONE_ORDER[a.zone] ?? 9;
      const zb = ZONE_ORDER[b.zone] ?? 9;
      if (za !== zb) return za - zb;
      return b.priority - a.priority;
    });

  // 景观重复组：同组只保留优先级最高的一个，其余直接标注为「可以不去」
  const seenDupe = new Set();
  const deduped = [];
  for (const p of candidates) {
    if (p.dupeGroup) {
      if (seenDupe.has(p.dupeGroup)) {
        skipped.push({ name: p.name, reason: `与同组景观重复（${p.dupeGroup}），已排入优先级更高的一个`, level: 'skip' });
        continue;
      }
      seenDupe.add(p.dupeGroup);
    }
    deduped.push(p);
  }

  // 酒店/放行李节点 —— 车程优先用「高铁站→市区」的真实换乘数据
  if (hotelFirst) {
    const taxi = transfer && transfer.ways.find((w) => w.name.includes('打车'));
    const t = taxi
      ? { durationMin: taxi.timeMin, mode: taxi.name.split('（')[0] || '打车', cost: taxi.cost, note: transfer.distance }
      : await transitBetween(city, cityName, '车站', '市区');
    nodes.push({
      time: toStr(cursor), icon: 'taxi', type: 'move',
      title: '车站 → 酒店',
      desc: transferDesc(t),
      dur: fmtDur(t.durationMin),
      link: 'station',
    });
    cursor += t.durationMin;
    nodes.push({
      time: toStr(cursor), icon: 'hotel', type: 'hotel',
      title: '到酒店寄存行李',
      desc: '正常入住时间是 14:00，先在前台免费寄存，轻装出门。',
      dur: '15 分钟',
    });
    cursor += 15;
  }

  let prevName = null; // 上一个落脚点的具体名称，用于调真实路径规划

  for (const poi of deduped) {
    const t = await transitBetween(city, cityName, zone, poi.zone, prevName, poi.name);
    const arrive = cursor + t.durationMin;

    // 硬约束 1：停止入园
    if (poi.hours && poi.hours.lastEntry && arrive > toMin(poi.hours.lastEntry)) {
      skipped.push({ name: poi.name, reason: `到达时间 ${toStr(arrive)} 晚于停止入园 ${poi.hours.lastEntry}`, level: 'skip' });
      continue;
    }
    // 硬约束 2：当天剩余时间
    if (arrive + poi.durationMin > endMin) {
      skipped.push({ name: poi.name, reason: '当天剩余时间不够', level: 'skip' });
      continue;
    }
    // 硬约束 3：闭园
    if (poi.hours && poi.hours.close && arrive + poi.durationMin > toMin(poi.hours.close)) {
      skipped.push({ name: poi.name, reason: `会超过闭园时间 ${poi.hours.close}`, level: 'skip' });
      continue;
    }

    // 交通节点
    if (t.durationMin > 0 && zone !== poi.zone) {
      nodes.push({
        time: toStr(cursor), icon: 'car', type: 'move',
        title: `${zone} → ${poi.zone}`,
        desc: transferDesc(t),
        dur: fmtDur(t.durationMin),
        tip: t.note || '',
      });
    }

    // 景点节点
    const pit = (poi.pitfalls || [])[0];
    const ticketNote = poi.ticket && (poi.ticket.price || poi.ticket.bundled)
      ? `门票 ¥${poi.ticket.price || 0}${poi.ticket.bundled ? ` + ${poi.ticket.bundledName || '附加费'} ¥${poi.ticket.bundled}（必买）` : ''}`
      : '免费';

    nodes.push({
      time: toStr(arrive),
      icon: poi.isFood ? 'food' : 'sight',
      type: poi.isFood ? 'food' : 'sight',
      title: poi.name,
      desc: [ticketNote, ...(poi.tips || []).slice(0, 3)].join('　·　'),
      dur: fmtDur(poi.durationMin),
      tip: poi.bestWindow ? `最佳时段 ${poi.bestWindow[0]}–${poi.bestWindow[1]}` : '',
      pitfall: pit ? pit.advice : '',
      needsId: poi.needsId || false,
    });

    cursor = arrive + poi.durationMin;
    zone = poi.zone;
    prevName = poi.name;
    usedPoiIds.add(poi.id);
  }

  // 收尾：从景区回到市区。
  // 只有当天真的出过城才需要这个节点 —— 纯市区日不该出现「回到市区」，更不该标红。
  if (zone !== '市区') {
    const t = await transitBetween(city, cityName, zone, '市区', prevName, '市区');
    nodes.push({
      time: toStr(cursor), icon: 'car', type: 'move',
      title: `${zone} → 市区`,
      desc: transferDesc(t),
      dur: fmtDur(t.durationMin),
    });
    cursor += t.durationMin;

    nodes.push({
      time: toStr(cursor), icon: 'station', type: 'warn',
      title: '回到市区 · 打车去酒店',
      desc: '从这里开始进入赶车倒计时。市区内打车约 12 分钟到酒店。',
      dur: '12 分钟',
      tip: '上车前就让网约车在门口等，别现叫',
      risk: 'high',
    });
    cursor += 12;
  }

  return { nodes, cursor };
}

/* -------------------- 交通时长 -------------------- */

const transitCache = new Map();

async function transitBetween(city, cityName, fromZone, toZone, fromName, toName) {
  // 人工维护的城市库有片区矩阵：同片区短驳直接给经验值，快且不耗接口
  if (fromZone === toZone && !city.dynamic) {
    const r = toZone === '防川'
      ? { durationMin: 15, mode: '景区观光车', cost: '7 元（必买）', note: '核心景点间距超 3 km，禁止步行' }
      : { durationMin: 12, mode: '打车', cost: '起步价 5 元', note: '' };
    return r;
  }

  const key = `${cityName}|${fromZone}>${toZone}|${fromName || ''}>${toName || ''}`;
  if (transitCache.has(key)) return transitCache.get(key);

  const matrix = city.zoneMatrix || {};
  const hit = matrix[`${fromZone}>${toZone}`] || matrix[`${toZone}>${fromZone}`];
  if (hit) {
    const r = { durationMin: hit.min, mode: hit.mode, cost: hit.cost || '', note: hit.note || '' };
    transitCache.set(key, r);
    return r;
  }

  // 矩阵没覆盖（动态城市基本都是这种情况）→ 交给 provider，配了高德就是真实路径规划
  const r = await providers.route({
    city: cityName,
    fromZone, toZone,
    origin: fromName || fromZone,
    destination: toName || toZone,
  });
  transitCache.set(key, r);
  return r;
}

function transferDesc(t) {
  const parts = [`${t.mode}约 ${t.durationMin} 分钟`];
  if (t.distanceKm) parts.unshift(`${t.distanceKm} km`);
  if (t.cost) parts.push(t.cost);
  if (t.note) parts.push(t.note);
  return parts.join(' · ');
}

/* -------------------- 汇总 -------------------- */

function collectPitfalls(pois) {
  const out = [];
  for (const p of pois) {
    for (const pit of p.pitfalls || []) {
      out.push({
        title: pit.score && pit.score.includes('重复') ? `${p.name}：${pit.score}` : `${p.name}`,
        level: pit.score && pit.score.includes('重复') ? 'skip' : 'warn',
        score: pit.score || '',
        quote: pit.quote || '',
        advice: pit.advice || '',
      });
    }
  }
  return out;
}

/**
 * 准备清单 —— 不硬编码，从「城市硬规则 + 排入景点的装备需求」推导出来。
 * 换一个城市，清单会跟着变，这才是产品该有的样子。
 */
function buildChecklist(city, usedPoiIds) {
  const rules = city.cityRules || [];
  const hasRule = (kw) => rules.some((r) => (r.title + r.detail).includes(kw));
  const items = [];

  if (hasRule('身份证')) {
    items.push({ item: '身份证（原件）', why: '沿途多个边防检查站，没它进不了景区', level: 'must', time: '出发前' });
  }
  if (hasRule('漫游')) {
    items.push({ item: '关闭手机「数据漫游」', why: '边境误连外国网络会扣费', level: 'must', time: '出发前' });
  }
  if (hasRule('水和零食')) {
    items.push({ item: '水和零食', why: '景区沿线几乎没有商店，前一晚在市区买好', level: 'must', time: '前一晚' });
  }

  // 从排入的景点里收集装备需求（望远镜这类）
  const gear = new Set();
  for (const id of usedPoiIds) {
    const p = city.pois.find((x) => x.id === id);
    for (const g of (p && p.gear) || []) gear.add(g);
  }
  for (const g of gear) {
    items.push({ item: g, why: '景区不提供租赁，现场买不到', level: 'must', time: '出发前' });
  }

  items.push({ item: '订去程高铁票', why: '热门班次二等座余票偏紧', level: 'must', time: '今天' });
  items.push({ item: '订返程高铁票', why: '按排程引擎推荐的最早可行班次', level: 'must', time: '今天' });
  items.push({ item: '订市区酒店', why: '别住景区村里，也别住车站周边', level: 'must', time: '今天' });
  items.push({ item: '预约去景区的包车', why: '返程直通车班次极少，靠不住', level: 'must', time: '前一晚' });

  if (hasRule('薄外套')) {
    items.push({ item: '薄外套', why: '江边风大，早晚温差明显', level: 'should', time: '出发前' });
  }
  items.push({ item: '充电宝', why: '拍照 + 导航，手机掉电极快', level: 'should', time: '出发前' });
  items.push({ item: '少量现金', why: '乡镇小店 / 包车结算更方便', level: 'should', time: '出发前' });
  items.push({ item: '防晒 + 墨镜', why: '观景台无遮挡，晴天紫外线强', level: 'should', time: '出发前' });

  if (hasRule('无人机')) {
    items.push({ item: '不要带无人机', why: '边境全域禁飞，带了也用不了', level: 'forbid', time: '出发前' });
  }
  return items;
}

function estimateBudget({ outbound, return: ret, days, pois, usedPoiIds }) {
  const items = [];
  const trainCost = (outbound ? outbound.price2 : 0) + (ret ? ret.price2 : 0);
  items.push({ name: '高铁往返', detail: `${outbound ? outbound.price2 : 0} × 2（按二等座估算）`, amount: trainCost });

  const hotelPer = days > 1 ? 109 : 0; // 按 ¥218 两人分摊
  if (hotelPer) items.push({ name: '酒店', detail: '按 ¥218/晚 两人分摊', amount: hotelPer });

  let ticketSum = 0;
  const ticketDetail = [];
  for (const id of usedPoiIds) {
    const p = pois.find((x) => x.id === id);
    if (!p || !p.ticket) continue;
    const cost = (p.ticket.price || 0) + (p.ticket.bundled || 0);
    if (cost > 0) { ticketSum += cost; ticketDetail.push(`${p.name} ¥${cost}`); }
  }
  items.push({ name: '景点门票', detail: ticketDetail.join(' + ') || '本行程均为免费景点', amount: ticketSum });

  const car = usedPoiIds.has('longhuge') ? 150 : 0;
  if (car) items.push({ name: '包车（市区↔景区）', detail: '150–200 元，4 人拼车人均 120–150', amount: car });

  items.push({ name: '市内交通', detail: '打车起步价 5 元', amount: 40 });
  items.push({ name: '餐饮', detail: '人均 50–80/餐', amount: days * 100 });

  const total = items.reduce((s, x) => s + x.amount, 0);
  return {
    perPerson: items,
    total: `约 ¥${Math.round(total / 10) * 10} – ${Math.round(total * 1.18 / 10) * 10}`,
    note: '海鲜（如帝王蟹）属大额弹性支出，未计入：约 240 元/斤 + 加工费 10 元/斤，随季节波动很大。',
  };
}

/* -------------------- 日期工具 -------------------- */

function weekdayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}
function nextDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = { buildPlan, toMin, toStr, fmtDur, BUFFER };
