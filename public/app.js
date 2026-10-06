/**
 * 随行 GoP · 前端
 *
 * 所有数据都来自服务端 API —— 前端不持有任何密钥，也不做任何第三方调用。
 * 改控制条里任意一个参数，都会带着新参数重新请求 /api/plan，
 * 服务端排程引擎全链路重算后返回新时间轴。这就是这个产品的核心交互。
 */

const ICON = {
  walk: '🚶', taxi: '🚕', car: '🚗', train: '🚄', station: '📍',
  sight: '🏞', shop: '🛍', food: '🍽', hotel: '🏨', check: '⚠️',
  rest: '☕', ticket: '🎫',
};
const CLS = {
  move: 'c-move', transport: 'c-transport', sight: 'c-sight', food: 'c-food',
  hotel: 'c-hotel', warn: 'c-warn', rest: 'c-rest', ticket: 'c-ticket',
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

let PLAN = null;
let STATUS = null;

async function api(url, opts) {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({ ok: false, error: '接口返回格式错误' }));
  if (!json.ok) throw new Error(json.error || '接口错误');
  return json.data !== undefined ? json.data : json;
}

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ==================== 载入 ==================== */

async function boot() {
  STATUS = await api('/api/status');
  $('#fCity').innerHTML = STATUS.cities.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('#fDate').value = tomorrowStr();
  renderSrcBar();
  await loadPlan();
}

async function loadPlan() {
  const btn = $('#fGo');
  btn.disabled = true;
  $('#boot').style.display = 'block';
  ['#tripBox', '#ticketBox', '#hotelBox', '#pitBox', '#packBox', '#budgetBox'].forEach((k) => { $(k).innerHTML = ''; });

  const q = new URLSearchParams({
    city: $('#fCity').value || '珲春',
    from: $('#fFrom').value || '延吉',
    date: $('#fDate').value || tomorrowStr(),
    days: $('#fDays').value || '2',
  });
  const rv = $('#fReturn').value;
  if (rv && rv !== 'auto') q.set('returnNo', rv);

  try {
    PLAN = await api('/api/plan?' + q.toString());
    $('#boot').style.display = 'none';
    if (PLAN.error) {
      $('#tripBox').innerHTML = `<div class="alertbox"><h3>排不出来</h3><p>${esc(PLAN.error)}</p></div>`;
      return;
    }
    fillReturnOptions();
    renderAll();
  } catch (err) {
    $('#boot').innerHTML = `<div class="alertbox"><h3>加载失败</h3><p>${esc(err.message)}</p></div>`;
  } finally {
    btn.disabled = false;
  }
}

function fillReturnOptions() {
  const list = (PLAN.trains.inbound.list || []);
  const cur = PLAN.trains.chosen.return;
  $('#fReturn').innerHTML =
    `<option value="auto">自动选择（推荐）</option>` +
    list.map((t) => `<option value="${esc(t.no)}"${cur && cur.no === t.no ? ' selected' : ''}>${esc(t.no)} ${t.dep}</option>`).join('');
}

function renderSrcBar() {
  const s = STATUS.status;
  const label = { amap: '路径规划', llm: 'AI 小助手', train: '车次', hotel: '酒店' };
  const txt = { live: '实时', '12306': '12306 实时', rule: '本地规则', snapshot: '快照', mock: '估算' };
  $('#srcbar').innerHTML = Object.entries(s).map(([k, v]) =>
    `<span class="src ${v}"><span class="dot"></span>${label[k]}：${txt[v] || v}</span>`
  ).join('');
  $('#chatMode').textContent = s.llm === 'live' ? '大模型模式' : '本地规则模式';
}

function renderAll() {
  renderTrip();
  renderTicket();
  renderHotel();
  renderPit();
  renderPack();
  renderBudget();
}

/* ==================== 行程 ==================== */

