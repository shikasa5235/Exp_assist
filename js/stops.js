// stops.js — 1/3段テーブルの生成と丸め。純粋関数のみ。副作用ゼロ。
//
// 原則（仕様 §4.1・CLAUDE.md）：
// - 厳密値は 2**(k/…) で生成する。ラベルは別配列（実体と表示は一致しない）。
// - 例：F5.6 の実体は 5.657、SS「15″」の実体は 16 秒。丸めは厳密値で行い、ラベルは対応表から引く。
// - 丸めは表示・確定の直前に一度だけ（snap）。途中で丸めると誤差が累積する。

/** F値ラベル（1/3段刻み、F1.0〜F32）。実体は 2**(index/6)。 */
const F_LABELS = [
  '1.0', '1.1', '1.2', '1.4', '1.6', '1.8', '2.0', '2.2', '2.5', '2.8',
  '3.2', '3.5', '4.0', '4.5', '5.0', '5.6', '6.3', '7.1', '8.0', '9.0',
  '10', '11', '13', '14', '16', '18', '20', '22', '25', '29', '32',
];

/** ISO ラベル（1/3段刻み、ISO50〜）。実体は 50*2**(index/3)。 */
const ISO_LABELS = [
  '50', '64', '80', '100', '125', '160', '200', '250', '320', '400',
  '500', '640', '800', '1000', '1250', '1600', '2000', '2500', '3200', '4000',
  '5000', '6400', '8000', '10000', '12800', '16000', '20000', '25600',
];

/** SS の最小 index（= 30″）。実体は 2**(-index/3) 秒。負ほど低速側。 */
const SS_MIN_INDEX = -15;

/** SS ラベル（1/3段刻み、30″〜1/8000）。index = 配列位置 + SS_MIN_INDEX。 */
const SS_LABELS = [
  '30″', '25″', '20″', '15″', '13″', '10″', '8″', '6″', '5″', '4″',   // -15..-6
  '3″', '2.5″', '2″', '1.6″', '1.3″', '1″', '0.8″', '0.6″', '1/2', '0.4″', // -5..4
  '0.3″', '1/4', '1/5', '1/6', '1/8', '1/10', '1/13', '1/15', '1/20', '1/25', // 5..14
  '1/30', '1/40', '1/50', '1/60', '1/80', '1/100', '1/125', '1/160', '1/200', '1/250', // 15..24
  '1/320', '1/400', '1/500', '1/640', '1/800', '1/1000', '1/1250', '1/1600', '1/2000', '1/2500', // 25..34
  '1/3200', '1/4000', '1/5000', '1/6400', '1/8000', // 35..39
];

/**
 * @typedef {Object} Series
 * @property {ReadonlyArray<string>} labels 表示ラベル
 * @property {number} minIndex
 * @property {number} maxIndex
 * @property {(index:number)=>number} real index → 厳密値
 * @property {(value:number)=>number} indexFor 厳密値 → 連続 index
 * @property {(index:number)=>string} label index → ラベル
 */

/**
 * 系列オブジェクトを組み立てる。
 * @param {{labels:ReadonlyArray<string>,minIndex:number,real:Function,indexFor:Function}} spec
 * @returns {Series}
 */
function makeSeries(spec) {
  const { labels, minIndex, real, indexFor } = spec;
  return {
    labels,
    minIndex,
    maxIndex: minIndex + labels.length - 1,
    real,
    indexFor,
    label(index) { return labels[index - minIndex]; },
  };
}

/** F値系列。実体 N = 2**(index/6)（1段で N は √2 倍 → 1/3段で 2**(1/6)）。 */
export const F = makeSeries({
  labels: F_LABELS,
  minIndex: 0,
  real: (i) => 2 ** (i / 6),
  indexFor: (n) => 6 * Math.log2(n),
});

/** SS 系列。実体 t = 2**(-index/3) 秒（index 正で高速＝短時間）。 */
export const SS = makeSeries({
  labels: SS_LABELS,
  minIndex: SS_MIN_INDEX,
  real: (i) => 2 ** (-i / 3),
  indexFor: (t) => -3 * Math.log2(t),
});

/** ISO 系列。実体 S = 50*2**(index/3)。 */
export const ISO = makeSeries({
  labels: ISO_LABELS,
  minIndex: 0,
  real: (i) => 50 * 2 ** (i / 3),
  indexFor: (s) => 3 * Math.log2(s / 50),
});

/**
 * 連続値を系列の最寄り 1/3段へ丸める。表示・確定の直前に一度だけ呼ぶ。
 * 範囲外はクランプし clamped=true で通知する（入力を拒否しない方針）。
 * @param {Series} series 対象系列（F / SS / ISO）
 * @param {number} value 連続値（F値／秒／ISO）
 * @returns {{index:number,label:string,real:number,clamped:boolean}}
 */
export function snap(series, value) {
  const raw = Math.round(series.indexFor(value));
  const index = Math.max(series.minIndex, Math.min(series.maxIndex, raw));
  return {
    index,
    label: series.label(index),
    real: series.real(index),
    clamped: index !== raw,
  };
}
