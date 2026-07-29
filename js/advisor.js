// advisor.js — 撮影意図→推奨設定＋代替案＋警告の生成。純粋関数のみ。副作用ゼロ。
// 仕様 §8・§9・§10。警告は必ず「何段足りない／超過している」を数値で示す。

import { evTarget, solveSS, solveN, handShakeLimit } from './exposure.js';
import { solveND } from './filters.js';
import { gnBase, applyModifier, applyIso, effectiveGN, hssLoss } from './flash.js';
import { F, SS, snap } from './stops.js';

/**
 * 警告の発火閾値（段）。1/3段未満のズレは表示の丸め幅に埋もれ、
 * 近似モデル（1/焦点距離則など）の精度も±1段しかないため警告しない。
 * クランプ警告（compute 側）でも同じ方針を使うので export する。
 */
export const THIRD_STOP = 1 / 3;

/**
 * 段数を人間可読に整形する。整数はそのまま、端数は小数第1位まで。
 * 例：2 → "2"、1.644 → "1.6"、4.0 → "4"。
 * @param {number} x 段数
 * @returns {string}
 */
export function formatStops(x) {
  const r = Math.round(Math.abs(x) * 10) / 10;
  return Math.abs(r - Math.round(r)) < 1e-9 ? String(Math.round(r)) : r.toFixed(1);
}

/**
 * 符号付きの段数を「−1.3」「+0.5」「0.0」の形に整形する（背景段数の表示用）。
 * @param {number} x 段数（負で暗い）
 * @returns {string}
 */
export function formatOffset(x) {
  const sign = x > 0 ? '+' : x < 0 ? '−' : '';
  return `${sign}${Math.abs(x).toFixed(1)}`;
}

/**
 * 手ブレ警告。SS が手ブレ限界より遅く、かつ不足が 1/3段以上のとき warn。仕様 §9。
 * @param {number} ssReal シャッター速度（秒、厳密値）
 * @param {number} focal 焦点距離(mm)
 * @param {number} [isStops=0] 手ブレ補正段数
 * @returns {{level:string,icon:string,message:string,stops:number}|null}
 */
export function shakeWarning(ssReal, focal, isStops = 0) {
  const limit = handShakeLimit(focal, isStops);
  if (ssReal <= limit) return null;
  const stops = Math.log2(ssReal / limit);
  if (stops < THIRD_STOP) return null; // 偽の精度を避ける
  return {
    level: 'warn',
    icon: 'shake',
    stops,
    message: `手ブレしやすい速度です（限界より${formatStops(stops)}段遅い）。三脚か、ISO を上げてください`,
  };
}

/**
 * 明るすぎて SS 上限でも露出オーバーになる場合の減光警告。仕様 §9。
 * @param {number} neededT 適正に必要な SS（秒、SS 上限より速い＝小さいとオーバー）
 * @param {number} maxSSReal 機種の最速 SS（秒、厳密値）
 * @returns {{level:string,icon:string,message:string,stops:number}|null}
 */
export function overBrightWarning(neededT, maxSSReal) {
  if (neededT >= maxSSReal) return null;
  const stops = Math.log2(maxSSReal / neededT);
  return {
    level: 'alert',
    icon: 'nd',
    stops,
    message: `明るすぎます。約${formatStops(stops)}段の減光が必要です（ND）`,
  };
}

/**
 * ISO が拡張下限を下回る（明るすぎて絞りきれない）場合の警告。仕様 §9 / 確定事項。
 * @param {number} neededISO 適正に必要な ISO（連続値）
 * @param {number} expandedISOMin 拡張下限 ISO
 * @returns {{level:string,icon:string,message:string,stops:number}|null}
 */
export function isoFloorWarning(neededISO, expandedISOMin) {
  if (neededISO >= expandedISOMin) return null;
  const stops = Math.log2(expandedISOMin / neededISO);
  return {
    level: 'alert',
    icon: 'nd',
    stops,
    message: `明るすぎます。ISO を${formatStops(stops)}段下げきれません（拡張下限 ISO${expandedISOMin}）。減光してください`,
  };
}