function renderTrip() {
  const m = PLAN.meta;
  const ov = [
    ['目的地', m.dest],
    ['行程', `${m.days} 天 ${m.nights} 晚`],
    ['出发', `${m.departCity} ${m.dateStart.slice(5)}`],
    ['去程', `${PLAN.trains.chosen.outbound.no} ${PLAN.trains.chosen.outbound.dep}`],
    ['返程', PLAN.trains.chosen.return ? `${PLAN.trains.chosen.return.no} ${PLAN.trains.chosen.return.dep}` : '—'],
    ['人均预算', PLAN.budget.total.replace('约 ', '')],
  ];

  const conflicts = (PLAN.conflicts || []).map((c) =>
    `<div class="conflict"><h4>⚠️ ${esc(c.title)}</h4><p>${esc(c.detail)}</p></div>`).join('');

  const days = PLAN.days.map((d, i) => `
    <div class="daycard">
      <div class="day-head ${i % 2 ? 'alt' : ''}">
        <div class="d">DAY ${d.day} · ${esc(d.date)} ${esc(d.weekday || '')}</div>
        <div class="t">${esc(d.title)}</div>
        <div class="s">${esc(d.summary || '')}</div>
      </div>
      <div class="tl">
        ${d.nodes.map((n) => {
          const cls = CLS[n.type] || 'c-move';
          return `
          <div class="node ${cls} ${n.risk === 'high' ? 'risk' : ''}">
            <div class="t">${esc(n.time)}</div>
            <div class="rail"><div class="pin">${ICON[n.icon] || '•'}</div></div>
            <div class="body">
              <h4>${esc(n.title)}</h4>
              <div class="desc">${esc(n.desc)}</div>
              ${n.dur ? `<div class="dur">时长 ${esc(n.dur)}</div>` : ''}
              ${n.tip ? `<span class="chip tip">💡 ${esc(n.tip)}</span>` : ''}
              ${n.pitfall ? `<span class="chip pit">⚠️ ${esc(n.pitfall)}</span>` : ''}
              ${n.needsId ? `<span class="chip risk">🪪 需出示身份证</span>` : ''}
              ${n.risk === 'high' ? `<span class="chip risk">⏱ 关键时间节点</span>` : ''}
              ${n.book ? `<a class="chip book" href="${esc(n.book.url)}" target="_blank" rel="noopener">${esc(n.book.label)} ↗</a>` : ''}
              ${n.risk === 'high' ? `<button class="chip book" style="background:linear-gradient(135deg,#ffb0c8,#b79cff)" onclick="askNode('${esc(n.title)}')">问小P ↗</button>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');

  const skipped = (PLAN.skipped || []).length ? `
    <div class="sec-head"><h2>引擎帮你砍掉的</h2><span class="sub">时间不够 / 景观重复 / 来不及入园</span></div>
    <div class="skipped">
      ${PLAN.skipped.map((s) => `<div class="sk"><span class="nm">${esc(s.name)}</span><span class="rs">${esc(s.reason)}</span><span class="tg">不排</span></div>`).join('')}
    </div>` : '';

  const wx = (PLAN.weather && PLAN.weather.days && PLAN.weather.days.length) ? `
    <div class="sec-head"><h2>天气</h2><span class="sub">来自高德实时数据</span></div>
    <div class="wx">${PLAN.weather.days.slice(0, 3).map((d) => `
      <div class="wxd">
        <div class="d">${esc(d.date || '')}</div>
        <div class="w">${esc(d.dayWeather || '')}</div>
        <div class="t">${esc(d.dayTemp || '')}° / ${esc(d.nightTemp || '')}°</div>
      </div>`).join('')}</div>` : '';

  const dynamicNote = m.dynamic ? `
    <div class="notice" style="max-width:none">
      <span>🛠</span>
      <div>这个城市还没有人工维护的景点库，景点由<b>高德真实 POI 动态生成</b>——名称、地址是真的，
      但开放时间、停止入园、游玩时长用的是<b>默认值</b>，也没有网友避坑数据。
      想要更准的行程，可以在 <code>server/data/pois.js</code> 里补充该城市（欢迎提 PR）。</div>
    </div>` : '';

  $('#tripBox').innerHTML = `
    ${dynamicNote}
    <div class="sec-head"><h2>这次去哪儿</h2><span class="sub">${esc(m.province || '')} · ${esc(m.intro || '')}</span></div>
    <div class="overview">${ov.map(([k, v]) => `<div class="ov"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
    ${conflicts}
    ${wx}
    <div class="sec-head"><h2>分钟级时间轴</h2><span class="sub">标红 = 晚 20 分钟就全盘崩</span></div>
    ${days}
    ${skipped}`;
}

/* ==================== 车票 ==================== */

function seatsTxt(n) {
  if (n === -1) return '有票';
  if (n === 0) return '无票';
  return `${n} 张`;
}

function trainRow(t) {
  const isRec = t.recommend;
  const p2 = t.price2 == null ? '待核验' : `¥${t.price2}`;
  const p1 = t.price1 == null ? '待核验' : `¥${t.price1}`;
  return `
    <div class="train ${isRec ? 'rec' : ''}">
      <div class="no">${esc(t.no)}</div>
      <div class="tm">${esc(t.dep)}<i>→</i>${esc(t.arr)}</div>
      <div class="dur">${esc(t.durMin)} 分钟</div>
      <div class="pr"${t.price2 == null ? ' style="color:var(--ink-3);font-size:14px"' : ''}>${p2}<small> 二等座</small></div>
      <div class="pr" style="color:var(--ink-3);font-size:13px">${p1}<small> 一等</small></div>
      ${isRec ? '<span class="badge">推荐</span>' : ''}
      <div class="seats">二等座 ${seatsTxt(t.seats2)}${t.seats2 === 0 ? '（可候补）' : ''}</div>
      <div class="note">${esc(t.note || '')}</div>
    </div>`;
}

function srcNote(t) {
  if (t.source === '12306') return `· 12306 实时余票 · 查询于 ${esc(String(t.queriedAt || '').slice(11, 16))}`;
  if (t.live) return '· 实时接口';
  return '· 参考快照，需在 12306 核验';
}

function renderTicket() {
  const o = PLAN.trains.outbound, b = PLAN.trains.inbound;
  const alert = b.alert ? `<div class="alertbox"><h3>⚠️ ${esc(b.alert.title)}</h3><p>${esc(b.alert.detail)}</p></div>` : '';
  const chosen = PLAN.trains.chosen;
  const degraded = [o, b].filter((x) => x.degraded);

  $('#ticketBox').innerHTML = `
    ${degraded.length ? `<div class="conflict"><h4>⚠️ 实时查询失败，已回落到参考快照</h4><p>${esc(degraded[0].error || '')}　数据可能不准，请以 12306 为准。</p></div>` : ''}
    <div class="sec-head"><h2>去程 · ${esc(o.from)} → ${esc(o.to)}</h2><span class="sub">${esc(o.date)} ${srcNote(o)}</span></div>
    <div style="display:grid;gap:10px">${(o.list || []).map(trainRow).join('')}</div>

    <div class="sec-head"><h2>返程 · ${esc(b.from)} → ${esc(b.to)}</h2><span class="sub">引擎已选 ${esc(chosen.return ? chosen.return.no : '—')} ${srcNote(b)}</span></div>
    ${alert}
    <div style="display:grid;gap:10px">${(b.list || []).map(trainRow).join('')}</div>

    <div class="notice" style="max-width:none;margin-top:20px">
      <span>🔗</span>
      <div>余票实时变动，<b>热门班次建议提前订</b>——城际线路临近发车常出现无座。
      标「待核验」的票价是因为限速保护没逐个查询，点开 12306 即可确认。</div>
    </div>`;
}

/* ==================== 酒店 & 接站 ==================== */

function renderHotel() {
  const t = PLAN.transfer;
  const xs = (t.stops || []).map((_, i, arr) => 70 + (i * (530 / Math.max(arr.length - 1, 1))));

  const stopsSVG = (t.stops || []).map((s, i) => {
    const isStart = s.kind === 'start', isEnd = s.kind === 'end';
    const size = isStart || isEnd ? 15 : 10;
    const color = isStart ? '#4aa8ff' : isEnd ? '#ff8fae' : '#c3d0e0';
    const lab = isStart ? '🚉' : isEnd ? '🏨' : '';
    return `
      <g>
        <circle cx="${xs[i]}" cy="95" r="${size + 4}" fill="#fff"/>
        <circle cx="${xs[i]}" cy="95" r="${size}" fill="${color}"/>
        ${lab ? `<text x="${xs[i]}" y="100" font-size="14" text-anchor="middle">${lab}</text>` : ''}
        <text x="${xs[i]}" y="132" font-size="12.5" font-weight="700" fill="#2b3445" text-anchor="middle">${esc(s.name)}</text>
        <text x="${xs[i]}" y="149" font-size="10.5" fill="#93a0b4" text-anchor="middle">${isStart ? '起点' : isEnd ? '酒店区' : '途经'}</text>
      </g>`;
  }).join('');

  const ways = (t.ways || []).map((w) => `
    <div class="way">
      <div class="n">${esc(w.name)}</div>
      <div class="m">${esc(w.cost)} · 约 ${w.timeMin} 分钟 · ${esc(w.hours || '')}</div>
      <div class="d">${esc(w.desc)}</div>
      <span class="tg">${esc(w.tag)}</span>
    </div>`).join('');

  $('#hotelBox').innerHTML = `
    <div class="sec-head"><h2>高铁站 → 酒店</h2><span class="sub">先把这 ${esc(t.distance)} 搞清楚</span></div>
    <div class="card routemap">
      <svg viewBox="0 0 680 168" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="680" height="168" rx="16" fill="#fafcff"/>
        <rect x="206" y="22" width="268" height="30" rx="15" fill="#e4fbf5"/>
        <text x="340" y="42" font-size="12.5" font-weight="700" fill="#1f9e88" text-anchor="middle">全程约 ${esc(t.distance)} · 打车 8–10 分钟 · 公交 15 分钟</text>
        <line x1="46" y1="95" x2="634" y2="95" stroke="#e6eef7" stroke-width="16" stroke-linecap="round"/>
        <line x1="58" y1="95" x2="606" y2="95" stroke="#4ecdc4" stroke-width="3" stroke-dasharray="9 7" stroke-linecap="round"/>
        <polygon points="620,95 604,88 604,102" fill="#4ecdc4"/>
        <g transform="translate(292,58)">
          <rect x="0" y="7" width="42" height="13" rx="6" fill="#5aa9ff"/>
          <path d="M9 7 L14 0 L30 0 L35 7 Z" fill="#8fc6ff"/>
          <circle cx="11" cy="21" r="4.5" fill="#2b3445"/>
          <circle cx="31" cy="21" r="4.5" fill="#2b3445"/>
        </g>
        ${stopsSVG}
      </svg>
      <div class="waylist">${ways}</div>
      <div class="notice" style="max-width:none;margin-top:16px"><span>💡</span><div>${esc(t.warning || '')}</div></div>
    </div>
    <div class="sec-head"><h2>住哪儿</h2><span class="sub">建议住市区核心，吃饭打车都方便；别住景区村里</span></div>
    <div id="hotelList"><div class="loading"><div class="spin"></div>载入酒店…</div></div>`;

  loadHotels();
}

async function loadHotels() {
  try {
    const h = await api('/api/hotels?city=' + encodeURIComponent(PLAN.meta.dest));
    $('#hotelList').innerHTML = `
      <div class="notice" style="max-width:none;margin-bottom:14px"><span>🏨</span><div>${esc(h.areaTip || '')}</div></div>
      ${(h.list || []).map((x) => `
        <div class="hotel" style="margin-bottom:12px">
          <div class="left">
            <div class="nm">${esc(x.name)}</div>
            <div class="mt">${esc(x.type)} · ${esc(x.area)} · ${esc(x.tel || '')}</div>
            <div class="why">${esc(x.why)}</div>
            <div class="fit">适合：${esc(x.fit)}</div>
          </div>
          <div class="right">
            <div class="pr">¥${x.price}<small> 起</small></div>
            <div class="sc">${x.score} 分</div>
            <div style="margin-top:8px"><span class="badge ${x.tag === '综合最优' || x.tag === '性价比王' ? '' : 'alt'}">${esc(x.tag)}</span></div>
          </div>
        </div>`).join('')}`;
  } catch (e) {
    $('#hotelList').innerHTML = `<div class="alertbox"><h3>酒店数据加载失败</h3><p>${esc(e.message)}</p></div>`;
  }
}

/* ==================== 避坑 & 红线 ==================== */

function renderPit() {
  const rules = (PLAN.cityRules || []).map((r) => `
    <div class="rule ${r.level === 'warn' ? 'warn' : ''}">
      <h4>${r.level === 'danger' ? '🚫' : '⚠️'} ${esc(r.title)}</h4>
      <p>${esc(r.detail)}</p>
      ${r.source ? `<div class="src2">来源：${esc(r.source)}</div>` : ''}
    </div>`).join('');

  const pits = (PLAN.pitfalls || []).map((p) => `
    <div class="pit ${p.level}">
      <div class="top"><h4>${esc(p.title)}</h4><span class="tag">${p.level === 'skip' ? '可以不去' : '注意'}</span></div>
      ${p.score ? `<div class="score">${esc(p.score)}</div>` : ''}
      ${p.quote ? `<div class="quote">${esc(p.quote)}</div>` : ''}
      ${p.advice ? `<div class="advice"><b>怎么做</b>　${esc(p.advice)}</div>` : ''}
    </div>`).join('');

  $('#pitBox').innerHTML = `
    <div class="sec-head"><h2>硬红线</h2><span class="sub">违反会导致行程直接崩掉</span></div>
    ${rules}
    <div class="sec-head"><h2>网友怎么说</h2><span class="sub">哪些可以不去 · 期望值怎么管</span></div>
    ${pits || '<div class="card">暂无结构化避坑数据，欢迎提 PR 补充。</div>'}`;
}

/* ==================== 准备清单 ==================== */

const CK_KEY = 'gop_checklist';

function renderPack() {
  let done = [];
  try { done = JSON.parse(localStorage.getItem(CK_KEY) || '[]'); } catch (e) { done = []; }
  const label = { must: '必带', should: '建议', forbid: '别带' };

  const draw = () => {
    $('#packBox').innerHTML = `
      <div class="sec-head"><h2>提前准备</h2><span class="sub">由城市硬规则 + 景点装备需求动态生成 · 点一下打勾</span></div>
      <div class="checks">
        ${PLAN.checklist.map((c, i) => `
          <div class="ck ${done.includes(i) ? 'done' : ''}" onclick="toggleCk(${i})">
            <div class="box">${done.includes(i) ? '✓' : ''}</div>
            <div style="flex:1">
              <div class="ci">${esc(c.item)}<span class="lv ${c.level}">${label[c.level]}</span></div>
              <div class="cw">${esc(c.why)}</div>
            </div>
            <div class="tm">${esc(c.time)}</div>
          </div>`).join('')}
      </div>`;
  };

  window.toggleCk = (i) => {
    done = done.includes(i) ? done.filter((x) => x !== i) : done.concat(i);
    try { localStorage.setItem(CK_KEY, JSON.stringify(done)); } catch (e) { /* 隐私模式下忽略 */ }
    draw();
  };
  draw();
}

/* ==================== 预算 & 架构 ==================== */

function renderBudget() {
  const b = PLAN.budget;
  $('#budgetBox').innerHTML = `
    <div class="sec-head"><h2>花多少</h2><span class="sub">人均 · 不含海鲜大餐</span></div>
    <div class="bud">
      ${b.perPerson.map((x) => `
        <div class="row">
          <div>${esc(x.name)}<div class="d">${esc(x.detail)}</div></div>
          <div class="a">¥${x.amount}</div>
        </div>`).join('')}
      <div class="tot"><span style="font-size:14px;font-weight:700">人均合计</span><b>${esc(b.total)}</b></div>
      <div class="nt">${esc(b.note)}</div>
    </div>

    <div class="sec-head"><h2>这个项目由什么组成</h2><span class="sub">架构与扩展点</span></div>
    <div class="card" style="line-height:1.9;font-size:13.5px;color:var(--ink-2)">
      <p><b style="color:var(--ink)">排程引擎</b>　<code>server/planner.js</code>。把开放时间、停止入园、末班车、发车时刻等硬约束与真实车程放在一起，
      倒推每个节点的最晚出发时间。改任意一个输入，全链路重算——这是它和普通攻略的根本区别。</p>
      <p style="margin-top:12px"><b style="color:var(--ink)">景点库</b>　<code>server/data/pois.js</code>。每个景点是一组可被算法使用的约束与一条取舍建议，
      而不是一张名片。想支持新城市，往这里加就行。</p>
      <p style="margin-top:12px"><b style="color:var(--ink)">可插拔数据源</b>　<code>server/providers/</code>。
      高德（路径/天气/POI）、大模型（小助手）、车次与酒店接口各自独立，
      任意一个失败都会静默降级，不会白屏。</p>
      <p style="margin-top:12px"><b style="color:var(--ink)">数据 honesty</b>　实时数据拿不到的部分，一律标注为快照并给出官方跳转，
      绝不把快照伪装成实时。车次接口的现状是：12306 无官方开放 API，因此默认走真实快照 + 官方核验。</p>
      <p style="margin-top:12px"><b style="color:var(--ink)">待办</b>　时间窗最优求解（当前为片区聚类 + 优先级贪心）、
      多城市扩展、行程可编辑与冲突实时回显、用户偏好记忆。</p>
    </div>`;
}

/* ==================== Tab ==================== */

function go(id) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === id));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
window.go = go;

/* ==================== 小助手 ==================== */

function pushMsg(who, text) {
  const bd = $('#chatBody');
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.innerHTML = `<div class="av">${who === 'bot' ? '🐣' : '🙋'}</div><div class="bb"></div>`;
  d.querySelector('.bb').textContent = text;
  bd.appendChild(d);
  bd.scrollTop = bd.scrollHeight;
  return d.querySelector('.bb');
}

function chatContext() {
  if (!PLAN) return {};
  return {
    dest: PLAN.meta.dest,
    dateRange: `${PLAN.meta.dateStart} ~ ${PLAN.meta.dateEnd}`,
    trains: PLAN.trains.chosen,
    alert: PLAN.trains.inbound.alert,
    keyNodes: PLAN.keyNodes,
    pitfalls: (PLAN.pitfalls || []).slice(0, 8),
    cityRules: PLAN.cityRules,
  };
}

async function send(text) {
  if (!text) return;
  pushMsg('me', text);
  $('#chatInput').value = '';
  const thinking = pushMsg('bot', '正在想…');
  try {
    const data = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: text }], context: chatContext() }),
    });
    thinking.textContent = data.text;
    if (data.degraded) {
      thinking.textContent += `\n\n（${data.error}）`;
    }
  } catch (err) {
    thinking.textContent = `抱歉，小助手暂时不可用：${err.message}`;
  }
  $('#chatBody').scrollTop = 1e6;
}
window.send = send;

