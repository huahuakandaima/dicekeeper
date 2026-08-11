// test/rules.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRulePack, parseYaml, RulePackError, validateRulePack } from '../src/rules.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(HERE, '..', 'rules');

test('加载 CoC 7e 规则包成功', () => {
  const pack = loadRulePack(join(RULES_DIR, 'coc7e.yaml'));
  assert.equal(pack.id, 'coc7e');
  assert.equal(pack.name, '克苏鲁的呼唤 7 版');
  assert.equal(pack.dice_schema, 'd100');
  assert.ok(pack.character_sheet.attributes.includes('STR'));
  assert.ok(pack.character_sheet.attributes.includes('SIZ'));
});

test('技能表完整且含 base 值', () => {
  const pack = loadRulePack(join(RULES_DIR, 'coc7e.yaml'));
  assert.ok(pack.character_sheet.skills.length >= 40);
  const spot = pack.character_sheet.skills.find((s) => s.name === '侦查');
  assert.ok(spot);
  assert.equal(spot.base, 25);
  assert.equal(spot.category, '调查');
});

test('check_rules 五档表达式完整', () => {
  const pack = loadRulePack(join(RULES_DIR, 'coc7e.yaml'));
  for (const key of ['extreme', 'hard', 'normal', 'crit_fail']) {
    assert.ok(pack.check_rules[key], `缺少 check_rules.${key}`);
    assert.equal(typeof pack.check_rules[key], 'string');
  }
});

test('chargen 段：属性生成法 + 衍生公式 + 年龄修正 + 职业', () => {
  const pack = loadRulePack(join(RULES_DIR, 'coc7e.yaml'));
  const cg = pack.chargen!;
  assert.ok(cg.attribute_methods!.length >= 2);
  assert.equal(cg.attribute_methods![0].formula, '3d6*5');
  assert.equal(cg.derived_formulas!.HP, '(SIZ+CON)/10');
  assert.ok(cg.age_adjustments!.length >= 6);
  assert.ok(cg.occupations!.length >= 4);
  const doc = cg.occupations!.find((o) => o.name === '医生');
  assert.ok(doc && doc.skills.includes('医学'));
});

test('块标量 rules_reference 保留换行', () => {
  const pack = loadRulePack(join(RULES_DIR, 'coc7e.yaml'));
  assert.ok(pack.rules_reference!.includes('奖励骰'));
  assert.ok(pack.rules_reference!.includes('\n'));
});

test('mini YAML：inline 数组/对象/注释/嵌套', () => {
  const obj = parseYaml(`
# 顶层注释
a: 1
b: [x, y, 3]
c: {name: 侦查, base: 25}
list:
  - {name: 医生, skills: [医学, 急救], points: "EDU*2+INT*2"}
  - 简单项
nested:
  child:
    deep: ok
`) as Record<string, unknown>;
  assert.equal(obj.a, 1);
  assert.deepEqual(obj.b, ['x', 'y', 3]);
  assert.deepEqual(obj.c, { name: '侦查', base: 25 });
  const list = obj.list as unknown[];
  assert.deepEqual(list[0], { name: '医生', skills: ['医学', '急救'], points: 'EDU*2+INT*2' });
  assert.equal(list[1], '简单项');
  assert.equal((obj.nested as { child: { deep: string } }).child.deep, 'ok');
});

test('非法 YAML：坏缩进报错', () => {
  assert.throws(() => parseYaml('a: 1\n  b: 2'), RulePackError);
});

test('校验：缺必填字段报错', () => {
  assert.throws(() => validateRulePack({ name: 'x' } as unknown as Record<string, unknown>), /id/);
  assert.throws(() => validateRulePack({ id: 'x', name: 'n', version: '1', dice_schema: 'd20' } as unknown as Record<string, unknown>), /character_sheet/);
});

test('校验：非法 DSL 表达式拒绝', () => {
  const bad = {
    id: 'x', name: 'n', version: '1', dice_schema: 'd100',
    character_sheet: { attributes: ['A'], skills: [] },
    check_rules: { normal: 'd100 <=' },
  };
  assert.throws(() => validateRulePack(bad as unknown as Record<string, unknown>), /表达式非法/);
});

// 技能按钮类型（action：check/narrative/none）——规则包"编辑时配置按钮"（2026-08-11 用户需求）
test('校验：skills action 枚举合法值接受、非法值拒绝、缺省视为 check', () => {
  const base = {
    id: 'x', name: 'n', version: '1', dice_schema: 'd100',
    character_sheet: { attributes: ['A'], skills: [] },
    check_rules: { normal: 'd100 <= SKILL' },
  };
  // 合法：check/narrative/none 混用
  const ok = validateRulePack({
    ...base,
    character_sheet: {
      attributes: ['A'],
      skills: [
        { name: '检定技能', base: 50, category: 'c1' },
        { name: '叙事技能', base: 40, category: 'c1', action: 'narrative' },
        { name: '隐藏技能', base: 30, category: 'c1', action: 'none' },
        { name: '显式检定', base: 20, category: 'c1', action: 'check' },
      ],
    },
  } as unknown as Record<string, unknown>);
  assert.equal(ok.character_sheet.skills[0].action, undefined); // 缺省不填
  assert.equal(ok.character_sheet.skills[1].action, 'narrative');
  assert.equal(ok.character_sheet.skills[2].action, 'none');
  // 非法枚举拒绝
  assert.throws(() => validateRulePack({
    ...base,
    character_sheet: { attributes: ['A'], skills: [{ name: 'x', base: 10, category: 'c', action: 'roll' }] },
  } as unknown as Record<string, unknown>), /action 非法/);
});
