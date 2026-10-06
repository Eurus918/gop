/**
 * 城市景点库
 *
 * 这是整个产品最核心的资产，也是最难被复制的部分。
 * 每个景点不只是一张名片，而是「一组可被算法使用的硬约束 + 一条取舍建议」。
 *
 * 字段说明：
 *  durationMin   建议游玩时长（分钟）
 *  priority      优先级 1-10，排程时时间不够会被优先牺牲低优先级的点
 *  hours         开放时间 / 停止入园 / 末班车 —— 排程引擎的硬约束来源
 *  zone          所属片区，配合 zoneMatrix 计算真实车程
 *  dupeGroup     景观重复组：同组内只排一个（金沙滩 vs 沙丘公园这类）
 *  optional      可选点，时间紧会被自动砍掉
 *  skipIf        遇到这些天气条件直接建议放弃
 *  pitfalls      网友真实吐槽（带出处）→ 前端「避坑」模块
 *
 * 数据来源：携程景点页公开评分与游记、公开攻略。采集于 2026-10。
 * 所有价格/时间标注为参考值，出行前请复核。欢迎提 PR 校正。
 */

const CITIES = {
  珲春: {
    city: '珲春',
    province: '吉林 · 延边朝鲜族自治州',
    intro: '中国唯一地处中俄朝三国交界的边境窗口城市。',
    railStation: '珲春站',
    hotelAreas: ['新安街', '欧式街', '东市场'],

    /**
     * 片区之间的车程矩阵（分钟）
     * mock 模式用这个；配了高德 key 之后会用真实路径规划覆盖
     */
    zoneMatrix: {
      '市区>市区': { min: 12, mode: '打车', cost: '起步价 5 元' },
      '市区>防川': { min: 60, mode: '包车', cost: '150–200 元', note: '约 70 km，走 G331 国道' },
      '防川>市区': { min: 60, mode: '包车', cost: '150–200 元' },
      '防川>防川': { min: 15, mode: '景区观光车', cost: '7 元（必买）', note: '核心景点间距超 3 km，禁止步行' },
      '市区>沿途': { min: 45, mode: '包车' },
      '沿途>市区': { min: 45, mode: '包车' },
      '沿途>防川': { min: 15, mode: '包车' },
      '防川>沿途': { min: 15, mode: '包车' },
      '沿途>沿途': { min: 20, mode: '包车' },
    },

    /** 城市级硬规则 —— 无条件展示给用户的红线 */
    cityRules: [
      {
        level: 'danger',
        title: '身份证必带，一路多个边防检查站',
        detail: '没有身份证过不去防川。这是整趟行程唯一「漏了就全盘崩」的东西。',
        source: '公开攻略一致提醒',
      },
      {
        level: 'danger',
        title: '全域禁止无人机，不拍哨所与军事设施',
        detail: '不要拍摄哨所、边防军人、军事设施；不要向图们江对岸喊话或扔东西。无人机直接别带。',
        source: '边境管理相关规定',
      },
      {
        level: 'warn',
        title: '关闭手机「数据漫游」',
        detail: '边境地区容易误连外国网络，产生高额漫游费。出发前在设置里关掉，或开飞行模式 + 手动连 WiFi。',
        source: '公开攻略一致提醒',
      },
      {
        level: 'warn',
        title: '进防川前在市区买好水和零食',
        detail: '沿线几乎没有商店，景区内选择少、物价高。前一晚在市区超市搞定。',
        source: '公开攻略一致提醒',
      },
      {
        level: 'warn',
        title: '江边风大，无论晴雨都带件薄外套',
        detail: '图们江边风力明显，10 月起早晚温差大。',
        source: '携程防川攻略',
      },
    ],

    pois: [
      {
        id: 'longhuge',
        name: '龙虎阁（一眼望三国）',
        zone: '防川',
        address: '珲春市敬信镇防川国家风景名胜区内',
        durationMin: 60,
        priority: 10,
        ticket: { price: 70, bundled: 7, bundledName: '景区观光车', note: '观光车与门票捆绑，必买；65 周岁以上免大门票但观光车仍需购买' },
        hours: { open: '08:00', close: '17:00', lastEntry: '16:00', lastShuttle: '16:30' },
        bestWindow: ['08:30', '11:00'],
        skipIf: ['雾', '大雨', '阴霾'],
        needsId: true,
        gear: ['望远镜'], // 会被排程引擎收进「准备清单」
        tips: [
          '楼高 64.8 米，电梯直达 10 楼露天观景台，无玻璃遮挡视野最好',
          '左手俄罗斯哈桑镇，右手朝鲜豆满江市，前方俄朝跨国铁路大桥',
          '一楼是吴大澂历史展览馆，建议先看历史再登高',
          '自备望远镜 —— 景区不提供租赁，肉眼看只能看到轮廓',
        ],
        pitfalls: [
          {
            score: '携程 3.4 分 · 「一眼望三国」3.6 分（防川片区最低）',
            quote: '「在这里看的不是令人陶醉的美景，只是到三个国家交界的一次打卡。」——携程游记',
            advice: '为「地理意义」去，不是为「风景」去。天气不好（大雾/下雨）直接放弃——看不到日本海等于白来 70 块。',
          },
        ],
      },
      {
        id: 'tuzibei',
        name: '土字碑 · 边境木栈道',
        zone: '防川',
        address: '防川国家风景名胜区内',
        durationMin: 25,
        priority: 9,
        ticket: { price: 0 },
        bestWindow: ['09:00', '12:00'],
        needsId: true,
        tips: ['清代中俄勘界界碑，历史意义很重', '沿图们江的木栈道适合慢走'],
        pitfalls: [
          {
            score: '网友反馈存在临时关闭情况',
            quote: '「土字碑我们去时不开放了，有些遗憾。」——携程游记',
            advice: '景区内现在是复刻碑，原碑在边防管控区内无法靠近。如果到了发现不开放，别硬等，直接去下一个点。',
          },
        ],
      },
      {
        id: 'wudacheng',
        name: '吴大澂雕像广场',
        zone: '防川',
        address: '珲春市敬信镇圈防线',
        durationMin: 15,
        priority: 6,
        ticket: { price: 0 },
        tips: ['纪念晚清官员据理力争收复国土、保住图们江通海权'],
        pitfalls: [],
      },
      {
        id: 'dongfangdiyicun',
        name: '东方第一村（朝鲜族民俗村）',
        zone: '防川',
        address: '珲春市敬信镇防川国家风景名胜区内',
        durationMin: 50,
        priority: 8,
        ticket: { price: 0 },
        bestWindow: ['11:00', '14:00'],
        isFood: true,
        tips: ['青瓦朝鲜族民居，可以租民族服饰拍照、体验打糕', '村里能吃朝鲜族家常菜，适合安排午餐'],
        pitfalls: [],
      },
      {
        id: 'yangguanping',
        name: '洋馆坪路堤',
        zone: '沿途',
        address: '圈防线 · 中俄朝界河图们江畔',
        durationMin: 10,
        priority: 7,
        ticket: { price: 0 },
        needsId: true,
        tips: ['全长 888 米，最窄处仅 8 米 —— 中国最窄领土', '左侧俄罗斯铁丝网，右侧图们江对岸是朝鲜'],
        pitfalls: [
          {
            score: '携程 3.5 分',
            quote: '路边短暂停靠拍照的点，不是景区',
            advice: '车辆只能短暂停靠，不要长时间占道。包车才能停，跟团大巴通常不停。',
          },
        ],
      },
      {
        id: 'quanhekouan',
        name: '圈河口岸',
        zone: '沿途',
        address: '珲春市圈河（中朝贸易口岸）',
        durationMin: 30,
        priority: 4,
        optional: true,
        ticket: { price: 25 },
        bestWindow: ['09:00', '15:00'],
        needsId: true,
        tips: ['中国与朝鲜的贸易口岸，有 119 号界碑', '需要坐很短时间的区间车'],
        pitfalls: [
          {
            score: '网友标签：打卡点',
            quote: '「也是一个打卡点，有 119 号界碑。」——携程游记',
            advice: '本质是打卡性质，与防川主线重合度高。对界碑没有执念可以跳过，省 25 元 + 30 分钟，把时间留给龙虎阁。',
          },
        ],
      },
      {
        id: 'zhanggufeng',
        name: '张鼓峰纪念馆',
        zone: '防川',
        address: '珲春市敬信镇防川沿线',
        durationMin: 20,
        priority: 3,
        optional: true,
        ticket: { price: 20 },
        needsId: true,
        tips: ['讲解张鼓峰事件与中、俄、朝三国边界划定的历史', '馆内有卖俄罗斯商品'],
        pitfalls: [],
      },
      {
        id: 'jingxinshidi',
        name: '敬信湿地',
        zone: '沿途',
        address: '珲春市敬信镇',
        durationMin: 30,
        priority: 5,
        ticket: { price: 0 },
        tips: ['候鸟迁徙季（春秋）最值得停', '返程途中顺路停 15–30 分钟比较合适'],
        pitfalls: [],
      },
      {
        id: 'binshuigongyuan',
        name: '珲春河滨水公园',
        zone: '市区',
        address: '珲春河沿岸城市公园',
        durationMin: 60,
        priority: 6,
        ticket: { price: 0 },
        tips: ['免费，人少安静，刚下车时缓一缓很合适', '河景秀丽，适合散步'],
        pitfalls: [],
      },
      {
        id: 'oushijie',
        name: '欧式街',
        zone: '市区',
        address: '珲春市新安路欧式街',
        durationMin: 90,
        priority: 7,
        ticket: { price: 0 },
        bestWindow: ['17:30', '20:00'],
        tips: ['市内一条欧式建筑商业街', '白天一般，天黑后灯亮起来才好看，别去太早'],
        pitfalls: [],
      },
      {
        id: 'haixianjie',
        name: '海鲜街（帝王蟹）',
        zone: '市区',
        address: '欧式街附近海鲜街',
        durationMin: 80,
        priority: 8,
        ticket: { price: 0 },
        isFood: true,
        tips: [
          '珲春是帝王蟹集散地，比内地便宜不少',
          '街里有「买蟹 + 加工」一体的店，加工费约 10 元/斤',
          '也可以吃朝鲜族现压冷面、石锅拌饭、米肠、大酱汤，人均 50 吃到撑',
        ],
        pitfalls: [
          {
            score: '时价波动很大',
            quote: '「7 月帝王蟹价格在 240 元/斤左右，加工费 10 元/斤，买蟹加工也是需要额外付加工费的。」——携程游记',
            advice: '进店第一句一定是「今天多少钱一斤」。加工费另算，别默认包含在蟹价里。这是珲春唯一的大额弹性支出，先给自己定上限再进店。',
          },
        ],
      },
      {
        id: 'waluojia',
        name: '瓦洛佳俄货店',
        zone: '市区',
        address: '珲春市区',
        durationMin: 40,
        priority: 3,
        optional: true,
        ticket: { price: 0 },
        tips: ['珲春买俄货最全的一家店', '不感兴趣可以直接跳过'],
        pitfalls: [],
      },
      {
        id: 'jinshatan',
        name: '金沙滩公园',
        zone: '防川',
        address: '防川国家风景名胜区内',
        durationMin: 30,
        priority: 4,
        optional: true,
        dupeGroup: 'sand',
        ticket: { price: 0 },
        tips: ['被称为「绿洲中的沙漠」'],
        pitfalls: [
          {
            score: '与沙丘公园景观高度重复',
            quote: '同属防川景区内的沙地景观，网友反馈差异不大',
            advice: '和沙丘公园二选一就够。两个都去 = 同一张照片拍两遍。',
          },
        ],
      },
      {
        id: 'shaqiugongyuan',
        name: '沙丘公园',
        zone: '防川',
        address: '防川风景区内',
        durationMin: 30,
        priority: 4,
        optional: true,
        dupeGroup: 'sand',
        ticket: { price: 0 },
        tips: ['沙地景观'],
        pitfalls: [
          {
            score: '与金沙滩公园景观高度重复',
            quote: '同属防川景区内的沙地景观',
            advice: '和金沙滩公园二选一就够。',
          },
        ],
      },
    ],
  },
};

module.exports = { CITIES, getCity: (name) => CITIES[name] };
