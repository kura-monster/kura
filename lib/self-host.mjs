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
  return "1.4-kura-semantic-frontend"
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
  return text == "pub" || text == "fn" || text == "async" || text == "let" || text == "mut" || text == "return" || text == "if" || text == "else" || text == "while" || text == "break" || text == "continue" || text == "move" || text == "true" || text == "false" || text == "match" || text == "enum" || text == "struct" || text == "trait" || text == "impl" || text == "for" || text == "where" || text == "as"
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
  let mut generic_names = []
  let generic_functions = parse_generic_function_signatures(tokens)
  let mut generic_function_index: usize = 0
  while generic_function_index < generic_functions.length {
    let mut generic_index: usize = 0
    while generic_index < generic_functions[generic_function_index][1].length {
      add_name(generic_names, generic_functions[generic_function_index][1][generic_index][0])
      generic_index += 1
    }
    generic_function_index += 1
  }
  let mut trait_names = []
  let mut trait_scan: usize = 0
  while trait_scan < tokens.length {
    if token_text(tokens, trait_scan) == "trait" { add_name(trait_names, token_text(tokens, trait_scan + 1)) }
    trait_scan += 1
  }
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
      let mut parameter_token: usize = index + 2
      if token_text(tokens, parameter_token) == "<" { parameter_token = find_matching_token(tokens, parameter_token, "<", ">") + 1 }
      if token_text(tokens, parameter_token) != "(" { diagnostics.push(["KR-SELF-PARSE-0002", "Function parameter list is missing.", token[2], token[3]]) }
    }
    if text == ":" {
      let type_name = tokens[index + 1][1]
      if type_name != "String" && type_name != "bool" && type_name != "i32" && type_name != "u32" && type_name != "usize" && !has_name(generic_names, type_name) && !builtin_trait(type_name) && !has_name(trait_names, type_name) {
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
    let mut signature_cursor: usize = index + 2
    if token_text(tokens, signature_cursor) == "<" { signature_cursor = find_matching_token(tokens, signature_cursor, "<", ">") + 1 }
    let open = signature_cursor
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
    if token_text(tokens, body_open) == "where" {
      while body_open < tokens.length && token_text(tokens, body_open) != "{" { body_open += 1 }
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


fn binary_precedence(operator: String) -> i32 {
  if operator == "||" { return 1 }
  if operator == "&&" { return 2 }
  if operator == "==" || operator == "!=" { return 3 }
  if operator == "<" || operator == ">" || operator == "<=" || operator == ">=" { return 4 }
  if operator == "+" || operator == "-" { return 5 }
  if operator == "*" || operator == "/" || operator == "%" { return 6 }
  return -1
}

fn parse_primary_expression(tokens, start: usize, end: usize) {
  if start >= end { return [["missing"], start] }
  let token = tokens[start]
  let text = token[1]
  if text == "!" || text == "-" || text == "move" || text == "&" {
    let operand = parse_primary_expression(tokens, start + 1, end)
    return [["unary", text, operand[0]], operand[1]]
  }
  if text == "(" {
    let close = find_matching_token(tokens, start, "(", ")")
    let nested = parse_binary_expression(tokens, start + 1, close, 0)
    return [nested[0], close + 1]
  }
  if text == "[" {
    let close = find_matching_token(tokens, start, "[", "]")
    let mut values = []
    let mut cursor: usize = start + 1
    let mut item_start: usize = cursor
    let mut depth: i32 = 0
    while cursor <= close {
      let current = token_text(tokens, cursor)
      if current == "(" || current == "[" { depth += 1 }
      if current == ")" || current == "]" { depth -= 1 }
      if (current == "," && depth == 0) || cursor == close {
        if item_start < cursor { values.push(parse_binary_expression(tokens, item_start, cursor, 0)[0]) }
        item_start = cursor + 1
      }
      cursor += 1
    }
    return [["array", values], close + 1]
  }
  if token[0] == "string" { return [["literal", "String", text], start + 1] }
  if token[0] == "number" { return [["literal", "i32", text], start + 1] }
  if text == "true" || text == "false" { return [["literal", "bool", text], start + 1] }
  if token[0] == "identifier" || token[0] == "keyword" {
    let mut path = text
    let mut cursor: usize = start + 1
    while token_text(tokens, cursor) == "::" {
      path = path + "::" + token_text(tokens, cursor + 1)
      cursor += 2
    }
    let mut node = ["name", path]
    if token_text(tokens, cursor) == "(" {
      let close = find_matching_token(tokens, cursor, "(", ")")
      let mut call_args = []
      let mut argument_start: usize = cursor + 1
      let mut scan: usize = argument_start
      let mut depth: i32 = 0
      while scan <= close {
        let current = token_text(tokens, scan)
        if current == "(" || current == "[" { depth += 1 }
        if current == ")" || current == "]" { depth -= 1 }
        if (current == "," && depth == 0) || scan == close {
          if argument_start < scan { call_args.push(parse_binary_expression(tokens, argument_start, scan, 0)[0]) }
          argument_start = scan + 1
        }
        scan += 1
      }
      node = ["call", path, call_args]
      cursor = close + 1
    }
    while token_text(tokens, cursor) == "[" {
      let close = find_matching_token(tokens, cursor, "[", "]")
      let index_node = parse_binary_expression(tokens, cursor + 1, close, 0)[0]
      node = ["index", node, index_node]
      cursor = close + 1
    }
    return [node, cursor]
  }
  return [["unknown", text], start + 1]
}

fn parse_binary_expression(tokens, start: usize, end: usize, minimum: i32) {
  let primary = parse_primary_expression(tokens, start, end)
  let mut left = primary[0]
  let mut index: usize = primary[1]
  while index < end {
    let operator = token_text(tokens, index)
    let precedence = binary_precedence(operator)
    if precedence < minimum { break }
    let right = parse_binary_expression(tokens, index + 1, end, precedence + 1)
    left = ["binary", operator, left, right[0]]
    index = right[1]
  }
  return [left, index]
}

pub fn parse_expression(source: String) -> String {
  let tokens = JSON.parse(tokenize_program(source))
  let end: usize = tokens.length - 1
  let result = parse_binary_expression(tokens, 0, end, 0)
  let mut diagnostics = []
  if result[1] < end { diagnostics.push(["KR-SELF-EXPR-0001", "Expression contains trailing tokens.", tokens[result[1]][2], tokens[result[1]][3]]) }
  return JSON.stringify([result[0], diagnostics])
}

fn split_pattern(tokens, start: usize, end: usize, separator: String) {
  let mut depth: i32 = 0
  let mut index: usize = start
  while index < end {
    let text = token_text(tokens, index)
    if text == "(" || text == "[" { depth += 1 }
    if text == ")" || text == "]" { depth -= 1 }
    if text == separator && depth == 0 { return index }
    index += 1
  }
  return end
}

fn parse_pattern_range(tokens, start: usize, end: usize) {
  let alternative = split_pattern(tokens, start, end, "|")
  if alternative < end {
    return ["or", parse_pattern_range(tokens, start, alternative), parse_pattern_range(tokens, alternative + 1, end)]
  }
  let binding = split_pattern(tokens, start, end, "@")
  if binding < end {
    return ["bind", token_text(tokens, start), parse_pattern_range(tokens, binding + 1, end)]
  }
  let text = token_text(tokens, start)
  if text == "_" { return ["wildcard"] }
  if tokens[start][0] == "string" || tokens[start][0] == "number" || text == "true" || text == "false" { return ["literal", text] }
  let mut path = text
  let mut variant_path = false
  let mut cursor: usize = start + 1
  while cursor < end && token_text(tokens, cursor) == "::" {
    variant_path = true
    path = path + "::" + token_text(tokens, cursor + 1)
    cursor += 2
  }
  if cursor < end && token_text(tokens, cursor) == "(" {
    let close = find_matching_token(tokens, cursor, "(", ")")
    let mut fields = []
    let mut field_start: usize = cursor + 1
    let mut scan: usize = field_start
    let mut depth: i32 = 0
    while scan <= close {
      let current = token_text(tokens, scan)
      if current == "(" { depth += 1 }
      if current == ")" { depth -= 1 }
      if (current == "," && depth == 0) || scan == close {
        if field_start < scan { fields.push(parse_pattern_range(tokens, field_start, scan)) }
        field_start = scan + 1
      }
      scan += 1
    }
    return ["variant", path, fields]
  }
  if variant_path { return ["variant", path, []] }
  return ["binding", path]
}

pub fn parse_pattern(source: String) -> String {
  let tokens = JSON.parse(tokenize_program(source))
  return JSON.stringify(parse_pattern_range(tokens, 0, tokens.length - 1))
}

fn parse_bound_list(tokens, start: usize, end: usize) {
  let mut bounds = []
  let mut index: usize = start
  while index < end {
    let text = token_text(tokens, index)
    if text != "+" && text != "," { bounds.push(text) }
    index += 1
  }
  return bounds
}

fn parse_generic_function_signatures(tokens) {
  let mut functions = []
  let mut index: usize = 0
  while index < tokens.length {
    if token_text(tokens, index) != "fn" { index += 1; continue }
    let name = token_text(tokens, index + 1)
    let mut cursor: usize = index + 2
    let mut generics = []
    if token_text(tokens, cursor) == "<" {
      let close = find_matching_token(tokens, cursor, "<", ">")
      let mut parameter_start: usize = cursor + 1
      let mut scan: usize = parameter_start
      while scan <= close {
        if token_text(tokens, scan) == "," || scan == close {
          if parameter_start < scan {
            let mut colon: usize = parameter_start
            while colon < scan && token_text(tokens, colon) != ":" { colon += 1 }
            let mut bounds = []
            if colon < scan { bounds = parse_bound_list(tokens, colon + 1, scan) }
            generics.push([token_text(tokens, parameter_start), bounds])
          }
          parameter_start = scan + 1
        }
        scan += 1
      }
      cursor = close + 1
    }
    while cursor < tokens.length && token_text(tokens, cursor) != "(" { cursor += 1 }
    let parameter_close = find_matching_token(tokens, cursor, "(", ")")
    cursor = parameter_close + 1
    if token_text(tokens, cursor) == "->" { cursor += 2 }
    let mut where_bounds = []
    if token_text(tokens, cursor) == "where" {
      cursor += 1
      let mut clause_start: usize = cursor
      while cursor < tokens.length && token_text(tokens, cursor) != "{" {
        if token_text(tokens, cursor) == "," {
          let mut colon: usize = clause_start
          while colon < cursor && token_text(tokens, colon) != ":" { colon += 1 }
          if colon < cursor { where_bounds.push([token_text(tokens, clause_start), parse_bound_list(tokens, colon + 1, cursor)]) }
          clause_start = cursor + 1
        }
        cursor += 1
      }
      if clause_start < cursor {
        let mut colon: usize = clause_start
        while colon < cursor && token_text(tokens, colon) != ":" { colon += 1 }
        if colon < cursor { where_bounds.push([token_text(tokens, clause_start), parse_bound_list(tokens, colon + 1, cursor)]) }
      }
    }
    functions.push([name, generics, where_bounds])
    index = cursor + 1
  }
  return functions
}

fn builtin_trait(name: String) -> bool {
  return name == "Copy" || name == "Clone" || name == "Send" || name == "Sync" || name == "Display" || name == "Debug" || name == "Eq" || name == "Ord"
}

pub fn analyze_generic_constraints(source: String) -> String {
  let tokens = JSON.parse(tokenize_program(source))
  let mut traits = []
  let mut impls = []
  let mut diagnostics = []
  let mut index: usize = 0
  while index < tokens.length {
    let text = token_text(tokens, index)
    if text == "trait" { traits.push(token_text(tokens, index + 1)) }
    if text == "impl" {
      let trait_name = token_text(tokens, index + 1)
      let mut cursor: usize = index + 2
      while cursor < tokens.length && token_text(tokens, cursor) != "for" && token_text(tokens, cursor) != "{" { cursor += 1 }
      if token_text(tokens, cursor) == "for" { impls.push([trait_name, token_text(tokens, cursor + 1)]) }
    }
    index += 1
  }
  let functions = parse_generic_function_signatures(tokens)
  let mut function_index: usize = 0
  while function_index < functions.length {
    let function_node = functions[function_index]
    let mut generic_names = []
    let mut generic_index: usize = 0
    while generic_index < function_node[1].length {
      let generic = function_node[1][generic_index]
      generic_names.push(generic[0])
      let mut bound_index: usize = 0
      while bound_index < generic[1].length {
        let bound = generic[1][bound_index]
        if !builtin_trait(bound) && !has_name(traits, bound) { diagnostics.push(["KR-SELF-TRAIT-0001", "Unknown trait bound " + bound + ".", 1, 1]) }
        bound_index += 1
      }
      generic_index += 1
    }
    let mut where_index: usize = 0
    while where_index < function_node[2].length {
      let clause = function_node[2][where_index]
      if !has_name(generic_names, clause[0]) { diagnostics.push(["KR-SELF-GENERIC-0001", "Where clause references unknown generic " + clause[0] + ".", 1, 1]) }
      let mut bound_index: usize = 0
      while bound_index < clause[1].length {
        let bound = clause[1][bound_index]
        if !builtin_trait(bound) && !has_name(traits, bound) { diagnostics.push(["KR-SELF-TRAIT-0001", "Unknown trait bound " + bound + ".", 1, 1]) }
        bound_index += 1
      }
      where_index += 1
    }
    function_index += 1
  }
  let mut impl_index: usize = 0
  while impl_index < impls.length {
    if !builtin_trait(impls[impl_index][0]) && !has_name(traits, impls[impl_index][0]) { diagnostics.push(["KR-SELF-TRAIT-0002", "Implementation targets unknown trait " + impls[impl_index][0] + ".", 1, 1]) }
    impl_index += 1
  }
  return JSON.stringify([diagnostics.length == 0, traits, impls, functions, diagnostics])
}

fn clone_names(names) {
  let mut result = []
  let mut index: usize = 0
  while index < names.length { result.push(names[index]); index += 1 }
  return result
}

fn add_name(names, name: String) {
  if !has_name(names, name) { names.push(name) }
}

fn remove_name(names, name: String) {
  let mut result = []
  let mut index: usize = 0
  while index < names.length {
    if names[index] != name { result.push(names[index]) }
    index += 1
  }
  return result
}

fn intersect_names(left, right) {
  let mut result = []
  let mut index: usize = 0
  while index < left.length {
    if has_name(right, left[index]) { result.push(left[index]) }
    index += 1
  }
  return result
}

fn scan_move_range(tokens, start: usize, end: usize, incoming, diagnostics, loop_depth: usize) {
  let mut moved = clone_names(incoming)
  let mut index: usize = start
  while index < end {
    let text = token_text(tokens, index)
    if text == "if" {
      let mut block_open: usize = index + 1
      while block_open < end && token_text(tokens, block_open) != "{" { block_open += 1 }
      let block_close = find_matching_token(tokens, block_open, "{", "}")
      let then_result = scan_move_range(tokens, block_open + 1, block_close, moved, diagnostics, loop_depth)
      let mut else_result = clone_names(moved)
      let mut next: usize = block_close + 1
      if token_text(tokens, next) == "else" && token_text(tokens, next + 1) == "{" {
        let else_close = find_matching_token(tokens, next + 1, "{", "}")
        else_result = scan_move_range(tokens, next + 2, else_close, moved, diagnostics, loop_depth)
        next = else_close + 1
      }
      moved = intersect_names(then_result, else_result)
      index = next
      continue
    }
    if text == "while" {
      let mut block_open: usize = index + 1
      while block_open < end && token_text(tokens, block_open) != "{" { block_open += 1 }
      let block_close = find_matching_token(tokens, block_open, "{", "}")
      let loop_result = scan_move_range(tokens, block_open + 1, block_close, moved, diagnostics, loop_depth + 1)
      let mut moved_index: usize = 0
      while moved_index < loop_result.length {
        if !has_name(moved, loop_result[moved_index]) { diagnostics.push(["KR-SELF-BORROW-0102", "Value " + loop_result[moved_index] + " may be moved more than once by a loop.", tokens[index][2], tokens[index][3]]) }
        moved_index += 1
      }
      index = block_close + 1
      continue
    }
    if text == "move" {
      let name = token_text(tokens, index + 1)
      if has_name(moved, name) { diagnostics.push(["KR-SELF-BORROW-0101", "Value " + name + " is moved more than once.", tokens[index][2], tokens[index][3]]) }
      add_name(moved, name)
      index += 2
      continue
    }
    if tokens[index][0] == "identifier" && token_text(tokens, index + 1) == "=" {
      moved = remove_name(moved, text)
      index += 1
      continue
    }
    if tokens[index][0] == "identifier" && has_name(moved, text) && token_text(tokens, index - 1) != "move" {
      diagnostics.push(["KR-SELF-BORROW-0103", "Use of moved value " + text + ".", tokens[index][2], tokens[index][3]])
    }
    index += 1
  }
  return moved
}

pub fn analyze_move_dataflow(source: String) -> String {
  let tokens = JSON.parse(tokenize_program(source))
  let mut diagnostics = []
  let moved = scan_move_range(tokens, 0, tokens.length - 1, [], diagnostics, 0)
  return JSON.stringify([diagnostics.length == 0, moved, diagnostics])
}

fn local_symbol_type(locals, name: String) -> String {
  let mut index: usize = 0
  while index < locals.length {
    if locals[index][0] == name { return locals[index][1] }
    index += 1
  }
  return "unknown"
}

fn function_symbol_type(symbols, name: String) -> String {
  let mut index: usize = 0
  while index < symbols.length {
    if symbols[index][0] == name { return symbols[index][2] }
    index += 1
  }
  return "unknown"
}

fn infer_expression_node(node, locals, symbols) -> String {
  if node[0] == "literal" { return node[1] }
  if node[0] == "name" { return local_symbol_type(locals, node[1]) }
  if node[0] == "call" { return function_symbol_type(symbols, node[1]) }
  if node[0] == "array" { return "array" }
  if node[0] == "index" { return "unknown" }
  if node[0] == "unary" {
    if node[1] == "!" { return "bool" }
    return infer_expression_node(node[2], locals, symbols)
  }
  if node[0] == "binary" {
    let operator = node[1]
    if operator == "==" || operator == "!=" || operator == "<" || operator == ">" || operator == "<=" || operator == ">=" || operator == "&&" || operator == "||" { return "bool" }
    let left = infer_expression_node(node[2], locals, symbols)
    let right = infer_expression_node(node[3], locals, symbols)
    if left == right { return left }
    if left == "unknown" { return right }
    return left
  }
  return "unknown"
}

pub fn semantic_typecheck_program(source: String) -> String {
  let tokens = JSON.parse(tokenize_program(source))
  let ast = JSON.parse(parse_program(source))
  let functions = ast[1]
  let symbol_result = JSON.parse(build_symbol_table(source))
  let symbols = symbol_result[0]
  let mut diagnostics = symbol_result[1]
  let mut function_index: usize = 0
  while function_index < functions.length {
    let function_node = functions[function_index]
    let mut locals = []
    let mut parameter_index: usize = 0
    while parameter_index < function_node[2].length { locals.push(function_node[2][parameter_index]); parameter_index += 1 }
    let mut statement_index: usize = 0
    while statement_index < function_node[4].length {
      let statement = function_node[4][statement_index]
      if statement[0] == "let" {
        let expression = parse_binary_expression(tokens, statement[3], statement[4], 0)[0]
        let inferred = infer_expression_node(expression, locals, symbols)
        let declared = statement[2]
        let mut actual = declared
        if actual == "inferred" { actual = inferred }
        if declared != "inferred" && !types_compatible(declared, inferred) { diagnostics.push(["KR-SELF-TYPE-0201", "Semantic initializer type " + inferred + " does not match " + declared + ".", function_node[7], function_node[8]]) }
        locals.push([statement[1], actual])
      }
      if statement[0] == "return" {
        let expression = parse_binary_expression(tokens, statement[1], statement[2], 0)[0]
        let inferred = infer_expression_node(expression, locals, symbols)
        if function_node[3] != "void" && !types_compatible(function_node[3], inferred) { diagnostics.push(["KR-SELF-TYPE-0202", "Semantic return type " + inferred + " does not match " + function_node[3] + ".", function_node[7], function_node[8]]) }
      }
      statement_index += 1
    }
    function_index += 1
  }
  let generic_result = JSON.parse(analyze_generic_constraints(source))
  let mut generic_index: usize = 0
  while generic_index < generic_result[4].length { diagnostics.push(generic_result[4][generic_index]); generic_index += 1 }
  let move_result = JSON.parse(analyze_move_dataflow(source))
  let mut move_index: usize = 0
  while move_index < move_result[2].length { diagnostics.push(move_result[2][move_index]); move_index += 1 }
  return JSON.stringify([diagnostics.length == 0, diagnostics, functions.length, symbols.length])
}

`;


export const SELF_HOST_TRAIT_SOLVER_SOURCE = `pub fn trait_solver_version() -> String {
  return "1.1-kura-hrtb-projection-trait-solver"
}

fn solver_text(tokens, index: usize) -> String {
  if index >= tokens.length { return "" }
  return tokens[index][1]
}

fn solver_has(values, value: String) -> bool {
  let mut index: usize = 0
  while index < values.length {
    if values[index] == value { return true }
    index += 1
  }
  return false
}

fn solver_add(values, value: String) {
  if !solver_has(values, value) { values.push(value) }
}

fn solver_find_close(tokens, start: usize, open: String, close: String) -> usize {
  let mut depth: i32 = 0
  let mut index: usize = start
  while index < tokens.length {
    let text = solver_text(tokens, index)
    if text == open { depth += 1 }
    if text == close {
      depth -= 1
      if depth == 0 { return index }
    }
    index += 1
  }
  return tokens.length - 1
}

fn solver_join(tokens, start: usize, end: usize) -> String {
  let mut result = ""
  let mut index: usize = start
  while index < end {
    result = result + solver_text(tokens, index)
    index += 1
  }
  return result
}

fn solver_generic_names(tokens, start: usize) {
  let mut names = []
  if solver_text(tokens, start) != "<" { return [names, start] }
  let close = solver_find_close(tokens, start, "<", ">")
  let mut index: usize = start + 1
  while index < close {
    let text = solver_text(tokens, index)
    if tokens[index][0] == "identifier" && solver_text(tokens, index - 1) != ":" { solver_add(names, text) }
    while index < close && solver_text(tokens, index) != "," { index += 1 }
    if solver_text(tokens, index) == "," { index += 1 }
  }
  return [names, close + 1]
}

fn solver_normalize_pattern(pattern: String, generics) -> String {
  let mut result = pattern
  let mut index: usize = 0
  while index < generics.length {
    result = result.replaceAll(generics[index], "_")
    index += 1
  }
  return result
}

fn solver_type_base(pattern: String) -> String {
  let open = pattern.indexOf("<")
  if open < 0 { return pattern }
  return pattern.slice(0, open)
}

fn solver_type_args(pattern: String) {
  let open = pattern.indexOf("<")
  let close = pattern.lastIndexOf(">")
  if open < 0 || close <= open { return [] }
  return pattern.slice(open + 1, close).split(",")
}

fn solver_patterns_overlap(left: String, right: String) -> bool {
  if left == right || left == "_" || right == "_" { return true }
  if solver_type_base(left) != solver_type_base(right) { return false }
  let left_args = solver_type_args(left)
  let right_args = solver_type_args(right)
  if left_args.length != right_args.length { return false }
  let mut index: usize = 0
  while index < left_args.length {
    if left_args[index] != right_args[index] && left_args[index] != "_" && right_args[index] != "_" { return false }
    index += 1
  }
  return true
}

fn solver_assoc_names(traits, trait_name: String) {
  let mut index: usize = 0
  while index < traits.length {
    if traits[index][0] == trait_name { return traits[index][1] }
    index += 1
  }
  return []
}

fn solver_binding_value(bindings, name: String) -> String {
  let mut index: usize = 0
  while index < bindings.length {
    if bindings[index][0] == name { return bindings[index][1] }
    index += 1
  }
  return ""
}

fn solver_substitution_value(substitutions, name: String) -> String {
  let mut index: usize = 0
  while index < substitutions.length {
    if substitutions[index][0] == name { return substitutions[index][1] }
    index += 1
  }
  return ""
}

fn solver_match_substitutions(raw_pattern: String, generics, query_type: String) {
  let mut substitutions = []
  let raw_args = solver_type_args(raw_pattern)
  let query_args = solver_type_args(query_type)
  if solver_type_base(raw_pattern) != solver_type_base(query_type) || raw_args.length != query_args.length { return substitutions }
  let mut index: usize = 0
  while index < raw_args.length {
    if solver_has(generics, raw_args[index]) { substitutions.push([raw_args[index], query_args[index]]) }
    index += 1
  }
  return substitutions
}

fn solver_substitute(value: String, substitutions) -> String {
  let mut result = value
  let mut index: usize = 0
  while index < substitutions.length {
    result = result.replaceAll(substitutions[index][0], substitutions[index][1])
    index += 1
  }
  return result
}

pub fn solve_trait_tokens(tokens_json: String, query_trait: String, query_type: String, query_assoc: String) -> String {
  let tokens = JSON.parse(tokens_json)
  let mut diagnostics = []
  let mut traits = []
  let mut local_traits = []
  let mut local_types = []
  let mut implementations = []
  let mut higher_ranked = []
  let mut requested_assoc = query_assoc
  if requested_assoc == null { requested_assoc = "" }
  let mut index: usize = 0
  while index < tokens.length {
    let text = solver_text(tokens, index)
    if text == "for" && solver_text(tokens, index + 1) == "<" {
      let close = solver_find_close(tokens, index + 1, "<", ">")
      let mut binders = []
      let mut binder_index: usize = index + 2
      while binder_index < close {
        if tokens[binder_index][0] == "identifier" {
          if solver_has(binders, solver_text(tokens, binder_index)) { diagnostics.push(["KR-SELF-TRAIT-1101", "Duplicate higher-ranked binder " + solver_text(tokens, binder_index) + ".", tokens[binder_index][2], tokens[binder_index][3]]) }
          solver_add(binders, solver_text(tokens, binder_index))
        }
        binder_index += 1
      }
      let mut bound_end: usize = close + 1
      while bound_end < tokens.length && solver_text(tokens, bound_end) != "," && solver_text(tokens, bound_end) != "{" && solver_text(tokens, bound_end) != ";" { bound_end += 1 }
      higher_ranked.push([binders, solver_join(tokens, close + 1, bound_end), tokens[index][2], tokens[index][3]])
    }
    if text == "struct" || text == "enum" { solver_add(local_types, solver_text(tokens, index + 1)) }
    if text == "trait" {
      let name = solver_text(tokens, index + 1)
      if solver_has(local_traits, name) { diagnostics.push(["KR-SELF-TRAIT-1001", "Duplicate trait " + name + ".", tokens[index][2], tokens[index][3]]) }
      solver_add(local_traits, name)
      let mut body_open: usize = index + 2
      while body_open < tokens.length && solver_text(tokens, body_open) != "{" { body_open += 1 }
      let body_close = solver_find_close(tokens, body_open, "{", "}")
      let mut associated = []
      let mut cursor: usize = body_open + 1
      while cursor < body_close {
        if solver_text(tokens, cursor) == "type" {
          let assoc = solver_text(tokens, cursor + 1)
          if solver_has(associated, assoc) { diagnostics.push(["KR-SELF-TRAIT-1002", "Duplicate associated type " + assoc + " in trait " + name + ".", tokens[cursor][2], tokens[cursor][3]]) }
          solver_add(associated, assoc)
        }
        cursor += 1
      }
      traits.push([name, associated, tokens[index][2], tokens[index][3]])
      index = body_close + 1
      continue
    }
    index += 1
  }

  index = 0
  while index < tokens.length {
    if solver_text(tokens, index) != "impl" { index += 1; continue }
    let generic_result = solver_generic_names(tokens, index + 1)
    let generics = generic_result[0]
    let mut cursor: usize = generic_result[1]
    let trait_name = solver_text(tokens, cursor)
    cursor += 1
    while cursor < tokens.length && solver_text(tokens, cursor) != "for" && solver_text(tokens, cursor) != "{" { cursor += 1 }
    if solver_text(tokens, cursor) != "for" { index += 1; continue }
    cursor += 1
    let type_start = cursor
    while cursor < tokens.length && solver_text(tokens, cursor) != "{" && solver_text(tokens, cursor) != "where" { cursor += 1 }
    let raw_pattern = solver_join(tokens, type_start, cursor)
    let pattern = solver_normalize_pattern(raw_pattern, generics)
    while cursor < tokens.length && solver_text(tokens, cursor) != "{" { cursor += 1 }
    let body_open = cursor
    let body_close = solver_find_close(tokens, body_open, "{", "}")
    let mut bindings = []
    cursor = body_open + 1
    while cursor < body_close {
      if solver_text(tokens, cursor) == "type" {
        let assoc = solver_text(tokens, cursor + 1)
        let mut value_start: usize = cursor + 2
        while value_start < body_close && solver_text(tokens, value_start) != "=" { value_start += 1 }
        value_start += 1
        let mut value_end = value_start
        let line = tokens[cursor][2]
        while value_end < body_close && solver_text(tokens, value_end) != ";" && tokens[value_end][2] == line { value_end += 1 }
        if solver_binding_value(bindings, assoc) != "" { diagnostics.push(["KR-SELF-TRAIT-1003", "Duplicate associated type binding " + assoc + ".", tokens[cursor][2], tokens[cursor][3]]) }
        bindings.push([assoc, solver_join(tokens, value_start, value_end)])
        cursor = value_end
        continue
      }
      cursor += 1
    }
    implementations.push([trait_name, pattern, bindings, generics, tokens[index][2], tokens[index][3], raw_pattern])
    index = body_close + 1
  }

  let mut impl_index: usize = 0
  while impl_index < implementations.length {
    let implementation = implementations[impl_index]
    let trait_name = implementation[0]
    let type_base = solver_type_base(implementation[1])
    if !solver_has(local_traits, trait_name) { diagnostics.push(["KR-SELF-TRAIT-1004", "Implementation references unknown trait " + trait_name + ".", implementation[4], implementation[5]]) }
    if !solver_has(local_traits, trait_name) && !solver_has(local_types, type_base) { diagnostics.push(["KR-SELF-TRAIT-1005", "Orphan implementation of " + trait_name + " for " + implementation[1] + ".", implementation[4], implementation[5]]) }
    let required = solver_assoc_names(traits, trait_name)
    let mut assoc_index: usize = 0
    while assoc_index < required.length {
      if solver_binding_value(implementation[2], required[assoc_index]) == "" { diagnostics.push(["KR-SELF-TRAIT-1006", "Missing associated type " + required[assoc_index] + " in implementation of " + trait_name + ".", implementation[4], implementation[5]]) }
      assoc_index += 1
    }
    assoc_index = 0
    while assoc_index < implementation[2].length {
      if !solver_has(required, implementation[2][assoc_index][0]) { diagnostics.push(["KR-SELF-TRAIT-1007", "Unknown associated type " + implementation[2][assoc_index][0] + " for trait " + trait_name + ".", implementation[4], implementation[5]]) }
      assoc_index += 1
    }
    let mut other: usize = impl_index + 1
    while other < implementations.length {
      if implementations[other][0] == trait_name && solver_patterns_overlap(implementation[1], implementations[other][1]) {
        diagnostics.push(["KR-SELF-TRAIT-1008", "Overlapping implementations of " + trait_name + " for " + implementation[1] + " and " + implementations[other][1] + ".", implementations[other][4], implementations[other][5]])
      }
      other += 1
    }
    impl_index += 1
  }

  let mut matches = []
  let mut projections = []
  if query_trait != "" && query_type != "" {
    impl_index = 0
    while impl_index < implementations.length {
      if implementations[impl_index][0] == query_trait && solver_patterns_overlap(implementations[impl_index][1], query_type) { matches.push(implementations[impl_index]) }
      impl_index += 1
    }
    if matches.length == 0 { diagnostics.push(["KR-SELF-TRAIT-1009", "Unsatisfied trait obligation " + query_trait + " for " + query_type + ".", 1, 1]) }
    if matches.length > 1 { diagnostics.push(["KR-SELF-TRAIT-1010", "Ambiguous trait obligation " + query_trait + " for " + query_type + ".", 1, 1]) }
    if matches.length == 1 && requested_assoc != "" {
      let binding = solver_binding_value(matches[0][2], requested_assoc)
      if binding == "" { diagnostics.push(["KR-SELF-TRAIT-1102", "Associated type projection " + query_trait + "::" + requested_assoc + " is not defined for " + query_type + ".", 1, 1]) }
      else {
        let substitutions = solver_match_substitutions(matches[0][6], matches[0][3], query_type)
        projections.push([requested_assoc, solver_substitute(binding, substitutions), substitutions])
      }
    }
  }
  return JSON.stringify([diagnostics.length == 0, traits, implementations, diagnostics, matches, trait_solver_version(), projections, higher_ranked])
}
`;

export const SELF_HOST_BORROW_CHECKER_SOURCE = `pub fn borrow_checker_version() -> String {
  return "2.0-kura-cfg-region-borrow-checker"
}

fn borrow_overlap(left: String, right: String) -> bool {
  return left == right || left.startsWith(right + ".") || right.startsWith(left + ".")
}

fn borrow_has_path(paths, path: String) -> bool {
  let mut index: usize = 0
  while index < paths.length {
    if borrow_overlap(paths[index], path) { return true }
    index += 1
  }
  return false
}

fn borrow_remove_assigned(paths, path: String) {
  let mut result = []
  let mut index: usize = 0
  while index < paths.length {
    if !borrow_overlap(paths[index], path) { result.push(paths[index]) }
    index += 1
  }
  return result
}

fn borrow_expire(loans, point: usize) {
  let mut active = []
  let mut index: usize = 0
  while index < loans.length {
    let loan = loans[index]
    if loan[4] == "suspended" && loan[6] < point { loan[4] = "active" }
    if loan[3] >= point { active.push(loan) }
    index += 1
  }
  return active
}

fn borrow_loan_index(loans, name: String) -> i32 {
  let mut index: usize = 0
  while index < loans.length {
    if loans[index][0] == name { return index }
    index += 1
  }
  return -1
}

fn borrow_conflict(loans, target: String, kind: String, ignored: String) -> String {
  let mut index: usize = 0
  while index < loans.length {
    let loan = loans[index]
    if loan[0] != ignored && loan[4] != "suspended" && borrow_overlap(loan[1], target) {
      if loan[4] == "reserved" {
        if kind == "mut" { return loan[0] }
      } else if kind == "mut" || loan[2] == "mut" { return loan[0] }
    }
    index += 1
  }
  return ""
}

fn borrow_activation_conflict(loans, target: String, ignored: String) -> String {
  let mut index: usize = 0
  while index < loans.length {
    let loan = loans[index]
    if loan[0] != ignored && loan[4] != "suspended" && borrow_overlap(loan[1], target) { return loan[0] }
    index += 1
  }
  return ""
}

fn borrow_any_loan(loans, target: String) -> String {
  let mut index: usize = 0
  while index < loans.length {
    if loans[index][4] != "suspended" && borrow_overlap(loans[index][1], target) { return loans[index][0] }
    index += 1
  }
  return ""
}

fn borrow_crosses_await(loans, point: usize) {
  let mut result = []
  let mut index: usize = 0
  while index < loans.length {
    let loan = loans[index]
    if loan[4] != "suspended" && loan[3] > point && !loan[1].startsWith("static.") && !loan[1].startsWith("global.") { result.push(loan) }
    index += 1
  }
  return result
}

pub fn check_borrow_paths(plan_json: String) -> String {
  let paths = JSON.parse(plan_json)
  let mut diagnostics = []
  let mut summaries = []
  let mut path_index: usize = 0
  while path_index < paths.length {
    let path_id = paths[path_index][0]
    let operations = paths[path_index][1]
    let mut loans = []
    let mut moved = []
    let mut operation_index: usize = 0
    while operation_index < operations.length {
      let operation = operations[operation_index]
      let kind = operation[0]
      let name = operation[1]
      let target = operation[2]
      let borrow_kind = operation[3]
      let point = operation[4]
      let last_use = operation[5]
      let line = operation[6]
      let column = operation[7]
      let mut parent = ""
      if operation.length > 8 && operation[8] != null { parent = operation[8] }
      loans = borrow_expire(loans, point)
      if kind == "borrow" || kind == "call_borrow" {
        let conflict = borrow_conflict(loans, target, borrow_kind, "")
        if conflict != "" { diagnostics.push(["KR-SELF-BORROW-0201", "Borrow of " + target + " conflicts with active reference " + conflict + " on path " + path_id + ".", line, column, path_id]) }
        if borrow_has_path(moved, target) { diagnostics.push(["KR-SELF-BORROW-0205", "Cannot borrow moved path " + target + " on path " + path_id + ".", line, column, path_id]) }
        loans.push([name, target, borrow_kind, last_use, "active", parent, last_use])
      }
      if kind == "capture_ref_move" || kind == "capture_ref_shared" {
        let conflict = borrow_conflict(loans, target, borrow_kind, name)
        if conflict != "" && conflict != name { diagnostics.push(["KR-SELF-BORROW-0310", "Closure capture of " + target + " conflicts with active reference " + conflict + " on path " + path_id + ".", line, column, path_id]) }
        loans.push(["closure." + name, target, borrow_kind, last_use, "active", name, last_use])
      }
      if kind == "reborrow" {
        let parent_index = borrow_loan_index(loans, parent)
        if parent_index < 0 { diagnostics.push(["KR-SELF-BORROW-0301", "Reborrow " + name + " has no live parent reference " + parent + " on path " + path_id + ".", line, column, path_id]) }
        else {
          if borrow_kind == "mut" && loans[parent_index][2] != "mut" { diagnostics.push(["KR-SELF-BORROW-0302", "Mutable reborrow " + name + " requires a mutable parent reference on path " + path_id + ".", line, column, path_id]) }
          let conflict = borrow_conflict(loans, target, borrow_kind, parent)
          if conflict != "" { diagnostics.push(["KR-SELF-BORROW-0201", "Reborrow of " + target + " conflicts with active reference " + conflict + " on path " + path_id + ".", line, column, path_id]) }
          if borrow_kind == "mut" { loans[parent_index][4] = "suspended"; loans[parent_index][6] = last_use }
          loans.push([name, target, borrow_kind, last_use, "active", parent, last_use])
        }
      }
      if kind == "reserve" {
        let conflict = borrow_conflict(loans, target, "mut", "")
        if conflict != "" && loans[borrow_loan_index(loans, conflict)][2] == "mut" { diagnostics.push(["KR-SELF-BORROW-0303", "Two-phase reservation of " + target + " conflicts with mutable reference " + conflict + " on path " + path_id + ".", line, column, path_id]) }
        loans.push([name, target, "mut", last_use, "reserved", "", last_use])
      }
      if kind == "activate" {
        let reservation_index = borrow_loan_index(loans, name)
        if reservation_index < 0 { diagnostics.push(["KR-SELF-BORROW-0305", "Two-phase activation has no reservation " + name + " on path " + path_id + ".", line, column, path_id]) }
        else {
          let conflict = borrow_activation_conflict(loans, target, name)
          if conflict != "" { diagnostics.push(["KR-SELF-BORROW-0306", "Activation of mutable receiver " + target + " conflicts with " + conflict + " on path " + path_id + ".", line, column, path_id]) }
          loans[reservation_index][4] = "active"
          loans[reservation_index][3] = point
        }
      }
      if kind == "await" {
        let crossings = borrow_crosses_await(loans, point)
        let mut crossing_index: usize = 0
        while crossing_index < crossings.length {
          diagnostics.push(["KR-SELF-BORROW-0304", "Reference " + crossings[crossing_index][0] + " to " + crossings[crossing_index][1] + " crosses await on path " + path_id + " without a stable async region.", line, column, path_id])
          crossing_index += 1
        }
      }
      if kind == "move" {
        let loan = borrow_any_loan(loans, target)
        if loan != "" { diagnostics.push(["KR-SELF-BORROW-0202", "Cannot move " + target + " while reference " + loan + " is live on path " + path_id + ".", line, column, path_id]) }
        if borrow_has_path(moved, target) { diagnostics.push(["KR-SELF-BORROW-0206", "Path " + target + " is moved more than once on path " + path_id + ".", line, column, path_id]) }
        moved.push(target)
      }
      if kind == "assign" {
        let loan = borrow_any_loan(loans, target)
        if loan != "" { diagnostics.push(["KR-SELF-BORROW-0203", "Cannot assign " + target + " while reference " + loan + " is live on path " + path_id + ".", line, column, path_id]) }
        moved = borrow_remove_assigned(moved, target)
      }
      if kind == "use" {
        if borrow_has_path(moved, target) { diagnostics.push(["KR-SELF-BORROW-0204", "Use of moved path " + target + " on path " + path_id + ".", line, column, path_id]) }
      }
      if kind == "use_ref" {
        let reference_index = borrow_loan_index(loans, name)
        if reference_index < 0 { diagnostics.push(["KR-SELF-BORROW-0207", "Reference " + name + " is not live on path " + path_id + ".", line, column, path_id]) }
        else if loans[reference_index][4] == "suspended" { diagnostics.push(["KR-SELF-BORROW-0307", "Parent reference " + name + " is suspended by a mutable reborrow on path " + path_id + ".", line, column, path_id]) }
      }
      operation_index += 1
    }
    summaries.push([path_id, loans, moved, operations.length])
    path_index += 1
  }
  return JSON.stringify([diagnostics.length == 0, diagnostics, summaries, borrow_checker_version()])
}
`;
export const SELF_HOST_CFG_REGION_SOURCE = `pub fn cfg_region_version() -> String {
  return "1.0-kura-cfg-region-analyzer"
}

fn cfg_text(tokens, index: usize) -> String {
  if index >= tokens.length { return "" }
  return tokens[index][1]
}

fn cfg_has(values, value: String) -> bool {
  let mut index: usize = 0
  while index < values.length {
    if values[index] == value { return true }
    index += 1
  }
  return false
}

fn cfg_add(values, value: String) {
  if !cfg_has(values, value) { values.push(value) }
}

fn cfg_has_number(values, value: usize) -> bool {
  let mut index: usize = 0
  while index < values.length {
    if values[index] == value { return true }
    index += 1
  }
  return false
}

fn cfg_find_close(tokens, start: usize, open: String, close: String) -> usize {
  let mut depth: i32 = 0
  let mut index: usize = start
  while index < tokens.length {
    let text = cfg_text(tokens, index)
    if text == open { depth += 1 }
    if text == close {
      depth -= 1
      if depth == 0 { return index }
    }
    index += 1
  }
  return tokens.length - 1
}

fn cfg_copy_segments(segments) {
  let mut result = []
  let mut index: usize = 0
  while index < segments.length {
    result.push([segments[index][0], segments[index][1]])
    index += 1
  }
  return result
}

fn cfg_with_segment(segments, start: usize, end: usize) {
  let result = cfg_copy_segments(segments)
  if start < end { result.push([start, end]) }
  return result
}

fn cfg_walk_paths(tokens, segments, start: usize, end: usize, id: String, output) {
  let mut index: usize = start
  let linear_start = start
  while index < end {
    let text = cfg_text(tokens, index)
    if text != "if" && text != "while" {
      index += 1
      continue
    }
    let mut open: usize = index + 1
    while open < end && cfg_text(tokens, open) != "{" { open += 1 }
    if open >= end {
      index += 1
      continue
    }
    let close = cfg_find_close(tokens, open, "{", "}")
    let before = cfg_with_segment(segments, linear_start, index)
    if text == "if" {
      let mut next: usize = close + 1
      let mut else_open: i32 = -1
      let mut else_close: i32 = -1
      if cfg_text(tokens, next) == "else" && cfg_text(tokens, next + 1) == "{" {
        else_open = next + 1
        else_close = cfg_find_close(tokens, next + 1, "{", "}")
        next = else_close + 1
      }
      let mut branches = []
      cfg_walk_paths(tokens, before, open + 1, close, id + ".then", branches)
      if else_open >= 0 { cfg_walk_paths(tokens, before, else_open + 1, else_close, id + ".else", branches) }
      else { branches.push([id + ".else", before]) }
      let mut branch_index: usize = 0
      while branch_index < branches.length {
        cfg_walk_paths(tokens, branches[branch_index][1], next, end, branches[branch_index][0], output)
        branch_index += 1
      }
      return
    }
    let mut loops = []
    loops.push([id + ".loop0", before])
    cfg_walk_paths(tokens, before, open + 1, close, id + ".loop1", loops)
    let mut loop_index: usize = 0
    while loop_index < loops.length {
      cfg_walk_paths(tokens, loops[loop_index][1], close + 1, end, loops[loop_index][0], output)
      loop_index += 1
    }
    return
  }
  output.push([id, cfg_with_segment(segments, linear_start, end)])
}

fn cfg_read_path(tokens, start: usize) {
  if start >= tokens.length || tokens[start][0] != "identifier" { return ["", start] }
  let mut path = cfg_text(tokens, start)
  let mut index: usize = start + 1
  while cfg_text(tokens, index) == "." && index + 1 < tokens.length && tokens[index + 1][0] == "identifier" {
    path = path + "." + cfg_text(tokens, index + 1)
    index += 2
  }
  return [path, index]
}

fn cfg_root(path: String) -> String {
  let dot = path.indexOf(".")
  if dot < 0 { return path }
  return path.slice(0, dot)
}

fn cfg_reference_index(references, name: String) -> i32 {
  let mut index: usize = 0
  while index < references.length {
    if references[index][0] == name { return index }
    index += 1
  }
  return -1
}

fn cfg_reference_target(references, name: String) -> String {
  let index = cfg_reference_index(references, name)
  if index < 0 { return "" }
  return references[index][1]
}

fn cfg_reference_kind(references, name: String) -> String {
  let index = cfg_reference_index(references, name)
  if index < 0 { return "" }
  return references[index][2]
}

fn cfg_is_mutating_method(name: String) -> bool {
  return name == "push" || name == "append" || name == "insert" || name == "remove" || name == "clear" || name == "set" || name == "update" || name == "write" || name == "send"
}

fn cfg_token_in_segments(segments, token_index: usize) -> bool {
  let mut index: usize = 0
  while index < segments.length {
    if token_index >= segments[index][0] && token_index < segments[index][1] { return true }
    index += 1
  }
  return false
}

fn cfg_collect_indices(segments) {
  let mut result = []
  let mut segment_index: usize = 0
  while segment_index < segments.length {
    let mut index: usize = segments[segment_index][0]
    while index < segments[segment_index][1] {
      result.push(index)
      index += 1
    }
    segment_index += 1
  }
  return result
}

fn cfg_path_used(tokens, indices, start_position: usize, end_token: usize, name: String) -> bool {
  let mut position = start_position
  while position < indices.length {
    let index = indices[position]
    if index >= end_token { return false }
    if cfg_text(tokens, index) == name { return true }
    position += 1
  }
  return false
}

fn cfg_last_ref_uses(operations) {
  let mut values = []
  let mut index: usize = 0
  while index < operations.length {
    let operation = operations[index]
    if operation[0] == "use_ref" || operation[0] == "reborrow" || operation[0] == "capture_ref_move" || operation[0] == "capture_ref_shared" {
      let name = operation[1]
      let mut found: i32 = -1
      let mut value_index: usize = 0
      while value_index < values.length {
        if values[value_index][0] == name { found = value_index }
        value_index += 1
      }
      if found < 0 { values.push([name, operation[4]]) }
      else { values[found][1] = operation[4] }
    }
    index += 1
  }
  return values
}

fn cfg_last_use(values, name: String, fallback: usize) -> usize {
  let mut index: usize = 0
  while index < values.length {
    if values[index][0] == name { return values[index][1] }
    index += 1
  }
  return fallback
}

fn cfg_emit_pending_activations(pending, token_index: usize, operations, point: usize) -> usize {
  let mut index: usize = 0
  let mut next_point = point
  while index < pending.length {
    if pending[index][0] == token_index {
      operations.push(["activate", pending[index][1], pending[index][2], "mut", next_point, next_point, pending[index][3], pending[index][4], ""])
      next_point += 1
    }
    index += 1
  }
  return next_point
}

fn cfg_operations_for_path(tokens, path) {
  let indices = cfg_collect_indices(path[1])
  let mut operations = []
  let mut references = []
  let mut tracked = []
  let mut consumed = []
  let mut pending = []
  let mut captures = []
  let mut awaits = []
  let mut point: usize = 0
  let mut position: usize = 0
  while position < indices.length {
    let index = indices[position]
    if cfg_has_number(consumed, index) || cfg_text(tokens, index) != "let" {
      position += 1
      continue
    }
    let mut cursor: usize = index + 1
    if cfg_text(tokens, cursor) == "mut" { cursor += 1 }
    let reference_name = cfg_text(tokens, cursor)
    while cfg_token_in_segments(path[1], cursor) && cfg_text(tokens, cursor) != "=" && cfg_text(tokens, cursor) != ";" && tokens[cursor][2] == tokens[index][2] { cursor += 1 }
    if cfg_text(tokens, cursor) != "=" || cfg_text(tokens, cursor + 1) != "&" {
      position += 1
      continue
    }
    let mut borrow_kind = "shared"
    let mut target_start: usize = cursor + 2
    if cfg_text(tokens, target_start) == "mut" {
      borrow_kind = "mut"
      target_start += 1
    }
    let target_result = cfg_read_path(tokens, target_start)
    if target_result[0] == "" {
      position += 1
      continue
    }
    let target_root = cfg_root(target_result[0])
    let parent_target = cfg_reference_target(references, target_root)
    let mut operation_kind = "borrow"
    let mut target = target_result[0]
    let mut parent = ""
    if parent_target != "" {
      operation_kind = "reborrow"
      target = parent_target
      parent = target_root
    }
    references.push([reference_name, target, borrow_kind, index])
    cfg_add(tracked, cfg_root(target))
    operations.push([operation_kind, reference_name, target, borrow_kind, point, 0, tokens[index][2], tokens[index][3], parent])
    point += 1
    let mut skip: usize = index
    while skip < target_result[1] {
      cfg_add(consumed, skip)
      skip += 1
    }
    position += 1
  }

  position = 0
  while position < indices.length {
    let index = indices[position]
    point = cfg_emit_pending_activations(pending, index, operations, point)
    if cfg_has_number(consumed, index) {
      position += 1
      continue
    }
    let text = cfg_text(tokens, index)
    if text == "await" {
      operations.push(["await", "", "", "", point, point, tokens[index][2], tokens[index][3], ""])
      awaits.push([path[0], point, tokens[index][2], tokens[index][3]])
      point += 1
      position += 1
      continue
    }
    let closure_move = text == "move" && (cfg_text(tokens, index + 1) == "|" || cfg_text(tokens, index + 1) == "||")
    let closure_shared = text == "|" || text == "||"
    if closure_move || closure_shared {
      let mut pipe_start = index
      if closure_move { pipe_start = index + 1 }
      let mut pipe_end: usize = pipe_start
      if cfg_text(tokens, pipe_start) == "|" {
        pipe_end = pipe_start + 1
        while pipe_end < tokens.length && cfg_text(tokens, pipe_end) != "|" { pipe_end += 1 }
      }
      let mut body_open: usize = pipe_end + 1
      while body_open < tokens.length && cfg_text(tokens, body_open) != "{" { body_open += 1 }
      if body_open < tokens.length {
        let body_close = cfg_find_close(tokens, body_open, "{", "}")
        let mut ref_index: usize = 0
        while ref_index < references.length {
          if cfg_path_used(tokens, indices, position, body_close, references[ref_index][0]) {
            let mut capture_kind = "capture_ref_shared"
            if closure_move { capture_kind = "capture_ref_move" }
            operations.push([capture_kind, references[ref_index][0], references[ref_index][1], references[ref_index][2], point, point, tokens[index][2], tokens[index][3], "closure"])
            captures.push([path[0], references[ref_index][0], references[ref_index][1], capture_kind, point])
            point += 1
          }
          ref_index += 1
        }
        let mut skip: usize = index
        while skip <= body_close {
          cfg_add(consumed, skip)
          skip += 1
        }
      }
      position += 1
      continue
    }
    if text == "move" {
      let target_result = cfg_read_path(tokens, index + 1)
      if target_result[0] != "" {
        cfg_add(tracked, cfg_root(target_result[0]))
        operations.push(["move", "", target_result[0], "", point, point, tokens[index][2], tokens[index][3], ""])
        point += 1
        let mut skip: usize = index
        while skip < target_result[1] {
          cfg_add(consumed, skip)
          skip += 1
        }
      }
      position += 1
      continue
    }
    let path_result = cfg_read_path(tokens, index)
    if path_result[0] == "" {
      position += 1
      continue
    }
    let full_path = path_result[0]
    let last_dot = full_path.lastIndexOf(".")
    if last_dot > 0 && cfg_text(tokens, path_result[1]) == "(" {
      let method = full_path.slice(last_dot + 1)
      if cfg_is_mutating_method(method) {
        let receiver = full_path.slice(0, last_dot)
        let close = cfg_find_close(tokens, path_result[1], "(", ")")
        let reservation_name = "two_phase_" + path[0] + "_" + point
        operations.push(["reserve", reservation_name, receiver, "mut", point, close, tokens[index][2], tokens[index][3], ""])
        pending.push([close, reservation_name, receiver, tokens[index][2], tokens[index][3]])
        cfg_add(tracked, cfg_root(receiver))
        point += 1
        let mut skip: usize = index
        while skip < path_result[1] {
          cfg_add(consumed, skip)
          skip += 1
        }
        position += 1
        continue
      }
    }
    let root = cfg_root(full_path)
    let reference_index = cfg_reference_index(references, root)
    if reference_index >= 0 && index != references[reference_index][3] {
      operations.push(["use_ref", root, references[reference_index][1], references[reference_index][2], point, point, tokens[index][2], tokens[index][3], ""])
      point += 1
      let mut skip: usize = index
      while skip < path_result[1] {
        cfg_add(consumed, skip)
        skip += 1
      }
      position += 1
      continue
    }
    if !cfg_has(tracked, root) {
      position += 1
      continue
    }
    let next = cfg_text(tokens, path_result[1])
    let previous = cfg_text(tokens, index - 1)
    if previous == "&" || previous == "mut" || previous == "move" || previous == "let" || previous == ":" || previous == "::" {
      position += 1
      continue
    }
    let mut operation_kind = "use"
    if next == "=" { operation_kind = "assign" }
    operations.push([operation_kind, "", full_path, "", point, point, tokens[index][2], tokens[index][3], ""])
    point += 1
    let mut skip: usize = index
    while skip < path_result[1] {
      cfg_add(consumed, skip)
      skip += 1
    }
    position += 1
  }
  point = cfg_emit_pending_activations(pending, tokens.length - 1, operations, point)
  let last_uses = cfg_last_ref_uses(operations)
  let final_point = point
  let mut operation_index: usize = 0
  while operation_index < operations.length {
    if operations[operation_index][0] == "borrow" || operations[operation_index][0] == "reborrow" {
      operations[operation_index][5] = cfg_last_use(last_uses, operations[operation_index][1], operations[operation_index][4])
    }
    if operations[operation_index][0] == "capture_ref_move" || operations[operation_index][0] == "capture_ref_shared" { operations[operation_index][5] = final_point }
    operation_index += 1
  }
  return [operations, captures, awaits]
}

fn cfg_block_id(start: usize, end: usize) -> String {
  return "b" + start + "_" + end
}

fn cfg_add_block(blocks, start: usize, end: usize, kind: String) {
  let id = cfg_block_id(start, end)
  let mut index: usize = 0
  while index < blocks.length {
    if blocks[index][0] == id { return }
    index += 1
  }
  blocks.push([id, start, end, kind])
}

fn cfg_build_graph(paths) {
  let mut blocks = []
  let mut edges = []
  let mut path_index: usize = 0
  while path_index < paths.length {
    let segments = paths[path_index][1]
    let mut segment_index: usize = 0
    while segment_index < segments.length {
      let kind = "linear"
      cfg_add_block(blocks, segments[segment_index][0], segments[segment_index][1], kind)
      if segment_index > 0 {
        edges.push([cfg_block_id(segments[segment_index - 1][0], segments[segment_index - 1][1]), cfg_block_id(segments[segment_index][0], segments[segment_index][1]), paths[path_index][0]])
      }
      segment_index += 1
    }
    path_index += 1
  }
  return [blocks, edges]
}

fn cfg_read_type(tokens, start: usize, stops) {
  let mut text = ""
  let mut index: usize = start
  while index < tokens.length && !cfg_has(stops, cfg_text(tokens, index)) {
    text = text + cfg_text(tokens, index)
    index += 1
  }
  return [text, index]
}

fn cfg_lifetime_contract(tokens, fn_index: usize, body_open: usize, body_close: usize) {
  let name = cfg_text(tokens, fn_index + 1)
  let mut open: usize = fn_index + 2
  if cfg_text(tokens, open) == "<" { open = cfg_find_close(tokens, open, "<", ">") + 1 }
  if cfg_text(tokens, open) != "(" { return [] }
  let close = cfg_find_close(tokens, open, "(", ")")
  let mut reference_parameters = []
  let mut cursor: usize = open + 1
  while cursor < close {
    if tokens[cursor][0] == "identifier" && cfg_text(tokens, cursor + 1) == ":" {
      let parameter_name = cfg_text(tokens, cursor)
      let mut type_start: usize = cursor + 2
      let mut kind = "value"
      if cfg_text(tokens, type_start) == "&" {
        kind = "shared"
        type_start += 1
        if cfg_text(tokens, type_start) == "mut" { kind = "mut"; type_start += 1 }
        reference_parameters.push([parameter_name, kind])
      }
    }
    cursor += 1
  }
  let mut return_reference = false
  cursor = close + 1
  if cfg_text(tokens, cursor) == "->" && cfg_text(tokens, cursor + 1) == "&" { return_reference = true }
  if !return_reference { return [] }
  let mut returned = ""
  cursor = body_open + 1
  while cursor < body_close {
    if cfg_text(tokens, cursor) == "return" && tokens[cursor + 1][0] == "identifier" { returned = cfg_text(tokens, cursor + 1) }
    cursor += 1
  }
  let mut source = ""
  let mut kind = "shared"
  cursor = 0
  while cursor < reference_parameters.length {
    if reference_parameters[cursor][0] == returned || (returned == "" && reference_parameters.length == 1) {
      source = reference_parameters[cursor][0]
      kind = reference_parameters[cursor][1]
    }
    cursor += 1
  }
  return [name, source, kind, tokens[fn_index][2], tokens[fn_index][3], reference_parameters]
}

pub fn build_cfg_regions(tokens_json: String) -> String {
  let tokens = JSON.parse(tokens_json)
  let mut diagnostics = []
  let mut functions = []
  let mut all_paths = []
  let mut plan = []
  let mut contracts = []
  let mut captures = []
  let mut awaits = []
  let mut index: usize = 0
  while index < tokens.length {
    if cfg_text(tokens, index) != "fn" {
      index += 1
      continue
    }
    let name = cfg_text(tokens, index + 1)
    let mut body_open: usize = index + 2
    while body_open < tokens.length && cfg_text(tokens, body_open) != "{" { body_open += 1 }
    if body_open >= tokens.length { diagnostics.push(["KR-SELF-CFG-0001", "Function " + name + " has no body.", tokens[index][2], tokens[index][3]]); index += 1; continue }
    let body_close = cfg_find_close(tokens, body_open, "{", "}")
    let mut paths = []
    cfg_walk_paths(tokens, [], body_open + 1, body_close, name + ".entry", paths)
    let graph = cfg_build_graph(paths)
    functions.push([name, graph[0], graph[1], paths, tokens[index][2], tokens[index][3]])
    let contract = cfg_lifetime_contract(tokens, index, body_open, body_close)
    if contract.length > 0 {
      if contract[1] == "" { diagnostics.push(["KR-SELF-REGION-0001", "Reference return from " + name + " has no unique input lifetime source.", contract[3], contract[4]]) }
      contracts.push(contract)
    }
    let mut path_index: usize = 0
    while path_index < paths.length {
      let prefixed = [paths[path_index][0], paths[path_index][1]]
      all_paths.push(prefixed)
      let operations = cfg_operations_for_path(tokens, prefixed)
      plan.push([prefixed[0], operations[0]])
      let mut capture_index: usize = 0
      while capture_index < operations[1].length { captures.push(operations[1][capture_index]); capture_index += 1 }
      let mut await_index: usize = 0
      while await_index < operations[2].length { awaits.push(operations[2][await_index]); await_index += 1 }
      path_index += 1
    }
    index = body_close + 1
  }
  return JSON.stringify([diagnostics.length == 0, diagnostics, functions, all_paths, plan, contracts, captures, awaits, cfg_region_version()])
}
`;

export function createSelfHostMigrationManifest() {
  return Object.freeze({
    stage: 'module-compiler',
    phase: 'cfg-region-and-projection-assisted-module-compiler',
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
      'Kura-authored precedence-climbing expression parser',
      'Kura-authored enum-style and binding pattern parser',
      'Kura-authored generic parameter and where-clause parser',
      'Kura-authored trait-bound and implementation validation',
      'Kura-authored branch and loop move-state dataflow',
      'Kura-authored expression-driven semantic type inference',
      'Kura-authored associated type and coherence validation',
      'Kura-authored generic trait obligation resolution',
      'Kura-authored path-sensitive field borrow checker core',
      'Kura-authored non-lexical loan expiration',
      'Kura-authored control-flow graph and branch-path construction',
      'Kura-authored region and final-use inference',
      'Kura-authored mutable reborrow suspension and resumption',
      'Kura-authored two-phase mutable receiver reservation and activation',
      'Kura-authored closure reference capture lifetime extension',
      'Kura-authored borrow-across-await rejection',
      'Kura-authored inferred interprocedural reference-return contracts',
      'Kura-authored higher-ranked trait-bound parsing',
      'Kura-authored associated-type projection substitution',
      'array, indexing, assignment and while language support',
      'fixed-point module compiler reproduction',
    ]),
    integration: Object.freeze({
      stage0Frontend: 'trusted JavaScript typed compiler',
      stage1Compiler: 'Kura module emitter compiled by Stage 0',
      stage2Compiler: 'Stage 1 self-reproduction',
      migratedFrontend: 'Kura lexer, AST and pattern parsers, semantic inference, higher-ranked associated-type trait solver, CFG and region builder, reborrow/two-phase/closure/async-aware NLL borrow core compiled by Stage 0 and exercised during bootstrap',
      fixedPointRequired: true,
    }),
    remaining: Object.freeze([
      'self-reproduction of the complete frontend module',
      'complete production declaration and pattern parser migration',
      'recursive associated-type projection normalization, negative impls and specialization ordering',
      'irreducible control-flow, exception edges and full production region-polonius equivalence',
      'borrow-aware async generator lowering and cross-function lifetime substitution',
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


function tokenText(tokens, index) { return index >= 0 && index < tokens.length ? tokens[index][1] : ''; }
function matchingToken(tokens, start, open, close) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const text = tokenText(tokens, index);
    if (text === open) depth += 1;
    if (text === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return tokens.length - 1;
}
function readPath(tokens, start) {
  if (tokens[start]?.[0] !== 'identifier') return null;
  const parts = [tokenText(tokens, start)];
  let index = start + 1;
  while (tokenText(tokens, index) === '.' && tokens[index + 1]?.[0] === 'identifier') {
    parts.push(tokenText(tokens, index + 1));
    index += 2;
  }
  return { path: parts.join('.'), end: index };
}
function enumerateTokenPaths(tokens) {
  const paths = [];
  const walk = (segments, start, end, id, output) => {
    let index = start;
    const linearStart = start;
    while (index < end) {
      const text = tokenText(tokens, index);
      if (text !== 'if' && text !== 'while') { index += 1; continue; }
      let open = index + 1;
      while (open < end && tokenText(tokens, open) !== '{') open += 1;
      if (open >= end) { index += 1; continue; }
      const close = matchingToken(tokens, open, '{', '}');
      const before = linearStart < index ? [...segments, [linearStart, index]] : [...segments];
      if (text === 'if') {
        let next = close + 1;
        let elseOpen = -1;
        let elseClose = -1;
        if (tokenText(tokens, next) === 'else' && tokenText(tokens, next + 1) === '{') {
          elseOpen = next + 1;
          elseClose = matchingToken(tokens, elseOpen, '{', '}');
          next = elseClose + 1;
        }
        const branchOutput = [];
        walk(before, open + 1, close, `${id}.then`, branchOutput);
        if (elseOpen >= 0) walk(before, elseOpen + 1, elseClose, `${id}.else`, branchOutput);
        else branchOutput.push({ id: `${id}.else`, segments: before });
        for (const branch of branchOutput) walk(branch.segments, next, end, branch.id, output);
        return;
      }
      const branchOutput = [{ id: `${id}.loop0`, segments: before }];
      walk(before, open + 1, close, `${id}.loop1`, branchOutput);
      for (const branch of branchOutput) walk(branch.segments, close + 1, end, branch.id, output);
      return;
    }
    output.push({ id, segments: linearStart < end ? [...segments, [linearStart, end]] : segments });
  };
  walk([], 0, tokens.length - 1, 'entry', paths);
  return paths;
}
function operationsForTokenPath(tokens, tokenPath) {
  const indices = [];
  for (const [start, end] of tokenPath.segments) for (let index = start; index < end; index += 1) indices.push(index);
  const included = new Set(indices);
  const operations = [];
  const trackedValues = new Set();
  const references = new Map();
  const consumed = new Set();
  let point = 0;
  for (const index of indices) {
    if (consumed.has(index) || tokenText(tokens, index) !== 'let') continue;
    let cursor = index + 1;
    if (tokenText(tokens, cursor) === 'mut') cursor += 1;
    const referenceName = tokenText(tokens, cursor);
    while (included.has(cursor) && tokenText(tokens, cursor) !== '=' && tokenText(tokens, cursor) !== ';' && tokens[cursor]?.[2] === tokens[index]?.[2]) cursor += 1;
    if (tokenText(tokens, cursor) !== '=' || tokenText(tokens, cursor + 1) !== '&') continue;
    let borrowKind = 'shared';
    let targetStart = cursor + 2;
    if (tokenText(tokens, targetStart) === 'mut') { borrowKind = 'mut'; targetStart += 1; }
    const target = readPath(tokens, targetStart);
    if (!target) continue;
    references.set(referenceName, { target: target.path, borrowKind, declarationIndex: index });
    trackedValues.add(target.path.split('.')[0]);
    operations.push(['borrow', referenceName, target.path, borrowKind, point++, 0, tokens[index][2], tokens[index][3]]);
    for (let skip = index; skip < target.end; skip += 1) consumed.add(skip);
  }
  for (const index of indices) {
    if (consumed.has(index)) continue;
    const text = tokenText(tokens, index);
    if (text === 'move') {
      const target = readPath(tokens, index + 1);
      if (target) {
        trackedValues.add(target.path.split('.')[0]);
        operations.push(['move', '', target.path, '', point++, 0, tokens[index][2], tokens[index][3]]);
        for (let skip = index; skip < target.end; skip += 1) consumed.add(skip);
      }
      continue;
    }
    const path = readPath(tokens, index);
    if (!path) continue;
    const root = path.path.split('.')[0];
    if (references.has(root) && index !== references.get(root).declarationIndex) {
      operations.push(['use_ref', root, '', '', point++, 0, tokens[index][2], tokens[index][3]]);
      for (let skip = index; skip < path.end; skip += 1) consumed.add(skip);
      continue;
    }
    if (!trackedValues.has(root)) continue;
    const next = tokenText(tokens, path.end);
    const previous = tokenText(tokens, index - 1);
    if (previous === '&' || previous === 'mut' || previous === 'move' || previous === 'let' || previous === ':' || previous === '::') continue;
    if (next === '=') operations.push(['assign', '', path.path, '', point++, 0, tokens[index][2], tokens[index][3]]);
    else operations.push(['use', '', path.path, '', point++, 0, tokens[index][2], tokens[index][3]]);
    for (let skip = index; skip < path.end; skip += 1) consumed.add(skip);
  }
  const lastUses = new Map();
  for (const operation of operations) if (operation[0] === 'use_ref') lastUses.set(operation[1], operation[4]);
  for (const operation of operations) if (operation[0] === 'borrow') operation[5] = lastUses.get(operation[1]) ?? operation[4];
  operations.sort((left, right) => left[4] - right[4]);
  return operations;
}
function createBorrowPlanFromTokens(tokens) {
  return enumerateTokenPaths(tokens).map(path => [path.id, operationsForTokenPath(tokens, path)]);
}
function decodeTraitSolver(raw) {
  const [ok, traits, implementations, diagnostics, matches, version, projections = [], higherRanked = []] = JSON.parse(raw);
  return { ok, traits, implementations, diagnostics: diagnostics.map(([code, message, line, column]) => ({ code, message, line, column })), matches, projections, higherRanked, version };
}
function decodeCfgRegion(raw) {
  const [ok, diagnostics, functions, paths, plan, contracts, captures, awaits, version] = JSON.parse(raw);
  return { ok, diagnostics: diagnostics.map(([code, message, line, column]) => ({ code, message, line, column })), functions, paths, plan, contracts, captures, awaits, version };
}
function decodeBorrowChecker(raw, plan) {
  const [ok, diagnostics, summaries, version] = JSON.parse(raw);
  return { ok, diagnostics: diagnostics.map(([code, message, line, column, path]) => ({ code, message, line, column, path })), summaries, version, plan };
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
  const traitSolver = compileLanguage(SELF_HOST_TRAIT_SOLVER_SOURCE, { file: 'self-host/trait-solver.kr', autoRun: false });
  const cfgRegion = compileLanguage(SELF_HOST_CFG_REGION_SOURCE, { file: 'self-host/cfg-region.kr', autoRun: false });
  const borrowChecker = compileLanguage(SELF_HOST_BORROW_CHECKER_SOURCE, { file: 'self-host/borrow-checker.kr', autoRun: false });
  const frontendModule = await importText(frontend.code, 'frontend');
  const traitSolverModule = await importText(traitSolver.code, 'trait-solver');
  const cfgRegionModule = await importText(cfgRegion.code, 'cfg-region');
  const borrowCheckerModule = await importText(borrowChecker.code, 'borrow-checker');
  if (typeof frontendModule.tokenize_program !== 'function' || typeof frontendModule.analyze_program !== 'function' || typeof cfgRegionModule.build_cfg_regions !== 'function') throw new Error('Kura frontend module did not export its scanner/checker API.');
  const frontendSelfAnalysis = decodeAnalysis(frontendModule.analyze_program(SELF_HOST_FRONTEND_SOURCE));
  if (!frontendSelfAnalysis.ok) throw new Error(`Kura frontend self-analysis failed: ${JSON.stringify(frontendSelfAnalysis.diagnostics[0])}`);
  const frontendAst = JSON.parse(frontendModule.parse_program(SELF_HOST_FRONTEND_SOURCE));
  const frontendSymbols = JSON.parse(frontendModule.build_symbol_table(SELF_HOST_FRONTEND_SOURCE));
  const frontendTypecheck = JSON.parse(frontendModule.typecheck_program(SELF_HOST_FRONTEND_SOURCE));
  const frontendSemanticTypecheck = JSON.parse(frontendModule.semantic_typecheck_program(SELF_HOST_FRONTEND_SOURCE));
  if (frontendAst[2].length !== 0 || frontendSymbols[1].length !== 0 || frontendTypecheck[0] !== true || frontendSemanticTypecheck[0] !== true) {
    throw new Error(`Kura semantic frontend rejected itself: ${JSON.stringify(frontendSemanticTypecheck[1][0] ?? frontendTypecheck[1][0] ?? frontendAst[2][0])}`);
  }
  const expressionProbe = JSON.parse(frontendModule.parse_expression('1 + 2 * 3 == 7'));
  if (expressionProbe[1].length !== 0 || expressionProbe[0][0] !== 'binary' || expressionProbe[0][1] !== '==') throw new Error('Kura expression parser failed precedence validation.');
  const patternProbe = JSON.parse(frontendModule.parse_pattern('Option::Some(value) | Option::None'));
  if (patternProbe[0] !== 'or' || patternProbe[1][0] !== 'variant') throw new Error('Kura pattern parser failed variant validation.');
  const genericProbe = JSON.parse(frontendModule.analyze_generic_constraints('trait Render {}\npub fn show<T: Render>(value: T) -> T where T: Clone { return value }'));
  if (!genericProbe[0] || genericProbe[3][0][1][0][0] !== 'T') throw new Error(`Kura generic constraint analysis failed: ${JSON.stringify(genericProbe[4][0])}`);
  const moveProbe = JSON.parse(frontendModule.analyze_move_dataflow('pub fn broken(value: String) -> String { let consumed = move value\nreturn value }'));
  if (moveProbe[0] || !moveProbe[2].some(item => item[0] === 'KR-SELF-BORROW-0103')) throw new Error('Kura move dataflow did not reject a use after move.');

  const traitProbeSource = 'trait Iterator { type Item }\nstruct Numbers {}\nimpl Iterator for Numbers { type Item = i32 }';
  const traitProbe = decodeTraitSolver(traitSolverModule.solve_trait_tokens(frontendModule.tokenize_program(traitProbeSource), 'Iterator', 'Numbers', 'Item'));
  if (!traitProbe.ok || traitProbe.matches.length !== 1 || traitProbe.projections[0]?.[1] !== 'i32') throw new Error(`Kura trait solver failed associated type resolution: ${JSON.stringify(traitProbe.diagnostics[0])}`);
  const coherenceProbeSource = 'trait Render { type Output }\nstruct Box {}\nimpl<T> Render for Box<T> { type Output = String }\nimpl Render for Box<i32> { type Output = String }';
  const coherenceProbe = decodeTraitSolver(traitSolverModule.solve_trait_tokens(frontendModule.tokenize_program(coherenceProbeSource), '', '', ''));
  if (coherenceProbe.ok || !coherenceProbe.diagnostics.some(item => item.code === 'KR-SELF-TRAIT-1008')) throw new Error('Kura trait solver did not reject overlapping implementations.');
  const hrtbProbeSource = 'trait Reader { type Item }\npub fn read_all<T>(value: T) -> T where T: for<a> Reader<a> { return value }';
  const hrtbProbe = decodeTraitSolver(traitSolverModule.solve_trait_tokens(frontendModule.tokenize_program(hrtbProbeSource), '', '', ''));
  if (!hrtbProbe.ok || hrtbProbe.higherRanked.length !== 1 || hrtbProbe.higherRanked[0][0][0] !== 'a') throw new Error('Kura trait solver failed higher-ranked bound parsing.');
  const borrowProbeSource = 'pub fn view(mut value: String, cond: bool) -> String { let view = &value\nif cond { print(view) } else { print(view) }\nvalue = "next"\nreturn value }';
  const borrowProbeCfg = decodeCfgRegion(cfgRegionModule.build_cfg_regions(frontendModule.tokenize_program(borrowProbeSource)));
  const borrowProbe = decodeBorrowChecker(borrowCheckerModule.check_borrow_paths(JSON.stringify(borrowProbeCfg.plan)), borrowProbeCfg.plan);
  if (!borrowProbeCfg.ok || !borrowProbe.ok) throw new Error(`Kura CFG/NLL borrow checker rejected a valid last-use assignment: ${JSON.stringify(borrowProbe.diagnostics[0] ?? borrowProbeCfg.diagnostics[0])}`);
  const borrowConflictSource = 'pub fn broken(mut value: String) -> String { let view = &value\nlet edit = &mut value\nprint(view)\nreturn value }';
  const borrowConflictCfg = decodeCfgRegion(cfgRegionModule.build_cfg_regions(frontendModule.tokenize_program(borrowConflictSource)));
  const borrowConflictProbe = decodeBorrowChecker(borrowCheckerModule.check_borrow_paths(JSON.stringify(borrowConflictCfg.plan)), borrowConflictCfg.plan);
  if (borrowConflictProbe.ok || !borrowConflictProbe.diagnostics.some(item => item.code === 'KR-SELF-BORROW-0201')) throw new Error('Kura NLL borrow checker did not reject a shared/mutable loan conflict.');
  const reborrowSource = 'pub fn edit(mut value: String) -> String { let root = &mut value\nlet child = &mut root\nprint(child)\nprint(root)\nreturn value }';
  const reborrowCfg = decodeCfgRegion(cfgRegionModule.build_cfg_regions(frontendModule.tokenize_program(reborrowSource)));
  const reborrowProbe = decodeBorrowChecker(borrowCheckerModule.check_borrow_paths(JSON.stringify(reborrowCfg.plan)), reborrowCfg.plan);
  if (!reborrowProbe.ok || !reborrowCfg.plan[0][1].some(item => item[0] === 'reborrow')) throw new Error(`Kura reborrow validation failed: ${JSON.stringify(reborrowProbe.diagnostics[0])}`);
  const twoPhaseSource = 'pub fn add(mut values: Values) -> Values { values.push(values.length)\nreturn values }';
  const twoPhaseCfg = decodeCfgRegion(cfgRegionModule.build_cfg_regions(frontendModule.tokenize_program(twoPhaseSource)));
  const twoPhaseProbe = decodeBorrowChecker(borrowCheckerModule.check_borrow_paths(JSON.stringify(twoPhaseCfg.plan)), twoPhaseCfg.plan);
  if (!twoPhaseProbe.ok || !twoPhaseCfg.plan[0][1].some(item => item[0] === 'reserve') || !twoPhaseCfg.plan[0][1].some(item => item[0] === 'activate')) throw new Error('Kura two-phase borrow validation failed.');
  const closureSource = 'pub fn make(mut value: String) -> String { let view = &value\nlet action = move || { print(view) }\nvalue = "next"\nreturn value }';
  const closureCfg = decodeCfgRegion(cfgRegionModule.build_cfg_regions(frontendModule.tokenize_program(closureSource)));
  const closureProbe = decodeBorrowChecker(borrowCheckerModule.check_borrow_paths(JSON.stringify(closureCfg.plan)), closureCfg.plan);
  if (closureProbe.ok || !closureProbe.diagnostics.some(item => item.code === 'KR-SELF-BORROW-0203')) throw new Error('Kura closure capture checking did not retain the captured loan.');
  const asyncBorrowSource = 'pub async fn broken(mut value: String) -> String { let view = &value\nawait task()\nprint(view)\nreturn value }';
  const asyncBorrowCfg = decodeCfgRegion(cfgRegionModule.build_cfg_regions(frontendModule.tokenize_program(asyncBorrowSource)));
  const asyncBorrowProbe = decodeBorrowChecker(borrowCheckerModule.check_borrow_paths(JSON.stringify(asyncBorrowCfg.plan)), asyncBorrowCfg.plan);
  if (asyncBorrowProbe.ok || !asyncBorrowProbe.diagnostics.some(item => item.code === 'KR-SELF-BORROW-0304')) throw new Error('Kura borrow checker did not reject an unstable borrow across await.');
  const lifetimeSource = 'pub fn identity(value: &String) -> &String { return value }';
  const lifetimeProbe = decodeCfgRegion(cfgRegionModule.build_cfg_regions(frontendModule.tokenize_program(lifetimeSource)));
  if (!lifetimeProbe.ok || lifetimeProbe.contracts[0]?.[1] !== 'value') throw new Error('Kura interprocedural lifetime contract inference failed.');

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
    frontendSource: SELF_HOST_FRONTEND_SOURCE, frontendCode: frontend.code, traitSolverSource: SELF_HOST_TRAIT_SOLVER_SOURCE, traitSolverCode: traitSolver.code, cfgRegionSource: SELF_HOST_CFG_REGION_SOURCE, cfgRegionCode: cfgRegion.code, borrowCheckerSource: SELF_HOST_BORROW_CHECKER_SOURCE, borrowCheckerCode: borrowChecker.code,
    frontendSelfAnalysis, frontendAst, frontendSymbols, frontendTypecheck, frontendSemanticTypecheck, expressionProbe, patternProbe, genericProbe, moveProbe, traitProbe, coherenceProbe, hrtbProbe, borrowProbe, borrowProbeCfg, borrowConflictProbe, borrowConflictCfg, reborrowProbe, reborrowCfg, twoPhaseProbe, twoPhaseCfg, closureProbe, closureCfg, asyncBorrowProbe, asyncBorrowCfg, lifetimeProbe, invalidAnalysis, invalidTypecheck, probeSource, probeCode, probeResult, probeAnalysis,
    stage1Version: stage2Module.compiler_version?.() ?? null,
    frontendVersion: frontendModule.frontend_version?.() ?? null,
    migration: createSelfHostMigrationManifest(),
    hashes: { source: hash(source), stage0: hash(stage0.code), stage2: hash(stage2Code), stage3: hash(stage3Code), frontendSource: hash(SELF_HOST_FRONTEND_SOURCE), frontendCode: hash(frontend.code), frontendTokens: hash(frontendModule.tokenize_program(SELF_HOST_FRONTEND_SOURCE)), frontendAst: hash(JSON.stringify(frontendAst)), frontendSymbols: hash(JSON.stringify(frontendSymbols)), frontendSemantics: hash(JSON.stringify(frontendSemanticTypecheck)), traitSolverSource: hash(SELF_HOST_TRAIT_SOLVER_SOURCE), traitSolverCode: hash(traitSolver.code), cfgRegionSource: hash(SELF_HOST_CFG_REGION_SOURCE), cfgRegionCode: hash(cfgRegion.code), borrowCheckerSource: hash(SELF_HOST_BORROW_CHECKER_SOURCE), borrowCheckerCode: hash(borrowChecker.code), expressionProbe: hash(JSON.stringify(expressionProbe)), patternProbe: hash(JSON.stringify(patternProbe)) },
    capabilities: { compilerWrittenInKura: true, moduleCompilerMigrated: true, selfReproduction: true, fixedPoint: true, deterministicScanner: true, syntaxValidation: true, bootstrapTypeChecking: true, moveDiagnostics: true, astParserWrittenInKura: true, symbolTableWrittenInKura: true, typeCheckerWrittenInKura: true, expressionParserWrittenInKura: true, patternParserWrittenInKura: true, genericConstraintCheckerWrittenInKura: true, moveDataflowWrittenInKura: true, associatedTypeSolverWrittenInKura: true, coherenceCheckerWrittenInKura: true, pathSensitiveBorrowCheckerWrittenInKura: true, nonLexicalLoanExpirationWrittenInKura: true, cfgConstructionWrittenInKura: true, regionInferenceWrittenInKura: true, reborrowCheckingWrittenInKura: true, twoPhaseBorrowWrittenInKura: true, closureCaptureCheckingWrittenInKura: true, asyncBorrowCheckingWrittenInKura: true, interproceduralLifetimeContractsWrittenInKura: true, higherRankedTraitBoundsWrittenInKura: true, associatedTypeProjectionWrittenInKura: true, frontendModuleWrittenInKura: true, fullCompilerMigration: false },
  };
}

export async function analyzeWithSelfHostedFrontend(source, options = {}) {
  const bootstrap = await bootstrapSelfHostedCompiler(options);
  const frontend = await importText(bootstrap.frontendCode, `semantic-${Date.now()}`);
  const traitSolver = await importText(bootstrap.traitSolverCode, `traits-${Date.now()}`);
  const cfgRegionModule = await importText(bootstrap.cfgRegionCode, `cfg-${Date.now()}`);
  const borrowChecker = await importText(bootstrap.borrowCheckerCode, `borrow-${Date.now()}`);
  const tokensJson = frontend.tokenize_program(source);
  const tokens = JSON.parse(tokensJson);
  const cfgRegion = decodeCfgRegion(cfgRegionModule.build_cfg_regions(tokensJson));
  const borrowPlan = cfgRegion.plan;
  return {
    analysis: decodeAnalysis(frontend.analyze_program(source)),
    ast: JSON.parse(frontend.parse_program(source)),
    symbols: JSON.parse(frontend.build_symbol_table(source)),
    typecheck: JSON.parse(frontend.typecheck_program(source)),
    semanticTypecheck: JSON.parse(frontend.semantic_typecheck_program(source)),
    generics: JSON.parse(frontend.analyze_generic_constraints(source)),
    moveDataflow: JSON.parse(frontend.analyze_move_dataflow(source)),
    traits: decodeTraitSolver(traitSolver.solve_trait_tokens(JSON.stringify(tokens), options.queryTrait ?? '', options.queryType ?? '', options.queryAssoc ?? '')),
    cfgRegion,
    borrow: decodeBorrowChecker(borrowChecker.check_borrow_paths(JSON.stringify(borrowPlan)), borrowPlan),
    frontendVersion: bootstrap.frontendVersion,
    frontendHash: bootstrap.hashes.frontendCode,
    migration: bootstrap.migration,
  };
}

export async function solveWithSelfHostedTraitSolver(source, options = {}) {
  const bootstrap = await bootstrapSelfHostedCompiler(options);
  const frontend = await importText(bootstrap.frontendCode, `trait-tokens-${Date.now()}`);
  const solver = await importText(bootstrap.traitSolverCode, `trait-solver-${Date.now()}`);
  return decodeTraitSolver(solver.solve_trait_tokens(frontend.tokenize_program(source), options.trait ?? '', options.type ?? '', options.assoc ?? ''));
}

export async function buildWithSelfHostedCfgRegion(source, options = {}) {
  const bootstrap = await bootstrapSelfHostedCompiler(options);
  const frontend = await importText(bootstrap.frontendCode, `cfg-tokens-${Date.now()}`);
  const cfgRegion = await importText(bootstrap.cfgRegionCode, `cfg-region-${Date.now()}`);
  return decodeCfgRegion(cfgRegion.build_cfg_regions(frontend.tokenize_program(source)));
}

export async function checkWithSelfHostedBorrowChecker(source, options = {}) {
  const bootstrap = await bootstrapSelfHostedCompiler(options);
  const frontend = await importText(bootstrap.frontendCode, `borrow-tokens-${Date.now()}`);
  const cfgRegionModule = await importText(bootstrap.cfgRegionCode, `borrow-cfg-${Date.now()}`);
  const checker = await importText(bootstrap.borrowCheckerCode, `borrow-checker-${Date.now()}`);
  const cfgRegion = options.plan ? null : decodeCfgRegion(cfgRegionModule.build_cfg_regions(frontend.tokenize_program(source)));
  const plan = options.plan ?? cfgRegion.plan;
  return { ...decodeBorrowChecker(checker.check_borrow_paths(JSON.stringify(plan)), plan), cfgRegion };
}

export async function parseWithSelfHostedFrontend(kind, source, options = {}) {
  const bootstrap = await bootstrapSelfHostedCompiler(options);
  const frontend = await importText(bootstrap.frontendCode, `parse-${kind}-${Date.now()}`);
  if (kind === 'expression') return JSON.parse(frontend.parse_expression(source));
  if (kind === 'pattern') return JSON.parse(frontend.parse_pattern(source));
  throw new TypeError(`Unsupported self-host parse kind '${kind}'.`);
}

export async function compileWithSelfHostedCompiler(source, options = {}) {
  const bootstrap = await bootstrapSelfHostedCompiler(options);
  const compiler = await importText(bootstrap.stage2Code, `compile-${Date.now()}`);
  const frontend = await importText(bootstrap.frontendCode, `frontend-${Date.now()}`);
  const analysis = decodeAnalysis(frontend.analyze_program(source));
  const ast = JSON.parse(frontend.parse_program(source));
  const typecheck = JSON.parse(frontend.typecheck_program(source));
  const semanticTypecheck = JSON.parse(frontend.semantic_typecheck_program(source));
  const traitSolver = await importText(bootstrap.traitSolverCode, `compile-traits-${Date.now()}`);
  const cfgRegionModule = await importText(bootstrap.cfgRegionCode, `compile-cfg-${Date.now()}`);
  const borrowChecker = await importText(bootstrap.borrowCheckerCode, `compile-borrow-${Date.now()}`);
  const tokensJson = frontend.tokenize_program(source);
  const tokens = JSON.parse(tokensJson);
  const traitCheck = decodeTraitSolver(traitSolver.solve_trait_tokens(JSON.stringify(tokens), '', '', ''));
  const cfgRegion = decodeCfgRegion(cfgRegionModule.build_cfg_regions(tokensJson));
  const borrowPlan = cfgRegion.plan;
  const borrowCheck = decodeBorrowChecker(borrowChecker.check_borrow_paths(JSON.stringify(borrowPlan)), borrowPlan);
  if (!analysis.ok) { const first = analysis.diagnostics[0]; const error = new Error(`${first.code} at ${first.line}:${first.column}: ${first.message}`); error.code = first.code; error.diagnostics = analysis.diagnostics; throw error; }
  if (!typecheck[0]) { const first = typecheck[1][0]; const error = new Error(`${first[0]}: ${first[1]}`); error.code = first[0]; error.diagnostics = typecheck[1]; throw error; }
  if (!semanticTypecheck[0]) { const first = semanticTypecheck[1][0]; const error = new Error(`${first[0]}: ${first[1]}`); error.code = first[0]; error.diagnostics = semanticTypecheck[1]; throw error; }
  if (!cfgRegion.ok) { const first = cfgRegion.diagnostics[0]; const error = new Error(`${first.code}: ${first.message}`); error.code = first.code; error.diagnostics = cfgRegion.diagnostics; throw error; }
  if (!traitCheck.ok) { const first = traitCheck.diagnostics[0]; const error = new Error(`${first.code}: ${first.message}`); error.code = first.code; error.diagnostics = traitCheck.diagnostics; throw error; }
  if (!borrowCheck.ok) { const first = borrowCheck.diagnostics[0]; const error = new Error(`${first.code}: ${first.message}`); error.code = first.code; error.diagnostics = borrowCheck.diagnostics; throw error; }
  return { code: compiler.compile_program(source), analysis, ast, typecheck, semanticTypecheck, traitCheck, cfgRegion, borrowCheck, compilerHash: bootstrap.hashes.stage2, frontendHash: bootstrap.hashes.frontendCode, compilerVersion: compiler.compiler_version?.() ?? bootstrap.stage1Version, migration: bootstrap.migration };
}

export async function writeSelfHostArtifacts(directory, options = {}) {
  const output = resolve(directory); await mkdir(output, { recursive: true });
  const result = await bootstrapSelfHostedCompiler(options);
  const files = { source: resolve(output, 'compiler.kr'), frontendSource: resolve(output, 'frontend.kr'), traitSolverSource: resolve(output, 'trait-solver.kr'), cfgRegionSource: resolve(output, 'cfg-region.kr'), borrowCheckerSource: resolve(output, 'borrow-checker.kr'), stage0: resolve(output, 'compiler-stage0.mjs'), stage1: resolve(output, 'compiler-stage1.mjs'), frontend: resolve(output, 'frontend-stage0.mjs'), traitSolver: resolve(output, 'trait-solver-stage0.mjs'), cfgRegion: resolve(output, 'cfg-region-stage0.mjs'), borrowChecker: resolve(output, 'borrow-checker-stage0.mjs'), report: resolve(output, 'self-host-report.json') };
  await writeFile(files.source, result.source); await writeFile(files.frontendSource, result.frontendSource); await writeFile(files.traitSolverSource, result.traitSolverSource); await writeFile(files.cfgRegionSource, result.cfgRegionSource); await writeFile(files.borrowCheckerSource, result.borrowCheckerSource); await writeFile(files.stage0, result.stage0Code); await writeFile(files.stage1, result.stage2Code); await writeFile(files.frontend, result.frontendCode); await writeFile(files.traitSolver, result.traitSolverCode); await writeFile(files.cfgRegion, result.cfgRegionCode); await writeFile(files.borrowChecker, result.borrowCheckerCode);
  await writeFile(files.report, JSON.stringify({ fixedPoint: result.fixedPoint, hashes: result.hashes, probeResult: result.probeResult, stage1Version: result.stage1Version, frontendVersion: result.frontendVersion, frontendSelfAnalysis: result.frontendSelfAnalysis, frontendAst: result.frontendAst, frontendSymbols: result.frontendSymbols, frontendTypecheck: result.frontendTypecheck, frontendSemanticTypecheck: result.frontendSemanticTypecheck, expressionProbe: result.expressionProbe, patternProbe: result.patternProbe, genericProbe: result.genericProbe, moveProbe: result.moveProbe, traitProbe: result.traitProbe, coherenceProbe: result.coherenceProbe, hrtbProbe: result.hrtbProbe, borrowProbe: result.borrowProbe, borrowProbeCfg: result.borrowProbeCfg, borrowConflictProbe: result.borrowConflictProbe, reborrowProbe: result.reborrowProbe, twoPhaseProbe: result.twoPhaseProbe, closureProbe: result.closureProbe, asyncBorrowProbe: result.asyncBorrowProbe, lifetimeProbe: result.lifetimeProbe, invalidAnalysis: result.invalidAnalysis, migration: result.migration, capabilities: result.capabilities }, null, 2) + '\n');
  return { ...result, files };
}

export async function verifySelfHostArtifacts(directory) {
  const source = await readFile(resolve(directory, 'compiler.kr'), 'utf8'); const stage1 = await readFile(resolve(directory, 'compiler-stage1.mjs'), 'utf8');
  const compiler = await import(pathToFileURL(resolve(directory, 'compiler-stage1.mjs')).href + `?v=${Date.now()}`);
  const frontend = await import(pathToFileURL(resolve(directory, 'frontend-stage0.mjs')).href + `?v=${Date.now()}`);
  const traitSolver = await import(pathToFileURL(resolve(directory, 'trait-solver-stage0.mjs')).href + `?v=${Date.now()}`);
  const cfgRegion = await import(pathToFileURL(resolve(directory, 'cfg-region-stage0.mjs')).href + `?v=${Date.now()}`);
  const borrowChecker = await import(pathToFileURL(resolve(directory, 'borrow-checker-stage0.mjs')).href + `?v=${Date.now()}`);
  const frontendSource = await readFile(resolve(directory, 'frontend.kr'), 'utf8'); const analysis = decodeAnalysis(frontend.analyze_program(frontendSource)); const typecheck = JSON.parse(frontend.typecheck_program(frontendSource)); const semanticTypecheck = JSON.parse(frontend.semantic_typecheck_program(frontendSource)); const reproduced = compiler.compile_program(source);
  const traitResult = decodeTraitSolver(traitSolver.solve_trait_tokens(frontend.tokenize_program(`trait ItemSource { type Item }
struct Values {}
impl ItemSource for Values { type Item = i32 }`), 'ItemSource', 'Values', 'Item'));
  const cfgResult = decodeCfgRegion(cfgRegion.build_cfg_regions(frontend.tokenize_program(`pub fn verify(mut value: String) -> String { let view = &value
print(view)
value = "next"
return value }`)));;
  const borrowResult = decodeBorrowChecker(borrowChecker.check_borrow_paths(JSON.stringify(cfgResult.plan)), cfgResult.plan);
  return { ok: analysis.ok && typecheck[0] && semanticTypecheck[0] && traitResult.ok && cfgResult.ok && borrowResult.ok && reproduced === stage1, analysis, typecheck, semanticTypecheck, traitResult, cfgResult, borrowResult, expectedHash: hash(stage1), actualHash: hash(reproduced) };
}
