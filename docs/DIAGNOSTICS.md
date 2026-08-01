# Friendly Diagnostics

Kura errors are designed to answer four questions:

1. What happened?
2. Where did it happen?
3. Which text caused it?
4. How can it be fixed?

Example:

```text
Kura Error [KR-PARSE-1102]
Kura needs a valid parameter name
  Expected a parameter name, but found '{'.

  --> src/main.kr:1:10

 > 1 | fn main( {
     |          ^
   2 |   let value = ;

Help: Use a name beginning with a letter or underscore.
```

## Machine-readable errors

```bash
kr check --json
```

The JSON output contains the stable error code, title, summary, hint, file, line, column, and highlighted length.

## Technical details

```bash
kr check --verbose
```

Verbose mode adds the internal stack trace. Secret-looking values are redacted before display.

## Stable code families

| Prefix | Meaning |
|---|---|
| `KR-LEX` | Tokenization and string/number errors |
| `KR-PARSE` | Grammar errors |
| `KR-CHECK` | Program validation errors |
| `KR-CONFIG` | Project configuration errors |
| `KR-FS` | File access errors |
| `KR-SEC` | Blocked unsafe operations |
| `KR-RUNTIME` | Program execution failures |
| `KR-AUDIT` | Security audit findings |
