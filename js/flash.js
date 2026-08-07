// flash.js — ストロボ計算：Ws→GN・校正・有効GN・到達距離・HSS・閃光時間。
// 純粋関数のみ。副作用ゼロ。仕様 §5。
//
// 中核原理（間違えると全体が壊れる）：
// - シャッター速度はストロボ露出に影響しない（発光時間 < SS）。ここに t は現れない。
// - ND はレンズ前にあるためアンビエントとストロボの両方に等しく効く（ndStops として現れる）。
// - Ws→GN は一意に決まらない推定値。校正機能とセットで、未校正は「推定値」バッジを出す。

import { POWER_STEPS, ISO_REF } from './scenes.js';
import { F, ISO, snap } from './stops.js';

/**
 * Ws から基準 GN（ISO100・フル発光・標準リフレクター）を推定する。仕様 §5.2。
 *   GN_base = k · √Ws
 * @param {number} ws 出力（ワット秒）
 * @param {number} k 機材係数（既定 4.0、範囲 2.5〜5.0）
 * @returns {number} 推定 GN
 */
export function gnBase(ws, k) {
  return k * Math.sqrt(ws);
}

/**
 * モディファイア減光を適用する。仕様 §5.2。
 *   GN_mod = GN_base · 2^(-modifierLoss/2)
 * @param {number} gn 基準 GN
 * @param {number} modifierLoss 減光段数
 * @returns {number}
 */
export function applyModifier(gn, modifierLoss) {
  return gn * 2 ** (-modifierLoss / 2);
}

/**
 * ISO を反映した GN。仕様 §5.3。
 *   GN_iso = GN_mod · √(S/100)
 * @param {number} gn モディファイア適用後 GN
 * @param {number} iso ISO 感度
 * @returns {number}
 */
export function applyIso(gn, iso) {
  return gn * Math.sqrt(iso / ISO_REF);
}

/**
 * 有効 GN。発光量・ND・HSS の損失をまとめて反映する。仕様 §5.3。
 *   GN_eff = GN_iso · 2^(-(powerStops + ndStops + hssLossStops)/2)
 * @param {number} gnIso ISO 反映後 GN
 * @param {number} [powerStops=0] フル発光からの絞り段数
 * @param {number} [ndStops=0] ND 減光段数
 * @param {number} [hssLossStops=0] HSS 損失段数
 * @returns {number}
 */
export function effectiveGN(gnIso, powerStops = 0, ndStops = 0, hssLossStops = 0) {
  return gnIso * 2 ** (-(powerStops + ndStops + hssLossStops) / 2);
}

/**
 * 到達距離。仕様 §5.3。到達距離 = GN_eff / N
 * @param {number} gnEff 有効 GN
 * @param {number} N F値
 * @returns {number} 到達距離(m)
 */
export function reachDistance(gnEff, N) {
  return gnEff / N;
}

/**
 * 必要 F値。仕様 §5.3。必要F値 = GN_eff / distance
 *
 * **いまアプリからもテストからも呼ばれていない（意図的に残す）。**
 * F は撮影者が決める軸（アンビエントの背景露出を左右する）なので、アプリは F を出力にせず
 * 発光量か距離を解いている。それでも仕様 §5.3 が定義する式なので `reachDistance` と対で残す
 * ——片方だけ置くと「逆算の向きが1つしか無い」と誤読され、後から式が再発明されるため。
 * F 優先の逆算（例：被写界深度を固定して距離を出す）を足すときはここを使う。
 *
 * @param {number} gnEff 有効 GN
 * @param {number} distance ストロボ→被写体の距離(m)
 * @returns {number} F値
 */
export function requiredAperture(gnEff, distance) {
  return gnEff / distance;
}

/**
 * テスト撮影から実測 GN を逆算し、機材係数 k を更新する。仕様 §5.2。
 *   GN_measured = N · distance
 *   GN_at_iso100_full = GN_measured / √(S/100) · 2^(powerStops/2)
 *   k = GN_at_iso100_full / √Ws
 * @param {{ws:number,distance:number,fAperture:number,iso:number,powerStops?:number}} input
 *   fAperture は撮影者が読み取った表示F値（例：11）をそのまま使う。
 * @returns {{gnMeasured:number,gnAtIso100Full:number,k:number}}
 */
export function calibrate({ ws, distance, fAperture, iso, powerStops = 0 }) {
  const gnMeasured = fAperture * distance;
  const gnAtIso100Full = gnMeasured / Math.sqrt(iso / ISO_REF) * 2 ** (powerStops / 2);
  return { gnMeasured, gnAtIso100Full, k: gnAtIso100Full / Math.sqrt(ws) };
}

