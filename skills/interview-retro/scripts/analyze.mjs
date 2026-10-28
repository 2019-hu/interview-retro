#!/usr/bin/env node
/**
 * interview-retro / analyze.mjs —— 事实层（零依赖，Node >= 18）
 *
 * 把一场面试的文字记录解析成可复现的结构化指标：题量、时长、字数、
 * STAR 信号、量化缺失、模糊词、团队主语、技术术语、JD 关键词覆盖。
 * 判断留给模型，测量留给脚本。
 *
 * 用法:
 *   node scripts/analyze.mjs <transcript.md> [--jd jd.md] [--company 互联网大厂]
 *     [--round 一面] [--role 后端工程师] [--out <dir>] [--cps 3.7]
 *     [--speaker-map "张三=interviewer,李四=candidate"] [--quiet]
 *
 * 退出码: 0 成功 / 2 输入错误 / 3 schema 或内部错误
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '1.0.0';
export const DIMENSIONS = ['structure', 'evidence', 'depth', 'fit', 'delivery'];

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES_PATH = join(HERE, '..', 'assets', 'company-profiles.json');

const INTERVIEWER_LABELS = ['面试官', '面试官a', '面试官b', '面试官1', '面试官2', '面试员', '考官', '主面', '主面试官',
  '技术面试官', '一面官', '二面官', 'hr', 'hrbp', 'hr面', '问', 'q', 'interviewer', '面试', '面试方'];
const CANDIDATE_LABELS = ['我', '本人', '候选人', '应聘者', '求职者', '自己', '答', 'a', 'me', 'candidate', 'c'];

const HEDGES = ['差不多', '大概', '可能', '估计', '应该是', '应该', '好像', '似乎', '记不清', '忘了', '不确定',
  '还行', '一般般', '比较简单', '反正', '之类的', '什么的', '大致', '基本上', '应该是吧', '不清楚', '没太注意', '印象中'];

const SIGNALS = {
  situation: ['当时', '背景', '起因', '需求是', '目标是', '问题在于', '线上', '业务上', '项目里', '系统里', '一开始', '场景是', '我们团队'],
  action: ['我负责', '我做了', '我的方案', '于是', '我设计', '我推动', '我先', '我引入', '我选型', '我实现', '我改', '我拆', '我定义', '我评估'],
  result: ['结果', '最终', '上线后', '提升', '下降', '降低', '稳定', '缩短', '减少了', '增长了', '达到了', '翻倍', '归零', '收敛']
};
const TRADEOFF_WORDS = ['取舍', '权衡', '代价', '但是', '不过', '牺牲', '折中', '对比', '选择了', '放弃了', '成本在于', '复杂度', '而不是'];
const VERIFY_WORDS = ['压测', '监控', '灰度', '指标', '埋点', '观测', '日志', '告警', '基准', '基准测试', 'benchmark', '看板', 'SLO', 'SLA', '回归'];
const FAILURE_WORDS = ['故障', '事故', '线上问题', '回滚', '踩坑', '失败', '挂了', '超时', '雪崩', '报警', '排查', '翻车'];

const QUANT_RE = /\d+(?:\.\d+)?\s*(?:%|％|倍|万|千|亿|个|人|台|条|次|天|周|月|年|小时|分钟|秒|毫秒|核|QPS|qps|TPS|tps|ms|MS|MB|GB|TB|PB|W|w|K|k|G|GiB)/g;

const TECH_LEXICON = ['分布式', '微服务', '高并发', '高可用', '缓存', '消息队列', '数据库', '索引', '分库分表', '读写分离',
  '事务', '锁', '幂等', '限流', '熔断', '降级', '容器', '容器化', 'Kubernetes', 'Docker', 'Service Mesh', '网关',
  '负载均衡', '链路追踪', '可观测性', '监控', '告警', '灰度发布', '压测', '性能调优', 'JVM', 'GC', '内存泄漏',
  '线程池', '协程', '异步', '网络', 'TCP', 'HTTP', 'RPC', 'gRPC', '序列化', '协议', '数据一致性', '最终一致',
  'CAP', 'BASE', '领域驱动', 'DDD', '重构', '设计模式', '单元测试', '集成测试', 'CI', 'CD', 'DevOps', '稳定性',
  '容量规划', '成本优化', '架构演进', '技术选型', '数据仓库', '离线', '实时', '流式', 'Spark', 'Flink', 'Kafka',
  'Redis', 'MySQL', 'PostgreSQL', 'Elasticsearch', 'MongoDB', 'Spring', 'Java', 'Go', 'Python', 'Kotlin', 'C++',
  'Vue', 'React', 'Node', 'TypeScript', 'Serverless', '云原生', '安全', '权限', '鉴权', '加密', '多租户', '机器学习'];

const EN_STOPWORDS = new Set(['the', 'and', 'or', 'for', 'with', 'you', 'your', 'our', 'are', 'will', 'can', 'have',
  'has', 'that', 'this', 'from', 'not', 'but', 'all', 'any', 'who', 'how', 'what', 'why', 'when', 'where', 'they',
  'their', 'them', 'its', 'it', 'is', 'be', 'to', 'of', 'in', 'on', 'at', 'as', 'by', 'an', 'we', 'us', 'if', 'do',
  'does', 'job', 'team', 'work', 'working', 'good', 'well', 'must', 'should', 'able', 'plus', 'etc']);

/** 输入/参数错误（退出码 2）。 */
export class InputError extends Error {}

