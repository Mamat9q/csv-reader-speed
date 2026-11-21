// Fast drop-in for csv-reader 1.0.0, backed by a WASM SIMD reader (reader.wasm).
// run(input) returns exactly csv-reader's {columns, rows, errors} for every
// input, faster: the module scans the UTF-16 input 8 units at a time with
// i16x8 SIMD and does all of the parsing in compiled code, while this file
// only materialises the answer's strings from the tables it returns.
//
// The tables (see reader.ts): per field a start, a length and a kind — plain
// and simply-quoted fields are slices of the input text, fields that needed
// unescaping are slices of one scratch string decoded a single time, empty
// fields are "". Per row a start index and a field count (short rows are
// padded here, long rows cut here, to the first record's width). Per error a
// code, a line, a row (null for the header) and an argument (short_row: the
// field count; long_row: how many fields were cut, their values sliced from
// the row's fields).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the
// next. Dependency-free ES module (the .wasm is loaded synchronously from the
// file next to it), Node 22.

import { readFileSync } from 'node:fs';

const wasmBytes = readFileSync(new URL('./reader.wasm', import.meta.url));
const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
const mem = instance.exports.memory;
const parse = instance.exports.parse;

const ERROR_CODES = ['stray_cr', 'quote_junk', 'unterminated_quote', 'short_row', 'long_row'];
const decoder = new TextDecoder('utf-16le', { ignoreBOM: true });

let buf = mem.buffer;
let u32 = new Uint32Array(buf);

function refreshViews() {
  if (mem.buffer !== buf) {
    buf = mem.buffer;
    u32 = new Uint32Array(buf);
  }
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;

  // Memory the module needs: the input (2n bytes) plus the output tables at
  // outPtr, laid out exactly as reader.ts lays them out (capacities are worst
  // case for the input: fields <= n + 1, rows <= n / 2 + 1, errors <= 3n + 4,
  // scratch 2n units for headroom).
  const F = n + 1;
  const R = (n >> 1) + 1;
  const E = 3 * n + 4;
  const outPtr = (2 * n + 7) & ~7;
  const fStart = outPtr + 64;
  const fLen = fStart + (F << 2);
  const fKind = fLen + (F << 2);
  const rStart = fKind + (((F + 3) >> 2) << 2);
  const rCount = rStart + (R << 2);
  const eOff = rCount + (R << 2);
  const scrOff = eOff + E * 16;
  const total = scrOff + 2 * (2 * n);
  if (total > buf.byteLength) {
    mem.grow(Math.ceil((total - buf.byteLength) / 65536));
    refreshViews();
  }

  // Copy the input as UTF-16LE straight into memory at 0, then parse.
  // Buffer.write encodes directly into the WASM memory: no temp 2n buffer
  // and no second copy (bench-copy.mjs: 1.1 ms median vs 2.5 ms, and no
  // allocation spikes).
  Buffer.from(buf, 0, 2 * n).write(text, 0, 2 * n, 'utf16le');
  parse(0, n, header ? 1 : 0, outPtr);

  // The header: counts, columns, width, and the table offsets.
  const h = outPtr >> 2;
  const fieldCount = u32[h];
  const rowCount = u32[h + 1];
  const errorCount = u32[h + 2];
  const unescUnits = u32[h + 3];
  const columnsCount = u32[h + 4];
  const columnsStart = u32[h + 5];
  const width = u32[h + 6];
  if (
    u32[h + 7] !== fStart || u32[h + 8] !== fLen || u32[h + 9] !== fKind ||
    u32[h + 10] !== rStart || u32[h + 11] !== rCount || u32[h + 12] !== eOff ||
    u32[h + 13] !== scrOff
  ) {
    throw new Error('reader.wasm layout mismatch');
  }

  const fs = new Uint32Array(buf, fStart, fieldCount);
  const fl = new Uint32Array(buf, fLen, fieldCount);
  const fk = new Uint8Array(buf, fKind, fieldCount);
  const rs = new Uint32Array(buf, rStart, rowCount);
  const rc = new Uint32Array(buf, rCount, rowCount);
  const unescStr = unescUnits > 0
    ? decoder.decode(new Uint8Array(buf, scrOff, unescUnits * 2))
    : '';

  // One field's value: a slice of the input, of the decoded scratch string,
  // or "" — inlined in the loops below, never a call per field.
  const columns = header ? [] : null;
  for (let j = 0; j < columnsCount; j++) {
    const i = columnsStart + j;
    const k = fk[i];
    columns.push(k === 3 ? '' : k === 2 ? unescStr.slice(fs[i], fs[i] + fl[i]) : text.slice(fs[i], fs[i] + fl[i]));
  }

  const rows = new Array(rowCount);
  for (let r = 0; r < rowCount; r++) {
    const start = rs[r];
    const count = rc[r];
    const take = count < width ? count : width;
    const row = new Array(width);
    for (let j = 0; j < take; j++) {
      const i = start + j;
      const k = fk[i];
      row[j] = k === 3 ? '' : k === 2 ? unescStr.slice(fs[i], fs[i] + fl[i]) : text.slice(fs[i], fs[i] + fl[i]);
    }
    for (let j = take; j < width; j++) row[j] = '';
    rows[r] = row;
  }

  const errors = new Array(errorCount);
  const eBase = eOff >> 2;
  for (let i = 0; i < errorCount; i++) {
    const p = eBase + (i << 2);
    const code = u32[p];
    const e = { code: ERROR_CODES[code], line: u32[p + 1], row: u32[p + 2] === 0 ? null : u32[p + 2] - 1 };
    if (code === 3) {
      e.fields = u32[p + 3];
    } else if (code === 4) {
      const arg = u32[p + 3];
      const rowIdx = u32[p + 2] - 1;
      const start = rs[rowIdx];
      const extra = new Array(arg);
      for (let j = 0; j < arg; j++) {
        const fi = start + width + j;
        const k = fk[fi];
        extra[j] = k === 3 ? '' : k === 2 ? unescStr.slice(fs[fi], fs[fi] + fl[fi]) : text.slice(fs[fi], fs[fi] + fl[fi]);
      }
      e.extra = extra;
    }
    errors[i] = e;
  }

  return { columns, rows, errors };
}
