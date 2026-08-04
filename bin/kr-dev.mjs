#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { IncrementalCompilerCache, createDwarfMetadata, KuraProfiler, AddressSanitizerModel, RaceDetectorModel } from '../lib/developer-toolchain.mjs';
const args=process.argv.slice(2); const command=args.shift()??'help';
try {
  if(command==='help'||command==='--help'){console.log('kr-dev cache-stats [directory]\nkr-dev cache-clear [directory]\nkr-dev dwarf <file.kr>\nkr-dev diagnose');process.exit(0);}
  if(command==='cache-stats'||command==='cache-clear'){const cache=new IncrementalCompilerCache(args[0]??'.kura/cache');await cache.load();if(command==='cache-clear'){await cache.clear();console.log('cache cleared');}else console.log(JSON.stringify(cache.stats(),null,2));}
  else if(command==='dwarf'){const file=args.shift();if(!file)throw new Error('Source file required.');const source=await readFile(resolve(file),'utf8');const functions=[...source.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(match=>({name:match[1],line:source.slice(0,match.index).split('\n').length}));console.log(createDwarfMetadata({file:resolve(file),directory:process.cwd(),functions}).text);}
  else if(command==='diagnose'){const profiler=new KuraProfiler();const event=profiler.begin('diagnose');const asan=new AddressSanitizerModel();const address=asan.allocate(8);asan.write(address,[1]);const race=new RaceDetectorModel();race.access({thread:1,address,write:true});race.access({thread:2,address,write:false});profiler.end(event);console.log(JSON.stringify({profiler:profiler.report(),asan:asan.snapshot(),race:race.report()},null,2));}
  else throw new Error(`Unknown command ${command}.`);
}catch(error){console.error(error.stack??error.message);process.exitCode=1;}
