#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import {readFile,writeFile,mkdir,readdir,access} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {compile,diagnose,format} from '../lib/compiler.mjs';
import {bindgen as generateBindings} from '../lib/bindgen.mjs';
import {validateSql} from '../lib/sql.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args=process.argv.slice(2);const cmd=args.shift()||'help';
try{
  switch(cmd){
    case'--version':case'-V':case'version':console.log('Kura v1.0.0');break;
    case'help':help(args.includes('--all'));break;
    case'new':await createProject(args[0]);break;
    case'run':await runCommand(args);break;
    case'build':await buildCommand(args);break;
    case'check':await checkCommand(args);break;
    case'fmt':await fmtCommand(args);break;
    case'bindgen':await bindgenCommand(args);break;
    case'sql-check':await sqlCommand(args);break;
    case'gpu':await gpuCommand(args);break;
    case'doctor':await doctor();break;
    case'bench':await benchCommand(args);break;
    case'velocity':await velocityCommand(args);break;
    default:if(cmd.endsWith('.kr'))await runCommand([cmd,...args]);else throw new Error(`unknown command '${cmd}'. Run kr help.`);
  }
}catch(e){console.error(`error: ${e.message}`);process.exitCode=1;}

function help(all=false){
  console.log(`Kura v1.0.0\n\nUsage: kr <command>\n\n  new <name>        Create a project\n  run [file]        Compile and run Kura\n  build [file]      Build to JavaScript\n  check [file]      Parse and validate\n  fmt [file]        Format source\n  bindgen <header>  Generate C bindings\n  sql-check         Validate comptime SQL\n  gpu doctor|init   GPU support tools\n  doctor            Check installation\n  version           Print version${all?'\n\nVelocity Engine (experimental)\n  run --turbo       Optimized cached execution\n  build --turbo     Constant-folded compact build\n  bench [file]      Measure hot main() latency\n  velocity status   Show hidden engine status':''}`);
}
async function exists(p){try{await access(p);return true;}catch{return false;}}
function optionValue(argv,name,fallback){const i=argv.indexOf(name);return i>=0&&argv[i+1]!==undefined?argv[i+1]:fallback;}
function sourceArg(argv){return argv.find((x,i)=>!x.startsWith('-')&&(i===0||!['--iterations','--warmup','--target-ms','-o'].includes(argv[i-1])));}
async function projectEntry(input){if(input)return path.resolve(input);const config=path.resolve('kura.json');if(await exists(config)){const json=JSON.parse(await readFile(config,'utf8'));return path.resolve(json.entry||'src/main.kr');}for(const p of ['src/main.kr','main.kr'])if(await exists(p))return path.resolve(p);throw new Error('no Kura entry found; pass a .kr file or run kr new <name>');}
async function compileFile(file,options={}){const source=await readFile(file,'utf8');const result=compile(source,{file,...options});return {source,...result};}
function velocityHash(file,source,mode){return createHash('sha256').update('kura-v1-velocity-1\0').update(mode).update('\0').update(path.resolve(file)).update('\0').update(source).digest('hex').slice(0,24);}
async function cachedCompile(file,{mode='run',autoRun=true,exposeMain=false,exposeBenchmark=false}={}){
  const source=await readFile(file,'utf8');const hash=velocityHash(file,source,mode);const buildDir=path.resolve('.kura','velocity');const js=path.join(buildDir,`${mode}-${hash}.mjs`);let cached=await exists(js);let compileMs=0;
  if(!cached){const started=performance.now();const out=compile(source,{file,optimize:true,compact:true,autoRun,exposeMain,exposeBenchmark});compileMs=performance.now()-started;await mkdir(buildDir,{recursive:true});await writeFile(js,out.code,'utf8');}
  return {source,hash,js,cached,compileMs};
}
async function runCommand(argv){const file=await projectEntry(sourceArg(argv));await sqlGate(path.dirname(file));const turbo=argv.includes('--turbo')||process.env.KURA_VELOCITY==='1';let js;
  if(turbo){({js}=await cachedCompile(file,{mode:'run',autoRun:true}));}
  else{const out=await compileFile(file);const buildDir=path.resolve('.kura','run');await mkdir(buildDir,{recursive:true});js=path.join(buildDir,path.basename(file,'.kr')+'.mjs');await writeFile(js,out.code,'utf8');}
  const child=spawn(process.execPath,[js],{stdio:'inherit',cwd:process.cwd()});await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{process.exitCode=code??1;resolve();});});
}
async function buildCommand(argv){const file=await projectEntry(sourceArg(argv));await sqlGate(path.dirname(file));const turbo=argv.includes('--turbo')||argv.includes('--release');const out=await compileFile(file,{optimize:turbo,compact:turbo});const idx=argv.indexOf('-o');const outArg=idx>=0?argv[idx+1]:undefined;const dest=path.resolve(outArg||path.join('build',path.basename(file,'.kr')+'.mjs'));await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,out.code,'utf8');console.log(`built ${path.relative(process.cwd(),dest)}${turbo?' [velocity]':''}`);}
async function checkCommand(argv){const file=await projectEntry(sourceArg(argv));const source=await readFile(file,'utf8');const d=diagnose(source,{file});for(const m of d.messages)console.error(`${m.severity}: ${m.message}`);if(!d.ok)throw new Error('check failed');await sqlGate(path.dirname(file));console.log(`checked ${path.relative(process.cwd(),file)}`);}
async function fmtCommand(argv){const file=await projectEntry(sourceArg(argv));const source=await readFile(file,'utf8');const output=format(source,{file});if(argv.includes('--check')){if(output!==source)throw new Error(`${file} is not formatted`);console.log('format check passed');}else{await writeFile(file,output,'utf8');console.log(`formatted ${path.relative(process.cwd(),file)}`);}}
async function createProject(name){if(!name)throw new Error('usage: kr new <name>');const dir=path.resolve(name);await mkdir(path.join(dir,'src'),{recursive:true});const cfg=JSON.parse(await readFile(path.join(root,'templates','kura.json'),'utf8'));cfg.name=path.basename(dir);await writeFile(path.join(dir,'kura.json'),JSON.stringify(cfg,null,2)+'\n');await writeFile(path.join(dir,'src','main.kr'),await readFile(path.join(root,'templates','main.kr'),'utf8'));console.log(`created ${name}\nnext: cd ${name} && kr run`);}
async function bindgenCommand(argv){const header=sourceArg(argv);if(!header)throw new Error('usage: kr bindgen <header.h> [-o bindings.kr] [--library name]');const outIndex=argv.indexOf('-o');const libIndex=argv.indexOf('--library');const output=path.resolve(outIndex>=0?argv[outIndex+1]:header.replace(/\.[^.]+$/,'.kr'));const library=libIndex>=0?argv[libIndex+1]:'c';const code=generateBindings(await readFile(header,'utf8'),{library});await mkdir(path.dirname(output),{recursive:true});await writeFile(output,code,'utf8');console.log(`generated ${path.relative(process.cwd(),output)}`);}
async function findKr(dir){const out=[];if(!(await exists(dir)))return out;for(const e of await readdir(dir,{withFileTypes:true})){if(['node_modules','.git','.kura','build'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await findKr(p));else if(e.name.endsWith('.kr'))out.push(p);}return out;}
async function sqlGate(dir,explicit=false){const files=await findKr(dir);let found=false;const failures=[];const schemaPath=path.resolve(dir,'kura.sql.schema.json');for(const file of files){const source=await readFile(file,'utf8');if(/comptime\s*\(\s*["']sql:/.test(source))found=true;}if(!found&&!explicit)return;if(!(await exists(schemaPath)))throw new Error(`SQL schema not found: ${schemaPath}`);const schema=JSON.parse(await readFile(schemaPath,'utf8'));let count=0;for(const file of files){const result=validateSql(await readFile(file,'utf8'),schema);count+=result.count;failures.push(...result.errors.map(x=>`${file}: ${x}`));}if(failures.length)throw new Error('SQL validation failed\n'+failures.join('\n'));console.log(`comptime SQL verified: ${count} queries`);}
async function sqlCommand(argv){await sqlGate(path.resolve(argv[0]||'.'),true);}
async function gpuCommand(argv){const action=argv[0]||'doctor';if(action==='doctor'){console.log(`WebGPU: ${globalThis.navigator?.gpu?'available':'not available in this Node runtime'}`);console.log('Runtime module: @kura-lang/compiler/runtime/gpu');return;}if(action==='init'){const outIndex=argv.indexOf('-o');const output=path.resolve(outIndex>=0?argv[outIndex+1]:'src/kr_gpu_native.kr');await mkdir(path.dirname(output),{recursive:true});await writeFile(output,'extern "C" from "wgpu_native" {\n  fn wgpuCreateInstance(descriptor: Ptr<u8>) -> Ptr<u8>;\n}\n','utf8');console.log(`generated ${path.relative(process.cwd(),output)}`);return;}throw new Error('usage: kr gpu doctor | kr gpu init');}
async function doctor(){console.log(`Kura: v1.0.0\nNode: ${process.version}\nPlatform: ${process.platform} ${process.arch}\nInstall root: ${root}\nVelocity Engine: installed (hidden)\nStatus: ready`);}
async function velocityCommand(argv){const action=argv[0]||'status';if(action!=='status')throw new Error('usage: kr velocity status');console.log('Kura v1 Velocity Engine\nStatus: installed\nModes: constant folding, range-loop lowering, lazy runtime prelude, content-addressed compile cache, hot-function benchmark\nTarget: 0.1–1.0 ms per hot main() invocation\nNote: Node process startup is measured separately and is not included in the hot target.');}
async function benchCommand(argv){
  const file=await projectEntry(sourceArg(argv));const iterations=Math.max(10,Number(optionValue(argv,'--iterations','10000')));const warmup=Math.max(0,Number(optionValue(argv,'--warmup','2000')));const targetMs=Math.max(0.001,Number(optionValue(argv,'--target-ms','1')));if(!Number.isFinite(iterations)||!Number.isFinite(warmup)||!Number.isFinite(targetMs))throw new Error('invalid benchmark options');
  const artifact=await cachedCompile(file,{mode:'bench',autoRun:false,exposeMain:true,exposeBenchmark:true});const moduleUrl=`${pathToFileURL(artifact.js).href}?velocity=${artifact.hash}`;const loadStart=performance.now();const mod=await import(moduleUrl);const loadMs=performance.now()-loadStart;const fn=mod.__kr_bench||mod.__kr_main;if(typeof fn!=='function')throw new Error('benchmark requires kernel fn <name>(seed) or fn main()');const functionName=mod.__kr_bench?'kernel':'main';let sink=0;const consume=value=>{const numeric=Number(value);sink=((sink*33)^(Number.isFinite(numeric)?numeric:0))>>>0;};
  const first=fn(0);const asyncMode=Boolean(first&&typeof first.then==='function');consume(asyncMode?await first:first);
  if(asyncMode){for(let i=0;i<warmup;i++)consume(await fn(i));}else{for(let i=0;i<warmup;i++)consume(fn(i));}
  const batchCount=Math.min(50,iterations);const base=Math.floor(iterations/batchCount);let remainder=iterations%batchCount;const samples=[];let calls=0;
  for(let batch=0;batch<batchCount;batch++){const count=base+(remainder-->0?1:0);const started=performance.now();if(asyncMode){for(let i=0;i<count;i++)consume(await fn(calls+i));}else{for(let i=0;i<count;i++)consume(fn(calls+i));}const elapsed=performance.now()-started;samples.push(elapsed/count);calls+=count;}
  samples.sort((a,b)=>a-b);const average=samples.reduce((a,b)=>a+b,0)/samples.length;const percentile=p=>samples[Math.min(samples.length-1,Math.floor((samples.length-1)*p))];const p50=percentile(.50),p95=percentile(.95),minimum=samples[0],maximum=samples.at(-1);const status=average<=0.1?'LIMIT BREAK':average<=targetMs?'TARGET MET':'ABOVE TARGET';
  const report={engine:'Kura v1 Velocity Engine',file:path.relative(process.cwd(),file),function:functionName,mode:asyncMode?'async':'sync',iterations:calls,warmup,average_ms:average,p50_ms:p50,p95_ms:p95,min_ms:minimum,max_ms:maximum,compile_ms:artifact.compileMs,module_load_ms:loadMs,cache_hit:artifact.cached,target_ms:targetMs,checksum:sink,status};
  if(argv.includes('--json'))console.log(JSON.stringify(report,null,2));else console.log(`Kura v1 Velocity Engine\nFile: ${report.file}\nFunction: ${report.function}\nMode: ${report.mode}\nIterations: ${calls.toLocaleString()} (+ ${warmup.toLocaleString()} warmup)\nAverage: ${average.toFixed(6)} ms\nP50: ${p50.toFixed(6)} ms\nP95: ${p95.toFixed(6)} ms\nMinimum: ${minimum.toFixed(6)} ms\nMaximum: ${maximum.toFixed(6)} ms\nCompile: ${artifact.cached?'cache hit':artifact.compileMs.toFixed(3)+' ms'}\nModule load: ${loadMs.toFixed(3)} ms\nTarget: <= ${targetMs.toFixed(3)} ms hot invocation\nResult: ${status}`);
}
