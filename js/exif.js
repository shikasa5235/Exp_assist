// exif.js — 画像バイト列 → EXIF の露出値。純粋関数のみ。副作用ゼロ。
// DOM・Canvas・fetch・localStorage・window に触らない（photocal-spec §7.1）。
//
// **GPS タグ（0x8825）は意図的に読まない。**（photocal-spec §6.5）
// ポインタの存在は IFD0 のエントリとして見えるが、**追わない・保存しない・返さない。**
// このアプリは通信しない設計であり、位置情報を扱う理由がない。
// 「読める場所にあるものは読む」を既定にしないため、除外をここに明記しておく。
//
// **BrightnessValue（0x9203）も読まない。** Apple の値は APEX の関係式から 0.8段ほど
// ずれることが知られている。EV は F/SS/ISO から計算する（photocal-spec §3.1）。
//
// **HEIC（BMFF）はパースしない。** 実機検証（iPhone 16 Pro Max / iOS 26.1）では
// カメラ設定が「高効率」でも `<input type="file">` 経由では iOS が JPEG に変換して渡す。
// 検出だけして案内に回す（photocal-spec §6.2）。
//
// 例外を投げない。読めないところで止めて、そこまでの値を返す。

/** EXIF の型番号 → 1要素のバイト数。未知の型はここに無いので弾ける。 */
const TYPE_SIZE = Object.freeze({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 });

const TAG_EXIF_IFD = 0x8769;   // ExifIFD へのポインタ
/** 読むタグ。**ここに 0x8825(GPS) と 0x9203(BrightnessValue) を足さないこと。** */
const TAG = Object.freeze({
  make: 0x010F, model: 0x0110,
  exposureTime: 0x829A, fNumber: 0x829D, iso: 0x8827,
  dateTimeOriginal: 0x9003, exposureBias: 0x9204, flash: 0x9209,
  focalLength: 0x920A, focalLength35: 0xA405,
});
/** ISO の代替タグ。`0x8827` を出さない機種向け（photocal-spec §4.1 の補足）。 */
const TAG_ISO_ALT = Object.freeze([0x8833, 0x8832]);

/** @type {ReadonlyArray<string>} HEIC/HEIF とみなす ftyp ブランド。 */
const HEIC_BRANDS = Object.freeze(['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1']);

/** 空の結果（形式だけ判ったとき）。 */
function empty(format) {
  return {
    format,
    fNumber: null, exposureTime: null, iso: null,
    focalLength: null, focalLength35: null, exposureBias: null,
    flashFired: null, make: null, model: null, dateTimeOriginal: null,
  };
}

