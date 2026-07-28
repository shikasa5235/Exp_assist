// exposure.js — アンビエント露出のソルバー。純粋関数のみ。副作用ゼロ。
// 仕様 §4。すべて連続値（float）で計算し、丸めは呼び出し側が snap() で一度だけ行う。

import { ISO_REF } from './scenes.js';

/**
 * 目標露出値 EV_target を求める。仕様 §4.1。
 *   EV_target = EV_scene + log2(S/100) − comp − nd
 * @param {number} evScene ISO100 基準のシーン EV
 * @param {number} iso ISO 感度
 * @param {number} [comp=0] 露出補正（段、正で明るく）
 * @param {number} [nd=0] ND 減光段数
 * @returns {number} EV_target
 */
export function evTarget(evScene, iso, comp = 0, nd = 0) {
  return evScene + Math.log2(iso / ISO_REF) - comp - nd;
}

/**
 * F値・ISO からシャッター速度（秒）を解く。仕様 §4.2。
 *   t = N² / 2^EV_target
 * @param {number} evScene
 * @param {number} iso
 * @param {number} N F値（厳密値）
 * @param {number} [comp=0]
 * @param {number} [nd=0]
 * @returns {number} シャッター速度（秒、連続値）
 */
export function solveSS(evScene, iso, N, comp = 0, nd = 0) {
  return (N * N) / 2 ** evTarget(evScene, iso, comp, nd);
}

/**
 * ISO・SS から F値を解く。仕様 §4.2。
 *   N = √(t · 2^EV_target)
 * @param {number} evScene
 * @param {number} iso
 * @param {number} t シャッター速度（秒）
 * @param {number} [comp=0]
 * @param {number} [nd=0]
 * @returns {number} F値（連続値）
 */
export function solveN(evScene, iso, t, comp = 0, nd = 0) {
  return Math.sqrt(t * 2 ** evTarget(evScene, iso, comp, nd));
}

/**
 * F値・SS から ISO を解く。仕様 §4.2。
 *   S = 100 · (N²/t) / 2^(EV_scene − comp − nd)
 * 返り値は連続値。ISO 下限へのクランプは呼び出し側（advisor / snap）で行う。
 * @param {number} evScene
 * @param {number} N F値（厳密値）
 * @param {number} t シャッター速度（秒）
 * @param {number} [comp=0]
 * @param {number} [nd=0]
 * @returns {number} ISO 感度（連続値）
 */
export function solveISO(evScene, N, t, comp = 0, nd = 0) {
  return ISO_REF * (N * N / t) / 2 ** (evScene - comp - nd);
}

/**
 * 手ブレ限界シャッター速度（秒）。仕様 §7.3。
 *   t_limit = (1/焦点距離) · 2^手ブレ補正段数
 * @param {number} focal 焦点距離(mm)
 * @param {number} [isStops=0] 手ブレ補正段数
 * @returns {number} 限界 SS（秒）
 */
export function handShakeLimit(focal, isStops = 0) {
  return (1 / focal) * 2 ** isStops;
}
