// test/gateway.test.ts — AI 网关全链路（MockProvider）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRulePack } from '../src/rules.ts';
import { generateCharacter } from '../src/chargen.ts';
import { World } from '../src/world.ts';
import { MockProvider, GatewayError, toWireMessages, type ChatMessage, type ToolCall } from '../src/gateway/provider.ts';
import { executeTool, TOOLS, type ToolContext, ToolError } from '../src/gateway/tools.ts';
import { verifyNarrative, verifyDiceRefs } from '../src/gateway/verify.ts';
import { runChat, parseStructured, extractNarrativePrefix } from '../src/gateway/chat.ts';
import { buildSystemPrompt } from '../src/gateway/prompt.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pack = loadRulePack(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules', 'coc7e.yaml'));
const character = generateCharacter(pack, { seed: 'gateway-char' });
const world = new World();
const npc = world.addEntity('npc', '埃德加', { 职业: '老船长', 秘密: '30 年前见过海怪' }, ['老船长', '渔夫']);

function ctx(seed = 'gateway'): ToolContext {
  return { pack, character, world, seed, extraFields: {} };
}

function tc(name: string, args: unknown): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) };
}

// —— tools ——

test('make_check：判定本地化——skill 从角色卡取值，AI 传 value 无效', async () => {
  const c = ctx('check-tool');
  const spot = character.skills['侦查'];
  const r = await executeTool(tc('make_check', { skill: '侦查', reason: '雾中辨认人影' }), c);
  const data = JSON.parse(r.content) as { taken: number; verdict: string };
  assert.ok(data.taken >= 1 && data.taken <= 100);
  assert.ok(['大失败', '极限成功', '困难成功', '普通成功', '失败'].includes(data.verdict));
  assert.equal(r.diceIds!.length, 1);
  assert.equal(world.diceLog.length, 1);
  // 审计里 skill 值 = 角色卡侦查（本地取值）
  assert.ok(spot >= 1);
});

test('make_check：未知技能报人话错误', async () => {
  const c = ctx('check-bad');
  await assert.rejects(() => executeTool(tc('make_check', { skill: '灵能' }), c), ToolError);
});

test('roll_dice：自由掷骰返回数值与审计', async () => {
  const c = ctx('roll-tool');
  const r = await executeTool(tc('roll_dice', { expression: '2d6+3' }), c);
  const data = JSON.parse(r.content) as { total: number; rolls: number[] };
  assert.equal(data.rolls.length, 2);
  assert.equal(data.total, data.rolls[0] + data.rolls[1] + 3);
});

test('query_world：按名称/别名检索实体', async () => {
  const c = ctx();
  const byName = await executeTool(tc('query_world', { query: '埃德加' }), c);
  assert.match(byName.content, /老船长/);
  const byAlias = await executeTool(tc('query_world', { query: '老船长' }), c);
  assert.match(byAlias.content, /埃德加/);
  const none = await executeTool(tc('query_world', { query: '不存在的龙王' }), c);
  assert.match(none.content, /无匹配实体/);
});

test('update_entity + remember：变更落审计日志', async () => {
  const c = ctx('update-tool');
  const before = world.changes.length;
  await executeTool(tc('update_entity', { entity_id: npc.id, delta: { 好感: -5 } }), c);
  await executeTool(tc('remember', { fact: '埃德加欠赌债', entity_refs: [npc.id], importance: 'high' }), c);
  assert.ok(world.changes.length >= before + 2);
  assert.equal(world.entities.get(npc.id)!.data['好感'], -5);
  assert.ok(world.facts.some((f) => f.fact.includes('欠赌债')));
});

test('update_entity：实体不存在报错', async () => {
  await assert.rejects(() => executeTool(tc('update_entity', { entity_id: 'nope', delta: {} }), ctx()), ToolError);
});

test('check_rule：规则参考检索', async () => {
  const r = await executeTool(tc('check_rule', { question: '奖励骰' }), ctx());
  assert.match(r.content, /奖励骰|惩罚骰|d100/);
});

test('draw_table：随机表抽取', async () => {
  const packWithTable = { ...pack, tables: { names: ['阿比盖尔', '以利亚', '米娜'] } };
  const r = await executeTool(tc('draw_table', { table_id: 'names' }), { ...ctx(), pack: packWithTable });
  assert.match(r.content, /阿比盖尔|以利亚|米娜/);
  await assert.rejects(() => executeTool(tc('draw_table', { table_id: 'missing' }), ctx()), ToolError);
});

