# 🎲 DiceKeeper — AI 守密人跑团

让 AI 扮演"守密人"（KP）的桌面角色扮演（TRPG）框架。你和朋友描述行动、掷骰判定、推进剧情——**掷骰与成败判定全部在本地执行，AI 无权改变判定结果**，它只负责叙事与世界演进。

![平台](https://img.shields.io/badge/平台-Windows%20%2F%20macOS%20%2F%20Linux-lightgrey)
![运行时](https://img.shields.io/badge/运行时-零前置-blueviolet)
![协议](https://img.shields.io/badge/License-MIT-green)

## ✨ 功能特性

- **判定本地化铁律**：骰子、成败、移动、张力全部本地裁定，AI 只能通过工具请求检定，不能篡改结果
- **双 LLM 供应商**：OpenAI 兼容 API（DeepSeek / 通义 / Kimi / OpenAI…）或本地 Ollama，一个配置切换
- **局域网联机**：房主中心化，AI 只跑房主侧；玩家为轻量端，发行动、收叙事。跨网用 Tailscale / ZeroTier 组网即可
- **内置 CoC 7e 规则包** + 内置剧本《雾港疑云》（NPC 种子 / 线索 / 倒计时事件）
- **规则包 / 剧本包 / 人格包**：YAML 编写，支持导入导出（.dk）与内置编辑器
- **记忆系统**：L1 上下文窗口 + L2 章节摘要 + L3 事实提取，长跑团不丢记忆
- **戏剧引擎**：张力仪表（强度 / 意外 / 失败代价滑杆）+ 倒计时线索，控制剧情节奏
- **全量审计**：掷骰记录、世界变更（可回滚）、AI 回复校验
- **离线可用**：无网络也能本地判定推进（配置 AI 后叙事完整展开）

## ⬇️ 下载

从 [Releases](../../releases/latest) 下载：

| 文件 | 说明 |
|------|------|
| `DiceKeeper-Setup-x.x.x.exe` | 安装版（可选安装目录，含桌面快捷方式） |
| `DiceKeeper-Portable-x.x.x.exe` | 便携版（单文件，双击即玩，数据存 `%APPDATA%\dicekeeper\`） |

## 🚀 快速开始

1. 下载并双击 exe
2. 左下角「⚙ 设置」→ 填入 OpenAI 兼容接口地址与 API 密钥（DeepSeek / 通义 / Kimi 均可），点「测试连接」
3. 「＋ 新建战役」→ 生成调查员角色卡 → 开始跑团

不想用云端 API？见下方**本地模式**。

## 🌐 局域网联机

1. **房主机**：点击「🌐 联机 → 开启房间」，把 `IP:端口` 地址发给玩家
2. **玩家机**：点击「🌐 联机 → 输入地址 + 昵称 → 加入房间」
3. 玩家发送的行动由房主本地判定与 AI 叙事，结果广播给所有人

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
- **打包**：electron-builder（NSIS 安装版 + 便携版）

## 🧑‍💻 开发

```bash
npm install
npm test          # 170+ 项测试（node:test）
npm run build     # 主进程 CJS + renderer
npm run dist:win  # 打包 Setup + Portable 双 exe（dist-package/）
```

## ⚖️ 版权声明

- 本软件为**非官方粉丝作品**，与混沌元素（Chaosium Inc.）无关
- `rules/coc7e.yaml` 数值与检定公式依据《克苏鲁的呼唤》第七版，衍生公式与年龄修正参考开源项目 [SLMT/coc7-character-generator](https://github.com/SLMT/coc7-character-generator) 与 [masquevil/trpg-saikou](https://github.com/masquevil/trpg-saikou)；规则文本版权归原权利方所有，本仓库仅作玩家自用转换
- 内置剧本《雾港疑云》为原创内容

## 📄 License

[MIT](LICENSE)
