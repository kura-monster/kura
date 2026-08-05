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
  return "1.3-kura-ast-frontend"
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

fn token_text(tokens, index: usize) -> String {
  if index >= tokens.length { return "" }
  return tokens[index][1]
}

fn find_matching_token(tokens, start: usize, open: String, close: String) -> usize {
  let mut depth: i32 = 0
  let mut index: usize = start
  while index < tokens.length {
    let text = token_text(tokens, index)
    if text == open { depth += 1 }
    if text == close {
      depth -= 1
      if depth == 0 { return index }
    }
    index += 1
  }
  return tokens.length - 1
}

fn statement_end(tokens, start: usize, limit: usize) -> usize {
  let mut parens: i32 = 0
  let mut brackets: i32 = 0
  let start_line = tokens[start][2]
  let mut index: usize = start
  while index < limit {
    if index > start && parens == 0 && brackets == 0 && tokens[index][2] > start_line { return index }
    let text = token_text(tokens, index)
    if text == "(" { parens += 1 }
    if text == ")" { parens -= 1 }
    if text == "[" { brackets += 1 }
    if text == "]" { brackets -= 1 }
    if parens == 0 && brackets == 0 && (text == ";" || text == "}") { return index }
    index += 1
  }
  return limit
}

fn parse_parameters(tokens, start: usize, end: usize) {
  let mut parameters = []
  let mut index: usize = start
  while index < end {
    if token_text(tokens, index) == "," {
      index += 1
      continue
    }
    let name = token_text(tokens, index)
    let mut type_name = "unknown"
    if token_text(tokens, index + 1) == ":" {
      type_name = token_text(tokens, index + 2)
      index += 3
    } else {
      index += 1
    }
    parameters.push([name, type_name])
  }
  return parameters
}

fn parse_body(tokens, start: usize, end: usize) {
  let mut statements = []
  let mut index: usize = start
  while index < end {
    let text = token_text(tokens, index)
    if text == "let" {
      let mut mutable = false
      let mut name_index = index + 1
      if token_text(tokens, name_index) == "mut" {
        mutable = true
        name_index += 1
      }
      let name = token_text(tokens, name_index)
      let mut type_name = "inferred"
      let mut cursor = name_index + 1
      if token_text(tokens, cursor) == ":" {
        type_name = token_text(tokens, cursor + 1)
        cursor += 2
      }
      while cursor < end && token_text(tokens, cursor) != "=" && token_text(tokens, cursor) != ";" && token_text(tokens, cursor) != "}" { cursor += 1 }
      let expression_start = cursor + 1
      let finish = statement_end(tokens, expression_start, end)
      statements.push(["let", name, type_name, expression_start, finish, mutable])
      index = finish
      continue
    }
    if text == "return" {
      let finish = statement_end(tokens, index + 1, end)
      statements.push(["return", index + 1, finish])
      index = finish
      continue
    }
    if text == "while" || text == "if" {
      let condition_start = index + 1
      let mut block_start = condition_start
      while block_start < end && token_text(tokens, block_start) != "{" { block_start += 1 }
      let block_end = find_matching_token(tokens, block_start, "{", "}")
      statements.push([text, condition_start, block_start, block_start + 1, block_end])
      index = block_end + 1
      continue
    }
    if tokens[index][0] == "identifier" && token_text(tokens, index - 1) != "." && token_text(tokens, index + 1) == "(" {
      let close = find_matching_token(tokens, index + 1, "(", ")")
      let mut argument_count: usize = 0
      let mut cursor = index + 2
      if cursor < close { argument_count = 1 }
      let mut nested: i32 = 0
      while cursor < close {
        let current = token_text(tokens, cursor)
        if current == "(" || current == "[" { nested += 1 }
        if current == ")" || current == "]" { nested -= 1 }
        if current == "," && nested == 0 { argument_count += 1 }
        cursor += 1
      }
      statements.push(["call", text, argument_count, index, close])
      index = close + 1
      continue
    }
    if tokens[index][0] == "identifier" && (token_text(tokens, index + 1) == "=" || token_text(tokens, index + 1) == "+=" || token_text(tokens, index + 1) == "-=") {
      let finish = statement_end(tokens, index + 2, end)
      statements.push(["assign", text, index + 2, finish])
      index = finish
      continue
    }
    index += 1
  }
  return statements
}

