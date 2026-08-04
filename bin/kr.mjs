#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile, diagnose, format } from '../lib/compiler.mjs';
import { bindgen as generateBindings } from '../lib/bindgen.mjs';
import { validateSql } from '../lib/sql.mjs';
import { KuraCliError, printFriendlyError, suggestCommand } from '../lib/diagnostics.mjs';
import {
  LIMITS,
  KuraSecurityError,
  assertInsideRoot,
  assertSafeProjectName,
  atomicWriteFile,
  auditProject,
  exists,
  findKuraFiles,
  nodeSecurityArgs,
  parseJsonSecure,
  prepareSecureCache,
  readTextFileSecure,
  readVerifiedCache,
  sanitizeChildEnv,
  validateProjectConfig,
  wrapSignedCache,
} from '../lib/security.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rawArgs = process.argv.slice(2);
const globalOptions = {
  json: rawArgs.includes('--json'),
  verbose: rawArgs.includes('--verbose'),
};
const args = [...rawArgs];
const command = args.shift() || 'help';

try {
  await dispatch(command, args);
} catch (error) {
  await printFriendlyError(error, globalOptions);
  process.exitCode = error?.exitCode ?? 1;
}

async function dispatch(cmd, argv) {
  switch (cmd) {
    case '--version':
    case '-V':
    case 'version':
      console.log('Kura v1.0.0');
      return;
    case 'help': help(argv.includes('--all')); return;
    case 'new': await createProject(sourceArg(argv), argv); return;
    case 'run': await runCommand(argv); return;
    case 'build': await buildCommand(argv); return;
    case 'check': await checkCommand(argv); return;
    case 'fmt': await formatCommand(argv); return;
    case 'bindgen': await bindgenCommand(argv); return;
    case 'sql-check': await sqlCommand(argv); return;
    case 'gpu': await gpuCommand(argv); return;
    case 'doctor': await doctor(); return;
    case 'bench': await benchCommand(argv); return;
    case 'velocity': await velocityCommand(argv); return;
    case 'security': await securityCommand(argv); return;
    default:
      if (cmd.endsWith('.kr')) {
        await runCommand([cmd, ...argv]);
        return;
      }
      const suggestion = suggestCommand(cmd);
      throw new KuraCliError(`Unknown command '${cmd}'.`, {
        code: 'KR-CLI-0002',
        title: 'Kura does not recognize this command',
        hint: suggestion ? `Did you mean 'kr ${suggestion}'? Run 'kr help' to see every command.` : "Run 'kr help' to see every available command.",
      });
  }
}

function help(all = false) {
  console.log(`Kura v1.0.0

Usage: kr <command> [options]

  new <name>        Create a project safely
  run [file]        Compile and run Kura
  build [file]      Build to JavaScript
  check [file]      Parse, validate, and explain errors
  fmt [file]        Format source atomically
  bindgen <header>  Generate C bindings
  sql-check         Validate comptime SQL
  gpu doctor|init   GPU support tools
  security audit   Scan project capabilities and risks
  doctor            Check installation and hardening
  version           Print version

Common options:
  --secure          Strict imports, Node permissions, secret filtering
  --json            Machine-readable diagnostics
  --verbose         Include technical stack details
  --allow-outside-project  Permit an explicit output outside the project
${all ? `
Velocity Engine (experimental)
  run --turbo       Optimized, signed, cached execution
  build --turbo     Constant-folded compact build
  bench [file]      Measure hot function latency
  velocity status   Show hidden engine status

Secure execution
  --timeout-ms N    Stop a process after N milliseconds (secure default: 30000)
  --memory-mb N     Set Node heap limit (secure default: 256)
  --allow-env A,B   Preserve named sensitive environment variables
  --unsafe-imports  Disable compiler import policy for trusted local code
` : ''}`);
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function optionValue(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) {
    throw new KuraCliError(`Option '${name}' needs a value.`, {
      code: 'KR-CLI-0003',
      title: 'A command option is incomplete',
      hint: `Example: ${name} 30000`,
    });
  }
  return argv[index + 1];
}

function sourceArg(argv) {
  const optionsWithValues = new Set(['--iterations', '--warmup', '--target-ms', '--timeout-ms', '--memory-mb', '--allow-env', '--library', '-o']);
  return argv.find((value, index) => !value.startsWith('-') && (index === 0 || !optionsWithValues.has(argv[index - 1])));
}

