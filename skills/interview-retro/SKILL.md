---
name: interview-retro
description: 面试复盘教练 —— 输入岗位 JD、公司性质与面试文字记录，输出一份有证据、可验收、能追踪的查漏补缺复盘报告（评分卡 / 逐题复盘 / 追问预测 / 补齐计划 / 跨场趋势）。当用户贴出面试记录、要求复盘面试表现、分析答不好的问题、生成面试复盘 .md 文档或跟踪多场面试进步时使用。
whenToUse: 用户提供面试对话文本（常伴随 JD、公司名、面试轮次），要求总结面试内容、找出回答中的问题、补齐短板、生成复盘文档，或对比多场面试的进步时。
---

# 面试复盘教练 (interview-retro)

把一场面试的文字记录，变成一份**有证据、可验收、能追踪**的复盘报告。

## 四条铁律（先读）

1. **先测量，再判断。** 事实层（题量、时长、字数、STAR 缺失、模糊词、量化缺失、JD 关键词覆盖）一律由 scripts/analyze.mjs 计算，禁止心算或目测。
2. **每个判断都要能指回原话。** 评分与丢分点必须引用记录原文片段（scores.json 的 evidence 字段），脚本会校验证据是否真的出现在文本里，对不上会告警。
3. **不编造、不鸡汤。** 记录里没有的数据标 [待补数据]；没有文本支撑的推断标 [推断]。禁止「多练练就好了」——每条建议必须带**产出物**和**验收标准**。
4. **算术交给脚本。** 加权总分、等级、历史趋势由 scripts/score.mjs 计算，模型只负责提供 1-5 分的维度判断与证据。

## 输入（Step 0：先确认，缺什么问什么）

- 必需：面试文字记录（支持这些形态：面试官：… / 我：…、Q/A、带时间戳的语音转写、零散要点笔记）
- 强烈建议：岗位 JD 原文、公司性质与轮次（例如「互联网大厂-二面」）
- 可选：面试前准备的资料、简历片段、是否有录音时间轴

缺 JD 或公司性质时，明确告诉用户「匹配度维度降权或不评分」，不要替用户假设 JD 内容。记录明显残缺（只有零星记忆）时，声明进入**稀疏模式**：逐题指标降级为定性，禁止伪造字数与时长。

## 执行流程

### 1. 落盘原始记录
把用户给的记录**原文**（不改写、不润色）写入 retro/raw/<date>-<company>-<round>.md。

### 2. 事实层：跑分析脚本
~~~
node scripts/analyze.mjs "retro/raw/2025-01-01-某公司-一面.md" --jd "jd/某公司-jd.md" --company "互联网大厂" --round "一面" --out "retro/2025-01-01-某公司-一面"
~~~
产出 analysis.json（含每题指标）并在 stdout 打印摘要。读懂这些字段再往下走：qa[]、flags[]、aggregate、jd.missing_keywords[]、parse.warnings[]。
没有时间戳时，时长用「字数 ÷ 每秒 3.7 字」估算，报告里必须注明是估算。

### 3. 评分层：按锚点打 1-5 分
读 references/scoring-rubric.md，对 5 个维度打分，每维至少 1 条原话证据。读 references/company-norms.md 确认该公司性质关注点，权重来自 assets/company-profiles.json（包含在 analysis.json 里）。

### 4. 归因层：映射到 G1-G6
读 references/gap-map.md，把每个丢分点归到 G1-G6 之一并写根因。同一 gap code 在本场出现多次时，只保留最有代表性的 1-3 条，其余合并进附录表，避免报告变成流水账。

### 5. 追问预测
读 references/probe-playbook.md，为得分最低的 3-5 道题预测第二、三层追问，并标出「差评回答里最容易被戳穿的漏洞」。

### 6. 改写层
只改写最丢分的 3-5 题，输出要点骨架（不是背诵稿），保留候选人真实经历，不虚构项目。

### 7. 汇总：写 scores.json 并计算
按 assets/report-template.md 顶部的 schema 写 <out>/scores.json，然后：
~~~
node scripts/score.mjs score --analysis "<out>/analysis.json" --scores "<out>/scores.json" --history "retro/history.jsonl"
~~~
脚本会校验 schema、加权算总分、判等级、追加历史记录。校验失败会非零退出并指出缺哪个字段——修好再继续，不要绕过。

### 8. 产出报告
按 assets/report-template.md 生成 retro/<date>-<company>-<round>-复盘.md，10 个章节一个都不能缺。某章无内容时写「无」并说明原因。

### 9. 趋势与收尾
~~~
node scripts/score.mjs trend --history "retro/history.jsonl"
~~~
把趋势表填进报告第 8 章；报告结尾给「下次面试前 60 秒检查清单」3 条。

### 10. 自检
~~~
node scripts/selftest.mjs
~~~
首次使用或升级技能后跑一次，确认脚本链路完好。

## 报告硬性要求

- 第 4 章逐题复盘六列齐全：题号 | 面试官真实意图 | 我的回答要点 | 丢分点（附原话） | 追问预测 | 改写骨架。
- 报告里所有分数必须与 analysis.json / scores.json 一致，不得手改。
- 每条补齐动作四要素：动作 | 产出物 | 验收标准（例如「能脱稿 90 秒讲完 + 挡住两层追问」）| 截止档位（今天/3 天/7 天）。
- 报告末尾附「数据待补清单」：面试中被问到但记录里没有的数字与指标。

## 常见坑

- 说话人标签混乱或转写错误：先看 analysis.json 的 parse.warnings，必要时用 --speaker-map "张三=interviewer,李四=candidate" 显式指定，不要手工猜。
- 一次面试里同一个坑反复出现：合并同类项，报告聚焦 3 大短板，其余进附录。
- 用户情绪化（面挂了）：先给事实层结论（分数与证据），再给行动；不做心理按摩，也不硬灌安慰。
- 用户只想要「话术模板」：仍然要跑事实层，否则改出来的答案解决不了真实丢分点。

## 资源

- references/scoring-rubric.md —— 5 维评分锚点（1/3/5 分具体长什么样）
- references/gap-map.md —— 丢分归因 G1-G6 与补齐动作库
- references/probe-playbook.md —— 追问预测与挡刀话术
- references/company-norms.md —— 公司性质 → 关注点、权重、忌讳
- references/jd-alignment.md —— JD 关注点提取与对齐改写
- assets/report-template.md —— 报告骨架 + scores.json / history.jsonl schema
- assets/company-profiles.json —— 权重档案数据
- scripts/analyze.mjs、scripts/score.mjs、scripts/selftest.mjs —— 零依赖 Node 脚本
- examples/ —— 脱敏样例记录与真实产出报告
