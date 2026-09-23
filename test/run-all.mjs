/**
 * run-all.mjs — 跑全部测试
 */
import { spawnSync } from 'node:child_process';
const files = ['test/dsp.test.mjs', 'test/pipeline.test.mjs', 'test/lessons.test.mjs'];
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [f], { stdio: 'inherit' });
  if (r.status !== 0) bad++;
}
console.log(bad ? `\n✗ ${bad} 个测试文件失败` : '\n✓ 全部测试通过');
process.exit(bad ? 1 : 0);
