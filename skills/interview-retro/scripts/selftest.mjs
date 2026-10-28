#!/usr/bin/env node
/**
 * interview-retro / selftest.mjs —— 质量闸门（零依赖，Node >= 18）
 *
 * 覆盖：解析器边界、指标计算、权重算术、等级边界、schema 校验、
 * 证据回溯、趋势聚合。全部用例不依赖网络与第三方包。
 *
 * 用法: node scripts/selftest.mjs [--verbose]
 * 退出码: 0 全通过 / 1 有失败
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTranscript, parseTranscript, measureAnswer, extractJd, resolveCompany, formatSummary, normalizeLabel, timestampToSeconds } from './analyze.mjs';
import { computeWeighted, gradeFor, validateScores, buildTrend, formatTrend, buildHistoryRecord } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'examples', 'sample-transcript.md');
const FIXTURE_JD = join(HERE, '..', 'examples', 'sample-jd.md');

let passed = 0;
const failures = [];
const verbose = process.argv.indexOf('--verbose') >= 0;

function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    if (verbose) process.stdout.write('  ok   ' + name + (detail ? '  (' + detail + ')' : '') + '\n');
  } catch (error) {
    failures.push({ name, message: error && error.message ? error.message : String(error) });
    process.stdout.write('  FAIL ' + name + ' -> ' + (error && error.message ? error.message : String(error)) + '\n');
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error((label || '值') + ' 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  return String(actual);
}
function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) throw new Error((label || '值') + ' 期望约 ' + expected + '，实际 ' + actual);
  return String(actual);
}

const transcriptText = readFileSync(FIXTURE, 'utf8');
const jdText = readFileSync(FIXTURE_JD, 'utf8');
const sample = analyzeTranscript({ transcript: transcriptText, jdText, company: '互联网大厂', round: '一面', role: '后端开发工程师' });

process.stdout.write('== interview-retro selftest ==\n');

process.stdout.write('[1] 解析器与基础函数\n');
check('时间戳解析 mm:ss 与 hh:mm:ss', () => {
  eq(timestampToSeconds('01:30'), 90);
  eq(timestampToSeconds('00:02:40'), 160);
  return '160s';
});
check('标签归一化去掉装饰符', () => eq(normalizeLabel(' **面试官** '), '面试官'));
check('样例回合与题目数', () => {
  eq(sample.parse.turns, 24, 'turns');
  eq(sample.parse.qa_count, 12, 'qa_count');
  return '24 回合 / 12 题';
});
check('markdown 加粗标签也能识别', () => {
  const t = '**面试官**：问题一\n**我**：答案一，这里补足六十个字的长度以便统计生效，测试用文本需要足够长才能触发各种阈值判断逻辑，继续填充。';
  const r = parseTranscript(t);
  eq(r.turns.length, 2, 'turns');
  eq(r.turns[0].role, 'interviewer');
  return '2 回合';
});
check('未知标签并入上一回合并告警', () => {
  const t = '面试官：问题\n张工：这是一句插话，长度足够\n我：这是我的回答，同样给足长度以便观察解析行为，测试文本继续填充到六十个字以上。';
  const r = parseTranscript(t);
  eq(r.turns.length, 2, 'turns');
  assert(r.warnings.length === 1 && r.warnings[0].indexOf('张工') >= 0, '应产生未知标签告警');
  return r.warnings[0].slice(0, 18);
});
check('--speaker-map 可识别自定义标签', () => {
  const t = '张工：你们系统怎么设计的\n李四：我用了读写分离，这是回答正文，继续补充内容让长度足够触发统计逻辑，测试文本填充。';
  const r = parseTranscript(t, { speakerMap: { [normalizeLabel('张工')]: 'interviewer', [normalizeLabel('李四')]: 'candidate' } });
  eq(r.turns.length, 2, 'turns');
  eq(r.turns[0].role, 'interviewer', '张工');
  eq(r.turns[1].role, 'candidate', '李四');
  return '自定义标签 -> interviewer/candidate';
});
check('无标签行作为续行拼接到上一条', () => {
  const t = '面试官：问题\n我：第一行答案\n这是第二行答案，属于同一段回答的内容';
  const r = parseTranscript(t);
  eq(r.turns.length, 2, 'turns');
  assert(r.turns[1].text.indexOf('第二行') >= 0, '续行应被拼接');
});

process.stdout.write('[2] 单题指标\n');
check('量化缺失 / 模糊词 / 团队主语被识别', () => {
  const m = measureAnswer('我们那个系统差不多平时 2000 左右吧，我们大促的时候可能能到 8000，我们也没太注意具体数字，反正就是这么大的量级，大概就是这样吧。');
  assert(m.flags.indexOf('hedge_heavy') >= 0, '应命中 hedge_heavy');
  assert(m.flags.indexOf('we_heavy') >= 0, '应命中 we_heavy');
  assert(m.quantifications.length === 0, '“2000 左右”不该被当作有效量化');
  return m.flags.join('/');
});
check('带单位量化被识别', () => {
  const m = measureAnswer('优化后 P99 从 800ms 降到 320ms，错误率下降 30%，峰值 8000 QPS，覆盖 12 个机房。');
  assert(m.quantifications.length >= 4, '量化数量应 >= 4，实际 ' + m.quantifications.length);
  return m.quantifications.join(' ');
});
check('STAR 信号完整度可计算', () => {
  const m = measureAnswer('当时线上出现超时，我负责排查并设计限流方案，最后 P99 从 800ms 降到 320ms，上线后稳定。');
  eq(m.star_score, 3, 'star_score');
});

process.stdout.write('[3] 样例整体事实\n');
check('样例未出现带单位量化（题少但都虚）', () => {
  assert(sample.aggregate.quantified_ratio < 0.2, '量化率应 < 0.2，实际 ' + sample.aggregate.quantified_ratio);
  return '量化率 ' + sample.aggregate.quantified_ratio;
});
check('样例团队主语明显偏多', () => {
  assert(sample.aggregate.we_total > sample.aggregate.i_total, '我们应多于我');
  return '我们 ' + sample.aggregate.we_total + ' vs 我 ' + sample.aggregate.i_total;
});
check('高风险题排序把服务拆分那题排在前面', () => {
  assert(sample.risks.length > 0, '应有风险题');
  eq(sample.risks[0].qa_index, 8, '首位风险题');
  return 'Q' + sample.risks[0].qa_index + ' 风险 ' + sample.risks[0].risk_score;
});
check('有真实时间戳时用时间戳总时长', () => {
  eq(sample.aggregate.duration_source, 'timestamps');
  eq(sample.aggregate.real_total_seconds, 1140, 'real_total_seconds');
  return sample.aggregate.real_total_seconds + ' 秒';
});
check('JD 覆盖率与未命中关键词合理', () => {
  assert(sample.jd && sample.jd.coverage > 0.15 && sample.jd.coverage < 0.6, '覆盖率应在 0.15-0.6，实际 ' + sample.jd.coverage);
  const missing = sample.jd.missing_keywords.map((k) => k.term);
  assert(missing.indexOf('压测') >= 0 || missing.indexOf('监控') >= 0, '压测/监控应未命中，实际 ' + missing.join(','));
  return '覆盖 ' + Math.round(sample.jd.coverage * 100) + '%，缺 ' + missing.slice(0, 4).join('/');
});
check('公司性质解析命中 bigtech', () => {
  eq(sample.company.type, 'bigtech');
  eq(resolveCompany('某银行').type, 'soe_finance');
  eq(resolveCompany('不存在的公司').type, 'general');
  return 'bigtech / soe_finance / general';
});
check('摘要文本非空', () => assert(formatSummary(sample).indexOf('事实层') > 0));

process.stdout.write('[4] 加权算术与等级边界\n');
check('加权分按权重计算', () => {
  const dims = [{ id: 'structure', score: 4 }, { id: 'evidence', score: 2 }, { id: 'depth', score: 5 }, { id: 'fit', score: 3 }, { id: 'delivery', score: 1 }];
  const w = { structure: 0.2, evidence: 0.2, depth: 0.2, fit: 0.2, delivery: 0.2 };
  const r = computeWeighted(dims, w);
  near(r.weighted, (4 + 2 + 5 + 3 + 1) / 5, 0.001, '等权平均');
  const r2 = computeWeighted(dims, { structure: 0.1, evidence: 0.2, depth: 0.3, fit: 0.2, delivery: 0.2 });
  near(r2.weighted, 4 * 0.1 + 2 * 0.2 + 5 * 0.3 + 3 * 0.2 + 1 * 0.2, 0.001, '加权平均');
  return r2.weighted + '';
});
check('not_applicable 维度跳过并重新归一化', () => {
  const dims = [{ id: 'structure', score: 4 }, { id: 'evidence', score: 4 }, { id: 'depth', score: 4 }, { id: 'fit', score: 4 }, { id: 'delivery', score: null, not_applicable: true, reason: '没有可评估的表达类题目' }];
  const r = computeWeighted(dims, { structure: 0.2, evidence: 0.2, depth: 0.2, fit: 0.2, delivery: 0.2 });
  near(r.weighted, 4, 0.001, '跳过 delivery');
  near(r.weight_sum, 0.8, 0.001, '权重和');
  return 'weighted ' + r.weighted;
});
check('等级边界', () => {
  eq(gradeFor(4.5).grade, 'S'); eq(gradeFor(4.49).grade, 'A');
  eq(gradeFor(3.8).grade, 'A'); eq(gradeFor(3.79).grade, 'B');
  eq(gradeFor(3.0).grade, 'B'); eq(gradeFor(2.99).grade, 'C');
  eq(gradeFor(2.0).grade, 'C'); eq(gradeFor(1.99).grade, 'D');
  return 'S/A/B/C/D 边界正确';
});
check('样例加权分与等级', () => {
  const r = computeWeighted([
    { id: 'structure', score: 2 }, { id: 'evidence', score: 2 }, { id: 'depth', score: 2 },
    { id: 'fit', score: 3 }, { id: 'delivery', score: 3 }
  ], sample.company.weights);
  near(r.weighted, 2.3, 0.001, '样例加权分');
  eq(gradeFor(r.weighted).grade, 'C');
  return '2.3 / C';
});

process.stdout.write('[5] schema 校验与证据回溯\n');
const goodScores = {
  task: 'selftest-1', company_type: 'bigtech', date: '2025-01-08',
  dimensions: [
    { id: 'structure', score: 2, evidence: '我们那个系统差不多平时 2000 左右吧', root_cause: 'G2' },
    { id: 'evidence', score: 2, evidence: '差不多平时 2000 左右吧，大促的时候会高一些' },
    { id: 'depth', score: 2, evidence: '因为 Kafka 是主流方案，大家做削峰都用它' },
    { id: 'fit', score: 3, evidence: '我们把订单服务拆了，拆成订单和库存两个服务' },
    { id: 'delivery', score: 3, evidence: '暂时没有，谢谢面试官' }
  ],
  gaps: [{ code: 'G3', title: '选型无取舍', evidence: '因为 Kafka 是主流方案，大家做削峰都用它', action: '写三层卡', output: '三张卡', acceptance: '能脱稿 90 秒讲完', due: '3天' }],
  data_todos: ['峰值 QPS 口径']
};
check('完整 scores.json 通过校验', () => {
  const r = validateScores(goodScores, sample, { strict: true });
  eq(r.errors.length, 0, 'errors: ' + r.errors.join(' | '));
  return '0 错误';
});
check('缺维度 / 分数越界 / 证据过短 均被拦下', () => {
  const bad = JSON.parse(JSON.stringify(goodScores));
  bad.dimensions.pop();
  bad.dimensions[0].score = 9;
  bad.dimensions[1].evidence = '还行';
  const r = validateScores(bad, sample, {});
  assert(r.errors.length >= 3, '应至少 3 条错误，实际 ' + r.errors.length + ' -> ' + r.errors.join(' | '));
  return r.errors.length + ' 条错误';
});
check('gap code 非法被拦下', () => {
  const bad = JSON.parse(JSON.stringify(goodScores));
  bad.gaps[0].code = 'G9';
  const r = validateScores(bad, sample, {});
  assert(r.errors.some((e) => e.indexOf('G1-G6') >= 0), '应提示 G1-G6');
});
check('证据不在原文里会被指出', () => {
  const bad = JSON.parse(JSON.stringify(goodScores));
  bad.dimensions[0].evidence = '这句话根本不在原始记录里面出现过';
  const r = validateScores(bad, sample, { strict: true });
  assert(r.errors.some((e) => e.indexOf('找不到') >= 0), '应给出证据回溯失败：' + r.errors.join(' | '));
  const lenient = validateScores(bad, sample, {});
  assert(lenient.errors.length === 0 && lenient.warnings.some((w) => w.indexOf('找不到') >= 0), '非 strict 下应降级为告警');
  return 'strict 报错 / 宽松告警';
});

process.stdout.write('[6] 趋势聚合\n');
check('重复 gap 与维度均值统计正确', () => {
  const mk = (date, dims, gaps) => ({
    date, task: date, company_type: 'bigtech', company_label: '一线互联网大厂', round: '一面',
    weighted: computeWeighted(Object.keys(dims).map((id) => ({ id, score: dims[id] })), { structure: 0.2, evidence: 0.2, depth: 0.2, fit: 0.2, delivery: 0.2 }).weighted,
    grade: 'C', dims, gaps, top_gap: gaps[0] || null
  });
  const records = [
    mk('2025-01-01', { structure: 2, evidence: 2, depth: 2, fit: 3, delivery: 3 }, ['G3', 'G2']),
    mk('2025-01-08', { structure: 3, evidence: 2, depth: 3, fit: 3, delivery: 3 }, ['G3', 'G1']),
    mk('2025-01-15', { structure: 4, evidence: 3, depth: 3, fit: 4, delivery: 4 }, ['G3'])
  ];
  const trend = buildTrend(records);
  eq(trend.sessions, 3, 'sessions');
  near(trend.dimAvg.depth.avg, (2 + 3 + 3) / 3, 0.01, 'depth 均值');
  eq(trend.dimAvg.structure.latest, 4, 'structure 最近值');
  const g3 = trend.gaps.filter((g) => g.code === 'G3')[0];
  eq(g3.sessions, 3, 'G3 场次');
  eq(g3.streak, 3, 'G3 连续场次');
  assert(trend.focus.length >= 2, '应给出聚焦建议');
  assert(formatTrend(trend).indexOf('| 2025-01-15 |') > 0, '趋势表应包含最新一场');
  return '3 场 / G3 连续 3 场';
});
check('history 记录结构可被趋势消费', () => {
  const rec = buildHistoryRecord(goodScores, sample, 2.3, gradeFor(2.3));
  eq(rec.grade, 'C');
  eq(rec.gaps.join(','), 'G3');
  const trend = buildTrend([rec]);
  eq(trend.sessions, 1);
  return rec.date + ' / ' + rec.weighted;
});
check('空历史返回占位文案而不是崩溃', () => {
  const trend = buildTrend([]);
  eq(trend.sessions, 0);
  assert(formatTrend(trend).indexOf('暂无历史记录') >= 0);
});

process.stdout.write('\n== 结果: ' + passed + ' 通过 / ' + failures.length + ' 失败 ==\n');
if (failures.length) {
  for (const f of failures) process.stdout.write('  - ' + f.name + ': ' + f.message + '\n');
  process.exitCode = 1;
}
