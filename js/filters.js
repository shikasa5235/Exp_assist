// filters.js — ND の組み合わせ探索と減光段数の計算。純粋関数のみ。副作用ゼロ。
// 仕様 §6。所有 ND の全部分集合を列挙し、必要段数を満たす最良解を返す。

/**
 * @typedef {Object} NDSolution
 * @property {number} totalStops 合計減光段数
 * @property {string[]|number[]} filters 使用するフィルタ（段数の配列）
 * @property {number} excess 超過段数（totalStops − required）
 * @property {number} count 使用枚数
 */

/**
 * 候補 a が b より優先されるか。仕様 §6 のソート順：
 *   枚数の少ない順 → 超過段数の小さい順 → 合計段数の小さい順。
 * 枚数優先はガラスを重ねるほどケラレ・色被り・フレアが増えるため。
 * @param {NDSolution} a
 * @param {NDSolution} b
 * @returns {boolean}
 */
function isBetter(a, b) {
  if (a.count !== b.count) return a.count < b.count;
  if (a.excess !== b.excess) return a.excess < b.excess;
  if (a.totalStops !== b.totalStops) return a.totalStops < b.totalStops;
  // 同枚数・同超過・同段数のときは「濃い側から貪欲に取った解」に一致させ、解を一意にする。
  // 段数の降順に並べて辞書式で大きい方を採る：5段なら [4,1](ND16+ND2) が [3,2](ND8+ND4) に勝つ。
  const da = [...a.filters].sort((x, y) => y - x);
  const db = [...b.filters].sort((x, y) => y - x);
  for (let i = 0; i < da.length; i++) {
    if (da[i] !== db[i]) return da[i] > db[i];
  }
  return false;
}

/**
 * ND 段数 → 表示名（1段=ND2、4段=ND16）。
 * @param {number} stops 減光段数
 * @returns {string}
 */
export function ndName(stops) { return `ND${2 ** stops}`; }

/**
 * ND 段数の配列 → 連結ラベル（例 "ND2+ND16"）。表示は薄い順に統一する。
 * 装着なしは空文字を返す（呼び出し側が「なし」等を選べるように）。
 * @param {number[]} stopsArr 減光段数の配列
 * @returns {string}
 */
export function ndLabel(stopsArr) {
  if (!stopsArr || !stopsArr.length) return '';
  return [...stopsArr].sort((a, b) => a - b).map(ndName).join('+');
}

/**
 * 所有 ND から必要段数を満たす最良の組み合わせを求める。仕様 §6。
 * @param {number[]} ownedStops 所有 ND の段数（例：[1,2,3,4]）
 * @param {number} required 必要減光段数
 * @returns {NDSolution|null} 満たす組み合わせが無ければ null
 */
export function solveND(ownedStops, required) {
  if (required <= 0) {
    return { totalStops: 0, filters: [], excess: 0, count: 0 };
  }
  const n = ownedStops.length;
  let best = null;
  // 空集合(mask=0)を除く全部分集合を列挙
  for (let mask = 1; mask < (1 << n); mask++) {
    const filters = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        filters.push(ownedStops[i]);
        sum += ownedStops[i];
      }
    }
    if (sum < required) continue;
    // filters は表示順（薄い順＝段数の昇順）で返す。選択の順序（濃い側から貪欲）とは別。
    filters.sort((x, y) => x - y);
    const cand = { totalStops: sum, filters, excess: sum - required, count: filters.length };
    if (best === null || isBetter(cand, best)) best = cand;
  }
  return best;
}