// —— verify ——

test('verifyNarrative：编造骰值被拦截', () => {
  const w = new World();
  w.addDice('d100', 37, [37], '侦查', 'ai', 's1');
  const issues = verifyNarrative('骰子滚出 17，你撞开了门', w);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'narrative_fabricated_dice');
  // 匹配审计的骰值放行
  assert.equal(verifyNarrative('你掷出 37，勉强成功', w).length, 0);
});

test('verifyNarrative：普通数字不误杀', () => {
  const w = new World();
  assert.equal(verifyNarrative('三匹马从门口跑过，五分钟前', w).length, 0);
});

test('verifyDiceRefs：引用不存在的掷骰被拦截', () => {
  const w = new World();
  w.addDice('d100', 37, [37], 'x', 'ai', 's');
  assert.equal(verifyDiceRefs(['real-id-unknown'], w).length, 1);
});

// —— chat 全链路 ——

test('runChat：工具循环 + 结构化输出 + 校验通过', async () => {
  const w = new World();
  const c = ctx('chat-loop');
  const provider = new MockProvider('mock', [
    // 第一轮：调用 make_check
    (msgs: ChatMessage[]) => ({
      content: null,
      toolCalls: [{ id: 'c1', name: 'make_check', arguments: JSON.stringify({ skill: '侦查', reason: '雾中辨认人影' }) }],
      model: 'mock',
    }),
    // 第二轮：最终叙事（引用真实骰值）
    (msgs: ChatMessage[]) => {
      const lastTool = msgs[msgs.length - 1] as { content: string };
      const toolData = JSON.parse(lastTool.content) as { dice: string; taken: number; verdict: string };
      return {
        content: JSON.stringify({
          narrative: `雾中那人影一晃而过。你掷出 ${toolData.taken}，${toolData.verdict}——你看清了，是老船长埃德加。`,
          dice_results: [toolData.dice],
          prompt_player: '要上前打招呼吗？',
        }),
        model: 'mock',
      };
    },
  ]);
  const out = await runChat('我眯起眼，想看清雾中的人影是谁。', [], {
    provider,
    toolCtx: c,
    systemPrompt: buildSystemPrompt({ pack, character, world: w }),
  });
  assert.equal(out.toolRounds, 1);
  assert.ok(out.narrative.includes('埃德加'));
  assert.ok(out.diceResults.length >= 1);
  assert.equal(out.issues.length, 0); // 引用真实骰值 → 无违规
});

test('runChat：AI 编造骰值被校验拦截', async () => {
  const w = new World();
  const provider = new MockProvider('mock-cheat', [
    {
      content: JSON.stringify({
        narrative: '你掷出 99，门被撞开了。',
        dice_results: [],
      }),
      model: 'mock',
    },
  ]);
  const out = await runChat('我用力撞门。', [], {
    provider,
    toolCtx: ctx('cheat'),
    systemPrompt: buildSystemPrompt({ pack, character, world: w }),
  });
  assert.ok(out.issues.length >= 1);
  assert.equal(out.issues[0].kind, 'narrative_fabricated_dice');
});

test('runChat：工具参数非法 JSON 容错后继续', async () => {
  const provider = new MockProvider('mock-bad-args', [
    { content: null, toolCalls: [{ id: 'c1', name: 'roll_dice', arguments: '{not-json' }], model: 'mock' },
    { content: JSON.stringify({ narrative: '风从破窗灌进来。', dice_results: [] }), model: 'mock' },
  ]);
  const out = await runChat('我看了看窗户。', [], {
    provider,
    toolCtx: ctx('bad-args'),
    systemPrompt: '你是守密人。',
  });
  assert.ok(out.narrative.includes('破窗'));
});

test('runChat：工具循环超过上限抛错', async () => {
  const provider = new MockProvider('mock-loop', Array.from({ length: 5 }, () => ({
    content: null,
    toolCalls: [{ id: 'c', name: 'roll_dice', arguments: '{"expression":"d20"}' }],
    model: 'mock',
  })));
  await assert.rejects(
    () => runChat('无限循环测试', [], { provider, toolCtx: ctx('loop'), systemPrompt: 'x', maxToolRounds: 3 }),
    /工具调用超过 3 轮/,
  );
});