/**
 * 閃光時間による被写体ブレ警告（スローシンクロ）。仕様 §5.5 / §9。
 * 止めているのは SS ではなく閃光時間。発光量が大きいほど閃光時間は長い。
 * @param {number} durationReal 閃光時間（秒）
 * @param {number|null} subjectSSReal 被写体の必要 SS（秒、null は制約なし）
 * @returns {{level:string,icon:string,message:string}|null}
 */
export function freezeWarning(durationReal, subjectSSReal) {
  if (subjectSSReal == null) return null;
  if (durationReal <= subjectSSReal) return null; // 閃光時間が十分短い
  return {
    level: 'warn',
    icon: 'motion',
    message: `閃光時間 ${snap(SS, durationReal).label} ではこの被写体は止まりません。発光量を下げて距離を詰めてください`,
  };
}

/**
 * ND 枚数に関する警告群。仕様 §6 / §9 / 確定事項。
 * - 2枚以上：拡張 ISO まで下げれば枚数を減らせる旨を info で提示。
 * - 3枚以上：ケラレ・色被り注意を warn で提示。
 * @param {import('./filters.js').NDSolution|null} nd
 * @param {{baseISO:number,expandedISOMin:number,ownedND:number[],wallStops:number}} ctx
 * @returns {Array<{level:string,icon:string,message:string}>}
 */
export function ndCountWarnings(nd, ctx) {
  const out = [];
  if (!nd || nd.count < 1) return out;
  const { baseISO, expandedISOMin, ownedND, wallStops } = ctx;
  if (nd.count >= 2) {
    const drop = Math.log2(baseISO / expandedISOMin);
    const reducedWall = wallStops - drop;
    const reduced = reducedWall <= 0 ? { count: 0 } : solveND(ownedND, Math.ceil(reducedWall - 1e-9));
    const rc = reduced ? reduced.count : null;
    const tail = rc === 0 ? 'ND が不要になります'
      : rc != null ? `ND ${rc}枚で済みます`
        : 'ND 枚数を減らせます';
    out.push({
      level: 'info',
      icon: 'nd',
      message: `ISO を拡張下限（${expandedISOMin}）まで下げれば${tail}（画質低下の可能性あり）`,
    });
  }
  if (nd.count >= 3) {
    out.push({
      level: 'warn',
      icon: 'nd',
      message: `ND を${nd.count}枚重ねます。ケラレ・色被りに注意してください`,
    });
  }
  return out;
}

/**
 * 日中シンクロの逆算。ND 経路と HSS 経路を両方計算して並べる。仕様 §8.1 / §5.6。
 * どちらも自動選択しない。到達距離と必要発光量をユーザーに見せて選ばせる。
 * @param {Object} p
 * @param {number} p.evScene
 * @param {number} p.iso 意図別ロジックの起点＝baseISO
 * @param {number} [p.comp=0]
 * @param {number} p.syncSpeedReal 同調速度（秒、厳密値）
 * @param {number} [p.ambientOffset=0] アンビエント目標段数（符号付き。−1=背景を1段暗く）
 * @param {number|null} [p.desiredN=null] 希望F値（厳密値）。null なら壁計算をしない
 * @param {number[]} [p.ownedND=[]]
 * @param {number} p.ws
 * @param {number} [p.k=4.0]
 * @param {number} [p.modLoss=0]
 * @param {boolean} [p.hssCapable=true]
 * @param {number} [p.hssBaseLoss=2.0]
 * @param {number} p.baseISO
 * @param {number} p.expandedISOMin
 * @returns {Object} { evAmbient, fAtSyncReal, fAtSync, wallStops?, ndPath?, hssPath?, warnings }
 */