/** 归一化说话人标签：去空格与装饰符，转小写。 */
export function normalizeLabel(raw) {
  return String(raw).replace(/[\s*_#>~\-\[\]（）()【】<>「」]/g, '').toLowerCase();
}

/** 解析 mm:ss 或 hh:mm:ss 时间戳为秒。 */
export function timestampToSeconds(ts) {
  if (!ts) return null;
  const parts = String(ts).split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

const LINE_RE = /^\s*(?:[-*>\u2022]\s*)?(?:\[\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\]\s*)?(?:(\d{1,2}:\d{2}(?::\d{2})?)\s+)?(?:\*\*)?\s*([^：:\n]{1,14}?)\s*(?:\*\*)?\s*[：:]\s*([\s\S]*)$/;

/**
 * 解析面试转写文本为说话人回合。
 * @param {string} text 原始记录
 * @param {{speakerMap?: Record<string,string>}} [options]
 */
export function parseTranscript(text, options) {
  const opts = options || {};
  const custom = opts.speakerMap || {};
  let src = String(text);
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
  const rawLines = src.replace(/\r\n?/g, '\n').split('\n');
  const warnings = [];
  const warnSeen = new Set();
  const preamble = [];
  const turns = [];
  let hasTimestamps = false;

  const warn = (msg) => {
    if (warnSeen.has(msg) || warnings.length >= 20) return;
    warnSeen.add(msg);
    warnings.push(msg);
  };

  for (const line of rawLines) {
    if (line.trim() === '') continue;
    const m = LINE_RE.exec(line);
    let role = null;
    let label = '';
    let body = line.trim();
    let ts = null;
    if (m) {
      ts = m[1] || m[2] || null;
      label = normalizeLabel(m[3]);
      body = (m[4] || '').trim();
      if (custom[label]) role = custom[label];
      else if (INTERVIEWER_LABELS.indexOf(label) >= 0) role = 'interviewer';
      else if (CANDIDATE_LABELS.indexOf(label) >= 0) role = 'candidate';
    }
    if (ts) hasTimestamps = true;
    if (role === null) {
      if (turns.length === 0) {
        preamble.push(line.trim());
        continue;
      }
      if (m) warn('无法识别的说话人标签「' + m[3].trim() + '」，已并入上一个回合；可用 --speaker-map 指定');
      const last = turns[turns.length - 1];
      last.text += '\n' + line.trim();
      continue;
    }
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.text += '\n' + body;
      if (last.ts === null && ts) last.ts = ts;
    } else {
      turns.push({ role, text: body, ts, seconds: timestampToSeconds(ts) });
    }
  }
  return { turns, warnings, hasTimestamps, preamble };
}

/** 把回合配对成 问-答 单元（连续追问合并进上一题，连续同角色回合自动合并）。 */
export function pairQa(turns) {
  const qa = [];
  const orphans = [];
  let current = null;
  for (const turn of turns) {
    if (turn.role === 'interviewer') {
      if (current && current.answerText.length === 0) {
        current.questionText += ' / ' + turn.text;
        current.followUps += 1;
      } else {
        if (current) qa.push(current);
        current = {
          questionText: turn.text,
          questionTs: turn.seconds,
          answerText: '',
          answerTs: null,
          followUps: 0
        };
      }
    } else if (turn.role === 'candidate') {
      if (current) {
        current.answerText += (current.answerText ? '\n' : '') + turn.text;
        if (current.answerTs === null) current.answerTs = turn.seconds;
      } else {
        orphans.push(turn.text);
      }
    }
  }
  if (current) qa.push(current);
  return { qa, orphans };
}

function countLatinWords(s) {
  const m = s.match(/[A-Za-z][A-Za-z0-9+#.\-\/]*/g);
  return m ? m.length : 0;
}
function countLatinChars(s) {
  const m = s.match(/[A-Za-z0-9]/g);
  return m ? m.length : 0;
}
function countCjk(s) {
  const m = s.match(/[一-龥]/g);
  return m ? m.length : 0;
}
function countWord(s, word) {
  let n = 0;
  let idx = s.indexOf(word);
  while (idx >= 0) {
    n += 1;
    idx = s.indexOf(word, idx + word.length);
  }
  return n;
}
function matchedWords(s, words) {
  return words.filter((w) => s.indexOf(w) >= 0);
}

/** 计算单题指标。 */
export function measureAnswer(text, cps) {
  const rate = cps && cps > 0 ? cps : 3.7;
  const cjk = countCjk(text);
  const latinChars = countLatinChars(text);
  const charCount = cjk + latinChars;
  const quant = text.match(QUANT_RE) || [];
  const we = countWord(text, '我们');
  const iCount = countWord(text, '我') - we;
  const hedges = [];
  for (const h of HEDGES) {
    const n = countWord(text, h);
    if (n > 0) hedges.push({ word: h, count: n });
  }
  const hedgeCount = hedges.reduce((a, b) => a + b.count, 0);
  const jargons = matchedWords(text, TECH_LEXICON);
  const signals = {
    situation: matchedWords(text, SIGNALS.situation).length > 0,
    action: matchedWords(text, SIGNALS.action).length > 0,
    result: matchedWords(text, SIGNALS.result).length > 0
  };
  const starScore = (signals.situation ? 1 : 0) + (signals.action ? 1 : 0) + (signals.result ? 1 : 0);
  const flags = [];
  if (charCount === 0) flags.push('unanswered');
  if (charCount > 0 && charCount < 60) flags.push('too_short');
  const estSeconds = Math.round(charCount / rate);
  if (estSeconds > 240) flags.push('too_long');
  if (charCount >= 60 && quant.length === 0) flags.push('no_quantification');
  if (hedgeCount >= 3 || (hedgeCount >= 2 && charCount < 200)) flags.push('hedge_heavy');
  if (we >= 3 && we > iCount) flags.push('we_heavy');
  if (charCount >= 60 && !signals.situation) flags.push('no_context');
  if (charCount >= 60 && !signals.action) flags.push('no_action');
  if (charCount >= 60 && !signals.result) flags.push('no_result');
  if (charCount >= 60 && matchedWords(text, TRADEOFF_WORDS).length === 0) flags.push('no_tradeoff');
  if (charCount >= 60 && matchedWords(text, VERIFY_WORDS).length === 0) flags.push('no_verification');
  if (charCount >= 60 && matchedWords(text, FAILURE_WORDS).length === 0) flags.push('no_failure_story');
  return {
    cjk, latin_chars: latinChars, latin_words: countLatinWords(text), char_count: charCount,
    est_seconds: estSeconds, quantifications: quant, hedge_count: hedgeCount, hedges,
    we_count: we, i_count: iCount, jargons, signals, star_score: starScore, flags
  };
}

const FLAG_WEIGHT = {
  unanswered: 3, no_quantification: 2, no_result: 2, no_action: 2, no_context: 1.5,
  hedge_heavy: 1.5, we_heavy: 1.5, no_tradeoff: 1, no_verification: 1, no_failure_story: 0.5,
  too_long: 1, too_short: 1
};

/** 完整分析入口。 */
export function analyzeTranscript(input) {
  const options = input || {};
  const parsed = parseTranscript(options.transcript, { speakerMap: options.speakerMap });
  const paired = pairQa(parsed.turns);
  const cps = options.cps;
  const qa = paired.qa.map((item, index) => {
    const m = measureAnswer(item.answerText, cps);
    return Object.assign({
      index: index + 1,
      question: item.questionText,
      question_preview: item.questionText.slice(0, 60),
      answer: item.answerText,
      answer_preview: item.answerText.slice(0, 80),
      follow_ups: item.followUps,
      question_ts: item.questionTs,
      answer_ts: item.answerTs,
      duration_seconds: null,
      answered: item.answerText.length > 0
    }, m);
  });
  for (let i = 0; i < qa.length; i += 1) {
    const cur = qa[i];
    if (cur.answer_ts === null) continue;
    let end = null;
    for (let j = i + 1; j < qa.length; j += 1) {
      if (qa[j].question_ts !== null) { end = qa[j].question_ts; break; }
    }
    if (end !== null && end > cur.answer_ts) cur.duration_seconds = end - cur.answer_ts;
  }
  const answered = qa.filter((q) => q.answered);
  const flagCounts = new Map();
  for (const q of qa) for (const f of q.flags) flagCounts.set(f, (flagCounts.get(f) || 0) + 1);
  const hedgeTotals = new Map();
  for (const q of qa) for (const h of q.hedges) hedgeTotals.set(h.word, (hedgeTotals.get(h.word) || 0) + h.count);
  const totalWe = qa.reduce((a, q) => a + q.we_count, 0);
  const totalI = qa.reduce((a, q) => a + q.i_count, 0);
  const realDurations = qa.filter((q) => q.duration_seconds !== null).map((q) => q.duration_seconds);
  const aggregate = {
    qa_count: qa.length,
    answered_count: answered.length,
    answered_ratio: qa.length ? Number((answered.length / qa.length).toFixed(3)) : 0,
    total_answer_chars: answered.reduce((a, q) => a + q.char_count, 0),
    avg_answer_chars: answered.length ? Math.round(answered.reduce((a, q) => a + q.char_count, 0) / answered.length) : 0,
    avg_est_seconds: answered.length ? Math.round(answered.reduce((a, q) => a + q.est_seconds, 0) / answered.length) : 0,
    avg_real_seconds: realDurations.length ? Math.round(realDurations.reduce((a, b) => a + b, 0) / realDurations.length) : null,
    est_total_seconds: answered.reduce((a, q) => a + q.est_seconds, 0),
    real_total_seconds: realDurations.length ? realDurations.reduce((a, b) => a + b, 0) : null,
    duration_source: realDurations.length ? 'timestamps' : 'estimated_from_chars',
    quantified_ratio: answered.length ? Number((answered.filter((q) => q.quantifications.length > 0).length / answered.length).toFixed(3)) : 0,
    star_complete_ratio: answered.length ? Number((answered.filter((q) => q.star_score === 3).length / answered.length).toFixed(3)) : 0,
    we_total: totalWe,
    i_total: totalI,
    follow_up_total: qa.reduce((a, q) => a + q.follow_ups, 0),
    hedge_total: Array.from(hedgeTotals.values()).reduce((a, b) => a + b, 0),
    top_hedges: Array.from(hedgeTotals.entries()).map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count).slice(0, 8)
  };
  const flags = Array.from(flagCounts.entries())
    .map(([flag, count]) => ({ flag, count, ratio: qa.length ? Number((count / qa.length).toFixed(2)) : 0, qa_indexes: qa.filter((q) => q.flags.indexOf(flag) >= 0).map((q) => q.index) }))
    .sort((a, b) => b.count - a.count);
  const risks = qa.map((q) => {
    const score = q.flags.reduce((a, f) => a + (FLAG_WEIGHT[f] || 0.5), 0);
    return { qa_index: q.index, risk_score: Number(score.toFixed(1)), flags: q.flags, question: q.question_preview };
  }).filter((r) => r.risk_score > 0).sort((a, b) => b.risk_score - a.risk_score).slice(0, 8);
  const company = resolveCompany(options.company);
  const jd = options.jdText ? extractJd(options.jdText, qa.map((q) => q.answer).join('\n')) : null;
  return {
    meta: {
      tool: 'interview-retro/analyze.mjs', version: VERSION, generated_at: new Date().toISOString(),
      transcript_chars: String(options.transcript).length, jd_provided: Boolean(options.jdText),
      cps: cps && cps > 0 ? cps : 3.7, company_query: options.company || null,
      company_type: company.type, company_label: company.label, company_match: company.match,
      round: options.round || null, role: options.role || null,
      dimension_order: DIMENSIONS, company_weights: company.weights
    },
    source: { text: String(options.transcript).slice(0, 200000) },
    parse: {
      lines: String(options.transcript).split('\n').length,
      turns: parsed.turns.length,
      interviewer_turns: parsed.turns.filter((t) => t.role === 'interviewer').length,
      candidate_turns: parsed.turns.filter((t) => t.role === 'candidate').length,
      qa_count: qa.length,
      orphan_answers: paired.orphans.length,
      preamble: parsed.preamble.slice(0, 5),
      has_timestamps: parsed.hasTimestamps,
      warnings: parsed.warnings
    },
    qa,
    flags,
    aggregate,
    risks,
    jd,
    company: { type: company.type, label: company.label, weights: company.weights, focus: company.focus, taboos: company.taboos }
  };
}

/** 提取 JD 关键词与关注点，并计算候选人回答的覆盖率。 */
export function extractJd(jdText, answerText) {
  const jd = String(jdText);
  const answers = String(answerText || '').toLowerCase();
  const enCounts = new Map();
  const enTokens = jd.match(/[A-Za-z][A-Za-z0-9+#.\-\/]{1,}/g) || [];
  for (const raw of enTokens) {
    const token = raw.toLowerCase().replace(/[.\-\/]+$/, '');
    if (token.length < 2 || EN_STOPWORDS.has(token) || /^[0-9]+$/.test(token)) continue;
    enCounts.set(token, (enCounts.get(token) || 0) + 1);
  }
  const cnTerms = TECH_LEXICON.filter((t) => jd.indexOf(t) >= 0);
  const keywords = [];
  for (const [token, count] of enCounts.entries()) keywords.push({ term: token, count, kind: 'en' });
  for (const term of cnTerms) keywords.push({ term, count: countWord(jd, term), kind: 'cn' });
  keywords.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  const top = keywords.slice(0, 40);
  const hit = [];
  const missing = [];
  for (const k of top) {
    const needle = k.term.toLowerCase();
    if (answers.indexOf(needle) >= 0) hit.push(k); else missing.push(k);
  }
  const focusLines = jd.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l.length > 6 && /负责|要求|熟悉|精通|优先|参与|具备|推动|掌握|了解|经验/.test(l))
    .slice(0, 12);
  return {
    keyword_count: top.length,
    coverage: top.length ? Number((hit.length / top.length).toFixed(3)) : 0,
    hit_keywords: hit,
    missing_keywords: missing,
    focus_lines: focusLines,
    core_requirements: top.slice(0, 8).map((k) => k.term)
  };
}

/** 公司性质 -> 权重档案。 */
export function resolveCompany(query, profilesPath) {
  const path = profilesPath || PROFILES_PATH;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const fallback = { type: 'general', label: data.profiles.general.label, weights: data.profiles.general.weights,
    focus: data.profiles.general.focus, taboos: data.profiles.general.taboos, match: 'fallback' };
  if (!query) return fallback;
  const q = String(query).trim().toLowerCase();
  if (data.profiles[q]) {
    const p = data.profiles[q];
    return { type: q, label: p.label, weights: p.weights, focus: p.focus, taboos: p.taboos, match: 'profile_key' };
  }
  if (data.aliases[q] && data.profiles[data.aliases[q]]) {
    const p = data.profiles[data.aliases[q]];
    return { type: data.aliases[q], label: p.label, weights: p.weights, focus: p.focus, taboos: p.taboos, match: 'alias_exact' };
  }
  const aliasKeys = Object.keys(data.aliases).sort((a, b) => b.length - a.length);
  for (const key of aliasKeys) {
    if (q.indexOf(key) >= 0 || key.indexOf(q) >= 0) {
      const p = data.profiles[data.aliases[key]];
      return { type: data.aliases[key], label: p.label, weights: p.weights, focus: p.focus, taboos: p.taboos, match: 'alias_fuzzy:' + key };
    }
  }
  for (const key of Object.keys(data.profiles)) {
    if (data.profiles[key].label.indexOf(String(query).trim()) >= 0) {
      const p = data.profiles[key];
      return { type: key, label: p.label, weights: p.weights, focus: p.focus, taboos: p.taboos, match: 'label_fuzzy' };
    }
  }
  return fallback;
}

/** 生成给人看的摘要文本。 */
export function formatSummary(result) {
  const L = [];
  const a = result.aggregate;
  L.push('== 面试记录事实层 (interview-retro ' + result.meta.version + ') ==');
  L.push('公司档案: ' + result.company.label + ' [' + result.company.type + ', 匹配方式 ' + result.meta.company_match + ']');
  L.push('解析: ' + result.parse.turns + ' 个回合 -> ' + a.qa_count + ' 题 (面试官 ' + result.parse.interviewer_turns + ' / 候选人 ' + result.parse.candidate_turns + ')');
  L.push('时长: ' + (a.duration_source === 'timestamps' ? ('时间戳合计 ' + a.real_total_seconds + ' 秒') : ('按 ' + result.meta.cps + ' 字/秒估算合计 ' + a.est_total_seconds + ' 秒'))
    + ' | 平均单题 ' + (a.avg_real_seconds === null ? a.avg_est_seconds + ' 秒(估算)' : a.avg_real_seconds + ' 秒(时间戳)')
    + ' | 平均 ' + a.avg_answer_chars + ' 字');
  L.push('量化率: ' + Math.round(a.quantified_ratio * 100) + '% | STAR 完整率: ' + Math.round(a.star_complete_ratio * 100) + '% | 追问次数: ' + a.follow_up_total);
  L.push('主语: 我们 ' + a.we_total + ' 次 vs 我 ' + a.i_total + ' 次 | 模糊词 ' + a.hedge_total + ' 次');
  if (a.top_hedges.length) L.push('  高频模糊词: ' + a.top_hedges.map((h) => h.word + 'x' + h.count).join(', '));
  if (result.flags.length) {
    L.push('高频问题信号:');
    for (const f of result.flags.slice(0, 8)) L.push('  - ' + f.flag + ' x' + f.count + ' (题 ' + f.qa_indexes.slice(0, 12).join(',') + ')');
  }
  if (result.risks.length) {
    L.push('最该复盘的题:');
    for (const r of result.risks.slice(0, 5)) L.push('  - Q' + r.qa_index + ' (风险 ' + r.risk_score + ') ' + r.flags.join('/') + ' | ' + r.question);
  }
  if (result.jd) {
    L.push('JD 覆盖: ' + Math.round(result.jd.coverage * 100) + '% (' + result.jd.hit_keywords.length + '/' + result.jd.keyword_count + ')');
    L.push('  未命中的高频要求: ' + result.jd.missing_keywords.slice(0, 8).map((k) => k.term).join(', '));
  } else {
    L.push('JD: 未提供 —— 匹配度维度应跳过或降权，不要猜。');
  }
  if (result.parse.warnings.length) {
    L.push('解析告警:');
    for (const w of result.parse.warnings) L.push('  ! ' + w);
  }
  return L.join('\n');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'quiet' || key === 'json-only' || key === 'help') { out[key] = true; continue; }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new InputError('参数 --' + key + ' 缺少取值');
      out[key] = value;
      i += 1;
    } else out._.push(arg);
  }
  return out;
}

function parseSpeakerMap(raw) {
  const map = {};
  if (!raw) return map;
  for (const part of String(raw).split(',')) {
    const pair = part.split('=');
    const label = (pair[0] || '').trim();
    const role = (pair[1] || '').trim();
    if (!label || !role) continue;
    if (role !== 'interviewer' && role !== 'candidate') throw new InputError('--speaker-map 的角色只能是 interviewer 或 candidate，收到: ' + role);
    map[normalizeLabel(label)] = role;
  }
  return map;
}

export function main(argv) {
  const args = parseArgs(argv || []);
  if (args.help || args._.length === 0) {
    process.stdout.write('用法: node scripts/analyze.mjs <transcript.md> [--jd jd.md] [--company 类型] [--round 轮次] [--role 岗位] [--out <dir>] [--cps 3.7] [--speaker-map "张三=interviewer"]\n');
    return 0;
  }
  const transcriptPath = resolve(args._[0]);
  if (!existsSync(transcriptPath)) throw new InputError('找不到记录文件: ' + transcriptPath);
  const transcript = readFileSync(transcriptPath, 'utf8');
  if (transcript.trim().length < 20) throw new InputError('记录内容过短，无法分析: ' + transcriptPath);
  let jdText = null;
  if (args.jd) {
    const jdPath = resolve(args.jd);
    if (!existsSync(jdPath)) throw new InputError('找不到 JD 文件: ' + jdPath);
    jdText = readFileSync(jdPath, 'utf8');
  }
  const result = analyzeTranscript({
    transcript, jdText, company: args.company, round: args.round, role: args.role,
    cps: args.cps ? Number(args.cps) : undefined, speakerMap: parseSpeakerMap(args['speaker-map'])
  });
  const outDir = args.out ? resolve(args.out) : dirname(transcriptPath);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, basename(transcriptPath, extname(transcriptPath)) + '.analysis.json');
  result.meta.analysis_path = outPath;
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  if (!args.quiet && !args['json-only']) process.stdout.write(formatSummary(result) + '\n');
  if (!args.quiet) process.stdout.write('analysis.json -> ' + outPath + '\n');
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof InputError ? 2 : 3;
    process.stderr.write('[analyze] ' + (error && error.message ? error.message : String(error)) + '\n');
    process.exitCode = code;
  }
}
