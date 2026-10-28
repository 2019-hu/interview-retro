#!/usr/bin/env node
/**
 * interview-retro / score.mjs —— 聚合层（零依赖，Node >= 18）
 *
 * 模型只负责给 1-5 分的维度判断与证据，本脚本负责：schema 校验、
 * 证据回溯、加权总分、等级判定、写入历史、跨场趋势。
 *
 * 用法:
 *   node scripts/score.mjs score --analysis a.analysis.json --scores scores.json [--history history.jsonl] [--strict]
 *   node scripts/score.mjs trend --history history.jsonl [--limit 10]
 *
 * 退出码: 0 成功 / 2 输入错误 / 3 schema 校验失败
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '1.0.0';
export const DIMENSIONS = ['structure', 'evidence', 'depth', 'fit', 'delivery'];
export const DIMENSION_LABELS = {
  structure: '结构化成篇', evidence: '事实与量化密度', depth: '技术纵深', fit: '岗位匹配', delivery: '表达与掌控'
};
export const GAP_LABELS = {
  G1: '事实/经历缺失', G2: '结构缺失', G3: '技术纵深不足',
  G4: '岗位匹配错位', G5: '表达损耗', G6: '反问与收尾'
};
export const GRADES = [
  { grade: 'S', min: 4.5, meaning: '稳过，风险在匹配而非能力' },
  { grade: 'A', min: 3.8, meaning: '有竞争力，输在细节与纵深' },
  { grade: 'B', min: 3.0, meaning: '边缘，看同场竞争' },
  { grade: 'C', min: 2.0, meaning: '需要系统补齐' },
  { grade: 'D', min: 0, meaning: '方向或准备不足' }
];
const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES_PATH = join(HERE, '..', 'assets', 'company-profiles.json');

/** 输入/参数错误（退出码 2）。 */
export class InputError extends Error {}
/** schema 校验失败（退出码 3）。 */
export class SchemaError extends Error {}

export function loadProfiles(path) {
  return JSON.parse(readFileSync(path || PROFILES_PATH, 'utf8'));
}

/** 按权重算加权分（跳过 not_applicable 维度并重新归一化）。 */
export function computeWeighted(dimensions, weights) {
  let sum = 0;
  let wsum = 0;
  const detail = [];
  for (const dim of dimensions) {
    const w = weights[dim.id];
    if (dim.score === null || dim.score === undefined) { detail.push({ id: dim.id, score: null, weight: w, skipped: true }); continue; }
    if (typeof w !== 'number') throw new SchemaError('权重档案里没有维度 ' + dim.id);
    sum += dim.score * w;
    wsum += w;
    detail.push({ id: dim.id, score: dim.score, weight: w, weighted: Number((dim.score * w).toFixed(4)), skipped: false });
  }
  if (wsum === 0) throw new SchemaError('没有任何有效维度分，无法计算');
  return { weighted: Number((sum / wsum).toFixed(3)), weight_sum: Number(wsum.toFixed(4)), detail };
}