window.askNode = (title) => {
  openChat(true);
  setTimeout(() => send(/车|出发|车站/.test(title) ? '赶车来得及吗' : `关于「${title}」要注意什么`), 250);
};

function openChat(force) {
  const c = $('#chat');
  if (force) c.classList.add('on'); else c.classList.toggle('on');
  if (c.classList.contains('on')) {
    $('#chatInput').focus();
    if (!$('#chatBody').dataset.init) {
      $('#chatBody').dataset.init = '1';
      const t = PLAN && PLAN.trains.chosen.return;
      const k = (PLAN.keyNodes || []).filter((n) => n.title.includes('出发'))[0];
      pushMsg('bot',
        `嗨，我是小P 🐣 你的随行搭子。\n\n这次去${PLAN ? PLAN.meta.dest : '目的地'}，` +
        (t ? `返程我给你排的是 ${t.no} ${t.dep}。` : '') +
        (k ? `\n\n全链路最关键的一环是 ${k.time} 的「${k.title}」——晚 20 分钟就赶不上车。` : '') +
        `\n\n时间轴里标红的都是「崩一个就全崩」的节点。随便问我，或者点下面的按钮。`);
    }
  }
}
window.openChat = openChat;

function renderSugg() {
  const picks = ['赶车来得及吗', '这个值不值得去', '必须带什么', '酒店怎么选', '整趟花多少', '我想改行程'];
  $('#sugg').innerHTML = picks.map((p) => `<button onclick="send('${p}')">${p}</button>`).join('');
}

/* ==================== 启动 ==================== */

document.addEventListener('DOMContentLoaded', () => {
  $('#fGo').onclick = loadPlan;
  ['#fCity', '#fDays', '#fReturn', '#fDate'].forEach((s) => { $(s).onchange = loadPlan; });
  $('#buddyBtn').onclick = () => openChat();
  $('#chatClose').onclick = () => $('#chat').classList.remove('on');
  $('#chatSend').onclick = () => send($('#chatInput').value.trim());
  $('#chatInput').onkeydown = (e) => { if (e.key === 'Enter') send($('#chatInput').value.trim()); };
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => go(t.dataset.tab); });
  renderSugg();
  boot().catch((e) => {
    $('#boot').innerHTML = `<div class="alertbox"><h3>启动失败</h3><p>${esc(e.message)}</p></div>`;
  });
});
