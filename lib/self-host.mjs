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

export function createSelfHostMigrationManifest() {
  return Object.freeze({
    stage: 'module-compiler',
    phase: 'semantic-frontend-assisted-module-compiler',
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
      'array, indexing, assignment and while language support',
      'fixed-point module compiler reproduction',
    ]),
    integration: Object.freeze({
      stage0Frontend: 'trusted JavaScript typed compiler',
      stage1Compiler: 'Kura module emitter compiled by Stage 0',
      stage2Compiler: 'Stage 1 self-reproduction',
      migratedFrontend: 'Kura lexer, statement and expression AST parsers, pattern parser, symbol table, semantic type inference, generic constraints and move dataflow compiled by Stage 0 and exercised during bootstrap',
      fixedPointRequired: true,
    }),
    remaining: Object.freeze([
      'self-reproduction of the complete frontend module',
      'complete production declaration and pattern parser migration',
      'associated types, coherence and full trait solver migration',
      'complete path-sensitive NLL borrow dataflow migration',
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
    frontendSelfAnalysis, frontendAst, frontendSymbols, frontendTypecheck, frontendSemanticTypecheck, expressionProbe, patternProbe, genericProbe, moveProbe, invalidAnalysis, invalidTypecheck, probeSource, probeCode, probeResult, probeAnalysis,
    stage1Version: stage2Module.compiler_version?.() ?? null,
    frontendVersion: frontendModule.frontend_version?.() ?? null,
    migration: createSelfHostMigrationManifest(),
    hashes: { source: hash(source), stage0: hash(stage0.code), stage2: hash(stage2Code), stage3: hash(stage3Code), frontendSource: hash(SELF_HOST_FRONTEND_SOURCE), frontendCode: hash(frontend.code), frontendTokens: hash(frontendModule.tokenize_program(SELF_HOST_FRONTEND_SOURCE)), frontendAst: hash(JSON.stringify(frontendAst)), frontendSymbols: hash(JSON.stringify(frontendSymbols)), frontendSemantics: hash(JSON.stringify(frontendSemanticTypecheck)), expressionProbe: hash(JSON.stringify(expressionProbe)), patternProbe: hash(JSON.stringify(patternProbe)) },
    capabilities: { compilerWrittenInKura: true, moduleCompilerMigrated: true, selfReproduction: true, fixedPoint: true, deterministicScanner: true, syntaxValidation: true, bootstrapTypeChecking: true, moveDiagnostics: true, astParserWrittenInKura: true, symbolTableWrittenInKura: true, typeCheckerWrittenInKura: true, expressionParserWrittenInKura: true, patternParserWrittenInKura: true, genericConstraintCheckerWrittenInKura: true, moveDataflowWrittenInKura: true, frontendModuleWrittenInKura: true, fullCompilerMigration: false },
  };
}

export async function analyzeWithSelfHostedFrontend(source, options = {}) {
  const bootstrap = await bootstrapSelfHostedCompiler(options);
  const frontend = await importText(bootstrap.frontendCode, `semantic-${Date.now()}`);
  return {
    analysis: decodeAnalysis(frontend.analyze_program(source)),
    ast: JSON.parse(frontend.parse_program(source)),
    symbols: JSON.parse(frontend.build_symbol_table(source)),
    typecheck: JSON.parse(frontend.typecheck_program(source)),
    semanticTypecheck: JSON.parse(frontend.semantic_typecheck_program(source)),
    generics: JSON.parse(frontend.analyze_generic_constraints(source)),
    moveDataflow: JSON.parse(frontend.analyze_move_dataflow(source)),
    frontendVersion: bootstrap.frontendVersion,
    frontendHash: bootstrap.hashes.frontendCode,
    migration: bootstrap.migration,
  };
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
  if (!analysis.ok) { const first = analysis.diagnostics[0]; const error = new Error(`${first.code} at ${first.line}:${first.column}: ${first.message}`); error.code = first.code; error.diagnostics = analysis.diagnostics; throw error; }
  if (!typecheck[0]) { const first = typecheck[1][0]; const error = new Error(`${first[0]}: ${first[1]}`); error.code = first[0]; error.diagnostics = typecheck[1]; throw error; }
  if (!semanticTypecheck[0]) { const first = semanticTypecheck[1][0]; const error = new Error(`${first[0]}: ${first[1]}`); error.code = first[0]; error.diagnostics = semanticTypecheck[1]; throw error; }
  return { code: compiler.compile_program(source), analysis, ast, typecheck, semanticTypecheck, compilerHash: bootstrap.hashes.stage2, frontendHash: bootstrap.hashes.frontendCode, compilerVersion: compiler.compiler_version?.() ?? bootstrap.stage1Version, migration: bootstrap.migration };
}

export async function writeSelfHostArtifacts(directory, options = {}) {
  const output = resolve(directory); await mkdir(output, { recursive: true });
  const result = await bootstrapSelfHostedCompiler(options);
  const files = { source: resolve(output, 'compiler.kr'), frontendSource: resolve(output, 'frontend.kr'), stage0: resolve(output, 'compiler-stage0.mjs'), stage1: resolve(output, 'compiler-stage1.mjs'), frontend: resolve(output, 'frontend-stage0.mjs'), report: resolve(output, 'self-host-report.json') };
  await writeFile(files.source, result.source); await writeFile(files.frontendSource, result.frontendSource); await writeFile(files.stage0, result.stage0Code); await writeFile(files.stage1, result.stage2Code); await writeFile(files.frontend, result.frontendCode);
  await writeFile(files.report, JSON.stringify({ fixedPoint: result.fixedPoint, hashes: result.hashes, probeResult: result.probeResult, stage1Version: result.stage1Version, frontendVersion: result.frontendVersion, frontendSelfAnalysis: result.frontendSelfAnalysis, frontendAst: result.frontendAst, frontendSymbols: result.frontendSymbols, frontendTypecheck: result.frontendTypecheck, frontendSemanticTypecheck: result.frontendSemanticTypecheck, expressionProbe: result.expressionProbe, patternProbe: result.patternProbe, genericProbe: result.genericProbe, moveProbe: result.moveProbe, invalidAnalysis: result.invalidAnalysis, migration: result.migration, capabilities: result.capabilities }, null, 2) + '\n');
  return { ...result, files };
}

export async function verifySelfHostArtifacts(directory) {
  const source = await readFile(resolve(directory, 'compiler.kr'), 'utf8'); const stage1 = await readFile(resolve(directory, 'compiler-stage1.mjs'), 'utf8');
  const compiler = await import(pathToFileURL(resolve(directory, 'compiler-stage1.mjs')).href + `?v=${Date.now()}`);
  const frontend = await import(pathToFileURL(resolve(directory, 'frontend-stage0.mjs')).href + `?v=${Date.now()}`);
  const frontendSource = await readFile(resolve(directory, 'frontend.kr'), 'utf8'); const analysis = decodeAnalysis(frontend.analyze_program(frontendSource)); const typecheck = JSON.parse(frontend.typecheck_program(frontendSource)); const semanticTypecheck = JSON.parse(frontend.semantic_typecheck_program(frontendSource)); const reproduced = compiler.compile_program(source);
  return { ok: analysis.ok && typecheck[0] && semanticTypecheck[0] && reproduced === stage1, analysis, typecheck, semanticTypecheck, expectedHash: hash(stage1), actualHash: hash(reproduced) };
}
