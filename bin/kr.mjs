#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile, diagnose } from '../lib/compiler.mjs';
import { formatKura } from '../lib/formatter.mjs';
import { bindgen as generateBindings } from '../lib/bindgen.mjs';
import { validateSql } from '../lib/sql.mjs';
import {
  addDependency,
  cleanPackageCache,
  installDependencies,
  listDependencies,
  removeDependency,
} from '../lib/package-manager.mjs';
import { runTestSuite } from '../lib/test-runner.mjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { buildStandalone } from '../lib/standalone.mjs';
import { startLanguageServer } from '../lib/lsp-server.mjs';
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
    case 'dev': await devCommand(argv); return;
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
    case 'add': await addCommand(argv); return;
    case 'remove': await removeCommand(argv); return;
    case 'install': await installCommand(argv); return;
    case 'update': await updateCommand(argv); return;
    case 'list': await listCommand(argv); return;
    case 'cache': await cacheCommand(argv); return;
    case 'test': await testCommand(argv); return;
    case 'std': await stdCommand(argv); return;
    case 'lsp': await lspCommand(argv); return;
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
  dev [file]        Start hot-reload development server
  build [file]      Build to JavaScript or a standalone executable
  check [file]      Parse, validate, and explain errors
  fmt [file]        Format one file or the whole project
  test [file]       Discover and run built-in Kura tests
  add <package>     Add and securely install a package
  remove <package>  Remove a package
  install           Reproduce dependencies from kura.json
  update            Refresh dependency versions and lockfile
  list              Show direct project dependencies
  cache clean       Clear the verified package cache
  std list          Show batteries-included modules
  lsp --stdio       Start the Kura language server
  bindgen <header>  Generate C bindings
  sql-check         Validate comptime SQL
  gpu doctor|init   GPU support tools
  kr-system         Native x86_64 kernel compiler (separate CLI)
  security audit   Scan project capabilities and risks
  doctor            Check installation and hardening
  version           Print version

Common options:
  --secure          Strict imports, Node permissions, secret filtering
  --json            Machine-readable diagnostics
  --verbose         Include technical stack details
  --allow-outside-project  Permit an explicit output outside the project
  --offline         Use only the local package cache
  --frozen          Require kura.lock to match kura.json exactly
  --allow-ai         Permit Kura.ai in strict security mode
