#!/usr/bin/env node
/**
 * interview-retro / install.mjs —— 把技能安装到 DSH 的技能目录（零依赖，Node >= 18）
 *
 * 默认目标: <DSH_HOME>/skills/interview-retro（Windows 默认 %USERPROFILE%\.dsh\skills）
 * DSH 会在会话中自动发现该目录下的 SKILL.md（目录包形式，附属文件通过 resourceBase 引用）。
 *
 * 用法:
 *   node scripts/install.mjs                     # 安装/更新到用户级技能目录
 *   node scripts/install.mjs --project           # 同时装到 <cwd>/.dsh/skills（项目级，优先级更高）
 *   node scripts/install.mjs --target <dir>      # 指定技能根目录
 *   node scripts/install.mjs --dry-run           # 只校验与打印计划
 *   node scripts/install.mjs --verify            # 安装后运行 selftest.mjs
 *   node scripts/install.mjs --link              # 用户级目标用目录联接（Windows junction / POSIX symlink），便于开发
 *
 * 退出码: 0 成功 / 2 输入错误 / 3 校验失败
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_SRC = resolve(HERE, '..', 'skills', 'interview-retro');
const SKILL_NAME = 'interview-retro';

class InputError extends Error {}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (['dry-run', 'verify', 'link', 'force', 'help'].indexOf(key) >= 0) { out[key] = true; continue; }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new InputError('参数 --' + key + ' 缺少取值');
      out[key] = value;
      i += 1;
    } else out._.push(arg);
  }
  return out;
}

/** 解析 DSH 技能根目录。 */
export function skillRoots(options) {
  const opts = options || {};
  const roots = [];
  if (opts.target) roots.push({ kind: 'custom', path: resolve(opts.target) });
  else {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    roots.push({ kind: 'user', path: join(home, 'skills') });
  }
  if (opts.project) roots.push({ kind: 'project', path: join(resolve(opts.cwd || process.cwd()), '.dsh', 'skills') });
  return roots;
}

/** 校验技能包结构，返回问题列表（空数组表示通过）。 */
export async function validateBundle(src) {
  const problems = [];
  const skillMd = join(src, 'SKILL.md');
  if (!existsSync(skillMd)) { problems.push('缺少 SKILL.md'); return problems; }
  const text = readFileSync(skillMd, 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) problems.push('SKILL.md 缺少 YAML frontmatter');
  else {
    const nameMatch = /^name:\s*(.+)$/m.exec(fm[1]);
    const descMatch = /^description:\s*(.+)$/m.exec(fm[1]);
    if (!nameMatch) problems.push('frontmatter 缺少 name');
    else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nameMatch[1].trim())) problems.push('name 必须是 kebab-case: ' + nameMatch[1].trim());
    else if (nameMatch[1].trim() !== SKILL_NAME) problems.push('name 应为 ' + SKILL_NAME + '，实际 ' + nameMatch[1].trim());
    if (!descMatch || descMatch[1].trim().length < 10) problems.push('frontmatter 缺少足够长的 description');
  }
  for (const rel of ['references/scoring-rubric.md', 'references/gap-map.md', 'references/probe-playbook.md',
    'references/company-norms.md', 'references/jd-alignment.md', 'assets/report-template.md',
    'assets/company-profiles.json', 'scripts/analyze.mjs', 'scripts/score.mjs', 'scripts/selftest.mjs']) {
    if (!existsSync(join(src, rel))) problems.push('缺少 ' + rel);
  }
  // 语法自检：动态导入两个脚本（CLI 入口有 invokedDirectly 守卫，导入不会执行 main）
  for (const rel of ['scripts/analyze.mjs', 'scripts/score.mjs']) {
    const p = join(src, rel);
    if (!existsSync(p)) continue;
    try {
      await import(pathToFileURL(p).href);
    } catch (error) {
      problems.push(rel + ' 无法导入: ' + (error && error.message ? error.message : String(error)));
    }
  }
  const profilesPath = join(src, 'assets', 'company-profiles.json');
  if (existsSync(profilesPath)) {
    try {
      const data = JSON.parse(readFileSync(profilesPath, 'utf8'));
      for (const [key, profile] of Object.entries(data.profiles)) {
        const sum = Object.values(profile.weights).reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1) > 1e-9) problems.push('company-profiles.json 中 ' + key + ' 的权重和不是 1.0（' + sum + '）');
      }
    } catch (error) {
      problems.push('company-profiles.json 解析失败: ' + (error && error.message ? error.message : String(error)));
    }
  }
  return problems;
}

/** 生成安装后要写进目录的元信息文件（可选，便于用户确认版本）。 */
function stamp(target) {
  const info = {
    name: SKILL_NAME,
    installed_at: new Date().toISOString(),
    source: SKILL_SRC,
    install_mode: 'copy'
  };
  writeFileSync(join(target, '.install.json'), JSON.stringify(info, null, 2) + '\n', 'utf8');
}

export async function install(args) {
  const opts = args || {};
  if (!existsSync(SKILL_SRC)) throw new InputError('找不到技能源目录: ' + SKILL_SRC);
  console.log('== interview-retro 安装 ==');
  console.log('源目录: ' + SKILL_SRC);
  const problems = await validateBundle(SKILL_SRC);
  if (problems.length) {
    console.error('[fail] 技能包校验未通过：');
    for (const p of problems) console.error('  - ' + p);
    return 3;
  }
  console.log('校验: 通过（frontmatter / 依赖文件 / 脚本可导入 / 权重和为 1）');
  const roots = skillRoots(opts);
  for (const root of roots) {
    const target = join(root.path, SKILL_NAME);
    console.log('[' + root.kind + '] ' + target);
    if (opts['dry-run']) { console.log('      (dry-run 跳过写入)'); continue; }
    mkdirSync(root.path, { recursive: true });
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    if (opts.link && root.kind === 'user') {
      try {
        symlinkSync(SKILL_SRC, target, process.platform === 'win32' ? 'junction' : 'dir');
        console.log('      已创建' + (process.platform === 'win32' ? '目录联接' : '软链接') + '（源目录修改即时生效）');
        continue;
      } catch (error) {
        console.warn('      链接失败，回退为复制: ' + (error && error.message ? error.message : String(error)));
        rmSync(target, { recursive: true, force: true });
      }
    }
    cpSync(SKILL_SRC, target, { recursive: true });
    stamp(target);
    console.log('      已安装 ' + readFileSync(join(target, 'SKILL.md'), 'utf8').split('\n').length + ' 行 SKILL.md + 知识库 + 脚本');
  }
  if (opts.verify) {
    const selftest = join(SKILL_SRC, 'scripts', 'selftest.mjs');
    console.log('运行自检: node ' + selftest);
    const r = spawnSync(process.execPath, [selftest], { stdio: 'inherit' });
    if (r.status !== 0) { console.error('[fail] 自检未通过'); return 1; }
  }
  console.log('完成。在 DSH 会话中说「帮我复盘这场面试」或直接点名 interview-retro 即可触发。');
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('用法: node scripts/install.mjs [--target <dir>] [--project] [--dry-run] [--link] [--verify]');
      process.exitCode = 0;
    } else {
      const code = await install(args);
      process.exitCode = code;
    }
  } catch (error) {
    console.error('[install] ' + (error && error.message ? error.message : String(error)));
    process.exitCode = error instanceof InputError ? 2 : 3;
  }
}