/** 加权分 -> 等级。 */
export function gradeFor(weighted) {
  for (const g of GRADES) if (weighted >= g.min) return g;
  return GRADES[GRADES.length - 1];
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function requireString(obj, field, label, minLen) {
  const v = obj[field];
  const need = minLen || 1;
  if (typeof v !== 'string' || v.trim().length < need) {
    throw new SchemaError(label + ' 缺少字段 ' + field + '（字符串，>= ' + need + ' 字符）');
  }
  return v.trim();
}
function normalizeWs(s) {
  return String(s).replace(/\s+/g, '');
}

/**
 * 校验 scores.json，返回 { errors, warnings, normalized }。
 * errors 非空即判定失败。
 */
export function validateScores(scores, analysis, options) {
  const opts = options || {};
  const errors = [];
  const warnings = [];
  if (!isPlainObject(scores)) throw new SchemaError('scores.json 根节点必须是对象');
  const push = (msg) => errors.push(msg);
  const warn = (msg) => warnings.push(msg);
  if (typeof scores.task !== 'string' || !scores.task.trim()) push('缺少 task（面试标识，例如 2025-01-01-某公司-一面）');
  if (scores.date !== undefined && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(scores.date))) push('date 必须是 YYYY-MM-DD');
  const profiles = loadProfiles();
  if (scores.company_type !== undefined && !profiles.profiles[scores.company_type]) {
    warn('company_type 「' + scores.company_type + '」不在权重档案里，将使用 analysis 中的权重或 general');
  }
  if (!Array.isArray(scores.dimensions)) {
    push('缺少 dimensions 数组');
  } else {
    const seen = new Set();
    for (const dim of scores.dimensions) {
      if (!isPlainObject(dim)) { push('dimensions 元素必须是对象'); continue; }
      const id = dim.id;
      if (DIMENSIONS.indexOf(id) < 0) { push('未知维度 id: ' + String(id) + '（应为 ' + DIMENSIONS.join('/') + '）'); continue; }
      if (seen.has(id)) push('维度 ' + id + ' 重复');
      seen.add(id);
      const skipped = dim.not_applicable === true;
      if (skipped) {
        if (typeof dim.reason !== 'string' || dim.reason.trim().length < 4) push('维度 ' + id + ' 标了 not_applicable 但没有写 reason');
      } else {
        if (!Number.isInteger(dim.score) || dim.score < 1 || dim.score > 5) push('维度 ' + id + ' 的 score 必须是 1-5 的整数，收到 ' + JSON.stringify(dim.score));
        if (typeof dim.evidence !== 'string' || dim.evidence.trim().length < 8) push('维度 ' + id + ' 缺少 evidence（>= 8 字的逐字原文）');
        if (dim.root_cause !== undefined && !/^G[1-6]$/.test(String(dim.root_cause))) push('维度 ' + id + ' 的 root_cause 必须是 G1-G6，收到 ' + JSON.stringify(dim.root_cause));
      }
    }
    for (const id of DIMENSIONS) {
      if (!seen.has(id)) push('维度 ' + id + '（' + (DIMENSION_LABELS[id] || id) + '）缺失，五个维度都要给（不适用时用 not_applicable）');
    }
  }
  if (!Array.isArray(scores.gaps) || scores.gaps.length === 0) {
    push('缺少 gaps（至少要写 1 条短板）');
  } else {
    scores.gaps.forEach((gap, i) => {
      const label = 'gaps[' + i + ']';
      if (!isPlainObject(gap)) { push(label + ' 必须是对象'); return; }
      if (!/^G[1-6]$/.test(String(gap.code))) push(label + ' 的 code 必须是 G1-G6，收到 ' + JSON.stringify(gap.code));
      requireStringOrPush(gap, 'title', label, 2, push);
      requireStringOrPush(gap, 'action', label, 4, push);
      requireStringOrPush(gap, 'output', label, 2, push);
      requireStringOrPush(gap, 'acceptance', label, 4, push);
      if (typeof gap.evidence !== 'string' || gap.evidence.trim().length < 8) push(label + ' 缺少 evidence（引用原话，>= 8 字）');
      if (gap.due !== undefined && ['今天', '3天', '7天'].indexOf(gap.due) < 0) warn(label + ' 的 due 建议用 今天/3天/7天，收到 ' + JSON.stringify(gap.due));
    });
  }
  if (scores.questions !== undefined) {
    if (!Array.isArray(scores.questions)) push('questions 必须是数组');
    else scores.questions.forEach((q, i) => {
      const label = 'questions[' + i + ']';
      if (!isPlainObject(q)) { push(label + ' 必须是对象'); return; }
      if (!Number.isInteger(q.qa_index)) push(label + ' 缺少 qa_index（整数，对应 analysis.qa[].index）');
      requireStringOrPush(q, 'intent', label, 2, push);
      requireStringOrPush(q, 'lost_points', label, 2, push);
      requireStringOrPush(q, 'rewrite', label, 4, push);
      if (!q.probe_l1) warn(label + ' 没写 probe_l1（第二层追问预测），建议补上');
    });
  }
  if (scores.data_todos !== undefined && !Array.isArray(scores.data_todos)) push('data_todos 必须是数组');
  // 证据回溯：evidence 必须真的出现在原始记录里
  if (analysis && analysis.source && typeof analysis.source.text === 'string') {
    const haystack = normalizeWs(analysis.source.text);
    const checks = [];
    if (Array.isArray(scores.dimensions)) for (const dim of scores.dimensions) if (dim && typeof dim.evidence === 'string') checks.push({ where: 'dimension ' + dim.id, text: dim.evidence });
    if (Array.isArray(scores.gaps)) for (const gap of scores.gaps) if (gap && typeof gap.evidence === 'string') checks.push({ where: 'gap ' + gap.code, text: gap.evidence });
    for (const c of checks) {
      if (c.text.indexOf('JD 未提供') >= 0 || c.text.indexOf('记录未提供') >= 0) continue;
      if (haystack.indexOf(normalizeWs(c.text)) < 0) {
        const msg = c.where + ' 的 evidence 在原始记录里找不到：「' + c.text.slice(0, 40) + '…」，请改成逐字原文';
        if (opts.strict) push(msg); else warn(msg);
      }
    }
  } else {
    warn('没有拿到 analysis.source.text，跳过证据回溯');
  }
  return { errors, warnings };
}