${all ? `
Velocity Engine (experimental)
  run --turbo       Optimized, signed, cached execution
  build --turbo     Constant-folded compact build
  build --standalone Create one self-contained executable
  dev --browser      Serve browser output with live reload
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
  const optionsWithValues = new Set(['--iterations', '--warmup', '--target-ms', '--timeout-ms', '--memory-mb', '--allow-env', '--library', '--registry', '--filter', '--jobs', '--indent-width', '--port', '--host', '--node', '--name', '--asset', '--public-dir', '-o']);
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
    const result = compile(source, { file, stdlibRoot: path.join(packageRoot, 'std'), aiRuntime: path.join(packageRoot, 'lib', 'ai.mjs'), ...options });
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
      stdlibRoot: path.join(packageRoot, 'std'),
      aiRuntime: path.join(packageRoot, 'lib', 'ai.mjs'),
      allowAi: Boolean(options.allowAi),
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
    ({ js } = await cachedCompile(project, { mode: 'run', autoRun: true, securityMode: mode, allowAi: hasFlag(argv, '--allow-ai') }));
  } else {
    const output = await compileFile(project.file, { securityMode: mode, allowAi: hasFlag(argv, '--allow-ai') });
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
    throw new KuraCliError(`The program ran for longer than ${timeoutMs.toLocaleString()} ms and was stopped.`, {
      code: 'KR-RUNTIME-0002', title: 'Secure execution timeout reached', file: project.file,
      hint: 'Fix an infinite loop, increase --timeout-ms, or use --timeout-ms 0 for a trusted long-running server.',
    });
  }
  if (result.code !== 0) {
    throw runtimeError(project.file, result.code, stderr);
  }
}

async function devCommand(argv) {
  const project = await resolveProject(sourceArg(argv), argv);
  const mode = securityMode(argv);
  const browser = hasFlag(argv, '--browser') || project.config?.target === 'browser';
  const host = optionValue(argv, '--host', '127.0.0.1');
  const port = numericOption(argv, '--port', 5173, 0, 65535);
  const strict = mode === 'strict';
  const allowEnv = String(optionValue(argv, '--allow-env', '')).split(',').map(value => value.trim()).filter(Boolean);
  const outputFile = path.join(project.projectRoot, '.kura', 'dev', 'app.mjs');
  const nodeArgs = nodeSecurityArgs({
    strict,
    memoryMb: numericOption(argv, '--memory-mb', strict ? 256 : 768, 64, 8192),
    allowRead: [project.projectRoot, packageRoot],
    allowWrite: [path.join(project.projectRoot, '.kura')],
  });
  const controller = await startDevServer({
    projectRoot: project.projectRoot,
    publicDir: optionValue(argv, '--public-dir', 'public'),
    host,
    port,
    browser,
    open: hasFlag(argv, '--open'),
    stdlibRoot: path.join(packageRoot, 'std'),
    aiRuntime: path.join(packageRoot, 'lib', 'ai.mjs'),
    outputFile,
    nodeArgs,
    env: sanitizeChildEnv(process.env, { strict, allow: allowEnv }),
    compile: async ({ browser: browserMode }) => {
      await sqlGate(project.projectRoot, false, argv);
      return compileFile(project.file, {
        optimize: hasFlag(argv, '--turbo'),
        compact: hasFlag(argv, '--turbo'),
        securityMode: mode,
        allowAi: hasFlag(argv, '--allow-ai'),
        target: browserMode ? 'browser' : 'node',
      });
    },
    writeOutput: (file, code) => atomicWriteFile(file, code, { root: project.projectRoot, mode: 0o600 }),
    onLog: message => console.log(`[Kura dev] ${message}`),
    onError: error => void printFriendlyError(error, { json: false, verbose: globalOptions.verbose }),
  });
  console.log(`Kura development server\nURL: ${controller.url}\nMode: ${browser ? 'browser live reload' : 'Node hot restart'}\nWatching: ${displayPath(project.projectRoot)}\nPress Ctrl+C to stop.`);
  if (hasFlag(argv, '--once')) { await controller.close(); return; }
  await waitForShutdown(controller);
}

async function buildCommand(argv) {
  const project = await resolveProject(sourceArg(argv), argv);
  await sqlGate(project.projectRoot, false, argv);
  const mode = securityMode(argv);
  const turbo = hasFlag(argv, '--turbo') || hasFlag(argv, '--release') || hasFlag(argv, '--standalone');
  const outputArg = optionValue(argv, '-o');

  if (hasFlag(argv, '--standalone')) {
    const report = await buildStandalone({
      projectRoot: project.projectRoot,
      entryFile: project.file,
      packageRoot,
      stdlibRoot: path.join(packageRoot, 'std'),
      aiRuntime: path.join(packageRoot, 'lib', 'ai.mjs'),
      nodeBinary: optionValue(argv, '--node', process.execPath),
      outputPath: outputArg,
      name: optionValue(argv, '--name', project.config?.name ?? path.basename(project.projectRoot)),
      assets: optionValues(argv, '--asset'),
      keepStage: hasFlag(argv, '--keep-stage'),
      allowOutsideProject: hasFlag(argv, '--allow-outside-project'),
      compile: () => compileFile(project.file, {
        optimize: true,
        compact: true,
        securityMode: mode,
        allowAi: hasFlag(argv, '--allow-ai'),
        target: 'node',
      }),
    });
    console.log(`Built standalone executable ${displayPath(report.output)}\nAssets: ${report.assets} files / ${formatBytes(report.appBytes)}\nBinary: ${formatBytes(report.bytes)}\nSHA-256: ${report.sha256}\nBuilder: Node.js ${report.node} (${report.platform} ${report.arch})`);
    return;
  }

  const output = await compileFile(project.file, {
    optimize: turbo,
    compact: turbo,
    securityMode: mode,
    allowAi: hasFlag(argv, '--allow-ai'),
  });
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
  const result = diagnose(source, { file: project.file, securityMode: securityMode(argv), stdlibRoot: path.join(packageRoot, 'std'), aiRuntime: path.join(packageRoot, 'lib', 'ai.mjs'), allowAi: hasFlag(argv, '--allow-ai') });
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
  const root = path.resolve(process.cwd());
  const explicit = sourceArg(argv);
  const files = explicit ? [path.resolve(explicit)] : await findKuraFiles(root);
  if (!files.length) {
    throw new KuraCliError('No .kr files were found to format.', {
      code: 'KR-FMT-0002', title: 'Nothing to format', hint: 'Create a .kr file or pass its path explicitly.',
    });
  }
  const indentWidth = numericOption(argv, '--indent-width', 2, 1, 8);
  const useTabs = hasFlag(argv, '--tabs');
  const changed = [];
  for (const file of files) {
    const source = await readTextFileSecure(file, { maxBytes: LIMITS.sourceBytes, allowSymlink: false });
    const validation = diagnose(source, { file, securityMode: securityMode(argv), stdlibRoot: path.join(packageRoot, 'std'), aiRuntime: path.join(packageRoot, 'lib', 'ai.mjs'), allowAi: hasFlag(argv, '--allow-ai') });
    if (!validation.ok) {
      const problem = validation.messages[0];
      throw new KuraCliError(problem.message, {
        code: problem.code, title: problem.title, hint: problem.hint, details: problem.details,
        file: problem.file, line: problem.line, column: problem.column, length: problem.length, source: problem.source,
      });
    }
    const output = formatKura(source, { indentWidth, useTabs });
    if (output !== source) {
      changed.push(file);
      if (!hasFlag(argv, '--check')) await atomicWriteFile(file, output, { root, mode: 0o600 });
    }
  }
  if (hasFlag(argv, '--check') && changed.length) {
    throw new KuraCliError(`${changed.length} ${changed.length === 1 ? 'file is' : 'files are'} not formatted.`, {
      code: 'KR-FMT-0001', title: 'Formatting check failed',
      hint: "Run 'kr fmt' to format the entire project.",
      details: changed.map(displayPath).join('\n'),
    });
  }
  if (hasFlag(argv, '--check')) console.log(`Formatting check passed for ${files.length} ${files.length === 1 ? 'file' : 'files'}.`);
  else console.log(`Formatted ${changed.length} of ${files.length} ${files.length === 1 ? 'file' : 'files'}.`);
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
  await mkdir(path.join(directory, 'tests'), { recursive: true, mode: 0o700 });
  const templateText = await readTextFileSecure(path.join(packageRoot, 'templates', 'kura.json'), { maxBytes: LIMITS.configBytes, allowSymlink: false });
  const config = validateProjectConfig(parseJsonSecure(templateText, 'templates/kura.json'), 'templates/kura.json');
  config.name = path.basename(directory);
  const mainTemplate = await readTextFileSecure(path.join(packageRoot, 'templates', 'main.kr'), { maxBytes: LIMITS.sourceBytes, allowSymlink: false });
  await atomicWriteFile(path.join(directory, 'kura.json'), `${JSON.stringify(config, null, 2)}\n`, { root: directory, mode: 0o600 });
  await atomicWriteFile(path.join(directory, 'src', 'main.kr'), mainTemplate, { root: directory, mode: 0o600 });
  const testTemplate = await readTextFileSecure(path.join(packageRoot, 'templates', 'basic_test.kr'), { maxBytes: LIMITS.sourceBytes, allowSymlink: false });
  await atomicWriteFile(path.join(directory, 'tests', 'basic_test.kr'), testTemplate, { root: directory, mode: 0o600 });
  console.log(`Created ${name}\nNext: cd ${name} && kr check && kr test && kr run`);
}

async function bindgenCommand(argv) {
  const header = sourceArg(argv);
  if (!header) {
    throw new KuraCliError('No C header was provided.', {
      code: 'KR-BINDGEN-0001', title: 'Kura needs a header file',
      hint: 'Example: kr bindgen include/demo.h -o src/demo_bindings.kr --library demo',
    });
  }
  const projectRoot = path.resolve(process.cwd());
  const headerPath = path.resolve(header);
  const library = optionValue(argv, '--library', 'c');
  if (!/^[A-Za-z0-9._+-]{1,128}$/.test(library)) {
    throw new KuraSecurityError(`The library name '${library}' contains unsafe characters.`, {
      code: 'KR-SEC-0601', hint: 'Use only letters, numbers, dots, dashes, underscores, and plus signs.',
    });
  }
  const source = await readTextFileSecure(headerPath, { maxBytes: LIMITS.headerBytes, allowSymlink: securityMode(argv) !== 'strict' });
  const outputArg = optionValue(argv, '-o', header.replace(/\.[^.]+$/, '.kr'));
  const outputPath = path.resolve(outputArg);
  const code = generateBindings(source, { library });
  await atomicWriteFile(outputPath, code, {
    root: projectRoot,
    mode: 0o600,
    allowOutsideRoot: hasFlag(argv, '--allow-outside-project'),
  });
  console.log(`Generated ${displayPath(outputPath)}.`);
}

async function sqlGate(directory, explicit = false, argv = []) {
  const files = await findKuraFiles(directory);
  let found = false;
  const failures = [];
  const schemaPath = path.resolve(directory, 'kura.sql.schema.json');
  for (const file of files) {
    const source = await readTextFileSecure(file, { maxBytes: LIMITS.sourceBytes, allowSymlink: securityMode(argv) !== 'strict' });
    if (/comptime\s*\(\s*["']sql:/.test(source)) found = true;
  }
  if (!found && !explicit) return;
  if (!(await exists(schemaPath))) {
    throw new KuraCliError('This project uses comptime SQL but has no schema file.', {
      code: 'KR-SQL-0001', title: 'SQL schema is missing', file: schemaPath,
      hint: 'Create kura.sql.schema.json beside kura.json, then rerun the command.',
    });
  }
  const schemaText = await readTextFileSecure(schemaPath, { maxBytes: LIMITS.schemaBytes, allowSymlink: false });
  const schema = parseJsonSecure(schemaText, schemaPath);
  let count = 0;
  for (const file of files) {
    const source = await readTextFileSecure(file, { maxBytes: LIMITS.sourceBytes, allowSymlink: securityMode(argv) !== 'strict' });
    const result = validateSql(source, schema);
    count += result.count;
    failures.push(...result.errors.map(message => ({ file, message })));
  }
  if (failures.length) {
    const first = failures[0];
    throw new KuraCliError(first.message, {
      code: 'KR-SQL-0002', title: 'Compile-time SQL validation failed', file: first.file,
      hint: 'Check table and column names against kura.sql.schema.json.',
      details: failures.length > 1 ? `${failures.length - 1} additional SQL problem(s) were found.` : null,
    });
  }
  console.log(`Compile-time SQL verified: ${count} ${count === 1 ? 'query' : 'queries'}.`);
}

async function sqlCommand(argv) {
  const directory = path.resolve(sourceArg(argv) || '.');
  await sqlGate(directory, true, argv);
}

async function gpuCommand(argv) {
  const action = argv[0] || 'doctor';
  if (action === 'doctor') {
    console.log(`WebGPU: ${globalThis.navigator?.gpu ? 'available' : 'not available in this Node runtime'}\nRuntime module: @kura-lang/compiler/runtime/gpu`);
    return;
  }
  if (action === 'init') {
    const root = path.resolve(process.cwd());
    const output = path.resolve(optionValue(argv, '-o', 'src/kr_gpu_native.kr'));
    await atomicWriteFile(output, 'extern "C" from "wgpu_native" {\n  fn wgpuCreateInstance(descriptor: Ptr<u8>) -> Ptr<u8>;\n}\n', {
      root,
      mode: 0o600,
      allowOutsideRoot: hasFlag(argv, '--allow-outside-project'),
    });
    console.log(`Generated ${displayPath(output)}.`);
    return;
  }
  throw new KuraCliError(`Unknown GPU action '${action}'.`, {
    code: 'KR-GPU-0001', title: 'Kura does not recognize this GPU action',
    hint: 'Use kr gpu doctor or kr gpu init.',
  });
}

async function doctor() {
  const permissionModel = process.allowedNodeEnvironmentFlags.has('--permission') ? 'available' : 'unavailable';
  console.log(`Kura: v1.0.0
Node: ${process.version}
Platform: ${process.platform} ${process.arch}
Install root: ${packageRoot}
Velocity Engine: installed, signed cache enabled
Security: standard-by-default, strict mode available
Node permission model: ${permissionModel}
Diagnostics: friendly code frames and JSON output enabled
Package manager: integrity-verified, script-free installs enabled
Standard library: batteries included
Kura.ai: native AI client, streaming, embeddings, and tools enabled
Development server: hot reload and browser live reload enabled
Standalone builder: Node SEA single-executable output enabled
Language server: LSP stdio server and VS Code integration enabled
Native system compiler: installed (kr-system)
Formatter: project-wide and deterministic
Test runner: isolated workers and timeouts enabled
Status: ready`);
}

async function velocityCommand(argv) {
  const action = argv[0] || 'status';
  if (action !== 'status') {
    throw new KuraCliError(`Unknown Velocity action '${action}'.`, {
      code: 'KR-VELOCITY-0001', title: 'Kura does not recognize this Velocity action',
      hint: 'Use kr velocity status.',
    });
  }
  console.log('Kura v1 Velocity Engine\nStatus: installed\nSecurity: HMAC-signed cache, owner-only cache directory, symlink protection\nModes: safe constant folding, range-loop lowering, lazy runtime prelude, content-addressed cache\nTarget: 0.1–1.0 ms per hot function invocation');
}

async function securityCommand(argv) {
  const action = argv[0] || 'status';
  if (action === 'status') {
    console.log(`Kura Security Shield
Status: enabled
Default mode: standard
Strict mode: kr run --secure
Protections: safe literal folding, import policy, file-size limits, path containment, atomic writes, symlink blocking, signed cache, NODE_OPTIONS removal, secret filtering, Node permission model, time and memory limits
Audit: kr security audit`);
    return;
  }
  if (action === 'audit') {
    const directory = path.resolve(argv.find((value, index) => index > 0 && !value.startsWith('-')) || '.');
    const report = await auditProject(directory);
    if (hasFlag(argv, '--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Kura Security Audit\nRoot: ${report.root}\nFiles scanned: ${report.scannedFiles}`);
      if (!report.findings.length) {
        console.log('Result: no security findings.');
      } else {
        for (const finding of report.findings) {
          console.log(`[${finding.severity.toUpperCase()}] ${finding.id} ${finding.file}:${finding.line} — ${finding.message}`);
        }
        console.log(`Summary: ${report.counts.high ?? 0} high, ${report.counts.medium ?? 0} medium, ${report.counts.low ?? 0} low`);
      }
    }
    if (!report.ok) {
      throw new KuraCliError('The project contains one or more high-severity security findings.', {
        code: 'KR-AUDIT-0001', title: 'Security audit needs attention',
        hint: 'Review the HIGH findings before running untrusted code. Use --json for CI integration.',
      });
    }
    return;
  }
  throw new KuraCliError(`Unknown security action '${action}'.`, {
    code: 'KR-SEC-0002', title: 'Kura does not recognize this security action',
    hint: 'Use kr security status or kr security audit.',
  });
}

