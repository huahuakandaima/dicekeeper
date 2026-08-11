# 🎲 DiceKeeper — AI 主持人跑团

让 AI 扮演主持人（GM）的桌面角色扮演（TRPG）框架。你和朋友描述行动、掷骰判定、推进剧情——**掷骰与成败判定全部在本地执行，AI 无权改变判定结果**，它只负责叙事与世界演进。主持人称谓随规则包变化：CoC 里是「守密人」，D&D 里是「地下城主」，你的规则包自己定。

![平台](https://img.shields.io/badge/平台-Windows%20%2F%20macOS%20%2F%20Linux-lightgrey)
![运行时](https://img.shields.io/badge/运行时-零前置-blueviolet)
![测试](https://img.shields.io/badge/tests-204%2F204-brightgreen)
![协议](https://img.shields.io/badge/License-MIT-green)

## ✨ 功能特性

- **判定本地化铁律**：骰子、成败、移动、张力全部本地裁定，AI 只能通过工具请求检定，不能篡改结果；全量审计（掷骰记录 / 世界变更可回滚 / AI 回复校验）
- **双内置规则包**：CoC 7e（d100 系）与 **D&D 5e（d20 系）**，建团即可选
- **换规则包**：自建/导入任意规则包（YAML），建团选择后**属性 / 技能 / 检定 / 车卡 / 主持人称呼全链按所选规则包运行**，运行时按战役加载
- **剧情包绑定规则包**：剧情包 `requires` 锁定规则体系，建团下拉自动联动配套剧本，错配直接拒绝
- **内容包体系**：规则包 / 剧本包 / 人格包，YAML 编写，内置可视化编辑器（表单 / 源码 / 试跑检定分布），导入导出 .dk
- **AI 生成内容**：一句话生成整包，或单点生成 NPC / 地点 / 世界观 / 世界书 / 遭遇 / 开场白 / **剧情线索 / 随机表**，草稿可「按意见修改」对话式迭代；AI 输出容错（JSON/YAML 双解析 + 自动重试 + 兜底规范化）
- **技能按钮类型可配置**：规则包编辑时给每个技能定义按钮行为——检定 / 叙事行动（不掷骰） / 不显示
- **单项重骰**：手动编辑角色卡时每个属性可单独 🎲 重掷（按规则包公式），衍生值自动重算
- **双 LLM 供应商**：OpenAI 兼容 API（DeepSeek / 通义 / Kimi / OpenAI…）或本地 Ollama，一个配置切换
- **局域网联机**：房主中心化（自实现 WebSocket，零依赖），AI 只跑房主侧；玩家为轻量端，发行动、收叙事；跨网用 Tailscale / ZeroTier 组网
- **记忆系统**：L1 上下文窗口 + L2 章节摘要 + L3 事实提取，长跑团不丢记忆
- **戏剧引擎**：张力仪表（强度 / 意外 / 失败代价滑杆）+ 倒计时线索，控制剧情节奏
- **离线可用**：无网络也能本地判定推进（配置 AI 后叙事完整展开）

## ⬇️ 下载

从 [Releases](../../releases/latest) 下载（每次发布自动打包，标题带版本号）：

| 文件 | 说明 |
|------|------|
| `DiceKeeper-Setup-x.x.x.exe` | 安装版（可选安装目录，含桌面快捷方式） |
| `DiceKeeper-Portable-x.x.x.exe` | 便携版（单文件，双击即玩，数据存 `%APPDATA%\dicekeeper\`） |

> 窗口标题栏始终显示当前版本号（`DiceKeeper v0.1.x — AI 主持人跑团`），一眼确认新旧。

## 🚀 快速开始

1. 下载并双击 exe
2. 左下角「⚙ 设置」→ 填入 OpenAI 兼容接口地址与 API 密钥（DeepSeek / 通义 / Kimi 均可），点「测试连接」
3. 「＋ 新建战役」→ 选**规则包**（默认 CoC 7e，或 D&D 5e / 自建包）→ 剧本包自动联动配套 → 生成角色卡 → 开始跑团

不想用云端 API？见下方**本地模式**。

## 📦 规则包与剧本包

**内置双规则包**：

| 规则包 | 骰系 | 主持人 | 判定 |
|--------|------|--------|------|
| 克苏鲁的呼唤 7 版 | d100 | 守密人 | d100 ≤ 技能值（极限/困难/普通/大失败） |
| 龙与地下城 5e | d20 | 地下城主 | d20 + 技能值 ≥ DC（10/15/20，天然 1 大失败） |

**自定义规则包**（设置 → 内容包）：新建 / 导入 .dk / AI 生成。规则包可定义：
- 属性、技能、衍生值（`character_sheet`）
- 检定档位 DSL（`check_rules`，支持优势/劣势/成功数）
- 车卡规则（`chargen`：属性公式如 `4d6kh3`、职业、衍生公式）
- **主持人称谓 `gm_title`**（守密人 / 地下城主 / 主持人…）
- **技能按钮类型 `action`**（check 检定 / narrative 叙事行动 / none 不显示）

**剧本包绑定**：剧本包 `requires` 锁定规则包，建团时剧本下拉只显示配套包；换规则包自动联动。编辑器保存规则包时会对衍生公式字段引用做告警（写错字段不再静默带病运行）。

## 🌐 局域网联机

1. **房主机**：点击「🌐 联机 → 开启房间」，把 `IP:端口` 地址发给玩家
2. **玩家机**：点击「🌐 联机 → 输入地址 + 昵称 → 加入房间」
3. 玩家发送的行动由房主本地判定与 AI 叙事，结果广播给所有人；消息串行队列保证顺序与并发安全

**跨网远程跑团**：双方安装 [Tailscale](https://tailscale.com/)（或 ZeroTier / 蒲公英），登录同一账号后，玩家输入房主的虚拟局域网 IP 即可，体验等同局域网。

## 🤖 本地模式（Ollama，免费 / 断网可用）

1. 「⚙ 设置 → 本地模式」→ 点击「下载并启用本地模式」（自动托管 Ollama 便携版，无需安装器）
2. 「检测硬件并推荐模型」→ 按显存 / 内存推荐档位（默认 Qwen2.5-7B，中文跑团平衡点）
3. 点「下载并启用」→ 进度条拉完即用，AI 设置自动切换本地

> 本地模型质量上限约 7B 档，与云端大模型有差距；追求叙事质量建议 API 模式。

## 🛠 技术栈

- **引擎**：纯 TypeScript，零 npm 运行时依赖（Node ≥22.6 原生 type-stripping + node:sqlite）
- **桌面**：Electron 43 + Vite 8 + React 19
- **联机**：自实现 RFC 6455 最小 WebSocket 服务器（零依赖）
- **打包与发布**：electron-builder（NSIS 安装版 + 便携版）；GitHub Actions 每次 push 自动测试 + 打包 + 递增版本发 Release（版本号自动写回仓库）

## 🧑‍💻 开发

```bash
npm install
npm test          # 204 项测试（node:test，18 个测试文件）
npm run build     # 主进程 CJS + renderer（改 renderer 后建议清 node_modules/.vite 再构建）
npm run dist:win  # 打包 Setup + Portable 双 exe（dist-package/）
```

## ⚖️ 版权声明

- 本软件为**非官方粉丝作品**，与混沌元素（Chaosium Inc.）及威世智（Wizards of the Coast）无关
- `rules/coc7e.yaml` 数值与检定公式依据《克苏鲁的呼唤》第七版，衍生公式与年龄修正参考开源项目 [SLMT/coc7-character-generator](https://github.com/SLMT/coc7-character-generator) 与 [masquevil/trpg-saikou](https://github.com/masquevil/trpg-saikou)；规则文本版权归原权利方所有，本仓库仅作玩家自用转换
- `rules/dnd5e.yaml` 为基于《龙与地下城》5e SRD 概念的简化近似实现（自用车卡与检定建模），非官方规则文本
- 内置剧本《雾港疑云》为原创内容

## 📄 License

[MIT](LICENSE)
