// state.js — 既定状態と状態操作のヘルパー。副作用ゼロ（DOM・localStorage に触らない）。
// ui.js と tests.html の両方から使う。DOM 依存を持たせないこと（テストが ui.js を読み込まずに
// compute(state) を検証できるようにするため）。
//
// 既定値は実機確定の上書きを含む（メモリ confirmed-default-overrides）：
//   ベースISO 200 ／ 拡張ISO下限 50 ／ SS上限 1/8000

import { MODIFIERS } from './scenes.js';

/** @typedef {Object} AppState アプリの単一状態（UI仕様 §9 の形） */

/**
 * 保存データのスキーマ版。破壊的変更のたびに上げる（MAINTENANCE.md §9）。
 * v2: profile.calibrated(boolean) → profile.cal（モディファイアごとの実測 k）
 *     ＋ MODIFIERS のキー削除（アンブレラ／ソフトボックス／ビューティディッシュ／ベアバルブ）
 */
export const SCHEMA_VERSION = 2;

/** 旧データの k を移送する先。標準リフレクターは既定なので校正時に選ばれていた可能性が最も高い。 */
const LEGACY_CAL_MODIFIER = 'reflector';

/** @type {AppState} */
export const defaultState = {
  schemaVersion: SCHEMA_VERSION,
  scene: { key: 'sunny', evBase: 15, adjust: 0 },
  intent: 'blur',
  subject: 'walking',
  focal: 50,
  camera: { syncSpeed: 1 / 250, maxSS: 1 / 8000, isoMin: 200, isoMax: 6400, isStops: 0, expandedISOMin: 50 },
  lens: { fMin: 2.8, fMax: 22 },
  // powerMode: 'auto' = 発光量を計算で決める（従属変数）／'fixed' = ユーザーが選び「距離」を解く。
  // powerStops は fixed のときだけ使う（0=1/1 … 7=1/128。大きいほど弱い）。
  flash: {
    profileId: 'p1', modifier: 'reflector', distance: 3, ambientOffset: -1,
    useHSS: true, tripod: false, curtain: false,
    powerMode: 'auto', powerStops: 5,
  },
  nd: [],
  manual: { fIndex: null, ssIndex: null, isoIndex: null, locks: { f: true, ss: true, iso: false } },
  // 光学フィルター。ND とは別概念（減光0段だが枚数には数える）。
  filters: { blackMist: false },
  // minPowerStops = 弱い側の限界（7 = 1/128）。powerCeilingStops = 強い側の限界（2 = 1/4）。
  // 段数は 1/1=0 … 1/128=7 なので、上限（強い側）のほうが数値は小さい。取り違えないこと。
  // cal = モディファイアごとの実測 k（{ reflector: 2.33, … }）。無い組み合わせは未校正で k を推定に使う。
  profiles: [
    { id: 'p1', name: '100Ws', ws: 100, k: 4.0, hss: true, minPowerStops: 7, powerCeilingStops: 2, modifier: 'reflector', cal: {} },
    { id: 'p2', name: '200Ws', ws: 200, k: 4.0, hss: true, minPowerStops: 7, powerCeilingStops: 2, modifier: 'reflector', cal: {} },
  ],
  settings: { hssBaseLoss: 2.0, ambientOffsetDefault: -1, ownedND: [1, 2, 3, 4], comp: 0, blackMistStops: 0 },
  // manual: null なら閉。'help-xxxx' ならそのセクションを開く（再描画経路を増やさないため state に置く）
  ui: { tab: 'easy', theme: 'auto', firstRun: true, manual: null },
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

/**
 * 旧形式の保存データを現行スキーマへ移送する。純粋関数（DOM・localStorage に触らない）。
 *
 * 校正値 k は実測しないと得られないので**破棄せず移送する**（MAINTENANCE.md §9）。
 * 削除済みの modifier キーは参照が undefined になり減光段数が NaN になり得るため、
 * 標準リフレクターへフォールバックする。
 *
 * @param {object|null} loaded storage.load() の生データ
 * @returns {{state:object|null, migrated:boolean, notice:string|null}}
 */
export function migrate(loaded) {
  if (!loaded || typeof loaded !== 'object') return { state: null, migrated: false, notice: null };
  const version = loaded.schemaVersion || 1;
  if (version >= SCHEMA_VERSION) return { state: loaded, migrated: false, notice: null };

  const out = clone(loaded);
  const known = new Set(MODIFIERS.map((m) => m.key));
  let movedCal = false;
  let fellBack = false;

  if (Array.isArray(out.profiles)) {
    out.profiles = out.profiles.map((p) => {
      const q = { ...p };
      if (q.cal == null || typeof q.cal !== 'object') {
        q.cal = {};
        // calibrated: true だった k を標準リフレクターの実測値として移送する
        if (q.calibrated === true && typeof q.k === 'number') {
          q.cal[LEGACY_CAL_MODIFIER] = q.k;
          movedCal = true;
        }
      }
      delete q.calibrated;
      if (q.modifier != null && !known.has(q.modifier)) { q.modifier = LEGACY_CAL_MODIFIER; fellBack = true; }
      if (q.powerCeilingStops == null) q.powerCeilingStops = defaultState.profiles[0].powerCeilingStops;
      return q;
    });
  }
  if (out.flash && out.flash.modifier != null && !known.has(out.flash.modifier)) {
    out.flash.modifier = LEGACY_CAL_MODIFIER;
    fellBack = true;
  }
  out.schemaVersion = SCHEMA_VERSION;

  const notice = movedCal
    ? 'モディファイアごとの校正に対応しました。標準リフレクター以外は再校正が必要です'
    : (fellBack ? '使われていないモディファイアを標準リフレクターに戻しました' : null);
  return { state: out, migrated: movedCal || fellBack, notice };
}