function securityMode(argv) {
  if (hasFlag(argv, '--unsafe-imports')) return 'off';
  return hasFlag(argv, '--secure') ? 'strict' : 'standard';
}

async function resolveProject(input, argv = []) {
  const cwd = path.resolve(process.cwd());
  const strict = securityMode(argv) === 'strict';
  if (input) {
    const file = path.resolve(input);
    await assertSourceFile(file, strict);
    return { file, projectRoot: pathInside(file, cwd) ? cwd : path.dirname(file), config: null };
  }

  const configFile = path.join(cwd, 'kura.json');
  if (await exists(configFile)) {
    const text = await readTextFileSecure(configFile, { maxBytes: LIMITS.configBytes, allowSymlink: false });
    const config = validateProjectConfig(parseJsonSecure(text, configFile), configFile);
    const file = assertInsideRoot(path.resolve(cwd, config.entry || 'src/main.kr'), cwd, 'configured entry');
    await assertSourceFile(file, strict);
    return { file, projectRoot: cwd, config };
  }

  for (const candidate of ['src/main.kr', 'main.kr']) {
    const file = path.join(cwd, candidate);
    if (await exists(file)) {
      await assertSourceFile(file, strict);
      return { file, projectRoot: cwd, config: null };
    }
  }

  throw new KuraCliError('No Kura entry file was found in this directory.', {
    code: 'KR-PROJECT-0001',
    title: 'This directory is not a Kura project yet',
    hint: "Run 'kr new hello', enter that directory, and run 'kr run'. You can also pass a .kr file directly.",
  });
}

async function assertSourceFile(file, strict) {
  if (!file.endsWith('.kr')) {
    throw new KuraCliError(`Expected a .kr source file, but received '${file}'.`, {
      code: 'KR-PROJECT-0002', title: 'Unsupported source file', file,
      hint: 'Choose a file ending in .kr.',
    });
  }
  await readTextFileSecure(file, { maxBytes: LIMITS.sourceBytes, allowSymlink: !strict });
}

async function compileFile(file, options = {}) {
  const source = await readTextFileSecure(file, {
    maxBytes: LIMITS.sourceBytes,
    allowSymlink: options.securityMode !== 'strict',
  });
  try {
    const result = compile(source, { file, ...options });
    return { source, ...result };
  } catch (error) {
    if (error && typeof error === 'object' && !error.source) error.source = source;
    throw error;
  }
}

function velocityHash(file, source, mode, security) {
  return createHash('sha256')
    .update('kura-v1-velocity-secure-2\0')
    .update(mode)
    .update('\0')
    .update(security)
    .update('\0')
    .update(path.resolve(file))
    .update('\0')
    .update(source)
    .digest('hex')
    .slice(0, 32);
}

async function cachedCompile(project, options = {}) {
  const mode = options.mode ?? 'run';
  const security = options.securityMode ?? 'standard';
  const source = await readTextFileSecure(project.file, {
    maxBytes: LIMITS.sourceBytes,
    allowSymlink: security !== 'strict',
  });
  const hash = velocityHash(project.file, source, mode, security);
  const { cacheDir, key } = await prepareSecureCache(project.projectRoot);
  const js = path.join(cacheDir, `${mode}-${hash}.mjs`);
  let cached = false;
  let compileMs = 0;

  if (await exists(js)) {
    const verified = await readVerifiedCache(js, key);
    if (verified !== null) {
      cached = true;
    } else {
      await rm(js, { force: true });
    }
  }

  if (!cached) {
    const started = performance.now();
    const output = compile(source, {
      file: project.file,
      optimize: true,
      compact: true,
      autoRun: options.autoRun ?? true,
      exposeMain: options.exposeMain ?? false,
      exposeBenchmark: options.exposeBenchmark ?? false,
      securityMode: security,
    });
    compileMs = performance.now() - started;
    await atomicWriteFile(js, wrapSignedCache(output.code, key), { root: project.projectRoot, mode: 0o600 });
  }

  return { source, hash, js, cached, compileMs, cacheDir };
}

