// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=path.join(root,'bin','kr.mjs');
const project=await mkdtemp(path.join(tmpdir(),'kura-velocity-'));
try{
  await mkdir(path.join(project,'src'),{recursive:true});
  await writeFile(path.join(project,'kura.json'),JSON.stringify({name:'velocity-test',entry:'src/main.kr'}));
  await writeFile(path.join(project,'src','main.kr'),`kernel fn hot(seed: int) -> int {
  let total: int = seed;
  for i in range(0, 1000) {
    total = total + i + seed;
  }
  return total;
}

fn main() -> int {
  return 0;
}
`);
  const first=spawnSync(process.execPath,[cli,'bench','--iterations','2000','--warmup','500','--json'],{cwd:project,encoding:'utf8'});
  assert.equal(first.status,0,first.stderr);
  const report=JSON.parse(first.stdout);
  assert.equal(report.engine,'Kura v1 Velocity Engine');
  assert.equal(report.function,'kernel');
  assert.equal(report.cache_hit,false);
  assert.ok(report.average_ms>=0);
  assert.ok(Number.isInteger(report.checksum));
  const second=spawnSync(process.execPath,[cli,'bench','--iterations','2000','--warmup','500','--json'],{cwd:project,encoding:'utf8'});
  assert.equal(second.status,0,second.stderr);
  assert.equal(JSON.parse(second.stdout).cache_hit,true);
}finally{await rm(project,{recursive:true,force:true});}
console.log('Kura Velocity Engine tests passed.');
