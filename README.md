# interview-retro · 面试复盘技能

一个装在 DeepSeek Harness（DSH）里的**面试复盘技能**：把一场面试的文字记录，变成一份有证据、可验收、能追踪的查漏补缺报告。

- 输入：岗位 JD + 公司性质 + 面试对话文本（语音转写、手打笔记、Q/A 格式都行）
- 输出：一份复盘 .md（评分卡 / 逐题复盘 / 追问预测 / 改写骨架 / 补齐计划 / 跨场趋势）
- 特点：**判断交给模型，测量交给脚本**。所有分数可复现、可追溯、可打分前后对比。

## 30 秒看懂它解决什么问题

面完一场，人的第一反应是「好像还行」，第二反应是「刚才那题应该怎么答来着」。
本技能把这种模糊感受压成三样东西：

1. **事实**：题量、每题耗时、量化率、STAR 完整率、模糊词、团队主语比例、JD 关键词覆盖率——由脚本算，不靠感觉。
2. **判断**：五维评分（结构/量化/纵深/匹配/表达）× 四个锚点等级，每个分数必须挂一句逐字原文证据。
3. **行动**：每条短板对应一个动作、一个产出物、一个验收标准、一个截止档位；下场面试前有 60 秒检查清单。

样例产出见 examples/sample-report.md（由 examples/sample-transcript.md 真实跑出来，加权分 2.30 / C）。

## 目录结构

    .
    ├── skills/interview-retro/          # 技能本体（可直接复制进 DSH 技能目录）
    │   ├── SKILL.md                     # 触发与流程（路由层，只写"怎么执行"）
    │   ├── references/                  # 领域知识（用到才读，避免污染上下文）
    │   │   ├── scoring-rubric.md         # 五维 1-5 分锚点
    │   │   ├── gap-map.md                # G1-G6 丢分归因 + 补齐动作库
    │   │   ├── probe-playbook.md         # 追问预测与挡刀话术
    │   │   ├── company-norms.md          # 公司性质 → 关注点/权重/忌讳
    │   │   └── jd-alignment.md           # JD 关注点提取与对齐改写
    │   ├── assets/
    │   │   ├── company-profiles.json     # 8 类公司权重档案（和恒为 1.0）
    │   │   └── report-template.md        # 报告骨架 + scores.json schema
    │   ├── scripts/                      # 计算层（零依赖 Node，纯 ESM）
    │   │   ├── analyze.mjs               # 事实层：解析 + 测量 + JD 覆盖
    │   │   ├── score.mjs                 # 聚合层：校验 + 加权 + 等级 + 历史 + 趋势
    │   │   └── selftest.mjs              # 质量闸门：28 项断言
    │   └── examples/                     # 脱敏样例：记录 → 分析 → 打分 → 报告
    ├── scripts/install.mjs               # 安装/更新到 DSH 技能目录
    └── docs/talk-track.md                # 面试讲解稿：90 秒 / 3 分钟 / 10 个追问

## 快速开始

安装（自动校验技能包结构、脚本可导入、权重和为 1，并跑自检）：

    node scripts/install.mjs --verify

默认装到 DSH_HOME 对应的技能目录（本机为 D:\EAC-rc2-data\skills\interview-retro）。
DSH 会热加载它——安装后在会话里直接说「帮我复盘这场面试」即可，无需重启。

手动跑一遍完整链路：

    node skills/interview-retro/scripts/analyze.mjs skills/interview-retro/examples/sample-transcript.md \
      --jd skills/interview-retro/examples/sample-jd.md \
      --company "互联网大厂" --round "一面" --role "后端开发工程师" \
      --out skills/interview-retro/examples/out

    node skills/interview-retro/scripts/score.mjs score \
      --analysis skills/interview-retro/examples/out/sample-transcript.analysis.json \
      --scores skills/interview-retro/examples/out/scores.json \
      --history skills/interview-retro/examples/out/history.jsonl

    node skills/interview-retro/scripts/score.mjs trend --history skills/interview-retro/examples/out/trend-demo.jsonl

## 架构：为什么是三层

| 层 | 谁来做 | 为什么 |
| --- | --- | --- |
| 路由层（SKILL.md） | 模型按流程执行 | 技能入口只放"怎么执行"，领域知识不塞进主文件，控制每次触发的上下文成本 |
| 知识层（references/） | 模型按需读取 | 评分锚点、归因表、追问手册体量大且只在特定步骤用；按需加载比一次性灌进去更省 token、也更容易改 |
| 计算层（scripts/） | Node 脚本 | 计数、正则、加权、趋势这类事模型做不稳也不该做：脚本可复现、可测试、零成本 |

一句话原则：**凡是能算出唯一答案的，都不让模型"感觉"；凡是需要判断的，都必须挂一句原文证据。**

几种常见做法与代价：

| 方案 | 结果 |
| --- | --- |
| 全交给模型写报告 | 每次分数漂移、无法跨场比较、建议容易空泛 |
| 全用脚本生成报告 | 只能输出模板填空，无法识别"这题面试官其实在考推动力" |
| **本方案：脚本测事实 + 模型做判断 + schema 做闸门** | 分数可复现、结论可追溯、建议可验收 |

## 质量保障（这部分是给面试官看的）

1. **schema 闸门**：脚本会拒绝不合规的 scores.json——五维缺一、分数越界、证据少于 8 字、gap code 不在 G1-G6、补齐动作缺产出物或验收标准，都会非零退出并指出具体字段。想抄近路写空话，报告根本生成不出来。
2. **证据回溯**：每条 evidence 都会被拿去原始记录里做空白归一化匹配；对不上就告警（--strict 下直接失败）。防止模型编造"原话"。
3. **回归测试**：scripts/selftest.mjs 覆盖解析器边界（加粗标签、未知标签续行、speaker-map、多行答案）、指标计算（带单位量化 vs "2000 左右"）、加权算术（含 not_applicable 重归一化）、等级边界（4.49→A、4.5→S）、schema 负例、趋势聚合（连续踩坑 streak）。当前 28/28 通过。
4. **权重档案有不变式**：company-profiles.json 的每套权重和必须为 1.0，安装与测试都会校验。

## 设计取舍（面试常被追问的三点）

- **为什么不用 LLM 抽指标？** 同一份记录抽两次数字不一样，跨场趋势就没意义。正则+计数的确定性是这个技能的立身之本。
- **为什么评分锚点写得这么细？** 没有锚点的 1-5 分等于个人偏好；有锚点才能让"这次 3 分、上次 2 分"有解释力。
- **为什么强行要求证据原话？** 一是防幻觉，二是让复盘可争论——用户不同意分数时，可以指着那句话讨论，而不是互相感觉。

## 数据与隐私

- 复盘产物默认写在工作目录的 retro/ 下（已进 .gitignore），原始记录不参与任何上传，全部本地计算。
- 样例中的公司、人名、数据均为脱敏虚构。

## 路线图

- [ ] 面试前模式：只给 JD + 公司性质，输出「备战包」（高频问题预测 + 素材匹配 + 缺口清单）
- [ ] 支持录音时间轴（说话人分离后的 SRT/VTT）→ 每题真实语速与停顿统计
- [ ] 英文面试口径（structure/delivery 锚点英文版）
- [ ] 报告导出为 HTML 单页，便于归档与对比

## 许可

个人项目，示例数据均为虚构。技能可自由复制到自己的 DSH 技能目录使用。
