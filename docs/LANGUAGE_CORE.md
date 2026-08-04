# Kura Typed Language Core

The typed language core is the application-facing frontend for Kura. It complements the freestanding native kernel compiler with high-level algebraic types, generic constraints, traits, closures, Result propagation, and deterministic resource cleanup.

## Generics and traits

```kr
trait Display<T> {
  fn display(value: T) -> String;
}

fn render<T>(value: T) -> String where T: Display {
  return value.display()
}
```

Generic calls with explicit type arguments are checked against their constraints and recorded as monomorphization specializations.

## Enum and exhaustive match

```kr
enum Result<T, E> {
  Ok(T),
  Err(E),
}

fn unwrap(value: Result<i32, String>) -> i32 {
  return match value {
    Result::Ok(item) => item,
    Result::Err(error) => 0,
  }
}
```

A match without a wildcard must cover every variant. Duplicate or mixed-enum arms are rejected.

## Result propagation

```kr
fn load() -> Result<i32, String> {
  let value = read_number()?
  return Result::Ok(value)
}
```

The `?` operator is accepted only in a function returning `Result<...>`. The JavaScript backend lowers it to an early-return carrier and preserves the original `Err` value.

## RAII and Drop

```kr
struct File { handle: usize }

impl Drop for File {
  fn drop(self: File) {
    close(self.handle)
  }
}

fn use_file() {
  let file: File = open_file()
  defer flush_logs()
}
```

The compiler creates a cleanup plan for every scope. Deferred actions run in reverse order, followed by `Drop` values in reverse declaration order. Cleanup executes on normal return and exceptional Result propagation.

## Partial move and NLL

```kr
struct User { name: String, age: u32 }

fn take(user: User) {
  let name = move user.name
  print(user.age)
}
```

Fields are tracked independently. A moved field cannot be read again, while unaffected siblings remain available. Borrow regions end at the last use of their reference binding rather than the end of the lexical block.

A type implementing `Drop` must explicitly opt into partial moves with `@partial_drop`, because its destructor must safely handle fields that have already moved.

## Closures

```kr
fn make_adder(base: i32) {
  let add = |value: i32| -> i32 { base + value }
}
```

Closure capture sets are reported in MIR output so later native backends can select `Fn`, `FnMut`, or `FnOnce` representations.

## CLI

```bash
kr-language check app.kr
kr-language mir app.kr --json
kr-language build app.kr -o build/app.mjs
kr-language run app.kr
```
