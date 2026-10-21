/**
 * MessagePack as Lightroom's sync docstore writes it, decoded so it re-encodes to the same bytes.
 *
 * A general-purpose codec loses what Lightroom relies on: a float that happens to be whole
 * (`1.0`) comes back as the integer `1`, and integer-like map keys get reordered by plain
 * objects. Floats are therefore kept as `MsgFloat` and maps as `Map`. Lightroom writes a
 * float as float32 when float32 holds it exactly, float64 otherwise; integers and lengths
 * take their smallest form.
 */

export class MsgFloat {
  constructor(readonly value: number) {}
}

export type MsgValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | MsgFloat
  | MsgValue[]
  | Map<MsgValue, MsgValue>;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

export function decodeMsgpack(bytes: Uint8Array): MsgValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const take = (n: number): Uint8Array => {
    if (pos + n > bytes.length) throw new Error('msgpack: truncated');
    const out = bytes.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  const u8 = () => view.getUint8((pos += 1) - 1);
  const u16 = () => view.getUint16((pos += 2) - 2);
  const u32 = () => view.getUint32((pos += 4) - 4);
  const int64 = (signed: boolean): number | bigint => {
    const v = signed ? view.getBigInt64(pos) : view.getBigUint64(pos);
    pos += 8;
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  };
  const str = (n: number) => utf8.decode(take(n));
  const arr = (n: number): MsgValue[] => Array.from({ length: n }, () => next());
  const map = (n: number): Map<MsgValue, MsgValue> => {
    const m = new Map<MsgValue, MsgValue>();
    for (let i = 0; i < n; i++) {
      const k = next();
      m.set(k, next());
    }
    return m;
  };

  function next(): MsgValue {
    const b = u8();
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if ((b & 0xf0) === 0x80) return map(b & 0x0f);
    if ((b & 0xf0) === 0x90) return arr(b & 0x0f);
    if ((b & 0xe0) === 0xa0) return str(b & 0x1f);
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return take(u8()).slice();
      case 0xc5: return take(u16()).slice();
      case 0xc6: return take(u32()).slice();
      case 0xca: { const v = view.getFloat32(pos); pos += 4; return new MsgFloat(v); }
      case 0xcb: { const v = view.getFloat64(pos); pos += 8; return new MsgFloat(v); }
      case 0xcc: return u8();
      case 0xcd: return u16();
      case 0xce: return u32();
      case 0xcf: return int64(false);
      case 0xd0: { const v = view.getInt8(pos); pos += 1; return v; }
      case 0xd1: { const v = view.getInt16(pos); pos += 2; return v; }
      case 0xd2: { const v = view.getInt32(pos); pos += 4; return v; }
      case 0xd3: return int64(true);
      case 0xd9: return str(u8());
      case 0xda: return str(u16());
      case 0xdb: return str(u32());
      case 0xdc: return arr(u16());
      case 0xdd: return arr(u32());
      case 0xde: return map(u16());
      case 0xdf: return map(u32());
      default: throw new Error(`msgpack: unsupported type 0x${b.toString(16)}`);
    }
  }

  const value = next();
  if (pos !== bytes.length) throw new Error('msgpack: trailing bytes');
  return value;
}

export function encodeMsgpack(value: MsgValue): Uint8Array {
  const out: number[] = [];
  const scratch = new DataView(new ArrayBuffer(8));
  const push = (n: number) => {
    for (let i = 0; i < n; i++) out.push(scratch.getUint8(i));
  };
  const head = (code: number, n: number, bytes: 1 | 2 | 4) => {
    out.push(code);
    if (bytes === 1) scratch.setUint8(0, n);
    else if (bytes === 2) scratch.setUint16(0, n);
    else scratch.setUint32(0, n);
    push(bytes);
  };
  const length = (n: number, fix: number, fixMax: number, code8: number | null, code16: number) => {
    if (n <= fixMax) out.push(fix | n);
    else if (code8 !== null && n < 0x100) head(code8, n, 1);
    else if (n < 0x10000) head(code16, n, 2);
    else head(code16 + 1, n, 4);
  };
  const float = (v: number) => {
    if (Math.fround(v) === v || Number.isNaN(v)) {
      out.push(0xca);
      scratch.setFloat32(0, v);
      push(4);
    } else {
      out.push(0xcb);
      scratch.setFloat64(0, v);
      push(8);
    }
  };
  const integer = (v: number | bigint) => {
    const n = BigInt(v);
    if (n >= 0n) {
      if (n < 0x80n) out.push(Number(n));
      else if (n < 0x100n) head(0xcc, Number(n), 1);
      else if (n < 0x10000n) head(0xcd, Number(n), 2);
      else if (n < 0x100000000n) head(0xce, Number(n), 4);
      else {
        out.push(0xcf);
        scratch.setBigUint64(0, n);
        push(8);
      }
    } else if (n >= -32n) {
      out.push(Number(n) & 0xff);
    } else if (n >= -0x80n) {
      out.push(0xd0);
      scratch.setInt8(0, Number(n));
      push(1);
    } else if (n >= -0x8000n) {
      out.push(0xd1);
      scratch.setInt16(0, Number(n));
      push(2);
    } else if (n >= -0x80000000n) {
      out.push(0xd2);
      scratch.setInt32(0, Number(n));
      push(4);
    } else {
      out.push(0xd3);
      scratch.setBigInt64(0, n);
      push(8);
    }
  };

  const write = (v: MsgValue): void => {
    if (v === null) out.push(0xc0);
    else if (v === true) out.push(0xc3);
    else if (v === false) out.push(0xc2);
    else if (v instanceof MsgFloat) float(v.value);
    else if (typeof v === 'number') {
      if (Number.isInteger(v)) integer(v);
      else float(v);
    } else if (typeof v === 'bigint') integer(v);
    else if (typeof v === 'string') {
      const b = utf8Encoder.encode(v);
      length(b.length, 0xa0, 31, 0xd9, 0xda);
      for (const x of b) out.push(x);
    } else if (v instanceof Uint8Array) {
      if (v.length < 0x100) head(0xc4, v.length, 1);
      else if (v.length < 0x10000) head(0xc5, v.length, 2);
      else head(0xc6, v.length, 4);
      for (const x of v) out.push(x);
    } else if (Array.isArray(v)) {
      length(v.length, 0x90, 15, null, 0xdc);
      for (const x of v) write(x);
    } else {
      length(v.size, 0x80, 15, null, 0xde);
      for (const [k, x] of v) {
        write(k);
        write(x);
      }
    }
  };

  write(value);
  return Uint8Array.from(out);
}
