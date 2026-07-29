// state.js — 既定状態と状態操作のヘルパー。副作用ゼロ（DOM・localStorage に触らない）。
// ui.js と tests.html の両方から使う。DOM 依存を持たせないこと（テストが ui.js を読み込まずに
// compute(state) を検証できるようにするため）。
//
// 既定値は実機確定の上書きを含む（メモリ confirmed-default-overrides）：
//   ベースISO 200 ／ 拡張ISO下限 50 ／ SS上限 1/8000

/** @typedef {Object} AppState アプリの単一状態（UI仕様 §9 の形） */

/** @type {AppState} */
export const defaultState = {
  scene: { key: 'sunny', evBase: 15, adjust: 0 },
  intent: 'blur',
  subject: 'walking',
  focal: 50,
  camera: { syncSpeed: 1 / 250, maxSS: 1 / 8000, isoMin: 200, isoMax: 6400, isStops: 0, expandedISOMin: 50 },
  lens: { fMin: 2.8, fMax: 22 },
  flash: { profileId: 'p1', modifier: 'reflector', distance: 3, ambientOffset: -1, useHSS: true, tripod: false, curtain: false },
  nd: [],
  manual: { fIndex: null, ssIndex: null, isoIndex: null, locks: { f: true, ss: true, iso: false } },
  profiles: [
    { id: 'p1', name: '100Ws', ws: 100, k: 4.0, hss: true, minPowerStops: 7, modifier: 'reflector', calibrated: false },
    { id: 'p2', name: '200Ws', ws: 200, k: 4.0, hss: true, minPowerStops: 7, modifier: 'reflector', calibrated: false },
  ],
  settings: { hssBaseLoss: 2.0, ambientOffsetDefault: -1, ownedND: [1, 2, 3, 4], comp: 0 },
  ui: { tab: 'easy', theme: 'auto', firstRun: true },
};

/** 深いコピー。 @template T @param {T} o @returns {T} */
export function clone(o) { return JSON.parse(JSON.stringify(o)); }

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/**
 * 2階層までの深いマージ（配列は置換）。
 * @param {object} base
 * @param {object} patch
 * @returns {object} 新しいオブジェクト
 */
export function mergeDeep(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = isObj(out[k]) && isObj(patch[k]) ? { ...out[k], ...patch[k] } : patch[k];
  }
  return out;
}

/**
 * 既定状態にパッチを当てた完全な状態を作る（テスト・初期化用）。
 * @param {object} [patch]
 * @returns {AppState}
 */
export function makeState(patch = {}) {
  return mergeDeep(clone(defaultState), patch);
}
