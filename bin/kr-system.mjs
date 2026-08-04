#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0

import {readFile,writeFile} from 'node:fs/promises';
import process from 'node:process';
import {KuraNativeCompileError,compileNativeSystemSource,describeNativeLayout,parseNativeSystemSource} from '../lib/system-native.mjs';

function usage(){return`Kura native system compiler

Usage:
  kr-system check <file.kr> [--target <triple>]
  kr-system emit-llvm <file.kr> [-o <file.ll>] [--target <triple>]
  kr-system layout <file.kr> [--json] [--target <triple>]
  kr-system ast <file.kr>

First supported target: x86_64-unknown-none`}
function parseArguments(argv){const positional=[],options={output:null,target:null,json:false,help:false};for(let index=0;index<argv.length;index++){const argument=argv[index];if(argument==='-o'||argument==='--output'){options.output=argv[++index];if(!options.output)throw new Error(`${argument} requires a path.`);continue;}if(argument==='--target'){options.target=argv[++index];if(!options.target)throw new Error('--target requires a triple.');continue;}if(argument==='--json'){options.json=true;continue;}if(argument==='-h'||argument==='--help'){options.help=true;continue;}positional.push(argument);}return{command:positional[0],file:positional[1],options};}
function renderError(error){if(error instanceof KuraNativeCompileError){const hint=error.hint?`\nhint: ${error.hint}`:'';return`${error.file}:${error.line}:${error.column}: ${error.code}: ${error.message}${hint}`;}return error?.stack??String(error);}
async function main(){const{command,file,options}=parseArguments(process.argv.slice(2));if(options.help||!command){console.log(usage());return;}if(!file)throw new Error(`${command} requires a .kr source file.`);const source=await readFile(file,'utf8'),compileOptions={file,target:options.target??undefined};switch(command){case'check':compileNativeSystemSource(source,compileOptions);console.log(`${file}: native system check passed`);return;case'emit-llvm':{const llvm=compileNativeSystemSource(source,compileOptions);if(options.output){await writeFile(options.output,llvm,'utf8');console.log(`wrote ${options.output}`);}else{process.stdout.write(llvm);if(!llvm.endsWith('\n'))process.stdout.write('\n');}return;}case'layout':{const layout=describeNativeLayout(source,compileOptions);if(options.json){console.log(JSON.stringify(layout,null,2));return;}console.log(`target: ${layout.target}`);for(const struct of layout.structs){console.log(`${struct.name}: size=${struct.size}, align=${struct.alignment}${struct.packed?', packed':''}`);for(const field of struct.fields)console.log(`  +${field.offset} ${field.name}: ${field.type} (size=${field.size}, align=${field.alignment})`);}return;}case'ast':console.log(JSON.stringify(parseNativeSystemSource(source,compileOptions),null,2));return;default:throw new Error(`Unknown command '${command}'.\n\n${usage()}`);}}
main().catch(error=>{console.error(renderError(error));process.exitCode=1;});