function requireStringOrPush(obj, field, label, minLen, push) {
  const v = obj[field];
  if (typeof v !== 'string' || v.trim().length < minLen) {
    push(label + ' 缺少 ' + field + '（字符串，>= ' + minLen + ' 字符）');
  }
}

/** 生成历史记录行。 */
export function buildHistoryRecord(scores, analysis, weighted, grade) {
  const dims = {};
  for (const dim of scores.dimensions) dims[dim.id] = dim.score === undefined ? null : dim.score;
  const gapCodes = Array.from(new Set((scores.gaps || []).map((g) => g.code)));
  const durationSec = analysis && analysis.aggregate
    ? (analysis.aggregate.real_total_seconds !== null ? analysis.aggregate.real_total_seconds : analysis.aggregate.est_total_seconds)
    : null;
  return {
    date: scores.date || new Date().toISOString().slice(0, 10),
    task: scores.task,
    company_type: scores.company_type || (analysis && analysis.meta ? analysis.meta.company_type : null),
    company_label: analysis && analysis.company ? analysis.company.label : null,
    role: scores.role || (analysis && analysis.meta ? analysis.meta.role : null),
    round: scores.round || (analysis && analysis.meta ? analysis.meta.round : null),
    weighted,
    grade: grade.grade,
    dims,
    gaps: gapCodes,
    top_gap: gapCodes[0] || null,
    qa_count: analysis && analysis.aggregate ? analysis.aggregate.qa_count : null,
    duration_min: durationSec === null ? null : Number((durationSec / 60).toFixed(1)),
    jd_coverage: analysis && analysis.jd ? analysis.jd.coverage : null,
    analyzed_at: new Date().toISOString()
  };
}

/** 读取历史的 JSONL。 */
export function readHistory(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter((r) => r !== null);
}

