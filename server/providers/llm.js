/**
 * AI 小助手 Provider
 *
 * 两种模式：
 *  1. live  —— 配置 LLM_API_KEY 后走 OpenAI Chat Completions 兼容协议
 *             （DeepSeek / 通义 / Kimi / Moonshot / OpenAI 都能直接填）
 *             行程数据会作为上下文注入，等价于一个轻量 RAG，
 *             保证它回答的是「你这趟行程」，而不是泛泛的旅游常识。
 *  2. rule  —— 无 key 时降级为本地关键词规则引擎，命中内置知识库；
 *             命中不了就老实说「没装进知识库」，绝不编造。
 *
 * 前端永远拿不到 LLM_API_KEY —— 调用全在服务端。
 */

const config = require('../config');
const sample = require('../data/sample');

const TIMEOUT_MS = 20000;

const SYSTEM_PROMPT = `你是「随行 GoP」的 AI 小助手「小P」，一个帮 P 人（临时起意型旅客）做分钟级出行规划的搭子。

你的原则：
1. 只基于下面【本次行程数据】回答。数据里没有的，就明确说你没有这个信息，不要编造车次、价格、开放时间。
2. 用户的时间假设经常是错的（比如说「我 17:30 的车」但实际没有这个班次）。发现冲突要第一时间指出，并给出最接近的可行替代。
3. 先给结论，再给理由。不要铺垫。
4. 涉及「值不值得去」时，如实转述网友评价，包括负面评价。用户要的是避坑，不是种草。
5. 回答控制在 200 字以内，用短句和换行，不要用大段排比。
6. 全程中文。`;

function buildContextBlock(context) {
  if (!context) return '';
  const parts = [];
  if (context.dest) parts.push(`目的地：${context.dest}`);
  if (context.dateRange) parts.push(`日期：${context.dateRange}`);
  if (context.trains) parts.push(`车次数据：${JSON.stringify(context.trains)}`);
  if (context.keyNodes && context.keyNodes.length) {
    parts.push(`关键时间节点（晚一点就会崩）：${context.keyNodes.map((n) => `${n.time} ${n.title}`).join(' | ')}`);
  }
  if (context.pitfalls && context.pitfalls.length) {
    parts.push(`网友避坑：${context.pitfalls.map((p) => p.title).join(' | ')}`);
  }
  if (context.cityRules && context.cityRules.length) {
    parts.push(`硬性规则：${context.cityRules.map((r) => r.title).join(' | ')}`);
  }
  return parts.length ? `\n\n【本次行程数据】\n${parts.join('\n')}` : '';
}

/** 模式 1：真实大模型 */
async function liveChat({ messages, context }) {
  const url = `${config.llm.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const payloadMessages = [
    { role: 'system', content: SYSTEM_PROMPT + buildContextBlock(context) },
    ...messages.slice(-8), // 只带最近 8 轮，控制 token
  ];

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: payloadMessages,
      temperature: 0.4,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`大模型接口 HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('大模型返回内容为空');
  return { text: content.trim(), source: 'llm' };
}

/** 模式 2：本地规则引擎 */
function ruleChat({ messages, context }) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const q = last ? String(last.content).replace(/\s/g, '') : '';

  if (context && context.alert && /车|赶|17|18/.test(q)) {
    return { text: `${context.alert.title}。${context.alert.detail}`, source: 'rule' };
  }

  for (const item of sample.qa) {
    if (item.keys.some((k) => q.includes(k))) {
      return { text: item.a, source: 'rule' };
    }
  }
  return { text: sample.fallback[Math.floor(Math.random() * sample.fallback.length)], source: 'rule' };
}

async function chat(opts) {
  if (config.llm.apiKey) {
    try {
      return await liveChat(opts);
    } catch (err) {
      // 大模型挂了不能让整个对话挂掉——降级并如实告知
      const r = ruleChat(opts);
      return {
        ...r,
        source: 'rule',
        degraded: true,
        error: `大模型调用失败（${err.message}），已降级为本地规则引擎`,
      };
    }
  }
  return ruleChat(opts);
}

module.exports = { chat, ruleChat, enabled: () => Boolean(config.llm.apiKey), name: 'llm' };
