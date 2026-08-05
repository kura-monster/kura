// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLanguage } from './language-core.mjs';

export const SELF_HOST_COMPILER_SOURCE = `pub fn compiler_version() -> String {
  return "1.1-stage1"
}

fn strip_scalar_types(source: String) -> String {
  let colon = ":"
  let arrow = " -" + ">"
  let space = " "
  let empty = ""
  let string_name = "String"
  let bool_name = "bool"
  let i32_name = "i32"
  let u32_name = "u32"
  let usize_name = "usize"
  return source
    .replaceAll(colon + space + string_name, empty)
    .replaceAll(colon + space + bool_name, empty)
    .replaceAll(colon + space + i32_name, empty)
    .replaceAll(colon + space + u32_name, empty)
    .replaceAll(colon + space + usize_name, empty)
    .replaceAll(arrow + space + string_name, empty)
    .replaceAll(arrow + space + bool_name, empty)
    .replaceAll(arrow + space + i32_name, empty)
    .replaceAll(arrow + space + u32_name, empty)
    .replaceAll(arrow + space + usize_name, empty)
}

pub fn compile_program(source: String) -> String {
  let pub_keyword = "p" + "ub "
  let async_keyword = "a" + "sync "
  let function_keyword = "f" + "n "
  let export_keyword = "ex" + "port "
  let javascript_function = "fun" + "ction "
  let let_keyword = "le" + "t "
  let let_mut_keyword = "le" + "t mut "
  let const_keyword = "con" + "st "
  let mutable_marker = "__KURA_" + "MUTABLE_BINDING__"
  return strip_scalar_types(source)
    .replaceAll(pub_keyword + async_keyword + function_keyword, export_keyword + async_keyword + javascript_function)
    .replaceAll(pub_keyword + function_keyword, export_keyword + javascript_function)
    .replaceAll(async_keyword + function_keyword, async_keyword + javascript_function)
    .replaceAll(function_keyword, javascript_function)
    .replaceAll(let_mut_keyword, mutable_marker)
    .replaceAll(let_keyword, const_keyword)
    .replaceAll(mutable_marker, let_keyword)
}
`;

