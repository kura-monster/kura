#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createUserspaceManifest, createUserspaceAssembly, createUserspaceKernelSource, createCompleteUserspaceKernelSource, buildUserspaceKernel } from '../lib/system-userspace.mjs';
const args=process.argv.slice(2);const command=args.shift()??'help';const value=name=>{const i=args.indexOf(name);if(i<0)return null;const v=args[i+1];args.splice(i,2);return v;};const flag=name=>{const i=args.indexOf(name);if(i<0)return false;args.splice(i,1);return true;};const output=value('-o')??value('--output');
try{
if(command==='help'||command==='--help'){console.log('kr-userspace manifest\nkr-userspace emit -o userspace.kr\nkr-userspace kernel -o kernel.kr\nkr-userspace assembly -o userspace.S\nkr-userspace build --out-dir build/userspace [--dry-run]');process.exit(0);}
if(command==='manifest')console.log(JSON.stringify(createUserspaceManifest(),null,2));
else if(['emit','kernel','assembly'].includes(command)){const content=command==='emit'?createUserspaceKernelSource():command==='kernel'?createCompleteUserspaceKernelSource():createUserspaceAssembly();const file=resolve(output??(command==='assembly'?'kura-userspace.S':command==='kernel'?'kernel-userspace.kr':'userspace.kr'));await mkdir(dirname(file),{recursive:true});await writeFile(file,content);console.log(file);}
else if(command==='build'){const outDir=value('--out-dir')??'build/userspace';const result=await buildUserspaceKernel(null,{outDir,dryRun:flag('--dry-run')});console.log(JSON.stringify({elf:result.plan.elf,userspaceObject:result.plan.userspaceObject,dryRun:Boolean(result.userspaceResult.step.dryRun)},null,2));}
else throw new Error(`Unknown command ${command}.`);
}catch(error){console.error(error.stack??error.message);process.exitCode=1;}
