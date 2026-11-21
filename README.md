[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Mamat9q/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Mamat9q/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# csv-reader-speed

A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader): `solve.js`
returns exactly csv-reader's `{columns, rows, errors}` for every input, about
4.7x faster than the reference on the practice set (test.mjs time, 9 rounds:
~98 ms vs ~458 ms for the reference on the 6 practice cases).

## Layout

- `solve.js` — the host. Loads `reader.wasm` once, copies each case's text
  as UTF-16LE straight into the module's memory, calls `parse()`, and
  materialises `{columns, rows, errors}` from the tables it returns.
  Dependency-free ES module, no I/O, no network, deterministic.
- `reader.wasm` — the reader, compiled from `../wasm-build/reader.ts` with
  AssemblyScript 0.28.20 (`asc reader.ts --outFile reader.wasm --optimize
  --enable simd --runtime stub`). No imports; exports `memory` and `parse`.
- `main.ts` — the driver. Reads `$MAKEFUN_INPUT_DIR/cases.json` (or
  `/input`), answers each case alone with `run()`, writes
  `$MAKEFUN_OUTPUT_DIR/answers.json` (or `/output`).

## Run it

```sh
node main.ts
```

## How it is fast

The reference reads one character at a time and builds every field up a
character at a time. This reader does all of the parsing in compiled code:

- **SIMD scans.** Plain fields scan for `,` LF CR and quoted fields scan for
  the closing quote 8 UTF-16 units at a time with i16x8 SIMD; a span's tail
  under 8 units is covered by one overlapping 8-unit load with the lanes
  before the span masked off, so no field ever pays a scalar tail loop.
- **One parse call per case.** The module walks the whole input in one go and
  returns tables — per field a start, a length and a kind; per row a start
  index and a field count; per error a code, a line, a row and an argument —
  instead of crossing the JS/WASM boundary per field.
- **Plain fields are never copied.** Plain and simply-quoted fields are slices
  of the input text; only fields that needed unescaping are built once into a
  scratch buffer the host decodes in a single call.
- **No temp copy of the input.** The host writes the text straight into the
  module's memory with a single `Buffer.write`, instead of encoding a temp
  buffer and copying it in.

## Correctness

The broken-row policy is csv-reader 1.0.0's, kept exactly: BOM dropped, LF /
CRLF record ends, blank lines are no records, lone CRs dropped (`stray_cr`),
quoted fields with `""` escapes and LF-normalised embedded breaks, junk after
a closing quote (`quote_junk`), never-closing quotes read again as unquoted
(`unterminated_quote`), short rows padded (`short_row`) and long rows cut
(`long_row`) to the first record's width, errors in encounter order with the
record's start line and row index.

Verified locally against this build: 6/6 practice cases byte-identical to the
reference answers, 122/122 hand-built edge cases, 36/36 freshly drawn
generator cases — all compared against csv-reader 1.0.0 itself.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