async function benchCommand(argv) {
  const project = await resolveProject(sourceArg(argv), argv);
  const iterations = numericOption(argv, '--iterations', 10_000, 10, 100_000_000);
  const warmup = numericOption(argv, '--warmup', 2_000, 0, 10_000_000);
  const targetMs = numericOption(argv, '--target-ms', 1, 0.001, 60_000);
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
    throw new KuraCliError('No benchmarkable function was found.', {
      code: 'KR-BENCH-0001', title: 'Kura needs a benchmark function', file: project.file,
      hint: 'Add kernel fn hot(seed: int) -> int { ... } or fn main().',
    });
  }
  const functionName = module.__kr_bench ? 'kernel' : 'main';
  let sink = 0;
  const consume = value => {
    const numeric = Number(value);
    sink = ((sink * 33) ^ (Number.isFinite(numeric) ? numeric : 0)) >>> 0;
  };
  const first = fn(0);
  const asyncMode = Boolean(first && typeof first.then === 'function');
  consume(asyncMode ? await first : first);
  if (asyncMode) for (let index = 0; index < warmup; index++) consume(await fn(index));
  else for (let index = 0; index < warmup; index++) consume(fn(index));

  const batchCount = Math.min(50, iterations);
  const base = Math.floor(iterations / batchCount);
  let remainder = iterations % batchCount;
  const samples = [];
  let calls = 0;
  for (let batch = 0; batch < batchCount; batch++) {
    const count = base + (remainder-- > 0 ? 1 : 0);
    const started = performance.now();
    if (asyncMode) for (let index = 0; index < count; index++) consume(await fn(calls + index));
    else for (let index = 0; index < count; index++) consume(fn(calls + index));
    samples.push((performance.now() - started) / count);
    calls += count;
  }
  samples.sort((left, right) => left - right);
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const percentile = position => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * position))];
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
    target_ms: targetMs,
    checksum: sink,
    status: average <= 0.1 ? 'LIMIT BREAK' : average <= targetMs ? 'TARGET MET' : 'ABOVE TARGET',
  };
  if (hasFlag(argv, '--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`Kura v1 Velocity Engine\nFile: ${report.file}\nFunction: ${report.function}\nMode: ${report.mode}\nIterations: ${calls.toLocaleString()} (+ ${warmup.toLocaleString()} warmup)\nAverage: ${average.toFixed(6)} ms\nP50: ${report.p50_ms.toFixed(6)} ms\nP95: ${report.p95_ms.toFixed(6)} ms\nMinimum: ${report.min_ms.toFixed(6)} ms\nMaximum: ${report.max_ms.toFixed(6)} ms\nCompile: ${artifact.cached ? 'verified cache hit' : `${artifact.compileMs.toFixed(3)} ms`}\nModule load: ${loadMs.toFixed(3)} ms\nTarget: <= ${targetMs.toFixed(3)} ms hot invocation\nResult: ${report.status}`);
}

async function addCommand(argv) {
  const spec = sourceArg(argv);
  if (!spec) throw new KuraCliError('No package was provided.', { code: 'KR-PKG-0001', title: 'Kura needs a package name', hint: 'Example: kr add kleur' });
  const report = await addDependency(process.cwd(), spec, packageOptions(argv));
  console.log(`Added ${report.name}@${report.range}. Installed ${report.installed} package ${report.installed === 1 ? 'entry' : 'entries'} and updated kura.lock.`);
}

async function removeCommand(argv) {
  const name = sourceArg(argv);
  if (!name) throw new KuraCliError('No package was provided.', { code: 'KR-PKG-0001', title: 'Kura needs a package name', hint: 'Example: kr remove kleur' });
  const report = await removeDependency(process.cwd(), name, packageOptions(argv));
  console.log(`Removed ${name}. Installed ${report.installed} remaining package ${report.installed === 1 ? 'entry' : 'entries'}.`);
}

async function installCommand(argv) {
  const report = await installDependencies(process.cwd(), packageOptions(argv));
  console.log(`Installed ${report.installed} package ${report.installed === 1 ? 'entry' : 'entries'} from ${report.direct} direct ${report.direct === 1 ? 'dependency' : 'dependencies'}.`);
}

async function updateCommand(argv) {
  const report = await installDependencies(process.cwd(), { ...packageOptions(argv), frozen: false });
  console.log(`Updated dependency graph. Installed ${report.installed} package ${report.installed === 1 ? 'entry' : 'entries'} and refreshed kura.lock.`);
}

async function listCommand(argv) {
  const rows = await listDependencies(process.cwd());
  if (hasFlag(argv, '--json')) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.log('No direct dependencies. Add one with kr add <package>.'); return; }
  for (const row of rows) console.log(`${row.kind === 'devDependency' ? 'dev ' : '    '}${row.name}  ${row.range}  ${row.version ?? 'not installed'}${row.installed ? '' : '  [missing]'}`);
}