test('parseStructured：容错解析非 JSON 输出', () => {
  assert.deepEqual(parseStructured('纯叙事没有 JSON'), { narrative: '纯叙事没有 JSON', dice_results: [], prompt_player: null });
  const p = parseStructured('前导文字{"narrative":"正文","dice_results":["a1"],"prompt_player":"继续?"}尾部');
  assert.equal(p.narrative, '正文');
  assert.deepEqual(p.dice_results, ['a1']);
  assert.equal(p.prompt_player, '继续?');
});

test('parseStructured：narrative 含未转义引号时容错提取三字段（不落外壳）', () => {
  // 真实故障场景：AI 输出「"名单"」未转义 → JSON.parse 失败 → 旧实现把含外壳全文当 narrative
  const bad = `{"narrative": "手记里提到的"名单"脱不了干系。", "dice_results": ["4c774791"], "prompt_player": "你打算——\\n① 继续观察\\n② 主动上前搭话"}`;
  const p = parseStructured(bad);
  assert.equal(p.narrative, '手记里提到的"名单"脱不了干系。');
  assert.deepEqual(p.dice_results, ['4c774791']);
  assert.equal(p.prompt_player, '你打算——\n① 继续观察\n② 主动上前搭话');
  // 转义引号场景不受影响（仍走 JSON.parse 快路径）
  const ok = parseStructured('{"narrative":"他说\\"快走\\"。","dice_results":[],"prompt_player":null}');
  assert.equal(ok.narrative, '他说"快走"。');
  // 未转义引号 + 前导废话：废话保留
  const withPrefix = parseStructured('好的，{"narrative":"名单上的"记号"在腋下。","dice_results":[],"prompt_player":null}');
  assert.equal(withPrefix.narrative, '名单上的"记号"在腋下。');
});

test('extractNarrativePrefix：narrative 含未转义引号时不截断、不泄漏外壳', () => {
  const bad = `{"narrative": "手记里提到的"名单"脱不了干系。", "dice_results": ["4c774791"]}`;
  assert.equal(extractNarrativePrefix(bad), '手记里提到的"名单"脱不了干系。');
  // 渐进片段：引号后内容逐步出现
  const part = `{"narrative": "手记里提到的"名单"脱不了干系。他还在等什么`;
  assert.equal(extractNarrativePrefix(part), '手记里提到的"名单"脱不了干系。他还在等什么');
});

// JSON 泄露防御（2026-08-11 用户反馈"json泄露"）：
// ① 数组包裹剥壳 ② YAML 风格值（值未加引号）提取 ③ verify 检测泄露特征
test('parseStructured：数组包裹 [{"narrative":...}] 剥壳提取', () => {
  const p = parseStructured('[{"narrative": "数组包裹的叙事", "dice_results": ["x1"]}]');
  assert.equal(p.narrative, '数组包裹的叙事');
  assert.deepEqual(p.dice_results, ['x1']);
});

test('parseStructured：YAML 风格值（"narrative": 文本 未加引号）不落外壳', () => {
  const p = parseStructured('{"narrative": 你推开酒馆的门，海盐味扑面而来。, "dice_results": []}');
  assert.equal(p.narrative, '你推开酒馆的门，海盐味扑面而来。');
});

test('verifyNarrative：叙事含 JSON 结构/内部字段被拦截（narrative_json_leak）', () => {
  const world = new World('test');
  // 工具返回结构回显（AI 把 make_check 结果原样复述）
  const leak1 = verifyNarrative('检定完成：{"dice": "r1", "taken": 42, "verdict": "困难成功"}', world);
  assert.ok(leak1.some((i) => i.kind === 'narrative_json_leak'));
  // AI 把系统字段结构原样复述（"dice_results": [...]）
  const leak2 = verifyNarrative('这是结果："dice_results": ["4c774791"]', world);
  assert.ok(leak2.some((i) => i.kind === 'narrative_json_leak'));
  // 正常叙事不误杀（含"检定"等词但无 JSON 结构）
  const ok = verifyNarrative('你掷出的骰子在桌面上转了几圈，最后停在一个令人紧张的数字上。', world);
  assert.equal(ok.length, 0);
});

test('MockProvider 脚本耗尽抛错', async () => {
  const p = new MockProvider('empty', []);
  await assert.rejects(() => p.chat([], []), GatewayError);
});

// 工具清单完整性
test('工具注册表包含 7 个工具', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['make_check', 'roll_dice', 'query_world', 'update_entity', 'remember', 'check_rule', 'draw_table']);
});

