#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeAsyncStateMachines, createNativeAsyncPlan, KuraExecutor, AsyncChannel, TaskGroup, sleep } from '../lib/async-runtime.mjs';
const args=process.argv.slice(2); const command=args.shift()??'help'; const json=args.includes('--json');
try {
  if (command==='help'||command==='--help') { console.log('kr-async manifest <file.kr> [--json]\nkr-async native-plan <file.kr>\nkr-async smoke'); process.exit(0); }
  if (command==='smoke') { const executor=new KuraExecutor({maxConcurrency:2}); const channel=new AsyncChannel(1); const group=new TaskGroup({executor}); group.spawn(async()=>{await sleep(2);await channel.send(40);return 1}); group.spawn(async()=>{const item=await channel.receive();return item.value+2}); const values=await group.wait(); channel.close(); await executor.shutdown(); console.log(JSON.stringify({ok:true,values})); }
  else { const file=args.shift(); if(!file) throw new Error('Source file required.'); const source=await readFile(resolve(file),'utf8'); const result=command==='native-plan'?createNativeAsyncPlan(source,{file}):analyzeAsyncStateMachines(source,{file}); console.log(json?JSON.stringify(result,null,2):command==='native-plan'?result.llvm:`Async functions: ${result.machines.length}\nAwait points: ${result.totalAwaitPoints}`); }
} catch(error){console.error(error.stack??error.message);process.exitCode=1;}
