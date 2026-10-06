/**
 * 配置中心
 *
 * 设计原则（开源项目的安全红线）：
 *  1. 所有密钥只从环境变量 / .env 读取，绝不写死在代码里
 *  2. .env 已在 .gitignore 中，永远不会被提交
 *  3. 前端拿不到任何 key —— 所有第三方调用都走 server 侧代理
 *  4. 任何 key 缺失都不影响启动，自动降级到 mock / 本地规则引擎
 */

const fs = require('fs');
const path = require('path');

/** 极简 .env 解析（不引入 dotenv，保持零依赖） */
function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    // 去掉成对引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // 已存在的真实环境变量优先级更高
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile();

const config = {
  port: Number(process.env.PORT || 3000),

  amap: {
    key: process.env.AMAP_KEY || '',
    base: 'https://restapi.amap.com/v3',
  },

  llm: {
    baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'deepseek-chat',
  },

  train: {
    /**
     * 数据源选择：
     *   12306    —— 调 12306 官方公开查询接口，拿真实余票与票价（默认）
     *   custom   —— 你自己实现的接口，需在 TRAIN_API_BASE 配置
     *   snapshot —— 完全不联网，只用内置真实采集快照
     */
    provider: process.env.TRAIN_PROVIDER || '12306',
    base: process.env.TRAIN_API_BASE || '',
    key: process.env.TRAIN_API_KEY || '',
  },

  hotel: {
    base: process.env.HOTEL_API_BASE || '',
    key: process.env.HOTEL_API_KEY || '',
  },
};

/** 当前有哪些数据源是「真数据」，哪些是「快照/降级」——前端会展示这个状态 */
config.dataSourceStatus = () => ({
  amap: config.amap.key ? 'live' : 'mock',
  llm: config.llm.apiKey ? 'live' : 'rule',
  train: config.train.base ? 'live' : 'snapshot',
  hotel: config.hotel.base ? 'live' : 'snapshot',
});

module.exports = config;