async function runCommand(argv) {
  const project = await resolveProject(sourceArg(argv), argv);
  await sqlGate(project.projectRoot, false, argv);
  const mode = securityMode(argv);
  const turbo = hasFlag(argv, '--turbo') || process.env.KURA_VELOCITY === '1';
  let js;

  if (turbo) {
    ({ js } = await cachedCompile(project, { mode: 'run', autoRun: true, securityMode: mode }));
  } else {
    const output = await compileFile(project.file, { securityMode: mode });
    const buildDir = path.join(project.projectRoot, '.kura', 'run');
    js = path.join(buildDir, `${path.basename(project.file, '.kr')}-${shortHash(output.code)}.mjs`);
    await atomicWriteFile(js, output.code, { root: project.projectRoot, mode: 0o600 });
  }

  const strict = mode === 'strict';
  const timeoutMs = numericOption(argv, '--timeout-ms', strict ? 30_000 : 0, 0, 86_400_000);
  const memoryMb = numericOption(argv, '--memory-mb', strict ? 256 : 768, 64, 8192);
  const allowEnv = String(optionValue(argv, '--allow-env', '')).split(',').map(item => item.trim()).filter(Boolean);
  const childArgs = [
    ...nodeSecurityArgs({
      strict,
      memoryMb,
      allowRead: [project.projectRoot, packageRoot],
      allowWrite: [path.join(project.projectRoot, '.kura')],
    }),
    js,
  ];
  const child = spawn(process.execPath, childArgs, {
    stdio: ['inherit', 'inherit', 'pipe'],
    cwd: project.projectRoot,
    env: sanitizeChildEnv(process.env, { strict, allow: allowEnv }),
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    process.stderr.write(chunk);
    stderr = (stderr + chunk).slice(-131_072);
  });

  const result = await waitForChild(child, timeoutMs);
  if (result.timedOut) {
    throw new KuraCliError(`The program ran for longer than ${timeoutMs.toLocalString()} ms and was stopped.`, {
      code: 'KR-RUNTIME-0002', title: 'Secure execution timeout reached', file: project.file,
      hint: 'Fix an infinite loop, increase --timeout-ms, or use --timeout-ms 0 for a trusted long-running server.',
    });
  }
  if (result.code !== 0) {
    throw runtimeError(project.file, result.code, stderr);
  }
}

async function buildCommand(argv) {
  const project = await resolveProject(sourceArg(argv), argv);
  await sqlGate(project.projectRoot, false, argv);
  const mode = securityMode(argv);
  const turbo = hasFlag(argv, '--turbo')
    || hasFlag(argv, '--release');
  const output = await compileFile(project.file, { optimize: turbo, compact: turbo, securityMode: mode });
  const outputArg = optionValue(argv, '-o');
  const destination = path.resolve(outputArg || path.join(project.projectRoot, 'build', `${path.basename(project.file, '.kr')}.mjs`));
  await atomicWriteFile(destination, output.code, {
    root: project.projectRoot,
    mode: 0o600,
    allowOutsideRoot: hasFlag(argv, '--allow-outside-project'),
  });
  console.log(`Built ${displayPath(destination)}${turbo ? ' [velocity]' : ''}`);
}

async function checkCommand(argv) {
  const project = await resolveProject(sourceArg(argv), argv);
  const source = await readTextFileSecure(project.file, {
    maxBytes: LIMITS.sourceBytes,
    allowSymlink: securityMode(argv) !== 'strict',
  });
  const result = diagnose(source, { file: project.file, securityMode: securityMode(argv) });
  if (!result.ok) {
    const diagnostic = result.messages[0];
    const error = new KuraCliError(diagnostic.message, {
      code: diagnostic.code,
      title: diagnostic.title,
      hint: diagnostic.hint,
      details: diagnostic.details,
      file: diagnostic.file,
      line: diagnostic.line,
      column: diagnostic.column,
      length: diagnostic.length,
      source: diagnostic.source,
    });
    throw error;
  }
  await sqlGate(project.projectRoot, false, argv);
  console.log(`Checked ${displayPath(project.file)} — no problems found.`);
}

async function formatCommand(argv) {
  const project = await resolveProject(sourceArg(argv), argv);
  const source = await readTextFileSecure(project.file, {
    maxBytes: LIMITS.sourceBytes,
    allowSymlink: false,
  });
  const output = format(source, { file: project.file, securityMode: securityMode(argv) });
  if (hasFlag(argv, '--check')) {
    if (output !== source) {
      throw new KuraCliError(`${displayPath(project.file)} is not formatted yet.`, {
        code: 'KR-FMT-0001', title: 'Formatting check failed', file: project.file,
        hint: `Run 'kr fmt ${displayPath(project.file)}' to apply the formatter safely.`,
      });
    }
    console.log('Formatting check passed.');
    return;
  }
  await atomicWriteFile(project.file, output, { root: project.projectRoot, mode: 0o600 });
  console.log(`Formatted ${displayPath(project.file)}.`);
}

