# 发布到 GitHub：完整步骤

本仓库已经 git init 并提交完毕（2 个提交，24 个文件），只差一个远程仓库地址。
本机没有安装 gh CLI，所以需要你先在网页上建一个**空仓库**（30 秒）。

## 第一步：在 GitHub 建空仓库

1. 打开 https://github.com/new
2. Repository name 填 interview-retro（或 面试复盘-skill，建议用英文名，URL 更干净）
3. **不要**勾选 Add a README file / .gitignore / license（否则会产生一次无关提交，推送时要先 pull 合并）
4. 可见性：Public（作品集建议公开；如果里面有真实面试数据就不要公开，见文末隐私提示）
5. 点 Create repository，然后复制页面上的 HTTPS 地址，形如：
   https://github.com/你的用户名/interview-retro.git

## 第二步：把地址给我，或者自己跑这三条

    git remote add origin https://github.com/你的用户名/interview-retro.git
    git branch -M main
    git push -u origin main

第一次推送会弹出 GitHub 登录（本机 credential.helper=manager，会存进 Windows 凭据管理器，之后不用再登）。

## 第三步（可选但推荐）：改成你自己的提交署名

当前两个提交的作者是占位身份 interview-retro <dev@example.com>。作品集仓库建议改成你自己的名字与 GitHub noreply 邮箱（在 GitHub → Settings → Emails 里能找到形如 12345678+username@users.noreply.github.com 的地址，用它不会暴露真实邮箱）。

改写作者（保留提交信息与时间）：

    git -c user.name="你的名字" -c user.email="你的邮箱" rebase --root --exec "git commit --amend --no-edit --reset-author"

或者只改本地配置、仅影响之后的提交（已有两个提交保持占位）：

    git config user.name "你的名字"
    git config user.email "你的邮箱"

> 注意：改写会生成新的 commit hash。如果已经推送过，需要 git push --force-with-lease；在只有你自己的分支上用 --force-with-lease 是安全的。

## 第四步：验证

    git remote -v
    git log --format='%h %an <%ae> %s'
    git status --short          # 应为空

推完之后在 GitHub 页面上确认三件事：

- 文件树里有 skills/interview-retro/SKILL.md 与 scripts/ 三个脚本
- README.md 正常渲染（表格与代码块没坏）
- 提交历史是 2 条，作者是你自己

## 隐私提示

- .gitignore 已经忽略 /retro/，那是放你真实面试记录的地方，不会被提交。
- examples/ 里的公司与数据都是脱敏虚构样例，可以公开。
- 推送前建议再跑一次 git status，确认没有把真实简历、JD（带公司名）或录音文本加进版本库。

## 之后更新技能

改了技能源码后：

    node scripts/install.mjs --verify     # 先自检 + 更新本机 DSH 技能目录
    git add -A
    git commit -m "feat: ..."
    git push