pub fn parse_program(source: String) -> String {
  let tokens = JSON.parse(tokenize_program(source))
  let mut module = []
  let mut diagnostics = []
  let mut index: usize = 0
  while index < tokens.length {
    let mut public_item = false
    let mut async_item = false
    if token_text(tokens, index) == "pub" {
      public_item = true
      index += 1
    }
    if token_text(tokens, index) == "async" {
      async_item = true
      index += 1
    }
    if token_text(tokens, index) != "fn" {
      index += 1
      continue
    }
    let function_token = tokens[index]
    let name = token_text(tokens, index + 1)
    let open = index + 2
    if token_text(tokens, open) != "(" {
      diagnostics.push(["KR-SELF-AST-0001", "Function parameter list is missing.", function_token[2], function_token[3]])
      index += 1
      continue
    }
    let close = find_matching_token(tokens, open, "(", ")")
    let parameters = parse_parameters(tokens, open + 1, close)
    let mut return_type = "void"
    let mut body_open = close + 1
    if token_text(tokens, body_open) == "->" {
      return_type = token_text(tokens, body_open + 1)
      body_open += 2
    }
    while body_open < tokens.length && token_text(tokens, body_open) != "{" { body_open += 1 }
    if body_open >= tokens.length {
      diagnostics.push(["KR-SELF-AST-0002", "Function body is missing.", function_token[2], function_token[3]])
      index = close + 1
      continue
    }
    let body_close = find_matching_token(tokens, body_open, "{", "}")
    let body = parse_body(tokens, body_open + 1, body_close)
    module.push(["function", name, parameters, return_type, body, public_item, async_item, function_token[2], function_token[3]])
    index = body_close + 1
  }
  return JSON.stringify(["module", module, diagnostics])
}

pub fn build_symbol_table(source: String) -> String {
  let ast = JSON.parse(parse_program(source))
  let functions = ast[1]
  let mut symbols = []
  let mut diagnostics = ast[2]
  let mut index: usize = 0
  while index < functions.length {
    let function_node = functions[index]
    let name = function_node[1]
    let mut duplicate = false
    let mut scan: usize = 0
    while scan < symbols.length {
      if symbols[scan][0] == name { duplicate = true }
      scan += 1
    }
    if duplicate {
      diagnostics.push(["KR-SELF-SYMBOL-0001", "Duplicate symbol " + name + ".", function_node[7], function_node[8]])
    } else {
      symbols.push([name, function_node[2].length, function_node[3], function_node[5], function_node[6]])
    }
    index += 1
  }
  return JSON.stringify([symbols, diagnostics])
}

fn expression_type(tokens, start: usize, end: usize, locals) -> String {
  if start >= end { return "void" }
  if token_text(tokens, start) == "JSON" && token_text(tokens, start + 1) == "." && token_text(tokens, start + 2) == "stringify" { return "String" }
  let mut scan: usize = start
  while scan < end {
    let operator = tokens[scan][1]
    if operator == "==" || operator == "!=" || operator == "<" || operator == ">" || operator == "<=" || operator == ">=" || operator == "&&" || operator == "||" { return "bool" }
    scan += 1
  }
  let token = tokens[start]
  let text = token[1]
  if token[0] == "string" { return "String" }
  if token[0] == "number" { return "i32" }
  if text == "true" || text == "false" { return "bool" }
  let mut index: usize = 0
  while index < locals.length {
    if locals[index][0] == text { return locals[index][1] }
    index += 1
  }
  return "unknown"
}

fn types_compatible(expected: String, actual: String) -> bool {
  if actual == "unknown" || expected == actual { return true }
  if actual == "i32" && (expected == "u32" || expected == "usize") { return true }
  return false
}