async function cacheCommand(argv) {
  const action = argv[0] || 'status';
  if (action === 'clean') {
    const directory = await cleanPackageCache(packageOptions(argv));
    console.log(`Cleared package cache: ${directory}`);
    return;
  }
  throw new KuraCliError(`Unknown cache action '${action}'.`, { code: 'KR-PKG-0901', title: 'Kura does not recognize this cache action', hint: 'Use kr cache clean.' });
}

function packageOptions(argv) {
  return {
    dev: hasFlag(argv, '--dev'),
    exact: hasFlag(argv, '--exact'),
    frozen: hasFlag(argv, '--frozen'),
    offline: hasFlag(argv, '--offline'),
    production: hasFlag(argv, '--production'),
    registry: optionValue(argv, '--registry'),
    allowHttpRegistry: hasFlag(argv, '--allow-http-registry'),
    force: hasFlag(argv, '--force'),
  };
}

async function testCommand(argv) {
  const timeoutMs = numericOption(argv, '--timeout-ms', 5000, 1, 3_600_000);
  const jobs = numericOption(argv, '--jobs', 1, 1, 32);
  const report = await runTestSuite({
    projectRoot: process.cwd(),
    explicit: sourceArg(argv),
    filter: optionValue(argv, '--filter', ''),
    timeoutMs,
    jobs,
    failFast: hasFlag(argv, '--fail-fast'),
    optimize: hasFlag(argv, '--turbo'),
    securityMode: securityMode(argv),
    stdlibRoot: path.join(packageRoot, 'std'),
    aiRuntime: path.join(packageRoot, 'lib', 'ai.mjs'),
    allowAi: hasFlag(argv, '--allow-ai'),
  });
  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const test of report.tests) {
      const mark = test.status === 'passed' ? 'PASS' : 'FAIL';
      console.log(`${mark} ${displayPath(test.file)}:${test.line} — ${test.name} (${test.durationMs.toFixed(2)} ms)`);
      if (test.error) console.log(`     ${test.error.message}`);
    }
    for (const error of report.loadErrors) console.log(`FAIL ${displayPath(error.file)} — ${error.message}`);
    console.log(`\nTests: ${report.passed} passed, ${report.failed} failed, ${report.tests.length} total across ${report.files} ${report.files === 1 ? 'file' : 'files'}.`);
  }
  if (!report.ok) throw new KuraCliError(`${report.failed} test ${report.failed === 1 ? 'failure' : 'failures'} detected.`, { code: 'KR-TEST-0002', title: 'Test suite failed', hint: 'Read the first failing test above, fix it, and rerun kr test.' });
}


