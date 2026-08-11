// test/campaign.test.ts — 存储层（SQLite 后端）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CampaignStore, toChatMessages, trimHistoryToWindow } from '../src/campaign.ts';
import { loadRulePack } from '../src/rules.ts';
import { generateCharacter } from '../src/chargen.ts';
import { World } from '../src/world.ts';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const pack = loadRulePack(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules', 'coc7e.yaml'));

function makeStore(): { store: CampaignStore; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dk-test-'));
  const dbPath = join(dir, 'test.db');
  return { store: new CampaignStore(dbPath), dbPath, dir };
}

test('建团：SQLite 文件/表就位，角色入库', () => {
  const { store, dbPath, dir } = makeStore();
  const c = generateCharacter(pack, { seed: 'c1' });
  const campaign = store.createCampaign({ name: '旧港疑云', rulePackId: 'coc7e', characters: [c] });
  assert.ok(campaign.id.length >= 6);
  assert.ok(existsSync(dbPath));
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as unknown as { name: string }[];
  const names = tables.map((t) => t.name).sort();
  assert.deepEqual(names, ['campaigns', 'changes', 'characters', 'dice_rolls', 'entities', 'lore_entries', 'memory_facts', 'messages', 'relations', 'sessions']);
  assert.equal(store.loadCampaign(campaign.id).characters.length, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('会话：开始→追加消息→读取→结束', () => {
  const { store, dir } = makeStore();
  const campaign = store.createCampaign({ name: '团', rulePackId: 'coc7e', characters: [] });
  const s1 = store.startSession(campaign.id);
  const s2 = store.startSession(campaign.id);
  assert.notEqual(s1.id, s2.id);
  assert.equal(store.listSessions(campaign.id).length, 2);

  store.appendMessage(campaign.id, s1.id, { role: 'user', content: '我推开酒馆的门' });
  store.appendMessage(campaign.id, s1.id, { role: 'assistant', content: '门吱呀一声…', diceResults: ['d1'] });
  const msgs = store.getMessages(campaign.id, s1.id);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[1].diceResults, ['d1']);
  assert.ok(msgs[0].created_at);
  assert.ok(msgs[0].id! > 0); // SQLite 自增 id

  const ended = store.endSession(campaign.id, s1.id, '埃德加出现');
  assert.ok(ended.ended_at);
  assert.equal(ended.summary, '埃德加出现');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('持久化：World 落库 + 新连接恢复全部数据', () => {
  const { store, dbPath, dir } = makeStore();
  const c = generateCharacter(pack, { seed: 'persist' });
  const campaign = store.createCampaign({ name: '持久化测试', rulePackId: 'coc7e', characters: [c] });
  const s = store.startSession(campaign.id);
  store.appendMessage(campaign.id, s.id, { role: 'user', content: '测试' });

  // World 落库
  const w = new World();
  const e = w.addEntity('npc', '埃德加', { 欠赌债: true }, ['老船长']);
  w.addFact('埃德加欠赌债', [e.id], 'high');
  w.addDice('d100', 37, [37], '侦查', 'ai', 's');
  w.saveToDb(store.db, campaign.id);

  // 新连接重载（模拟重启）
  const store2 = new CampaignStore(dbPath);
  const c2 = store2.loadCampaign(campaign.id);
  assert.equal(c2.characters[0].name, c.name);
  assert.equal(store2.getMessages(campaign.id, s.id)[0].content, '测试');
  const w2 = World.loadFromDb(store2.db, campaign.id);
  assert.equal(w2.entities.size, 1);
  assert.equal(w2.entities.get(e.id)!.name, '埃德加');
  assert.equal(w2.entities.get(e.id)!.aliases?.[0], '老船长');
  assert.equal(w2.facts.length, 1);
  assert.equal(w2.facts[0].importance, 'high');
  assert.equal(w2.diceLog.length, 1);
  assert.equal(w2.diceLog[0].result, 37);
  assert.equal(w2.changes.length, 2); // entity_add + fact_add（掷骰走 dice_rolls 审计表，不进 changes）
  store.close(); store2.close();
  rmSync(dir, { recursive: true, force: true });
});

test('替换 PC 角色卡（车卡重骰）：删旧插新且保留战役', () => {
  const { store, dir } = makeStore();
  const c = generateCharacter(pack, { seed: 'old', name: '老调查员' });
  const campaign = store.createCampaign({ name: '团', rulePackId: 'coc7e', characters: [c] });
  const fresh = generateCharacter(pack, { seed: 'new', name: '老调查员' }); // 保留名字
  store.replaceCharacter(campaign.id, fresh);
  const loaded = store.loadCampaign(campaign.id);
  assert.equal(loaded.characters.length, 1);
  assert.equal(loaded.characters[0].name, '老调查员');
  assert.notEqual(loaded.characters[0].created_seed, 'old');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('历史转 ChatMessage：工具消息带 tool_call_id', () => {  const { store, dir } = makeStore();
  const campaign = store.createCampaign({ name: '团', rulePackId: 'coc7e', characters: [] });
  const s = store.startSession(campaign.id);
  store.appendMessage(campaign.id, s.id, { role: 'user', content: 'a' });
  store.appendMessage(campaign.id, s.id, {
    role: 'assistant', content: '',
    tool_calls: [{ id: 'c1', name: 'make_check', arguments: '{"skill":"侦查"}' }],
  });
  store.appendMessage(campaign.id, s.id, { role: 'tool', content: '{"verdict":"失败"}', tool_call_id: 'c1' });
  const chat = toChatMessages(store.getMessages(campaign.id, s.id));
  assert.equal(chat.length, 3);
  const tool = chat[2] as { role: 'tool'; tool_call_id: string };
  assert.equal(tool.tool_call_id, 'c1');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('L1 窗口截断：保留最近 30 轮，工具链完整（§3.3）', () => {
  // 构造 35 轮（user+assistant 交替），其中 10 轮带工具调用（assistant 带 tool_calls + tool 消息）
  const msgs: StoredMessage[] = [];
  for (let r = 1; r <= 35; r++) {
    msgs.push({ id: r * 10, role: 'user', content: `行动${r}` });
    if (r % 3 === 0) {
      msgs.push({ id: r * 10 + 1, role: 'assistant', content: '', tool_calls: [{ id: `c${r}`, name: 'make_check', arguments: '{}' }] });
      msgs.push({ id: r * 10 + 2, role: 'tool', content: '{}', tool_call_id: `c${r}` });
    }
    msgs.push({ id: r * 10 + 3, role: 'assistant', content: `回复${r}` });
  }
  const win = trimHistoryToWindow(msgs);
  // 只保留最近 30 轮（早期 5 轮被截掉）
  assert.equal(win.filter((m) => m.role === 'user').length, 30);
  assert.equal(win[0].role, 'user');
  assert.equal(win[0].content, '行动6');
  // 窗口内无悬挂 tool（tool 必须紧跟带 tool_calls 的 assistant）
  for (let i = 0; i < win.length; i++) {
    if (win[i].role === 'tool') {
      const prev = win[i - 1];
      assert.ok(prev && prev.role === 'assistant' && prev.tool_calls?.length, `tool 消息 ${i} 前应有 assistant tool_calls`);
    }
  }
  // 窗口内 assistant(tool_calls) 的 tool 消息都在窗口内
  const lastTcIdx = win.findLastIndex((m) => m.tool_calls?.length);
  assert.ok(lastTcIdx >= 0);
  assert.ok(win[lastTcIdx + 1]?.role === 'tool', 'tool_calls 后紧跟 tool 结果');
  // 消息数不足 30 轮时不截断
  const small = msgs.slice(0, 20);
  assert.equal(trimHistoryToWindow(small).length, small.length);
});

test('删除战役：级联清理全部关联数据', () => {
  const { store, dir } = makeStore();
  const c = generateCharacter(pack, { seed: 'del' });
  const campaign = store.createCampaign({ name: '待删除', rulePackId: 'coc7e', characters: [c] });
  const s = store.startSession(campaign.id);
  store.appendMessage(campaign.id, s.id, { role: 'user', content: 'x' });
  const w = new World();
  w.addEntity('npc', '埃德加', {});
  w.addFact('事实', ['e1'], 'high');
  w.saveToDb(store.db, campaign.id);
  // 删除
  store.deleteCampaign(campaign.id);
  assert.throws(() => store.loadCampaign(campaign.id), /战役不存在/);
  assert.equal(store.listCampaigns().length, 0);
  // 关联表也清空
  assert.equal((store.db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c, 0);
  assert.equal((store.db.prepare('SELECT COUNT(*) c FROM entities').get() as { c: number }).c, 0);
  assert.equal((store.db.prepare('SELECT COUNT(*) c FROM dice_rolls').get() as { c: number }).c, 0);
  // 删除不存在的报错
  assert.throws(() => store.deleteCampaign('nope'), /战役不存在/);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('错误路径：不存在的战役/会话报错', () => {
  const { store, dir } = makeStore();
  assert.throws(() => store.loadCampaign('nope'), /战役不存在/);
  assert.throws(() => store.startSession('nope'), /战役不存在/);
  assert.throws(() => store.appendMessage('nope', 'x', { role: 'user', content: 'x' }), /会话不存在/);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('变更回滚：entity_update 恢复 before 快照（§11.5）', () => {
  const { store, dir } = makeStore();
  const campaign = store.createCampaign({ name: '回滚测试', rulePackId: 'coc7e', characters: [generateCharacter(pack, { seed: 'rb' })] });
  const w = new World();
  const e = w.addEntity('npc', '埃德加', { traits: '原始描述', 好感: 10 });
  w.updateEntity(e.id, { 好感: 60, 受伤: true });
  const changeId = w.changes[w.changes.length - 1].id;
  assert.equal(w.entities.get(e.id)!.data['好感'], 60);
  // 回滚 → 恢复 before 快照
  assert.equal(w.rollbackChange(changeId), true);
  assert.equal(w.entities.get(e.id)!.data['好感'], 10);
  assert.equal(w.entities.get(e.id)!.data['受伤'], undefined);
  // 回滚操作本身入日志（manual，不可再回滚）
  assert.equal(w.changes[w.changes.length - 1].kind, 'manual');
  assert.equal(w.rollbackChange(w.changes[w.changes.length - 1].id), false);
  // 落库后恢复一致
  w.saveToDb(store.db, campaign.id);
  const w2 = World.loadFromDb(store.db, campaign.id);
  assert.equal(w2.entities.get(e.id)!.data['好感'], 10);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('变更回滚：entity_add / fact_add 删除对应记录', () => {
  const w = new World();
  const e = w.addEntity('npc', '马修', {});
  const f = w.addFact('马修欠赌债', [e.id], 'high');
  const addChange = w.changes.find((c) => c.target === e.id && c.kind === 'entity_add')!;
  const factChange = w.changes.find((c) => c.target === f.id && c.kind === 'fact_add')!;
  assert.equal(w.rollbackChange(factChange.id), true);
  assert.equal(w.facts.length, 0);
  assert.equal(w.rollbackChange(addChange.id), true);
  assert.equal(w.entities.has(e.id), false);
});

test('记忆审计可修改：updateFact / deleteFact / deleteRelation / 人工 addFact', () => {
  const w = new World();
  const a = w.addEntity('npc', '甲', {});
  const b = w.addEntity('npc', '乙', {});
  const f = w.addFact('甲乙是旧识', [a.id, b.id], 'normal');
  const r = w.addRelation(a.id, b.id, '认识', '码头认识的');
  // 改 importance + 事实文本
  const u = w.updateFact(f.id, { importance: 'high', fact: '甲乙是多年的旧识' });
  assert.equal(u?.importance, 'high');
  assert.equal(u?.fact, '甲乙是多年的旧识');
  // 删除
  assert.equal(w.deleteFact(f.id), true);
  assert.equal(w.deleteFact(f.id), false);
  assert.equal(w.facts.length, 0);
  assert.equal(w.deleteRelation(r.id), true);
  assert.equal(w.relations.length, 0);
  // 人工添加（actor=player 记录）
  w.addFact('玩家标记的重点', [], 'high', 'player');
  assert.equal(w.facts[0].importance, 'high');
  assert.equal(w.changes[w.changes.length - 1].actor, 'player');
});
