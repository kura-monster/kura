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
  const turbo = hasFlag(argv, '--turbo'
||| hasFlag(argv, '--release');
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
  await mkdir(path.join(directory, 'src'), { recursive: true, mode: 0o00 });
  const templateText = await readTextFileSecure(path.join(packageRoot, 'templates', 'kura.json'), { maxBytes: LIMITS.configBytes, allowSymlink: false });
  const config = validateProjectConfig(parseJsonSecure(templateText, 'templates/kura.json'), 'templates/kura.json');
  config.name = path.basename(directory);
  const mainTemplate = await readTextFileSecure(path.join(packageRoot, 'templates', 'main.kr'), { maxBytes: LIMITS.sourceBytes, allowSymlink: false });
  await atomicWriteFile(path.join(directory, 'kura.json'), `${JSON.stringify(config, null, 2)}\n`, { root: directory, mode: 0o600 });
  await atomicWriteFile(path.join(directory, 'src', 'main.kr'), mainTemplate, { root: directory, mode: 0o600 });
  console.log(`Created ${name}\nNext: cd ${name} && kr check && kr run`);
}
