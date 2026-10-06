/**
 * 极简测试（零依赖，node test/run.js）
 * 重点验证排程引擎的三件事：
 *   1. 硬约束有没有生效（停止入园 / 时间不够 → 景点被正确砍掉）
 *   2. 赶车倒推算得对不对
 *   3. 景观重复组有没有去重
 */

const planner = require('../server/planner');
const { toMin } = planner;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); fail++; }
}

(async () => {
  console.log('\n=== 排程引擎 ===');
  const plan = await planner.buildPlan({
    city: '珲春', fromCity: '延吉', date: '2026-10-07', days: 2,
  });

  ok('无致命错误', !plan.error, plan.error);
  if (plan.error) { process.exit(1); }

  ok('生成 2 天行程', plan.days.length === 2, JSON.stringify(plan.days.map(d => d.day)));
  ok('高铁往返都选到了', !!plan.trains.chosen.outbound && !!plan.trains.chosen.return);

  const day2 = plan.days[1];
  const nodes = day2.nodes;

  /* --- 赶车倒推校验 --- */
  const train = plan.trains.chosen.return;
  const depart = toMin(train.dep);
  const arriveStation = nodes.find(n => n.title.includes('到站'));
  const leaveHotel = nodes.find(n => n.title.includes('从酒店出发'));

  ok('存在「从酒店出发」关键节点', !!leaveHotel);
  ok('存在「到站安检」关键节点', !!arriveStation);
  if (leaveHotel && arriveStation) {
    ok('酒店出发 + 30 分钟缓冲 = 到站时间',
      toMin(arriveStation.time) - toMin(leaveHotel.time) === planner.BUFFER.stationTransit,
      `${leaveHotel.time} → ${arriveStation.time}`);
    ok('到站 + 20 分钟安检 = 发车时间',
      depart - toMin(arriveStation.time) === planner.BUFFER.security,
      `${arriveStation.time} → ${train.dep}`);
  }

  /* --- 时间单调性：节点时间不能倒流 --- */
  let monotonic = true, prev = -1;
  for (const n of nodes) {
    const m = toMin(n.time);
    if (m < prev && m < 300) { monotonic = false; break; } // 允许跨午夜
    prev = m;
  }
  ok('Day2 时间轴单调递增', monotonic);

  /* --- 硬约束：龙虎阁必须排在上午 --- */
  const longhuge = nodes.find(n => n.title.includes('龙虎阁'));
  ok('核心景点龙虎阁已排入', !!longhuge);
  if (longhuge) {
    ok('龙虎阁排在上午（午后起雾）', toMin(longhuge.time) < 12 * 60, longhuge.time);
  }

  /* --- 景观重复组去重 --- */
  const sandNodes = nodes.filter(n => n.title.includes('金沙滩') || n.title.includes('沙丘'));
  ok('沙地景观只保留一个', sandNodes.length <= 1, sandNodes.map(n => n.title).join(','));

  /* --- 停止入园约束 --- */
  const lastEntryViolation = nodes.filter(n => n.title.includes('龙虎阁'))
    .some(n => toMin(n.time) > toMin('16:00'));
  ok('没有违反 16:00 停止入园', !lastEntryViolation);

  console.log('\n=== 冲突检测 ===');
  ok('返回冲突数组', Array.isArray(plan.conflicts));
  plan.conflicts.forEach(c => console.log(`  ! [${c.level}] ${c.title}: ${c.detail}`));

  console.log('\n=== 被砍掉的景点（引擎的取舍） ===');
  ok('返回 skipped 数组', Array.isArray(plan.skipped));
  plan.skipped.forEach(s => console.log(`  · ${s.name} —— ${s.reason}`));

  console.log('\n=== 关键节点 ===');
  plan.keyNodes.forEach(k => console.log(`  ⏱  ${k.time}  ${k.title}`));

  console.log('\n=== 预算 ===');
  console.log('  ' + plan.budget.total);
  plan.budget.perPerson.forEach(p => console.log(`  · ${p.name}: ¥${p.amount}`));

  /* --- 边界：单日往返 --- */
  console.log('\n=== 边界：当天往返（days=1） ===');
  const oneDay = await planner.buildPlan({ city: '珲春', fromCity: '延吉', date: '2026-10-07', days: 1 });
  ok('单日往返不报错', !oneDay.error, oneDay.error);
  if (!oneDay.error) {
    ok('单日只排 1 天', oneDay.days.length === 1);
    ok('单日也有返程车次', !!oneDay.trains.chosen.return);
    console.log(`  砍掉了 ${oneDay.skipped.length} 个景点（时间不够）`);
  }

  /* --- 边界：不支持的城市 --- */
  const bad = await planner.buildPlan({ city: '火星', fromCity: '延吉', date: '2026-10-07' });
  ok('未知城市给出友好提示', !!bad.error && bad.error.includes('暂不支持'));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();