/** 由历史生成趋势分析（纯函数，便于测试）。 */
export function buildTrend(records) {
  const sorted = records.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.task).localeCompare(String(b.task)));
  const dimAvg = {};
  for (const id of DIMENSIONS) {
    const values = sorted.map((r) => (r.dims ? r.dims[id] : null)).filter((v) => typeof v === 'number');
    dimAvg[id] = {
      avg: values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null,
      latest: values.length ? values[values.length - 1] : null,
      first: values.length ? values[0] : null,
      samples: values.length
    };
  }
  const gapStats = {};
  for (const key of Object.keys(GAP_LABELS)) gapStats[key] = { code: key, label: GAP_LABELS[key], sessions: 0, lastIndex: -1, streak: 0 };
  sorted.forEach((r, i) => {
    for (const code of (r.gaps || [])) {
      if (!gapStats[code]) gapStats[code] = { code, label: '自定义', sessions: 0, lastIndex: -1, streak: 0 };
      gapStats[code].sessions += 1;
      gapStats[code].lastIndex = i;
    }
  });
  for (const code of Object.keys(gapStats)) {
    let streak = 0;
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if ((sorted[i].gaps || []).indexOf(code) >= 0) streak += 1; else break;
    }
    gapStats[code].streak = streak;
  }
  const gaps = Object.values(gapStats).filter((g) => g.sessions > 0).sort((a, b) => b.sessions - a.sessions || b.streak - a.streak);
  const weightedValues = sorted.map((r) => r.weighted).filter((v) => typeof v === 'number');
  const weakestDims = DIMENSIONS.map((id) => ({ id, avg: dimAvg[id].avg }))
    .filter((d) => d.avg !== null).sort((a, b) => a.avg - b.avg);
  const focus = [];
  if (weakestDims.length) focus.push('维度优先：' + DIMENSION_LABELS[weakestDims[0].id] + '（均值 ' + weakestDims[0].avg + '，最弱）');
  if (gaps.length) {
    const top = gaps[0];
    focus.push('归因优先：' + top.code + ' ' + top.label + '（' + top.sessions + ' 场命中' + (top.streak >= 2 ? '，已连续 ' + top.streak + ' 场' : '') + '）');
  }
  const trendNote = weightedValues.length >= 2
    ? ('加权趋势：' + weightedValues[0] + ' -> ' + weightedValues[weightedValues.length - 1]
      + (weightedValues[weightedValues.length - 1] > weightedValues[0] ? '（上升）' : weightedValues[weightedValues.length - 1] < weightedValues[0] ? '（下降）' : '（持平）'))
    : '加权趋势：样本不足（>= 2 场才能比较）';
  return { sessions: sorted.length, records: sorted, dimAvg, gaps, focus, trendNote };
}

/** 趋势 -> markdown 片段。 */
export function formatTrend(trend) {
  if (trend.sessions === 0) return '（暂无历史记录：这是第一场，报告第 8 章写「首场，无趋势数据」）';
  const L = [];
  L.push('共 ' + trend.sessions + ' 场记录。' + trend.trendNote);
  L.push('');
  L.push('| 日期 | 公司/轮次 | 加权 | 等级 | 最低维度 | 主要 gap |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of trend.records) {
    let lowId = null;
    for (const id of DIMENSIONS) {
      const v = r.dims ? r.dims[id] : null;
      if (typeof v !== 'number') continue;
      if (lowId === null || v < r.dims[lowId]) lowId = id;
    }
    L.push('| ' + r.date + ' | ' + [r.company_label || r.company_type, r.round].filter(Boolean).join(' / ')
      + ' | ' + r.weighted + ' | ' + r.grade
      + ' | ' + (lowId ? DIMENSION_LABELS[lowId] + ' ' + r.dims[lowId] : '-')
      + ' | ' + (r.top_gap || (r.gaps && r.gaps[0]) || '-') + ' |');
  }
  L.push('');
  L.push('| 维度 | 首场 | 最近 | 均值 | 趋势 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const id of DIMENSIONS) {
    const d = trend.dimAvg[id];
    const arrow = d.avg === null ? '-' : (d.latest > d.avg + 0.1 ? '↑' : d.latest < d.avg - 0.1 ? '↓' : '→');
    L.push('| ' + DIMENSION_LABELS[id] + ' | ' + (d.first === null ? '-' : d.first) + ' | ' + (d.latest === null ? '-' : d.latest)
      + ' | ' + (d.avg === null ? '-' : d.avg) + ' | ' + arrow + ' |');
  }
  if (trend.gaps.length) {
    L.push('');
    L.push('| gap | 含义 | 命中场次 | 连续场次 |');
    L.push('| --- | --- | --- | --- |');
    for (const g of trend.gaps) L.push('| ' + g.code + ' | ' + g.label + ' | ' + g.sessions + ' | ' + g.streak + ' |');
  }
  L.push('');
  L.push('聚焦建议:');
  for (const f of trend.focus) L.push('- ' + f);
  return L.join('\n');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'strict' || key === 'json' || key === 'help') { out[key] = true; continue; }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new InputError('参数 --' + key + ' 缺少取值');
      out[key] = value;
      i += 1;
    } else out._.push(arg);
  }
  return out;
}

