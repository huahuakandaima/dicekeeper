# DiceKeeper 项目记忆（来自 WorkBuddy 迁移，2026-08-11）

> 权威交接文档：`.zcode/reference/2026-08-11-12-04-44/HANDOFF.md`（新会话先读它，覆盖之前所有版本）
> 技术方案蓝本：`.zcode/reference/2026-08-10-20-31-09/.workbuddy/artifacts/DiceKeeper跑团框架技术方案.md`
> 本工作区的 dicekeeper 是桌面 `C:\Users\28917\Desktop\dicekeeper\` 的副本；**项目唯一权威位置是桌面那份**（git 仓库，remote=github.com/huahuakandaima/dicekeeper）。改代码、测试、push 都在桌面那份做。
> **适用边界**：本文件来自 WorkBuddy 环境；「沙箱 unset 三连」等坑在 ZCode 环境是否适用需实际验证。

## 项目是什么
- DiceKeeper：AI 主持人跑团（TRPG）框架。玩家与 LLM 扮演的 KP 跑团；**判定本地化铁律：AI 无权改判定结果**（掷骰/成败全本地），AI 只做叙事与世界操作。
- 技术栈：纯 TypeScript 引擎（Node ≥22.6 原生 type-stripping）、node:sqlite、Electron 43.3 + Vite 8 + React 19；引擎层与主进程零 npm 运行时依赖（WS 服务器自实现）。
- 已发布 GitHub 公开仓库（MIT）：https://github.com/huahuakandaima/dicekeeper（用户 GitHub：huahuakandaima）
- 当前进度：Phase 0~P6 + code-review backlog 全部完成（内置 dnd5e 双规则包、单项重骰、AI 生成 plot_threads/tables、串行队列/规则匹配/称谓下沉引擎层、AI target 单表、衍生公式告警）；测试 **204/204** 全绿；CI 自动发版 + 版本号自动写回仓库；用户实测反馈循环中。

## 关键命令（在桌面 dicekeeper 目录）
- 全量测试：`npm test`（18 文件 184 项）
- 构建：`npm run build`（新增 node: 模块后检查 `vite.config.main.ts` external 列表！）
- E2E：`unset ELECTRON_RUN_AS_NODE && export DK_E2E=1 && node_modules/.bin/electron.cmd . --no-sandbox > e2e.log 2>&1`（结果 `%TEMP%\dk-e2e-result.txt`；**先 grep 失败于步骤**）
- 发布：改代码 → `npm test` → `npm run build` → `git push`（CI 自动打包递增版本发 Release）
- 沙箱内 unset 三连放命令最前：`unset CODEBUDDY_SESSION_ID && unset CLAUDE_SESSION_ID && export NODE_OPTIONS=""`

## 致命坑（绝对不要踩）
1. **deepseek-v4-flash 对 max_tokens 返回空 content**（HTTP 200 但 content 空）→ provider.chat/aiGenerate 一律不传 maxTokens
2. **vite external 漏 node: 模块 → 主进程启动崩** → 主进程新增 node: 模块必须同步加 vite.config.main.ts external（列表含 http/net/os/child_process/util）
3. **campaign.rulePackId 死字段教训** → 功能实现必须查"存储字段 → 运行时加载 → 判定/prompt 使用"全链
4. **AI 输出格式不可假设 YAML** → JSON+YAML 双解析（parseAiOutput）+ 清洗（sanitizeAiYaml）+ 重试 1 次 + normalize 兜底
5. **对象合并兜底占位被空串覆盖** → 占位放 spread 之后 `{ ...n, traits: 有效?n.traits:占位 }` + Array.isArray 保护
6. **功能改造漏调用点**（v0.1.19 漏 preview；**v0.1.24 漏 preload 转发层**——主进程 handler 和 App.tsx 都改了，preload.cjs 的 `characters.preview/fields/derive` 没转发 rulePackId，UI 传了参数被 preload 丢弃 → 永远默认 coc7e，用户实测"按规则包生成角色卡还是默认规则"，E2E 也测不出（老 E2E 不传 rulePackId））→ 功能改造必须全链审查：**App.tsx → global.d.ts → preload.cjs → main.ts handler → 引擎**，每层参数签名逐一核对；preload 是手写 CJS 不参与打包，最容易漏
7. **规则包缺 chargen 段 → 车卡/衍生/手填全链炸（2026-08-11 v0.1.23 修复）**：模板新建/AI 生成的规则包可能缺 chargen（attribute_methods+occupations），validateRulePack 不校验（保存放行），generateCharacter/computeDerived/buildCharacter 却强依赖 → 前端无 catch 时静默保留旧默认卡（用户看到"还是默认规则"）。防线四层：模板补 chargen；normalizeGeneratedPack 兜底；ensureChargen 加载时兜底老包；前端报错可见。**车卡属性以 character_sheet.attributes 为驱动**（公式按字段匹配 attribute_methods、缺省 3d6*5）——改属性名不再脱节；职业点/衍生公式求值失败兜底不炸
8. **UI 显示层硬编码 CoC 名**（v0.1.24 修）：预览卡衍生行曾硬编码 `HP {..} / MP {..} / SAN {..} / 幸运 {..}`——非 CoC 包显示 "HP undefined..." 像"默认规则"。渲染衍生/属性必须 `Object.entries(x).map` 动态
9. **scenario:info 硬编码内置雾港（v0.1.25 修）**：`scenario:info` 曾固定返回全局内置剧本，与当前战役剧本包无关——选自定义剧本包建团后开场白仍是"雾港"第一句。修：按 activeCampaignId 的 campaign.scenarioPackId 加载；**React 陷阱**：openCampaign 里 setScenario 异步，开场白不能用 state 闭包（旧值），必须用 await 的局部变量。教训：**凡"返回当前上下文信息"的 IPC，必须按 activeCampaignId/战役字段取数，不能全局常量**
10. **onClick 直绑带业务参数的函数 = 静默失效（v0.1.26 修）**：`onClick={send}` 被 React 传入 MouseEvent → `send(optText?)` 的 optText=事件对象 → `(optText ?? input).trim()` TypeError 静默 → "发送按钮不管用只能回车"。**规则：onClick 一律 `() => fn(...)` 包裹**；函数首参是业务参数的绝不能直绑
11. **剧本包-规则包绑定（v0.1.26 用户要求）**：剧情包只能配套所选规则包——建团弹窗剧本包下拉按 requires 过滤联动（选规则包自动切第一个配套包）；campaign:create 校验 `sc.requires !== activePack.id` 拒绝；listScenarioPacks 内置 meta 必须带 requires。测试指纹：E2E r36 bad=REJECTED/good=OK
12. **技能按钮类型 action 字段（v0.1.27 用户需求"编辑时配置按钮"）**：`character_sheet.skills[].action`——check=检定（默认 d100）/ narrative=叙事行动（不掷骰，点击发行动消息 AI 叙事推进）/ none=不显示按钮。PackEditor 表单对 action 字段渲染下拉（ObjEditor 特殊处理）；App.tsx 右侧技能栏按 action 渲染（narrative 按钮样式 skill-narrative）；fields IPC 返回 action；validateRulePack 校验枚举。调研结论：Foundry 用"系统包+manifest+世界锁定"无默认兜底；Datasworn 动作类型枚举（action_roll/no_roll/progress_roll）；UI 数据驱动由动作类型决定按钮可见性
13. **GitHub 直连不稳定（用户在国内）**：git push 失败（443 超时）时走系统代理：`git config http.proxy http://127.0.0.1:7897`（本仓库配置；ProxyEnable=1 说明代理软件在跑）
14. **vite 构建缓存吞掉 renderer 产物（2026-08-11 实测）**：`npm run build` 显示 "built in 31ms/76ms" 秒完但 **dist/renderer 是旧产物**（index.html/JS 时间戳不变）→ 用户重启多次界面仍是旧文案。**根治：改 renderer 后删 `node_modules/.vite` + `dist/renderer` 强制重建**，并 grep dist 验证（`select-string 主持人 dist/renderer`）。**E2E 必须断言界面文本**（`document.body.innerText` 检查关键词，如 subTitle/staleKeeper），不能只验 IPC/窗口标题——r19 已加副标题断言
15. **规则包编辑后运行时缓存不失效（v0.1.30 修）**：rulePackCache 在 editor:save/create、packs:importText（覆盖导入）、packs:delete 后必须 clear——曾导致"编辑器改完规则包不生效"（E2E r39 暴露：保存 gm_title 后 fields 仍返回旧值）
16. **gh 用绝对路径** `/c/Program Files/GitHub CLI/gh.exe`（bash PATH 不刷新）；`gh release view` 须在仓库目录内；**git 用 `C:\Users\28917\.workbuddy\vendor\PortableGit\cmd\git.exe`**（系统 PATH 无 git）
17. **沙箱 safe-delete 拦 rm/rename/清理** → unset 三连放命令最前（`unset CODEBUDDY_SESSION_ID && unset CLAUDE_SESSION_ID && export NODE_OPTIONS=""`）
18. **E2E 结果文件是旧的** → 验证前先 grep "失败于步骤" 或看文件时间戳；**E2E 结果行里 r34 的 occ/derived 是判别"是否回退默认包"的指纹**（occ=私家侦探/derived 含幸运 ⇒ coc7e 回退；occ=示例职业 ⇒ 模板包生效）

## 约定
- 判定本地化铁律：随机与成败只在本地；AI 只能通过 make_check/roll_dice 请求；移动/张力/Ollama 状态/联机判定同为本地数值（多人=房主本地）
- 全量审计：掷骰→dice_rolls；世界变更→changes；AI 回复校验→verify.ts
- 新功能必须有测试（node:test），写完立即 `npm test`
- 中文 UI/文案；英文只留配置值
- Node 22 跑 TS：禁 constructor parameter properties；`import type` 导类型
- 用户偏好：先结论后论据、有立场；反馈→快速修复→push→让用户重启验证；**改完必须确认用户下到新版**（版本号递增是唯一信号）
- 用户已配置真实 API key（DeepSeek deepseek-v4-flash），AI 功能真实生效