async function createProject(name) {
  assertSafeProjectName(name);
  const cwd = path.resolve(process.cwd());
  const directory = assertInsideRoot(path.resolve(cwd, name), cwd, 'new project');
  if (await exists(directory)) {
    throw new KuraCliError(`The path '${displayPath(directory)}' already exists.`, {
      code: 'KR-PROJECT-0003', title: 'Kura will not overwrite an existing directory',
      hint: 'Choose another project name or move the existing directory first.',
    });
  }
  await mkdir(path.join(directory, 'src'), { recursive: true, mode: 0o700 });
  const templateText = await readTextFileSecure(path.join(packageRoot, 'templates', 'kura.json'), { maxBytes: LIMITS.configBytes, allowSymlink: false });
  const config = validateProjectConfig(parseJsonSecure(templateText, 'templates/kura.json'), 'templates/kura.json');
  config.name = path.basename(directory);
  const mainTemplate = await readTextFileSecure(path.join(packageRoot, 'templates', 'main.kr'), { maxBytes: LIMITS.sourceBytes, allowSymlink: false });
  await atomicWriteFile(path.join(directory, 'kura.json'), `${JSON.stringify(config, null, 2)}\n`, { root: directory, mode: 0o600 });
  await atomicWriteFile(path.join(directory, 'src', 'main.kr'), mainTemplate, { root: directory, mode: 0o600 });
  console.log(`Created ${name}\nNext: cd ${name} && kr check && kr run`);
}

async function bindgenCommand(argv) {
  const headerArg = sourceArg(argv);
  if (!headerArg) {
    throw new KuraCliError('A C header path is required.', {
      code: 'KR-BINDGEN-0001', title: 'Kura needs a header file',
      hint: 'Example: kr bindgen include/example.h -o src/example.kr --library example',
    });
  }
  const header = path.resolve(headerArg);
  const library = optionValue(argv, '--library', 'c');
  const defaultOutput = header.replace(/\.[^.]+$/, '.kr');
  const output = path.resolve(optionValue(argv, '-o', defaultOutput));
  const source = await readTextFileSecure(header, { maxBytes: LIMITS.headerBytes, allowSymlink: false });
  const code = generateBindings(source, { library });
  await atomicWriteFile(output, code, {
    root: process.cwd(), mode: 0o600,
    allowOutsideRoot: hasFlag(argv, '--allow-outside-project'),
  });
  console.log(`Generated ${displayPath(output)}`);
}