/** Frontend logic authored in Kura and compiled by the trusted Stage 0 compiler. */
export const SELF_HOST_FRONTEND_SOURCE = `pub fn frontend_version() -> String {
  return "1.2-kura-frontend"
}

fn is_space(ch: String) -> bool {
  return ch == " " || ch == "\\t" || ch == "\\r" || ch == "\\n"
}

fn is_digit(ch: String) -> bool {
  return ch >= "0" && ch <= "9"
}

fn is_alpha(ch: String) -> bool {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch == "_"
}

fn is_alnum(ch: String) -> bool {
  return is_alpha(ch) || is_digit(ch)
}

fn is_keyword(text: String) -> bool {
  return text == "pub" || text == "fn" || text == "async" || text == "let" || text == "mut" || text == "return" || text == "if" || text == "else" || text == "while" || text == "break" || text == "continue" || text == "move" || text == "true" || text == "false"
}

pub fn tokenize_program(source: String) -> String {
  let mut tokens = []
  let mut index: usize = 0
  let mut line: usize = 1
  let mut column: usize = 1
  while index < source.length {
    let ch = source[index]
    if ch == "\\n" {
      index += 1
      line += 1
      column = 1
      continue
    }
    if is_space(ch) {
      index += 1
      column += 1
      continue
    }
    if ch == "/" && source[index + 1] == "/" {
      while index < source.length && source[index] != "\\n" {
        index += 1
        column += 1
      }
      continue
    }
    if ch == "\\\"" || ch == "'" {
      let quote = ch
      let start_line = line
      let start_column = column
      let mut text = ch
      index += 1
      column += 1
      let mut escaped = false
      while index < source.length {
        let current = source[index]
        text = text + current
        index += 1
        column += 1
        if escaped {
          escaped = false
          continue
        }
        if current == "\\\\" {
          escaped = true
          continue
        }
        if current == quote { break }
      }
      tokens.push(["string", text, start_line, start_column])
      continue
    }
    if is_digit(ch) {
      let start_line = line
      let start_column = column
      let mut text = ""
      while index < source.length && (is_digit(source[index]) || source[index] == "_") {
        text = text + source[index]
        index += 1
        column += 1
      }
      tokens.push(["number", text, start_line, start_column])
      continue
    }
    if is_alpha(ch) {
      let start_line = line
      let start_column = column
      let mut text = ""
      while index < source.length && is_alnum(source[index]) {
        text = text + source[index]
        index += 1
        column += 1
      }
      let mut kind = "identifier"
      if is_keyword(text) { kind = "keyword" }
      tokens.push([kind, text, start_line, start_column])
      continue
    }
    let start_line = line
    let start_column = column
    let two = ch + source[index + 1]
    if two == "->" || two == "=>" || two == "==" || two == "!=" || two == "<=" || two == ">=" || two == "&&" || two == "||" || two == "+=" || two == "-=" || two == "*=" || two == "/=" || two == "::" {
      tokens.push(["symbol", two, start_line, start_column])
      index += 2
      column += 2
      continue
    }
    tokens.push(["symbol", ch, start_line, start_column])
    index += 1
    column += 1
  }
  tokens.push(["eof", "", line, column])
  return JSON.stringify(tokens)
}

fn has_name(names, name: String) -> bool {
  let mut index: usize = 0
  while index < names.length {
    if names[index] == name { return true }
    index += 1
  }
  return false
}

pub fn analyze_program(source: String) -> String {
  let tokens = JSON.parse(tokenize_program(source))
  let mut diagnostics = []
  let mut braces: i32 = 0
  let mut parens: i32 = 0
  let mut brackets: i32 = 0
  let mut functions: usize = 0
  let mut names = []
  let mut moved = []
  let mut index: usize = 0
  while index < tokens.length {
    let token = tokens[index]
    let text = token[1]
    if text == "{" { braces += 1 }
    if text == "}" { braces -= 1 }
    if text == "(" { parens += 1 }
    if text == ")" { parens -= 1 }
    if text == "[" { brackets += 1 }
    if text == "]" { brackets -= 1 }
    if braces < 0 || parens < 0 || brackets < 0 {
      diagnostics.push(["KR-SELF-PARSE-0001", "Closing delimiter has no matching opener.", token[2], token[3]])
    }
    if text == "fn" {
      functions += 1
      let name = tokens[index + 1][1]
      if has_name(names, name) { diagnostics.push(["KR-SELF-NAME-0001", "Duplicate function " + name + ".", token[2], token[3]]) }
      names.push(name)
      if tokens[index + 2][1] != "(" { diagnostics.push(["KR-SELF-PARSE-0002", "Function parameter list is missing.", token[2], token[3]]) }
    }
    if text == ":" {
      let type_name = tokens[index + 1][1]
      if type_name != "String" && type_name != "bool" && type_name != "i32" && type_name != "u32" && type_name != "usize" {
        diagnostics.push(["KR-SELF-TYPE-0001", "Unsupported bootstrap type " + type_name + ".", token[2], token[3]])
      }
    }
    if text == "move" {
      moved.push(tokens[index + 1][1])
      index += 2
      continue
    }
    if token[0] == "identifier" && has_name(moved, text) {
      let previous = tokens[index - 1][1]
      if previous != "move" && previous != "=" {
        diagnostics.push(["KR-SELF-BORROW-0001", "Use of moved value " + text + ".", token[2], token[3]])
      }
    }
    index += 1
  }
  if braces != 0 || parens != 0 || brackets != 0 { diagnostics.push(["KR-SELF-PARSE-0003", "Unbalanced delimiters.", 1, 1]) }
  if functions == 0 { diagnostics.push(["KR-SELF-PARSE-0004", "A module must contain at least one function.", 1, 1]) }
  return JSON.stringify([frontend_version(), functions, diagnostics, tokens.length])
}

`;