pub fn typecheck_program(source: String) -> String {
  let tokens = JSON.parse(tokenize_program(source))
  let ast = JSON.parse(parse_program(source))
  let functions = ast[1]
  let symbol_result = JSON.parse(build_symbol_table(source))
  let symbols = symbol_result[0]
  let mut diagnostics = symbol_result[1]
  let mut function_index: usize = 0
  while function_index < functions.length {
    let function_node = functions[function_index]
    let parameters = function_node[2]
    let return_type = function_node[3]
    let body = function_node[4]
    let mut locals = []
    let mut parameter_index: usize = 0
    while parameter_index < parameters.length {
      locals.push(parameters[parameter_index])
      parameter_index += 1
    }
    let mut statement_index: usize = 0
    while statement_index < body.length {
      let statement = body[statement_index]
      if statement[0] == "let" {
        let declared = statement[2]
        let inferred = expression_type(tokens, statement[3], statement[4], locals)
        let mut actual = declared
        if actual == "inferred" { actual = inferred }
        if declared != "inferred" && !types_compatible(declared, inferred) {
          diagnostics.push(["KR-SELF-TYPE-0101", "Initializer type " + inferred + " does not match " + declared + ".", function_node[7], function_node[8]])
        }
        locals.push([statement[1], actual])
      }
      if statement[0] == "return" {
        let actual = expression_type(tokens, statement[1], statement[2], locals)
        if return_type != "void" && !types_compatible(return_type, actual) {
          diagnostics.push(["KR-SELF-TYPE-0102", "Return type " + actual + " does not match " + return_type + ".", function_node[7], function_node[8]])
        }
      }
      if statement[0] == "call" {
        let target = statement[1]
        let mut found = false
        let mut symbol_index: usize = 0
        while symbol_index < symbols.length {
          if symbols[symbol_index][0] == target {
            found = true
            if symbols[symbol_index][1] != statement[2] {
              diagnostics.push(["KR-SELF-CALL-0002", "Call to " + target + " has the wrong argument count.", function_node[7], function_node[8]])
            }
          }
          symbol_index += 1
        }
        if !found {
          diagnostics.push(["KR-SELF-CALL-0001", "Unknown function " + target + ".", function_node[7], function_node[8]])
        }
      }
      statement_index += 1
    }
    function_index += 1
  }
  return JSON.stringify([diagnostics.length == 0, diagnostics, functions.length, symbols.length])
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
      'Kura-authored AST parser for functions, parameters, statements and calls',
      'Kura-authored symbol table construction',
      'Kura-authored return, initializer and call type checks',
      'array, indexing, assignment and while language support',
      'fixed-point module compiler reproduction',
    ]),
    integration: Object.freeze({
      stage0Frontend: 'trusted JavaScript typed compiler',
      stage1Compiler: 'Kura module emitter compiled by Stage 0',
      stage2Compiler: 'Stage 1 self-reproduction',
      migratedFrontend: 'Kura lexer, AST parser, symbol table and bootstrap type checker compiled by Stage 0 and exercised during bootstrap',
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
  const frontendAst = JSON.parse(frontendModule.parse_program(SELF_HOST_FRONTEND_SOURCE));
  const frontendSymbols = JSON.parse(frontendModule.build_symbol_table(SELF_HOST_FRONTEND_SOURCE));
  const frontendTypecheck = JSON.parse(frontendModule.typecheck_program(SELF_HOST_FRONTEND_SOURCE));
  if (frontendAst[2].length !== 0 || frontendSymbols[1].length !== 0 || frontendTypecheck[0] !== true) {
    throw new Error(`Kura AST frontend rejected itself: ${JSON.stringify(frontendTypecheck[1][0] ?? frontendAst[2][0])}`);
  }

  const probeSource = options.probeSource ?? 'pub fn normalize(source: String) -> String { return source.trim() }\npub fn answer(source: String) -> String { return normalize(source) }';
  const probeAnalysis = decodeAnalysis(frontendModule.analyze_program(probeSource));
  if (!probeAnalysis.ok) throw new Error(`Self-host probe analysis failed: ${JSON.stringify(probeAnalysis.diagnostics[0])}`);
  const probeCode = stage2Module.compile_program(probeSource);
  const probeModule = await importText(probeCode, 'probe');
  const probeResult = probeModule.answer('  Kura  ');
  if (probeResult !== 'Kura') throw new Error(`Self-host probe returned ${JSON.stringify(probeResult)}.`);
  const invalidAnalysis = decodeAnalysis(frontendModule.analyze_program('pub fn broken(value: Unknown) -> String { return value }'));
  if (invalidAnalysis.ok || !invalidAnalysis.diagnostics.some(item => item.code === 'KR-SELF-TYPE-0001')) throw new Error('Kura frontend did not reject an unsupported bootstrap type.');
  const invalidTypecheck = JSON.parse(frontendModule.typecheck_program('pub fn broken() -> String { return 42 }'));
  if (invalidTypecheck[0] || !invalidTypecheck[1].some(item => item[0] === 'KR-SELF-TYPE-0102')) throw new Error('Kura AST type checker did not reject a return mismatch.');

  return {
    fixedPoint, source, stage0Code: stage0.code, stage2Code, stage3Code,
    frontendSource: SELF_HOST_FRONTEND_SOURCE, frontendCode: frontend.code,
    frontendSelfAnalysis, frontendAst, frontendSymbols, frontendTypecheck, invalidAnalysis, invalidTypecheck, probeSource, probeCode, probeResult, probeAnalysis,
    stage1Version: stage2Module.compiler_version?.() ?? null,
    frontendVersion: frontendModule.frontend_version?.() ?? null,
    migration: createSelfHostMigrationManifest(),
    hashes: { source: hash(source), stage0: hash(stage0.code), stage2: hash(stage2Code), stage3: hash(stage3Code), frontendSource: hash(SELF_HOST_FRONTEND_SOURCE), frontendCode: hash(frontend.code), frontendTokens: hash(frontendModule.tokenize_program(SELF_HOST_FRONTEND_SOURCE)), frontendAst: hash(JSON.stringify(frontendAst)), frontendSymbols: hash(JSON.stringify(frontendSymbols)) },
    capabilities: { compilerWrittenInKura: true, moduleCompilerMigrated: true, selfReproduction: true, fixedPoint: true, deterministicScanner: true, syntaxValidation: true, bootstrapTypeChecking: true, moveDiagnostics: true, astParserWrittenInKura: true, symbolTableWrittenInKura: true, typeCheckerWrittenInKura: true, frontendModuleWrittenInKura: true, fullCompilerMigration: false },
  };
}

export async function compileWithSelfHostedCompiler(source, options = {}) {
  const bootstrap = await bootstrapSelfHostedCompiler(options);
  const compiler = await importText(bootstrap.stage2Code, `compile-${Date.now()}`);
  const frontend = await importText(bootstrap.frontendCode, `frontend-${Date.now()}`);
  const analysis = decodeAnalysis(frontend.analyze_program(source));
  const ast = JSON.parse(frontend.parse_program(source));
  const typecheck = JSON.parse(frontend.typecheck_program(source));
  if (!analysis.ok) { const first = analysis.diagnostics[0]; const error = new Error(`${first.code} at ${first.line}:${first.column}: ${first.message}`); error.code = first.code; error.diagnostics = analysis.diagnostics; throw error; }
  if (!typecheck[0]) { const first = typecheck[1][0]; const error = new Error(`${first[0]}: ${first[1]}`); error.code = first[0]; error.diagnostics = typecheck[1]; throw error; }
  return { code: compiler.compile_program(source), analysis, ast, typecheck, compilerHash: bootstrap.hashes.stage2, frontendHash: bootstrap.hashes.frontendCode, compilerVersion: compiler.compiler_version?.() ?? bootstrap.stage1Version, migration: bootstrap.migration };
}

export async function writeSelfHostArtifacts(directory, options = {}) {
  const output = resolve(directory); await mkdir(output, { recursive: true });
  const result = await bootstrapSelfHostedCompiler(options);
  const files = { source: resolve(output, 'compiler.kr'), frontendSource: resolve(output, 'frontend.kr'), stage0: resolve(output, 'compiler-stage0.mjs'), stage1: resolve(output, 'compiler-stage1.mjs'), frontend: resolve(output, 'frontend-stage0.mjs'), report: resolve(output, 'self-host-report.json') };
  await writeFile(files.source, result.source); await writeFile(files.frontendSource, result.frontendSource); await writeFile(files.stage0, result.stage0Code); await writeFile(files.stage1, result.stage2Code); await writeFile(files.frontend, result.frontendCode);
  await writeFile(files.report, JSON.stringify({ fixedPoint: result.fixedPoint, hashes: result.hashes, probeResult: result.probeResult, stage1Version: result.stage1Version, frontendVersion: result.frontendVersion, frontendSelfAnalysis: result.frontendSelfAnalysis, frontendAst: result.frontendAst, frontendSymbols: result.frontendSymbols, frontendTypecheck: result.frontendTypecheck, invalidAnalysis: result.invalidAnalysis, migration: result.migration, capabilities: result.capabilities }, null, 2) + '\n');
  return { ...result, files };
}

export async function verifySelfHostArtifacts(directory) {
  const source = await readFile(resolve(directory, 'compiler.kr'), 'utf8'); const stage1 = await readFile(resolve(directory, 'compiler-stage1.mjs'), 'utf8');
  const compiler = await import(pathToFileURL(resolve(directory, 'compiler-stage1.mjs')).href + `?v=${Date.now()}`);
  const frontend = await import(pathToFileURL(resolve(directory, 'frontend-stage0.mjs')).href + `?v=${Date.now()}`);
  const frontendSource = await readFile(resolve(directory, 'frontend.kr'), 'utf8'); const analysis = decodeAnalysis(frontend.analyze_program(frontendSource)); const typecheck = JSON.parse(frontend.typecheck_program(frontendSource)); const reproduced = compiler.compile_program(source);
  return { ok: analysis.ok && typecheck[0] && reproduced === stage1, analysis, typecheck, expectedHash: hash(stage1), actualHash: hash(reproduced) };
}
