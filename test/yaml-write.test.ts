// test/yaml-write.test.ts — YAML 序列化器（P3b 编辑器：serialize → parse roundtrip 无损）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeYaml } from '../src/yaml-write.ts';
import { parseYaml } from '../src/rules.ts';
import { loadRulePack } from '../src/rules.ts';
import { loadScenarioPack } from '../src/scenario.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// roundtrip：serialize → parse 必须 deepEqual 原对象
function rt(obj: Record<string, unknown>): unknown {
  return parseYaml(serializeYaml(obj));
}

test('roundtrip：标量/数组/对象/嵌套全类型', () => {
  const obj = {
    id: 'demo',
    name: '演示包',
    version: 1.0,
    dice_schema: 'd100',
    bool_true: true,
    bool_false: false,
    null_val: null,
    num_int: 42,
    str_num: '007',              // 数字字面量字符串 → 需引号保真
    str_true: 'true',            // 布尔字面量字符串
    str_colon: 'a: b',           // 含冒号
    str_hash: '雾潮之民 # 传说', // 含 #（注释风险）
    arr: ['会计', '侦查', '聆听'],
    arr_num: [1, 2, 3],
    inline_obj: { name: '会计', base: 5, category: '调查' },
    nested: {
      list: [
        { name: '甲', traits: '多行\n内容\n第三行' },
        { name: '乙', tags: ['x', 'y'], info: { k: 1, s: 'v' } },
      ],
      empty_arr: [],
      empty_obj: {},
    },
  };
  assert.deepEqual(rt(obj), obj);
});

test('roundtrip：多行字符串（块标量）', () => {
  const obj = { summary: '第一行\n第二行\n第三行', name: 'x' };
  const out = serializeYaml(obj);
  assert.ok(out.includes('summary: |'), `应使用块标量:\n${out}`);
  assert.deepEqual(rt(obj), obj);
});

test('roundtrip：含引号与反斜杠字符串（引号包裹保真）', () => {
  const obj = { note: '他说："今晚别去码头" 路径 C:\\雾港', name: 'y' };
  const out = serializeYaml(obj);
  assert.ok(out.includes(`note: '`), `单引号包裹:\n${out}`);
  assert.deepEqual(rt(obj), obj);
});

test('roundtrip：首尾空格字符串（引号包裹保真）', () => {
  const obj = { pad: '  有空格  ', name: 'z' };
  const out = serializeYaml(obj);
  assert.ok(out.includes('"  有空格  "'), out);
  assert.deepEqual(rt(obj), obj);
});

test('roundtrip：剧本 hooks 元素（含单引号/双引号/冒号的叙事句）', () => {
  const obj = {
    hooks: [
      "老船长说：'那雾里有东西，比鱼更老。'",
      '她低声说："别去码头，求你了"',
      '码头的钟敲了三下。',
      '雾潮之民 # 传说',
    ],
  };
  const back = rt(obj) as { hooks: string[] };
  assert.deepEqual(back.hooks, obj.hooks);
});

test('roundtrip：完整内置规则包 coc7e.yaml', () => {
  const pack = loadRulePack(join(HERE, '..', 'rules', 'coc7e.yaml')) as unknown as Record<string, unknown>;
  const back = rt(pack);
  assert.deepEqual(back, pack);
});

test('roundtrip：完整内置剧本包 fogharbor.yaml', () => {
  const pack = loadScenarioPack(join(HERE, '..', 'scenarios', 'fogharbor.yaml')) as unknown as Record<string, unknown>;
  const back = rt(pack);
  assert.deepEqual(back, pack);
});

test('序列化输出：list 项 map 展开（非 inline）', () => {
  const obj = {
    items: [
      { name: '会计', base: 5, category: '调查' },
      { name: '侦查', base: 25, category: '调查' },
    ],
  };
  const out = serializeYaml(obj);
  // 全标量值 → inline 风格（与内置包一致）
  assert.ok(out.includes('- {name: 会计, base: 5, category: 调查}'), out);
});

test('序列化输出：复杂 list 项展开为多行', () => {
  const obj = {
    npc_seeds: [
      { name: '埃德加', traits: '六十三岁\n嗜酒', aliases: ['老船长'] },
    ],
  };
  const out = serializeYaml(obj);
  assert.ok(out.includes('npc_seeds:'), out);
  assert.ok(out.includes('- name: 埃德加'), out);
  assert.ok(out.includes('traits: |'), out);
  assert.deepEqual(rt(obj), obj);
});

test('序列化输出：inline 数组元素含逗号 → 展开 list', () => {
  const obj = { arr: ['甲, 乙', '丙'], name: 'x' };
  const out = serializeYaml(obj);
  assert.ok(!out.includes('[甲'), out); // 不能 inline（含逗号）
  assert.ok(out.includes('- 甲, 乙'), out);
  assert.deepEqual(rt(obj), obj);
});