export function createSelfHostMigrationManifest() {
  return Object.freeze({
    stage: 'module-compiler',
    phase: 'frontend-assisted-module-compiler',
    migrated: Object.freeze([
      'bootstrap source transformation',
      'multi-function module emission',
      'Kura-authored deterministic lexical scanner',
      'Kura-authored source-position tracking',
      'Kura-authored delimiter and function syntax checks',
      'Kura-authored bootstrap scalar type checks',
      'Kura-authored duplicate symbol checks',
      'Kura-authored move-after-use diagnostics',
      'array, indexing, assignment and while language support',
      'fixed-point module compiler reproduction',
    ]),
    integration: Object.freeze({
      stage0Frontend: 'trusted JavaScript typed compiler',
      stage1Compiler: 'Kura module emitter compiled by Stage 0',
      stage2Compiler: 'Stage 1 self-reproduction',
      migratedFrontend: 'Kura frontend module compiled by Stage 0 and exercised during bootstrap',
      fixedPointRequired: true,
    }),
    remaining: Object.freeze([
      'self-reproduction of the complete frontend module',
      'complete production AST parser migration',
      'generic and trait solver migration',
      'complete NLL borrow dataflow migration',
      'LLVM backend migration',
      'package manager and LSP migration',
    ]),
    fullCompilerMigration: false,
    frontendLogicMigrated: true,
  });
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
async function importText(code, nonce = '') { return import(`data:text/javascript;base64,${Buffer.from(`${code}\n//${nonce}`).toString('base64')}`); }
function decodeAnalysis(raw) {
  const [version, functions, diagnostics, tokenCount] = JSON.parse(raw);
  return { version, functions, diagnostics: diagnostics.map(([code, message, line, column]) => ({ code, message, line, column })), tokenCount, ok: diagnostics.length === 0 };
}

export async function bootstrapSelfHostedCompiler(options = {}) {
  const source = options.source ?? SELF_HOST_COMPILER_SOURCE;
  const stage0 = compileLanguage(source, { file: options.file ?? 'self-host/compiler.kr', autoRun: false });
  const stage1Module = await importText(stage0.code, 'stage1');
  if (typeof stage1Module.compile_program !== 'function') throw new Error('Stage 0 did not produce compile_program.');
  const stage2Code = stage1Module.compile_program(source);
  const stage2Module = await importText(stage2Code, 'stage2');
  if (typeof stage2Module.compile_program !== 'function') throw new Error('Stage 1 failed to reproduce the compiler.');
  const stage3Code = stage2Module.compile_program(source);
  const fixedPoint = stage2Code === stage3Code;
  if (!fixedPoint) throw new Error('Self-host module compiler failed fixed-point verification.');

  const frontend = compileLanguage(SELF_HOST_FRONTEND_SOURCE, { file: 'self-host/frontend.kr', autoRun: false });
  const frontendModule = await importText(frontend.code, 'frontend');
  if (typeof frontendModule.tokenize_program !== 'function' || typeof frontendModule.analyze_program !== 'function') throw new Error('Kura frontend module did not export its scanner/checker API.');
  const frontendSelfAnalysis = decodeAnalysis(frontendModule.analyze_program(SELF_HOST_FRONTEND_SOURCE));
  if (!frontendSelfAnalysis.ok) throw new Error(`Kura frontend self-analysis failed: ${JSON.stringify(frontendSelfAnalysis.diagnostics[0])}`);

  const probeSource = options.probeSource ?? 'pub fn normalize(source: String) -> String { return source.trim() }\npub fn answer(source: String) -> String { return normalize(source) }';
  const probeAnalysis = decodeAnalysis(frontendModule.analyze_program(probeSource));
  if (!probeAnalysis.ok) throw new Error(`Self-host probe analysis failed: ${JSON.stringify(probeAnalysis.diagnostics[0])}`);
  const probeCode = stage2Module.compile_program(probeSource);
  const probeModule = await importText(probeCode, 'probe');
  const probeResult = probeModule.answer('  Kura  ');
  if (probeResult !== 'Kura') throw new Error(`Self-host probe returned ${JSON.stringify(probeResult)}.`);
  const invalidAnalysis = decodeAnalysis(frontendModule.analyze_program('pub fn broken(value: Unknown) -> String { return value }'));
  if (invalidAnalysis.ok || !invalidAnalysis.diagnostics.some(item => item.code === 'KR-SELF-TYPE-0001')) throw new Error('Kura frontend did not reject an unsupported bootstrap type.');

  return {
    fixedPoint, source, stage0Code: stage0.code, stage2Code, stage3Code,
    frontendSource: SELF_HOST_FRONTEND_SOURCE, frontendCode: frontend.code,
    frontendSelfAnalysis, invalidAnalysis, probeSource, probeCode, probeResult, probeAnalysis,
    stage1Version: stage2Module.compiler_version?.() ?? null,
    frontendVersion: frontendModule.frontend_version?.() ?? null,
    migration: createSelfHostMigrationManifest(),
    hashes: { source: hash(source), stage0: hash(stage0.code), stage2: hash(stage2Code), stage3: hash(stage3Code), frontendSource: hash(SELF_HOST_FRONTEND_SOURCE), frontendCode: hash(frontend.code), frontendTokens: hash(frontendModule.tokenize_program(SELF_HOST_FRONTEND_SOURCE)) },
    capabilities: { compilerWrittenInKura: true, moduleCompilerMigrated: true, selfReproduction: true, fixedPoint: true, deterministicScanner: true, syntaxValidation: true, bootstrapTypeChecking: true, moveDiagnostics: true, frontendModuleWrittenInKura: true, fullCompilerMigration: false },
  };
}

export async function compileWithSelfHostedCompiler(source, options = {}) {
  const bootstrap = await bootstrapSelfHostedCompiler(options);
  const compiler = await importText(bootstrap.stage2Code, `compile-${Date.now()}`);
  const frontend = await importText(bootstrap.frontendCode, `frontend-${Date.now()}`);
  const analysis = decodeAnalysis(frontend.analyze_program(source));
  if (!analysis.ok) { const first = analysis.diagnostics[0]; const error = new Error(`${first.code} at ${first.line}:${first.column}: ${first.message}`); error.code = first.code; error.diagnostics = analysis.diagnostics; throw error; }
  return { code: compiler.compile_program(source), analysis, compilerHash: bootstrap.hashes.stage2, frontendHash: bootstrap.hashes.frontendCode, compilerVersion: compiler.compiler_version?.() ?? bootstrap.stage1Version, migration: bootstrap.migration };
}

export async function writeSelfHostArtifacts(directory, options = {}) {
  const output = resolve(directory); await mkdir(output, { recursive: true });
  const result = await bootstrapSelfHostedCompiler(options);
  const files = { source: resolve(output, 'compiler.kr'), frontendSource: resolve(output, 'frontend.kr'), stage0: resolve(output, 'compiler-stage0.mjs'), stage1: resolve(output, 'compiler-stage1.mjs'), frontend: resolve(output, 'frontend-stage0.mjs'), report: resolve(output, 'self-host-report.json') };
  await writeFile(files.source, result.source); await writeFile(files.frontendSource, result.frontendSource); await writeFile(files.stage0, result.stage0Code); await writeFile(files.stage1, result.stage2Code); await writeFile(files.frontend, result.frontendCode);
  await writeFile(files.report, JSON.stringify({ fixedPoint: result.fixedPoint, hashes: result.hashes, probeResult: result.probeResult, stage1Version: result.stage1Version, frontendVersion: result.frontendVersion, frontendSelfAnalysis: result.frontendSelfAnalysis, invalidAnalysis: result.invalidAnalysis, migration: result.migration, capabilities: result.capabilities }, null, 2) + '\n');
  return { ...result, files };
}

export async function verifySelfHostArtifacts(directory) {
  const source = await readFile(resolve(directory, 'compiler.kr'), 'utf8'); const stage1 = await readFile(resolve(directory, 'compiler-stage1.mjs'), 'utf8');
  const compiler = await import(pathToFileURL(resolve(directory, 'compiler-stage1.mjs')).href + `?v=${Date.now()}`);
  const frontend = await import(pathToFileURL(resolve(directory, 'frontend-stage0.mjs')).href + `?v=${Date.now()}`);
  const analysis = decodeAnalysis(frontend.analyze_program(await readFile(resolve(directory, 'frontend.kr'), 'utf8'))); const reproduced = compiler.compile_program(source);
  return { ok: analysis.ok && reproduced === stage1, analysis, expectedHash: hash(stage1), actualHash: hash(reproduced) };
}