async function lspCommand(argv) {
  if (!argv.includes('--stdio') && argv.length > 0) {
    throw new KuraCliError("Kura LSP currently supports stdio transport only.", {
      code: 'KR-LSP-0001',
      title: 'Unsupported language-server transport',
      hint: 'Run kr lsp --stdio. VS Code starts this command automatically when system-server mode is enabled.',
    });
  }
  startLanguageServer();
  await new Promise(resolve => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
}

async function stdCommand(argv) {
  const action = argv[0] || 'list';
  const modules = ['ai', 'assert', 'cli', 'collections', 'crypto', 'encoding', 'env', 'fs', 'http', 'json', 'log', 'math', 'path', 'process', 'random', 'testing', 'time', 'url'];
  if (action === 'list') {
    console.log(`Kura standard library (${modules.length} modules)\n${modules.map(name => `  std:${name}`).join('\n')}\n\nExample: import { readText } from std:"fs";`);
    return;
  }
  throw new KuraCliError(`Unknown std action '${action}'.`, { code: 'KR-STDLIB-0002', title: 'Kura does not recognize this standard-library action', hint: 'Use kr std list.' });
}

function optionValues(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === name && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) values.push(argv[index + 1]);
  }
  return values;
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

async function waitForShutdown(controller) {
  await new Promise(resolve => {
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
      await controller.close();
      resolve();
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  });
}

function numericOption(argv, name, fallback, minimum, maximum) {
  const raw = optionValue(argv, name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new KuraCliError(`Option '${name}' must be between ${minimum} and ${maximum}.`, {
      code: 'KR-CLI-0004', title: 'Invalid numeric option',
      hint: `Example: ${name} ${fallback}`,
    });
  }
  return Math.trunc(value) === value || minimum < 1 ? value : Math.trunc(value);
}

async function waitForChild(child, timeoutMs) {
  let timer = null;
  let timedOut = false;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    timer.unref();
  }
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', value => resolve(value ?? 1));
  });
  if (timer) clearTimeout(timer);
  return { code, timedOut };
}

function runtimeError(file, code, stderr) {
  const first = String(stderr).split(/\r?\n/).find(line => line.trim())?.trim();
  return new KuraCliError(first ? `The program stopped with: ${first}` : `The program exited with code ${code}.`, {
    code: 'KR-RUNTIME-0001', title: 'Your Kura program stopped while running', file,
    hint: "Read the first stack line above. Add smaller println() checks, or run with --verbose for technical details.",
    details: `Exit code: ${code}`,
  });
}

function pathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function displayPath(file) {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith('..') ? relative : file;
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