export function daylightSync(p) {
  const {
    evScene, iso, comp = 0, syncSpeedReal, ambientOffset = 0,
    desiredN = null, ownedND = [], ws, k = 4.0, modLoss = 0,
    hssCapable = true, hssBaseLoss = 2.0, baseISO, expandedISOMin,
    maxSSReal = null,
  } = p;

  const evT = evTarget(evScene, iso, comp, 0);
  // 符号付き：−1段（背景を暗く）なら露出を減らす＝EV を上げる。
  const evAmbient = evT - ambientOffset;
  const fAtSyncReal = Math.sqrt(syncSpeedReal * 2 ** evAmbient);

  const out = { evAmbient, fAtSyncReal, fAtSync: snap(F, fAtSyncReal), warnings: [] };
  if (desiredN == null) return out;

  const wallStops = 2 * Math.log2(fAtSyncReal / desiredN);
  out.wallStops = wallStops;
  if (wallStops <= THIRD_STOP) return out; // 同調速度の壁なし＝通常発光で完結

  const gnIso = applyIso(applyModifier(gnBase(ws, k), modLoss), iso);

  // ND 経路：壁の段数を ND でカバーし、SS を同調速度に留める
  const need = Math.ceil(wallStops - 1e-9);
  const nd = solveND(ownedND, need);
  if (nd) {
    const gnEff = effectiveGN(gnIso, 0, nd.totalStops, 0);
    out.ndPath = { ...nd, ssReal: syncSpeedReal, ss: snap(SS, syncSpeedReal), gnEff, reach: gnEff / desiredN };
    out.warnings.push(...ndCountWarnings(nd, { baseISO, expandedISOMin, ownedND, wallStops }));
  } else {
    out.ndPath = null;
  }

  // HSS 経路：希望F値でアンビエント適正になる SS を求め、HSS 損失を反映。
  // SS 上限を超える要求は達成できないのでクランプし、損失・到達距離は
  // 「実際に使う SS」から求める。達成できる背景段数も返して黙って外さない。
  if (hssCapable) {
    const tIdeal = (desiredN * desiredN) / 2 ** evAmbient;
    const tUsed = maxSSReal != null ? Math.max(tIdeal, maxSSReal) : tIdeal;
    const clampStops = tUsed > tIdeal ? Math.log2(tUsed / tIdeal) : 0; // 背景が明るくなる段数
    const loss = hssLoss(hssBaseLoss, syncSpeedReal, tUsed);
    const gnEff = effectiveGN(gnIso, 0, 0, loss);
    const achievableOffset = ambientOffset + clampStops;
    out.hssPath = {
      ssReal: tUsed, ss: snap(SS, tUsed), hssLoss: loss, gnEff, reach: gnEff / desiredN,
      ssClamped: clampStops > 1e-6, clampStops, achievableOffset,
    };
    if (clampStops > 1e-6) {
      out.warnings.push({
        level: 'warn', icon: 'hss',
        message: `HSS経路は SS上限のため背景は ${formatOffset(achievableOffset)}段までです（${formatStops(clampStops)}段明るくなります）`,
      });
    }
  }

  return out;
}

/**
 * スローシンクロのアンビエント側 SS を求める。仕様 §8.2。
 * @param {Object} p
 * @param {number} p.evScene
 * @param {number} p.iso
 * @param {number} [p.comp=0]
 * @param {number} p.N F値（厳密値）
 * @param {number} [p.ambientOffset=0] 符号付き
 * @param {number} [p.nd=0] ND 減光段数
 * @returns {{evAmbient:number,ssReal:number,ss:{index:number,label:string,real:number,clamped:boolean}}}
 */
export function slowSyncAmbient(p) {
  const { evScene, iso, comp = 0, N, ambientOffset = 0, nd = 0 } = p;
  const evT = evTarget(evScene, iso, comp, nd);
  const evAmbient = evT - ambientOffset;
  const t = (N * N) / 2 ** evAmbient;
  return { evAmbient, ssReal: t, ss: snap(SS, t) };
}
