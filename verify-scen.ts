// 验证：用户真实剧本包（2003选秀之夜）能否被 loadImportedScenario 加载（失败→回退内置雾港疑云）
import { PackStore, loadImportedScenario } from './src/packs.ts';
import { loadScenarioPack } from './src/scenario.ts';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const store = new PackStore('C:\\Users\\28917\\AppData\\Roaming\\dicekeeper\\packs');
const sc = loadImportedScenario(store, 'scen-msoi2yj5');
console.log('loadImportedScenario =', sc ? `OK name=${sc.name} hooks=${sc.hooks.length} firstHook=${String(sc.hooks[0]).slice(0, 30)}` : 'NULL（回退内置！）');

// 对比内置
const builtin = loadScenarioPack(join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios', 'fogharbor.yaml'));
console.log('内置雾港 firstHook =', String(builtin.hooks?.[0] ?? '').slice(0, 30));
process.exit(sc ? 0 : 2);