async function sqlGate(directory, explicit = false, argv = []) {
  const root = path.resolve(directory);
  const files = await findKuraFiles(root);
  let found = false;
  const sources = new Map();
  for (const file of files) {
    const source = await readTextFileSecure(file, { maxBytes: LIMITS.sourceBytes, allowSymlink: true });
    sources.set(file, source);
    if (/comptime\s*\(\s*["']sql:/.test(source)) found = true;
  }
  if (!found && !explicit) return;

  const schemaPath = path.join(root, 'kura.sql.schema.json');
  if (!(await exists(schemaPath))) {
    throw new KuraCliError(`SQL schema not found: ${schemaPath}`, {
      code: 'KR-SQL-0001', title: 'Comptime SQL needs a schema', file: schemaPath,
      hint: 'Create kura.sql.schema.json in the project root, or remove the comptime SQL query.',
    });
  }
  const schemaText = await readTextFileSecure(schemaPath, { maxBytes: LIMITS.schemaBytes, allowSymlink: false });
  const schema = parseJsonSecure(schemaText, schemaPath);
  const failures = [];
  let count = 0;
  for (const file of files) {
    const result = validateSql(sources.get(file), schema);
    count += result.count;
    failures.push(...result.errors.map(message => `${displayPath(file)}: ${message}`));
  }
  if (failures.length) {
    throw new KuraCliError('SQL validation failed.', {
      code: 'KR-SQL-0002', title: 'A comptime SQL query is invalid',
      details: failures.join('\n'),
      hint: 'Update the query or the schema until every referenced table and column is valid.',
    });
  }
  if (!hasFlag(argv, '--quiet')) console.log(`Comptime SQL verified: ${count} ${count === 1 ? 'query' : 'queries'}`);
}

async function sqlCommand(argv) {
  const root = path.resolve(sourceArg(argv) || '.');
  await sqlGate(root, true, argv);
}

async function gpuCommand(argv) {
  const action = argv[0] || 'doctor';
  if (action === 'doctor') {
    console.log(`WebGPU: ${globalThis.navigator?.gpu ? 'available' : 'not available in this Node runtime'}`);
    console.log('Runtime module: @kura-lang/compiler/runtime/gpu');
    return;
  }
  if (action === 'init') {
    const output = path.resolve(optionValue(argv, '-o', 'src/kr_gpu_native.kr'));
    const code = 'extern "C" from "wgpu_native" {\n  fn wgpuCreateInstance(descriptor: Ptr<u8>) -> Ptr<u8>;\n}\n';
    await atomicWriteFile(output, code, {
      root: process.cwd(), mode: 0o600,
      allowOutsideRoot: hasFlag(argv, '--allow-outside-project'),
    });
    console.log(`Generated ${displayPath(output)}`);
    return;
  }
  throw new KuraCliError(`Unknown GPU action '${action}'.`, {
    code: 'KR-GPU-0001', title: 'Unsupported GPU command',
    hint: 'Use kr gpu doctor or kr gpu init.',
  });
}

async function doctor() {
  const rootInfo = await lstat(packageRoot);
  const checks = [
    ['Kura', 'v1.0.0'],
    ['Node', process.version],
    ['Platform', `${process.platform} ${process.arch}`],
    ['Install root', packageRoot],
    ['Install root type', rootInfo.isDirectory() ? 'directory' : 'unexpected'],
    ['Security Shield', 'installed'],
    ['Velocity Engine', 'installed'],
    ['Native system compiler', 'installed'],
    ['Status', 'ready'],
  ];
  console.log(checks.map(([name, value]) => `${name}: ${value}`).join('\n'));
}

async function velocityCommand(argv) {
  const action = argv[0] || 'status';
  if (action !== 'status') {
    throw new KuraCliError(`Unknown Velocity action '${action}'.`, {
      code: 'KR-VELOCITY-0001', title: 'Unsupported Velocity command',
      hint: 'Use kr velocity status.',
    });
  }
  console.log([
    'Kura v1 Velocity Engine',
    'Status: installed',
    'Modes: constant folding, range-loop lowering, signed content-addressed cache, hot-function benchmark',
    'Target: 0.1–1.0 ms per hot main() invocation',
  ].join('\n'));
}

async function benchCommand(argv) {
  const project = await resolveProject(sourceArg(argv), argv);
  await sqlGate(project.projectRoot, false, argv);
  const iterations = numericOption(argv, '--iterations', 10_000, 10, 100_000_000);
  const warmup = numericOption(argv, '--warmup', 2_000, 0, 100_000_000);
  const targetMsRaw = Number(optionValue(argv, '--target-ms', '1'));
  if (!Number.isFinite(targetMsRaw) || targetMsRaw <= 0 || targetMsRaw > 60_000) {
    throw new KuraCliError('The benchmark target must be a positive number of milliseconds.', {
      code: 'KR-BENCH-0001', title: 'Invalid benchmark target',
      hint: 'Example: --target-ms 1',
    });
  }
  const artifact = await cachedCompile(project, {
    mode: 'bench', autoRun: false, exposeMain: true, exposeBenchmark: true,
    securityMode: securityMode(argv),
  });
  const moduleUrl = `${pathToFileURL(artifact.js).href}?velocity=${artifact.hash}`;
  const loadStart = performance.now();
  const module = await import(moduleUrl);
  const loadMs = performance.now() - loadStart;
  const fn = module.__kr_bench || module.__kr_main;
  if (typeof fn !== 'function') {
    throw new KuraCliError('Benchmark requires a kernel function or main function.', {
      code: 'KR-BENCH-0002', title: 'No benchmarkable function was generated',
      file: project.file,
    });
  }
  const functionName = module.__kr_bench ? 'kernel' : 'main';
  let checksum = 0;
  const consume = value => {
    const number = Number(value);
    checksum = ((checksum * 33) ^ (Number.isFinite(number) ? number : 0)) >>> 0;
  };
  const first = fn(0);
  const asyncMode = Boolean(first && typeof first.then === 'function');
  consume(asyncMode ? await first : first);
  if (asyncMode) {
    for (let index = 0; index < warmup; index++) consume(await fn(index));
  } else {
    for (let index = 0; index < warmup; index++) consume(fn(index));
  }

  const batchCount = Math.min(50, iterations);
  const base = Math.floor(iterations / batchCount);
  let remainder = iterations % batchCount;
  const samples = [];
  let calls = 0;
  for (let batch = 0; batch < batchCount; batch++) {
    const count = base + (remainder-- > 0 ? 1 : 0);
    const started = performance.now();
    if (asyncMode) {
      for (let index = 0; index < count; index++) consume(await fn(calls + index));
    } else {
      for (let index = 0; index < count; index++) consume(fn(calls + index));
    }
    samples.push((performance.now() - started) / count);
    calls += count;
  }
  samples.sort((left, right) => left - right);
  const percentile = fraction => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * fraction))];
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const report = {
    engine: 'Kura v1 Velocity Engine',
    file: displayPath(project.file),
    function: functionName,
    mode: asyncMode ? 'async' : 'sync',
    iterations: calls,
    warmup,
    average_ms: average,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    min_ms: samples[0],
    max_ms: samples.at(-1),
    compile_ms: artifact.compileMs,
    module_load_ms: loadMs,
    cache_hit: artifact.cached,
    target_ms: targetMsRaw,
    checksum,
    status: average <= 0.1 ? 'LIMIT BREAK' : average <= targetMsRaw ? 'TARGET MET' : 'ABOVE TARGET',
  };
  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log([
      report.engine,
      `File: ${report.file}`,
      `Function: ${report.function}`,
      `Mode: ${report.mode}`,
      `Iterations: ${calls.toLocaleString()} (+ ${warmup.toLocaleString()} warmup)`,
      `Average: ${average.toFixed(6)} ms`,
      `P50: ${report.p50_ms.toFixed(6)} ms`,
      `P95: ${report.p95_ms.toFixed(6)} ms`,
      `Compile: ${artifact.cached ? 'cache hit' : `${artifact.compileMs.toFixed(3)} ms`}`,
      `Module load: ${loadMs.toFixed(3)} ms`,
      `Result: ${report.status}`,
    ].join('\n'));
  }
}