/**
 * **公称ラベルで読み取った値から校正する。校正 UI はこちらを呼ぶこと。**
 *
 * カメラの EXIF も、人が背面液晶から読んで打ち込む値も、どちらも 1/3段グリッドの
 * **公称ラベル**（`F11` の実体は 11.3137、`ISO80` は 79.37）。`calibrate()` に
 * ラベルのまま渡すと k が 0.08段 ずれる（200Ws・3m・ISO100・1/1 で 2.400 → 2.3335）。
 *
 * **スマホの測定側（`lightmeter.evFromExposure`）は逆に変換しない。**
 * あちらは AE が連続値で制御した実測値（`1/4405`）で、グリッド上に存在しないため。
 * 出所の判別はメタデータで行わない。**呼び出し側が自分の用途を知っている。**
 *
 * 変換をここに閉じ込めてあるので、UI 側で書き忘れる余地が無い。回帰テストは **I3**。
 *
 * @param {{ws:number,distance:number,fAperture:number,iso:number,powerStops?:number}} input
 *   fAperture / iso は**公称ラベル**（11 / 100 のように読み取った値）
 * @returns {{gnMeasured:number,gnAtIso100Full:number,k:number,
 *            fExact:number,isoExact:number}}
 */
export function calibrateFromLabels(input) {
  const g = (series, v) => (Number.isFinite(v) && v > 0 ? snap(series, v).real : v);
  const fExact = g(F, input.fAperture);
  const isoExact = g(ISO, input.iso);
  return { ...calibrate({ ...input, fAperture: fExact, iso: isoExact }), fExact, isoExact };
}

/**
 * HSS の損失段数（近似）。仕様 §5.4。
 *   hssLossStops = hssBaseLoss + log2(tSync / t)   （t < tSync のとき）
 * @param {number} hssBaseLoss HSS 基準損失（既定 2.0）
 * @param {number} tSync 同調速度（秒）
 * @param {number} t シャッター速度（秒）
 * @returns {number}
 */
export function hssLoss(hssBaseLoss, tSync, t) {
  return hssBaseLoss + Math.log2(tSync / t);
}

/**
 * 過剰段数。正なら光が強すぎる。仕様 §5.3。
 *   overStops = 2 · log2(GN_after / (N · distance))
 * GN_after は ND・HSS を反映しフル発光時の GN（発光量はまだ引かない）。
 * @param {number} gnAfterFilters ND/HSS 反映後・フル発光の GN
 * @param {number} N F値
 * @param {number} distance ストロボ→被写体の距離(m)
 * @returns {number}
 */
export function overStops(gnAfterFilters, N, distance) {
  return 2 * Math.log2(gnAfterFilters / (N * distance));
}

/**
 * 過剰段数を発光量ステップ（整数段）と FEC 端数に分解する。仕様 §5.3。
 * 例：6.2段オーバー → 発光量 1/64（powerStops=6）＋ FEC −0.2段。
 * @param {number} over 過剰段数
 * @param {{maxPowerStops?:number,minPowerStops?:number}} [opts]
 * @returns {{powerStops:number,fec:number}}
 */
export function resolvePower(over, opts = {}) {
  const { maxPowerStops = 7, minPowerStops = 0 } = opts;
  const powerStops = Math.max(minPowerStops, Math.min(maxPowerStops, Math.round(over)));
  return { powerStops, fec: over - powerStops };
}

/**
 * 固定発光量から「推奨距離」を解く。距離はストロボにだけ効き、背景の明るさを変えないため、
 * 発光量を固定したときに動かすべき唯一の軸（F や ISO を動かすと背景まで変わる）。仕様 §5.3。
 * @param {{gnIso:number,N:number,powerStops?:number,ndStops?:number,hssLossStops?:number}} p
 * @returns {{gnEff:number,distance:number}} distance はストロボ→被写体(m)
 */
export function solveDistance({ gnIso, N, powerStops = 0, ndStops = 0, hssLossStops = 0 }) {
  const gnEff = effectiveGN(gnIso, powerStops, ndStops, hssLossStops);
  return { gnEff, distance: gnEff / N };
}

/**
 * 発光量の上限（強い側）を尊重して発光量を決める。上限より強い側は主案にしない。
 * @param {number} over 過剰段数（overStops の戻り値。正なら光が強すぎる＝絞れる段数）
 * @param {{ceilingStops?:number,minPowerStops?:number}} limits
 *   ceilingStops = 強い側の限界（3 = 1/8）／minPowerStops = 弱い側の限界（7 = 1/128）
 * @returns {{powerStops:number,fec:number,shortStops:number,excessStops:number}}
 *   shortStops>0 は上限に当たって光量が足りない分、excessStops>0 は最小発光量でも強すぎる分
 */
export function resolvePowerWithCeiling(over, limits = {}) {
  const { ceilingStops = 0, minPowerStops = 7 } = limits;
  const rounded = Math.round(over);
  const powerStops = Math.max(ceilingStops, Math.min(minPowerStops, rounded));
  return {
    powerStops,
    fec: over - powerStops,
    shortStops: Math.max(0, ceilingStops - over),   // 上限のほうが弱い＝光が足りない
    excessStops: Math.max(0, over - minPowerStops), // 最小発光量でも強すぎる
  };
}

/**
 * 発光量に対応する閃光時間の目安（秒）。仕様 §5.5 / §7.6。
 * @param {number} powerStops フル発光からの段数(0..7)
 * @returns {number|null} 閃光時間(秒)。範囲外は null
 */
export function flashDuration(powerStops) {
  const step = POWER_STEPS[powerStops];
  return step ? step.duration : null;
}