function readJson(path, label) {
  const p = resolve(path);
  if (!existsSync(p)) throw new InputError('找不到' + label + ': ' + p);
  try {
    return { path: p, data: JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    throw new InputError(label + ' 不是合法 JSON: ' + p + ' -> ' + e.message);
  }
}

export function main(argv) {
  const args = parseArgs(argv || []);
  const command = args._[0];
  if (args.help || !command) {
    process.stdout.write('用法:\n  node scripts/score.mjs score --analysis a.analysis.json --scores scores.json [--history h.jsonl] [--strict]\n  node scripts/score.mjs trend --history h.jsonl [--limit 10]\n');
    return 0;
  }
  if (command === 'trend') {
    const historyPath = args.history ? resolve(args.history) : null;
    if (!historyPath) throw new InputError('trend 需要 --history <history.jsonl>');
    const records = readHistory(historyPath);
    const trend = buildTrend(records);
    if (args.json) process.stdout.write(JSON.stringify(trend, null, 2) + '\n');
    else process.stdout.write(formatTrend(trend) + '\n');
    return 0;
  }
  if (command === 'score') {
    if (!args.analysis || !args.scores) throw new InputError('score 需要 --analysis 与 --scores');
    const analysisFile = readJson(args.analysis, ' analysis.json');
    const scoresFile = readJson(args.scores, 'scores.json');
    const analysis = analysisFile.data;
    const scores = scoresFile.data;
    const check = validateScores(scores, analysis, { strict: args.strict === true });
    for (const w of check.warnings) process.stderr.write('[warn] ' + w + '\n');
    if (check.errors.length) {
      process.stderr.write('[fail] scores.json 校验未通过（' + check.errors.length + ' 项）：\n');
      for (const e of check.errors) process.stderr.write('  - ' + e + '\n');
      process.stderr.write('修正后重跑；不要绕过校验直接写报告。\n');
      return 3;
    }
    const profiles = loadProfiles();
    const weights = (analysis.meta && analysis.meta.company_weights)
      || (scores.company_type && profiles.profiles[scores.company_type] ? profiles.profiles[scores.company_type].weights : profiles.profiles.general.weights);
    const { weighted, weight_sum, detail } = computeWeighted(scores.dimensions, weights);
    const grade = gradeFor(weighted);
    const record = buildHistoryRecord(scores, analysis, weighted, grade);
    const historyPath = args.history ? resolve(args.history) : join(dirname(analysisFile.path), 'history.jsonl');
    mkdirSync(dirname(historyPath), { recursive: true });
    appendFileSync(historyPath, JSON.stringify(record) + '\n', 'utf8');
    const resultPath = join(dirname(scoresFile.path), 'score-result.json');
    writeFileSync(resultPath, JSON.stringify({ version: VERSION, weighted, weight_sum, grade: grade.grade, grade_meaning: grade.meaning, detail, record }, null, 2) + '\n', 'utf8');
    const L = [];
    L.push('== 评分聚合 (interview-retro ' + VERSION + ') ==');
    L.push('任务: ' + record.task + ' | 档案: ' + (record.company_label || record.company_type) + ' | 轮次: ' + (record.round || '未填'));
    L.push('维度明细:');
    for (const d of detail) {
      L.push('  - ' + d.id + ' (' + DIMENSION_LABELS[d.id] + ') 分数 ' + (d.skipped ? 'N/A' : d.score) + ' x 权重 ' + d.weight + (d.skipped ? '' : ' = ' + d.weighted));
    }
    L.push('加权总分: ' + weighted + ' / 5  (权重和 ' + weight_sum + ')');
    L.push('等级: ' + grade.grade + ' —— ' + grade.meaning);
    L.push('主要短板: ' + (record.gaps.length ? record.gaps.map((c) => c + ' ' + (GAP_LABELS[c] || '')).join(' / ') : '无'));
    L.push('历史已追加: ' + historyPath);
    L.push('结果文件: ' + resultPath);
    if (args.json) process.stdout.write(JSON.stringify({ record, weighted, grade: grade.grade, detail }, null, 2) + '\n');
    else process.stdout.write(L.join('\n') + '\n');
    return 0;
  }
  throw new InputError('未知子命令: ' + command + '（可用 score / trend）');
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof InputError ? 2 : 3;
    process.stderr.write('[score] ' + (error && error.message ? error.message : String(error)) + '\n');
    process.exitCode = code;
  }
}