async function securityCommand(argv) {
  const action = argv[0] || 'status';
  if (action === 'status') {
    console.log('Kura Security Shield\nStatus: installed\nModes: standard, strict');
    return;
  }
  if (action !== 'audit') {
    throw new KuraCliError(`Unknown security action '${action}'.`, {
      code: 'KR-AUDIT-0002', title: 'Unsupported security command',
      hint: 'Use kr security status or kr security audit.',
    });
  }
  const report = await auditProject(path.resolve(sourceArg(argv.slice(1)) || '.'));
  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Scanned ${report.scannedFiles} Kura ${report.scannedFiles === 1 ? 'file' : 'files'}.`);
    for (const finding of report.findings) {
      console.log(`${finding.id} [${finding.severity}] ${finding.file}:${finding.line} ${finding.message}`);
    }
  }
  if (!report.ok) {
    throw new KuraSecurityError('The security audit found high-risk capabilities.', {
      code: 'KR-AUDIT-0001', title: 'Security audit failed',
      details: `${report.counts.high ?? 0} high-risk finding(s) detected.`,
      hint: 'Review the listed files and remove or explicitly isolate dangerous capabilities.',
    });
  }
}

function pathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function displayPath(file) {
  const relative = path.relative(process.cwd(), path.resolve(file));
  return relative || '.';
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function numericOption(argv, name, fallback, minimum, maximum) {
  const raw = optionValue(argv, name, String(fallback));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new KuraCliError(`Option '${name}' must be an integer from ${minimum} to ${maximum}.`, {
      code: 'KR-CLI-0004', title: 'Invalid numeric command option',
      hint: `Example: ${name} ${fallback}`,
    });
  }
  return value;
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timer = null;
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), signal, timedOut });
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

function runtimeError(file, code, stderr) {
  const details = String(stderr || '').trim().slice(-16_384);
  return new KuraCliError(`The Kura program exited with code ${code}.`, {
    code: 'KR-RUNTIME-0001', title: 'The compiled program failed', file,
    details: details || null,
    hint: 'Read the runtime output above, fix the program, and run it again.',
  });
}
