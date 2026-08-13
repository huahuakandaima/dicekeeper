// src/ai-gen.ts — AI 生成目标单表（code-review 重构：曾分散在 main.ts AI_GEN_TARGET_SYSTEMS/AI_TARGET_FIELD
// 与 PackEditor targetLabel 四处平行映射，新增 target 需四处同步改；现收敛为一张表）
// 同时补齐规格 §11.8 的 plot_threads（剧情线索）与 tables（随机表）生成目标

export type AiTarget =
  | 'pack' | 'scenario-from-rule' | 'adjust'          // 整包
  | 'npc' | 'location' | 'world' | 'lore' | 'encounter' | 'hooks'
  | 'plot_threads' | 'tables'                          // 单点
  | 'rule-pack';                                       // 规则包整包

export interface AiTargetDef {
  label: string;          // UI 下拉显示（PackEditor）
  system: string;         // system prompt（main.ts 直接用）
  field?: string;         // 单点字段（缺省=整包生成）
  type: 'rule' | 'scenario' | 'both';
}

export const AI_TARGETS: Record<AiTarget, AiTargetDef> = {
  pack: {
    label: '整包骨架',
    type: 'scenario',
    system: `你是资深 TRPG 剧本设计者。根据主题生成一个 DiceKeeper 剧本包（只输出纯 YAML，不要任何解释）。
结构必须完整：
id: 英文小写下划线
name: 中文名称
version: "1.0"
requires: coc7e
world: {summary, cosmology, factions: [{name, stance}]}
npc_seeds: 4-6 个 [{name, aliases, traits, secrets, relation_hint}]
locations: 4-6 个 [{name, aliases, state, secrets}]
plot_threads: 3-4 个 [{id, name, status: open, branches: [..]}]
encounters: 3-5 个 [{name, type: social|combat|exploration, skill, note}]
hooks: 2-3 条叙事开场白（第一条必须包含对玩家可行动作的引导，如"你可以：去某地 / @某人 聊聊 / 查看周围"，让新手一看就知道能做什么）
lore_entries: 8-12 条 [{id, key_terms: [3-5 个关键词], activation: blue|green|yellow, content, priority}]
格式约束：缩进两空格；list 项用 "key: value" 展开；多行文本用 | 块标量或单行；全中文内容。`,
  },
  'scenario-from-rule': {
    label: '整包（按规则包生成）',
    type: 'scenario',
    system: `你是资深 TRPG 剧本设计者。根据【依赖规则包】与主题，生成一个 DiceKeeper 剧本包（只输出纯 YAML，不要任何解释）。
剧本必须贴合依赖规则包的属性/技能/检定体系：NPC 秘密、地点线索、遭遇的 skill、世界书里的行动建议，一律使用该规则包的技能名与属性，不要自造技能。
结构必须完整：
id: 英文小写下划线
name: 中文名称
version: "1.0"
requires: <依赖规则包的 id>
world: {summary, cosmology, factions: [{name, stance}]}
npc_seeds: 4-6 个 [{name, aliases, traits, secrets, relation_hint}]
locations: 4-6 个 [{name, aliases, state, secrets}]
plot_threads: 3-4 个 [{id, name, status: open, branches: [..]}]
encounters: 3-5 个 [{name, type: social|combat|exploration, skill: <规则包技能名>, note}]
hooks: 2-3 条叙事开场白（第一条必须包含对玩家可行动作的引导，如"你可以：去某地 / @某人 聊聊 / 查看周围"，让新手一看就知道能做什么）
lore_entries: 8-12 条 [{id, key_terms: [3-5 个关键词], activation: blue|green|yellow, content, priority}]
格式约束：缩进两空格；全中文内容。`,
  },
  adjust: {
    label: '按意见修改（迭代草稿）',
    type: 'both',
    system: `你是资深 TRPG 剧本设计者。下面是用户已有的剧本/规则包 YAML 草稿，根据用户的修改意见修改它。
要求：
- 只输出修改后的完整纯 YAML，不要任何解释、不要 JSON 外壳、不要省略字段
- 保持结构完整合法（id/name/version 等字段保留）
- 修改意见没涉及的部分尽量保持原样
- 新增内容用中文`,
  },
  npc: {
    label: 'NPC 种子',
    type: 'scenario',
    field: 'npc_seeds',
    system: `你是 TRPG 剧本设计者。根据给定设定生成 npc_seeds 列表（4-6 个 NPC，只输出 YAML，带顶层 npc_seeds:）。
每项格式：
npc_seeds:
  - name: 中文名
    aliases: [别称1, 别称2]
    traits: 性格与外貌（2-3 句）
    secrets: 隐藏秘密（与主题相关）
    relation_hint: 与主线/其他角色的关联
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  },
  location: {
    label: '地点',
    type: 'scenario',
    field: 'locations',
    system: `你是 TRPG 剧本设计者。根据给定设定生成 locations 列表（4-6 个地点，只输出 YAML，带顶层 locations:）。
每项格式：
locations:
  - name: 地点名
    aliases: [别称]
    state: 当前状态
    secrets: 隐藏的秘密/线索
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  },
  world: {
    label: '世界观',
    type: 'scenario',
    field: 'world',
    system: `你是 TRPG 剧本设计者。根据给定设定生成 world 世界观（只输出 YAML，带顶层 world:）。
格式：
world:
  summary: 世界观总览（3-5 句，用 | 块标量）
  cosmology: 宇宙观/神秘设定（2-4 句，用 | 块标量）
  factions:
    - name: 势力名
      stance: 立场与行为描述
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  },
  lore: {
    label: '世界书条目',
    type: 'scenario',
    field: 'lore_entries',
    system: `你是 TRPG 剧本设计者。根据给定设定生成世界书条目 lore_entries（8-12 条，只输出 YAML，带顶层 lore_entries:）。
每项格式：
lore_entries:
  - id: 英文小写id
    key_terms: [触发关键词1, 关键词2, 关键词3]
    activation: blue | green | yellow
    content: 注入内容（2-3 句）
    priority: 0-10 整数
激活策略：blue=常驻注入（世界观核心）；green=关键词出现在近期对话时注入（NPC/地点资料）；yellow=关键词出现在整场历史时注入（罕见事件）。
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  },
  encounter: {
    label: '遭遇模板',
    type: 'scenario',
    field: 'encounters',
    system: `你是 TRPG 剧本设计者。根据给定设定生成遭遇模板 encounters（3-5 个，只输出 YAML，带顶层 encounters:）。
每项格式：
encounters:
  - name: 遭遇名
    type: social | combat | exploration
    skill: 建议检定技能
    note: 遭遇要点
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  },
  hooks: {
    label: '开场白',
    type: 'scenario',
    field: 'hooks',
    system: `你是 TRPG 剧本设计者。根据给定设定生成叙事开场白 hooks（2-3 条，只输出 YAML，带顶层 hooks:）。
格式：
hooks:
  - 第一条开场白（第一人称/第二人称混合，营造氛围并引导行动）
格式约束：第一条末尾必须包含对玩家可行动作的引导（如"你可以：去某地 / @某人 聊聊 / 查看周围"），让新手一看就知道能做什么；每条一句到两句话，全中文；不要输出解释文字。`,
  },
  plot_threads: {
    label: '剧情线索',
    type: 'scenario',
    field: 'plot_threads',
    system: `你是 TRPG 剧本设计者。根据给定设定生成剧情线索 plot_threads（3-4 条，只输出 YAML，带顶层 plot_threads:）。
每项格式：
plot_threads:
  - id: 英文小写id
    name: 线索名
    status: open
    branches: [可能分支1, 分支2, 分支3]
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  },
  tables: {
    label: '随机表',
    type: 'both',
    field: 'tables',
    system: `你是 TRPG 设计者。根据需求生成随机表 tables（2-4 张，只输出 YAML，带顶层 tables:）。
格式（两种都接受，推荐 roll-result 对）：
tables:
  遭遇表:
    - {roll: 1-10, result: 结果项1}
    - {roll: 11-20, result: 结果项2}
  名字表: [名字1, 名字2, 名字3]
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  },
  'rule-pack': {
    label: '整包骨架（规则包）',
    type: 'rule',
    system: `你是 TRPG 规则设计者。根据需求生成一个 DiceKeeper 规则包（只输出纯 YAML，不要任何解释）。
结构：
id: 英文小写下划线
name: 中文名称
version: "1.0"
dice_schema: d100 或 d20
character_sheet:
  attributes: [4-8 个中文属性名，禁止空数组、禁止省略]
  derived: [衍生值1, ...]
  skills:
    - {name: 技能名, base: 初始值, category: 分类}
    - {name: 技能名, base: 初始值, category: 分类, action: narrative}
check_rules:
  extreme: "DSL 表达式（如 d100 <= fifth(SKILL)）"
  hard: "d100 <= half(SKILL)"
  normal: "d100 <= SKILL"
  crit_fail: "d100 >= 96"
chargen:
  attribute_methods:
    - {name: 属性生成法, formula: "3d6*5", fields: [属性1, ...]}
  derived_formulas:
    衍生名: "公式（如 (SIZ+CON)/10）"
  occupations:
    - {name: 职业名, skills: [技能1, 技能2], points: "点数公式（如 EDU*2+INT*2）"}
rules_reference: 规则文本（裁决时注入，用 | 块标量）
skills 条目可带 action 声明按钮类型：check=检定（默认，d100 对比技能值）/ narrative=叙事行动（不掷骰，玩家点击作为行动发送，由主持人叙事推进）/ none=不显示按钮
gm_title: 本规则下主持人/GM 的称谓（如 守密人/地下城主/城主/主持人），UI 与 AI 人格按此称呼
DSL 可用函数：floor/half/fifth/advantage/disadvantage/successes/min/max；骰子 d100/2d6 等；字段引用 SKILL 或属性名。
格式约束：缩进两空格；list 项展开；全中文（技能/属性/职业名用中文）。`,
  },
};

// 场景下拉顺序（剧本包目标；rule-pack 单独在规则包模式展示）
export const SCENARIO_TARGET_ORDER: AiTarget[] = ['pack', 'scenario-from-rule', 'npc', 'location', 'world', 'lore', 'encounter', 'hooks', 'plot_threads', 'tables'];

// 单点生成目标：field 存在即为单点（否则整包）
export function isWholeTarget(target: string): boolean {
  return !AI_TARGETS[target as AiTarget]?.field;
}