/** 指定オフセットから n バイトを ASCII として読む（範囲外は空文字で止める）。 */
function ascii(u8, o, n) {
  let s = '';
  for (let i = 0; i < n && o + i < u8.length; i++) {
    const b = u8[o + i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/** 先頭バイトから形式を判定する。 */
function detectFormat(u8) {
  if (u8.length >= 3 && u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'jpeg';
  if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'png';
  if (u8.length >= 12 && ascii(u8, 4, 4) === 'ftyp') {
    const major = ascii(u8, 8, 4);
    // compatible brands（16バイト目以降を4バイト刻み）も見る。major が mp41 等でも中身は HEIC のことがある
    if (HEIC_BRANDS.includes(major)) return 'heic';
    const size = u8.length >= 4 ? (u8[0] << 24 | u8[1] << 16 | u8[2] << 8 | u8[3]) >>> 0 : 0;
    for (let o = 16; o + 4 <= Math.min(size, u8.length); o += 4) {
      if (HEIC_BRANDS.includes(ascii(u8, o, 4))) return 'heic';
    }
    return 'unknown';
  }
  return 'unknown';
}

/**
 * JPEG の APP1 のうち "Exif\0\0" で始まるものを探す。
 * @returns {number} TIFF ヘッダの絶対オフセット。見つからなければ −1
 */
function findExifApp1(u8) {
  let p = 2; // FF D8 の直後
  while (p + 3 < u8.length) {
    if (u8[p] !== 0xFF) return -1;                       // マーカー同期を失った
    let m = u8[p + 1];
    while (m === 0xFF && p + 2 < u8.length) { p++; m = u8[p + 1]; }  // フィルバイト
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD9)) { p += 2; continue; } // 長さを持たない
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (len < 2) return -1;
    const data = p + 4;
    if (m === 0xE1 && data + 6 <= u8.length && ascii(u8, data, 4) === 'Exif'
        && u8[data + 4] === 0 && u8[data + 5] === 0) {
      return data + 6;
    }
    if (m === 0xDA) return -1;                            // 圧縮データに入った
    p += 2 + len;
  }
  return -1;
}

/**
 * IFD エントリ1件を読む。
 * @returns {{tag:number, value:*}|null} 読めなければ null（例外は投げない）
 */
function readEntry(dv, u8, tiffStart, at, little) {
  const tag = dv.getUint16(at, little);
  const type = dv.getUint16(at + 2, little);
  const count = dv.getUint32(at + 4, little);
  const size = TYPE_SIZE[type];
  if (!size || count > 0x10000) return { tag, value: null };
  const total = size * count;
  const vo = total <= 4 ? at + 8 : tiffStart + dv.getUint32(at + 8, little);
  if (vo < 0 || vo + total > u8.length) return { tag, value: null };

  if (type === 2) return { tag, value: ascii(u8, vo, count) };
  if (type === 5 || type === 10) {                        // (S)RATIONAL
    const n = type === 5 ? dv.getUint32(vo, little) : dv.getInt32(vo, little);
    const d = type === 5 ? dv.getUint32(vo + 4, little) : dv.getInt32(vo + 4, little);
    // **有理数のまま割る。1/3段グリッドへ寄せない**（この関数の上のコメントと lightmeter.js 参照）
    return { tag, value: d === 0 ? null : n / d };
  }
  if (type === 3) return { tag, value: dv.getUint16(vo, little) };
  if (type === 4) return { tag, value: dv.getUint32(vo, little) };
  if (type === 8) return { tag, value: dv.getInt16(vo, little) };
  if (type === 9) return { tag, value: dv.getInt32(vo, little) };
  return { tag, value: null };                            // BYTE / UNDEFINED などは使わない
}

/**
 * IFD を1つ読んで tag→value の Map に足す。
 * @returns {number} 次の IFD へのオフセット（0 なら終わり）
 */
function readIfd(dv, u8, tiffStart, ifdOffset, little, into) {
  const at = tiffStart + ifdOffset;
  if (at < 0 || at + 2 > u8.length) return 0;
  const n = dv.getUint16(at, little);
  if (n > 512 || at + 2 + n * 12 > u8.length) return 0;   // 壊れた count で暴走させない
  for (let i = 0; i < n; i++) {
    const e = readEntry(dv, u8, tiffStart, at + 2 + i * 12, little);
    if (e && !into.has(e.tag)) into.set(e.tag, e.value);
  }
  return at + 2 + n * 12 + 4 <= u8.length ? dv.getUint32(at + 2 + n * 12, little) : 0;
}

/** 数値として使える値だけ返す。 */
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
/** 空でない文字列だけ返す。 */
function str(v) { return typeof v === 'string' && v.length ? v : null; }

/**
 * 画像バイト列から EXIF の露出値を取り出す。
 *
 * **値は EXIF に記録されたまま返す。1/3段グリッドへ寄せない。**
 * スマホの AE は連続値でシャッターを制御する（実機で `1/4405`、`F1.7799999713880652`）。
 * 公称ラベルだと思ってスナップすると最大 1/6段 の誤差を自分で作り込む。
 * カメラの公称ラベル（F11・1/250）を厳密値に直すのは**呼び出し側の仕事**
 * （`lightmeter.solveAeOffset` のカメラ側だけ）。
 *
 * @param {ArrayBuffer} buf 画像ファイル全体
 * @returns {{format:'jpeg'|'heic'|'png'|'unknown',
 *   fNumber:number|null, exposureTime:number|null, iso:number|null,
 *   focalLength:number|null, focalLength35:number|null, exposureBias:number|null,
 *   flashFired:boolean|null, make:string|null, model:string|null,
 *   dateTimeOriginal:string|null}|null} 使えないバッファなら null
 */
export function parseExif(buf) {
  if (!buf || typeof buf.byteLength !== 'number' || buf.byteLength < 4) return null;
  let u8, dv;
  try { u8 = new Uint8Array(buf); dv = new DataView(buf); } catch { return null; }

  const format = detectFormat(u8);
  const out = empty(format);
  if (format !== 'jpeg') return out;                      // HEIC/PNG/未知は検出だけ（案内は UI 側）

  const tiffStart = findExifApp1(u8);
  if (tiffStart < 0 || tiffStart + 8 > u8.length) return out;

  const bo = ascii(u8, tiffStart, 2);
  if (bo !== 'II' && bo !== 'MM') return out;
  const little = bo === 'II';
  if (dv.getUint16(tiffStart + 2, little) !== 42) return out;

  const tags = new Map();
  const ifd0 = dv.getUint32(tiffStart + 4, little);
  readIfd(dv, u8, tiffStart, ifd0, little, tags);
  const exifPtr = tags.get(TAG_EXIF_IFD);
  if (typeof exifPtr === 'number' && exifPtr > 0) readIfd(dv, u8, tiffStart, exifPtr, little, tags);
  // **GPS ポインタ（0x8825）はここで追わない。** tags には番号だけ残るが読み出さない

  out.fNumber = num(tags.get(TAG.fNumber));
  out.exposureTime = num(tags.get(TAG.exposureTime));
  out.iso = num(tags.get(TAG.iso));
  if (out.iso === null) {
    for (const alt of TAG_ISO_ALT) { const v = num(tags.get(alt)); if (v !== null) { out.iso = v; break; } }
  }
  out.focalLength = num(tags.get(TAG.focalLength));
  out.focalLength35 = num(tags.get(TAG.focalLength35));
  out.exposureBias = num(tags.get(TAG.exposureBias));
  const flash = tags.get(TAG.flash);
  out.flashFired = typeof flash === 'number' ? (flash & 1) === 1 : null;  // bit0 = 発光した
  out.make = str(tags.get(TAG.make));
  out.model = str(tags.get(TAG.model));
  out.dateTimeOriginal = str(tags.get(TAG.dateTimeOriginal));
  return out;
}