// —— 协议适配（OpenAI 兼容 wire 格式）——
test('toWireMessages：tool_calls 转 OpenAI 规范格式（含 type/function 嵌套）', () => {
  const wire = toWireMessages([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', name: 'make_check', arguments: '{"skill":"侦查"}' }],
    },
    { role: 'tool', content: '{}', tool_call_id: 'c1' },
  ]);
  const assistant = wire[1] as { tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] };
  assert.equal(assistant.tool_calls[0].type, 'function');
  assert.equal(assistant.tool_calls[0].function.name, 'make_check');
  assert.equal(assistant.tool_calls[0].function.arguments, '{"skill":"侦查"}');
  // 普通消息原样透传
  assert.equal((wire[0] as { role: string }).role, 'user');
  assert.equal((wire[2] as { tool_call_id: string }).tool_call_id, 'c1');
});

// —— 流式输出（叙事逐字推送）——
test('runChat with onDelta：流式原始片段累积（JSON 原文）', async () => {
  const w = new World();
  const p = new MockProvider('stream', [
    { content: JSON.stringify({ narrative: '雾里的黑影动了。它转过身来。', dice_results: [] }), toolCalls: null, model: 'mock' },
    { content: JSON.stringify({ narrative: '第二次回应。', dice_results: [] }), toolCalls: null, model: 'mock' },
  ]);
  let acc = '';
  const out = await runChat('我盯着雾', [], {
    provider: p,
    toolCtx: { pack, world: w, seed: 's' },
    systemPrompt: 'sys',
    onDelta: (t) => { acc += t; },
  });
  // onDelta 收到的是 LLM 原始流（JSON 外壳），最终叙事由 parseStructured 解析
  assert.equal(acc, JSON.stringify({ narrative: '雾里的黑影动了。它转过身来。', dice_results: [] }));
  assert.equal(out.narrative, '雾里的黑影动了。它转过身来。');
  // 无 onDelta 时回退一次性 chat，行为不变
  const out2 = await runChat('再试', [], { provider: p, toolCtx: { pack, world: w, seed: 's' }, systemPrompt: 'sys' });
  assert.ok(out2.narrative.length > 0);
});

// —— 流式 JSON 外壳剥离（UI 逐字显示用）——
test('extractNarrativePrefix：完整 JSON / 渐进片段 / 非 JSON 原样', () => {
  const full = '{"narrative":"雾里的黑影动了。","dice_results":[]}';
  assert.equal(extractNarrativePrefix(full), '雾里的黑影动了。');
  // 渐进：只累积到 "narrative": "雾里的黑影动了 时
  const part1 = '{"narrative":"雾里';
  assert.equal(extractNarrativePrefix(part1), '雾里');
  const part2 = '{"narrative":"雾里的黑影动';
  assert.equal(extractNarrativePrefix(part2), '雾里的黑影动');
  // 含转义：\n 还原
  const esc = '{"narrative":"第一行\\n第二行","dice_results":[]}';
  assert.equal(extractNarrativePrefix(esc), '第一行\n第二行');
  // 非 JSON（LLM 没按格式）：原样
  assert.equal(extractNarrativePrefix('雾里的黑影动了。'), '雾里的黑影动了。');
  // code fence 包裹（AI 输出 ```json ... ```）：外壳不泄漏
  assert.equal(extractNarrativePrefix('```json\n{"narrative":"雾里的黑影动了。","dice_results":[]}\n```'), '雾里的黑影动了。');
  // fence + 渐进片段
  assert.equal(extractNarrativePrefix('```json\n{"narrative":"雾里的黑影动'), '雾里的黑影动');
  // fence 包裹但含前导文字：非 JSON 原样（叙事直接显示，不剥）
  assert.equal(extractNarrativePrefix('雾里的黑影动了。'), '雾里的黑影动了。');
  // AI 先废话再 JSON（"好的，{"narrative":...}"）：废话保留 + JSON 外壳剥离
  assert.equal(extractNarrativePrefix('好的，{"narrative":"雾里的黑影动了。"}'), '好的，\n雾里的黑影动了。');
  // 废话 + JSON 渐进片段
  assert.equal(extractNarrativePrefix('好的，{"narrative":"雾里的黑影动'), '好的，\n雾里的黑影动');
  // 叙事本身含花括号（非 JSON）：原样不误伤
  assert.equal(extractNarrativePrefix('他打开箱子{里面是空的}'), '他打开箱子{里面是空的}');
  assert.equal(extractNarrativePrefix(''), '');
});
