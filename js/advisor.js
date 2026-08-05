// advisor.js — 撮影意図→推奨設定＋代替案＋警告の生成。純粋関数のみ。副作用ゼロ。
// 仕様 §8・§9・§10。警告は必ず「何段足りない／超過している」を数値で示す。

import { evTarget, solveSS, solveN, handShakeLimit } from './exposure.js';
import { solveND, ndLabel } from './filters.js';
import { gnBase, applyModifier, applyIso, effectiveGN, hssLoss } from './flash.js';
import { F, SS, snap } from './stops.js';
import { HELP, BACKLIT_EXTRA_STOPS, AMBIENT_OFFSETS } from './scenes.js';

/**
 * 警告の発火閾値（段）。1/3段未満のズレは表示の丸め幅に埋もれ、
 * 近似モデル（1/焦点距離則など）の精度も±1段しかないため警告しない。
 * クランプ警告（compute 側）でも同じ方針を使うので export する。
 */
export const THIRD_STOP = 1 / 3;

/**
 * 段数を「実在する整数段の機材」（ND）へ切り上げるときに吸収する誤差（段）。
 *
 * **IEEE754 の丸め誤差だけを吸収するための値。**
 * `2 ** (i/6)` などで作った 1/3段の値どうしの比を `log2` で段数に戻すと、
 * 本来ちょうど整数のところが `6.000000000000001` になることがある。
 * `Math.ceil` はこれを 7 に飛ばし、**ND がまるごと1段増える。**
 *
 * **特定の経路の保険ではない。** 1/3段グリッドの全組み合わせ（40×40）を走査すると
 * `2·log2(F/F)` の経路で 215/1600、`log2(N²/t)` の経路で 28/1600 に誤差が乗る。
 * 約13%。**段数を切り上げるすべての箇所で必要。**
 *
 * **公称ラベル（F2.8 / 1/250）を厳密値として扱ってしまう誤差はここでは吸収しない。**
 * あちらは 0.03〜0.09段 と桁が7つ違い、`compute.exactGear()` が入口で厳密値へ直して潰す。
 * ここを大きくして誤魔化すと、本当に切り上げが要る 6.1段 を 6段 と答えるようになる。
 */
export const CEIL_EPS = 1e-9;

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
    helpId: HELP.shake,
    stops,
    message: `手ブレしやすい速度です（限界より${formatStops(stops)}段遅い）。三脚か、ISO を上げてください`,
  };
}

/**
 * 必要減光量から「装着すべき ND の組み合わせ」を解く。仕様 §6。
 *
 * **必要段数は切り上げる。** ND は整数段でしか存在しないため。切り捨てると露出過剰が残り、
 * 装着しても警告が消えない（実機で確認された症状）。切り上げた余りは自由軸が吸収できる
 * ——自由軸は「明るすぎ」側の限界に張り付いているので、暗くする方向には動かせるため。
 *
 * @param {number[]} ownedND 所有 ND の段数（例：[1,2,3,4]）
 * @param {number} requiredStops いま不足している減光段数（連続値）
 * @param {number} [attachedStops=0] すでに装着済みの減光段数（合計必要量に含める）
 * @returns {{text:string,ok:boolean,solution:import('./filters.js').NDSolution|null,need:number}}
 *   ok=true のとき text は「ND2+ND16（5段）を装着」形式（後ろに「してください」を継げられる）。
 *   ok=false のとき text は理由を述べる完結した文か空文字（継いではいけない）。
 */
export function ndAdvice(ownedND, requiredStops, attachedStops = 0) {
  const owned = ownedND || [];
  const need = Math.ceil(attachedStops + requiredStops - CEIL_EPS);
  if (need <= 0 || owned.length === 0) {
    return { text: '', ok: false, solution: null, need: Math.max(0, need) };
  }
  const sol = solveND(owned, need);
  if (!sol || !sol.count) {
    const max = owned.reduce((a, b) => a + b, 0);
    return { text: `所有 ND（合計${max}段）では ${need}段 に届きません`, note: '', ok: false, solution: null, need, overshoot: 0 };
  }
  // 行き過ぎ量。所有 ND の刻みによっては 4.7段 に対して 7段 しか作れない、ということが起こる。
  // このとき 2.3段 暗くなり、自由軸では吸収しきれない。**黙って勧めない。**
  // 1/3段未満なら自由軸が吸収するので書かない（書くと端数の説明が常時出て読み飛ばされる）。
  const overshoot = sol.totalStops - (attachedStops + requiredStops);
  return {
    text: `${ndLabel(sol.filters)}（${sol.totalStops}段）を装着`,
    note: overshoot >= THIRD_STOP ? `（${formatStops(overshoot)}段 暗くなります）` : '',
    ok: true, solution: sol, need, overshoot,
  };
}

/**
 * 明るすぎて SS 上限でも露出オーバーになる場合の減光警告。仕様 §9。
 * **必要段数は丸めずに 1/3段の精度で出す。** 整数に丸めるとその通り装着しても合わない。
 * @param {number} neededT 適正に必要な SS（秒、SS 上限より速い＝小さいとオーバー）
 * @param {number} maxSSReal 機種の最速 SS（秒、厳密値）
 * @param {{ownedND?:number[],attachedStops?:number}} [opts] 組み合わせ提案の材料
 * @returns {{level:string,icon:string,message:string,stops:number}|null}
 */
export function overBrightWarning(neededT, maxSSReal, opts = {}) {
  if (neededT >= maxSSReal) return null;
  const stops = Math.log2(maxSSReal / neededT);
  if (stops < THIRD_STOP) return null; // 1/3段未満は表示の丸め幅に埋もれる。行動に移せない
  const { ownedND = [], attachedStops = 0 } = opts;
  const adv = ndAdvice(ownedND, stops, attachedStops);
  return {
    level: 'alert',
    icon: 'nd',
    helpId: HELP.nd,
    stops,
    message: `明るすぎます。${formatStops(stops)}段の減光が必要です`
      + (adv.ok ? `。${adv.text}してください${adv.note}` : adv.text ? `。${adv.text}` : '（ND）'),
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
  if (stops < THIRD_STOP) return null; // 1/3段未満は表示の丸め幅に埋もれる
  return {
    level: 'alert',
    icon: 'nd',
    helpId: HELP.nd,
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
    helpId: HELP.flashDuration,
    message: `閃光時間 ${snap(SS, durationReal).label} ではこの被写体は止まりません。発光量を下げて距離を詰めてください`,
  };
}

/** 背景段数のラベル。整数の選択肢なので「−2段」の形に整える（formatOffset は小数第1位）。 */
function offsetLabel(o) {
  return o > 0 ? `+${o}段` : o === 0 ? '0段' : `−${Math.abs(o)}段`;
}

/**
 * 白飛び警告。**適正露出でも空は飛ぶ**ことを段数ではなく「選ぶべき背景段数」で伝える。
 * 仕様 §11 / photocal-spec §5.1・§5.2・§5.4。
 *
 *   オーバー段数 = コントラスト目安 + 背景段数 − ヘッドルーム
 *
 * 段数そのものより背景段数を出すのは、目安の精度が±1段しかないため。
 * 「4.5段の差がある」より「背景を−2段にすれば残る」のほうが誤差に強く、そのまま行動に移せる。
 *
 * @param {Object} p
 * @param {number|null} p.contrastStops シーンのコントラスト目安（null なら判定しない）
 * @param {string} p.sceneLabel シーン名（文言に出す）
 * @param {boolean} [p.backlit=false] 逆光なら BACKLIT_EXTRA_STOPS を足す
 * @param {number} [p.ambientOffset=0] 現在の背景段数（符号付き）
 * @param {number} [p.headroomStops=3] ハイライトのヘッドルーム
 * @param {number[]} [p.offsets] 選べる背景段数
 * @param {number} [p.flashHeadroomStops=Infinity] ストロボが余らせている段数（フル発光までの余裕）
 * @param {number} [p.costPerStop=0] 背景を1段暗くするとストロボが失う段数
 *   （日中シンクロは同調速度の壁が1段上がるので 1。スローシンクロは SS が動くだけなので 0）
 * @returns {{level:string,icon:string,helpId:string,message:string,overStops:number,
 *            recommendedOffset:number|null}|null}
 */
export function blowoutWarning(p) {
  const {
    contrastStops, sceneLabel = 'このシーン', backlit = false, ambientOffset = 0,
    headroomStops = 3.0, offsets = AMBIENT_OFFSETS,
    flashHeadroomStops = Infinity, costPerStop = 0,
  } = p;
  if (contrastStops == null) return null; // 判定を持たないシーン（屋内・夜間・薄暮）
  const contrast = contrastStops + (backlit ? BACKLIT_EXTRA_STOPS : 0);
  const overOf = (o) => contrast + o - headroomStops;
  const over = overOf(ambientOffset);
  if (over < THIRD_STOP) return null; // 1/3段未満は表示の丸め幅に埋もれる（他の警告と同じ閾値）

  // 空が残る最も明るい背景段数。判定の閾値を警告と揃える（ここだけ厳しくすると推奨が1段ずれる）
  const safe = offsets.filter((o) => overOf(o) < THIRD_STOP);
  const recommended = safe.length ? Math.max(...safe) : null;

  // 現在値から推奨（無ければ最も暗い選択肢）までを並べる。明るい順
  const floorOffset = recommended == null ? Math.min(...offsets) : recommended;
  const rows = offsets
    .filter((o) => o <= ambientOffset && o >= floorOffset)
    .sort((a, b) => b - a)
    .map((o) => {
      const ov = overOf(o);
      const verdict = ov >= THIRD_STOP ? `${formatStops(ov)}段オーバー` : '空が残ります';
      return `背景 ${offsetLabel(o)} → ${verdict}${o === recommended ? '（推奨）' : ''}`;
    });

  const head = `空が飛ぶ可能性があります（${sceneLabel}${backlit ? '・逆光' : ''}の目安 ${formatStops(contrast)}段）`;
  const tail = '※空を飛ばす表現を狙う場合はこの警告を無視してかまいません';
  const parts = [head, rows.join('／')];

  if (recommended == null) {
    parts.push(`背景を ${offsetLabel(floorOffset)} まで落としても空は残りません。露出を諦めるか、空を画角から外してください`);
  } else {
    // **提案が別の警告を生まないか検証する。** 背景を暗くすると日中シンクロでは
    // 同調速度の壁が上がり、ND か HSS 損失が増えてストロボが届かなくなる。
    const need = (ambientOffset - recommended) * costPerStop;
    if (need > flashHeadroomStops + THIRD_STOP) {
      const shortStops = formatStops(need - flashHeadroomStops);
      parts.push(`ただし背景 ${offsetLabel(recommended)} では光量が ${shortStops}段 足りません（減光がその分増えるため）。距離を詰めるか ISO を上げてください`);
    }
  }
  parts.push(tail);

  return {
    level: 'warn', icon: 'nd', helpId: HELP.blowout,
    overStops: over, recommendedOffset: recommended,
    message: parts.join('。').replace(/。。/g, '。'),
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
  const { baseISO, expandedISOMin, ownedND, wallStops, allowExpandedIso = false } = ctx;
  // 拡張ISO が既に ON なら「使えば減る」という提案は成り立たない
  if (nd.count >= 2 && !allowExpandedIso) {
    const drop = Math.log2(baseISO / expandedISOMin);
    const reducedWall = wallStops - drop;
    const reduced = reducedWall <= 0 ? { count: 0 } : solveND(ownedND, Math.ceil(reducedWall - CEIL_EPS));
    const rc = reduced ? reduced.count : null;
    const tail = rc === 0 ? 'ND が不要になります'
      : rc != null ? `ND ${rc}枚で済みます`
        : 'ND 枚数を減らせます';
    out.push({
      level: 'info',
      icon: 'nd',
      helpId: HELP.nd,
      // トグルを入れれば解決する、という具体的な行動を指す文言にする
      message: `拡張ISO（${expandedISOMin}〜）を使えば${tail}（画質低下の可能性あり）`,
    });
  }
  if (nd.count >= 3) {
    out.push({
      level: 'warn',
      icon: 'nd',
      helpId: HELP.nd,
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
    maxSSReal = null, allowExpandedIso = false,
  } = p;

  const evT = evTarget(evScene, iso, comp, 0);
  // 符号付き：−1段（背景を暗く）なら露出を減らす＝EV を上げる。
  const evAmbient = evT - ambientOffset;
  const fAtSyncReal = Math.sqrt(syncSpeedReal * 2 ** evAmbient);

  // fAtSync（丸めたラベル）は js/ からは読まれない。**テスト #19 が読むので残す**
  // ——「同調速度で適正になるF値」は日中シンクロの理解の中心で、壁の段数が正しいことを
  // 表示ラベルの水準で確かめられる唯一の出口。消すと #19 が検証対象を失う。
  const out = { evAmbient, fAtSyncReal, fAtSync: snap(F, fAtSyncReal), warnings: [] };
  if (desiredN == null) return out;

  const wallStops = 2 * Math.log2(fAtSyncReal / desiredN);
  out.wallStops = wallStops;
  if (wallStops <= THIRD_STOP) return out; // 同調速度の壁なし＝通常発光で完結

  const gnIso = applyIso(applyModifier(gnBase(ws, k), modLoss), iso);

  // ND 経路：壁の段数を ND でカバーし、SS を同調速度に留める
  const need = Math.ceil(wallStops - CEIL_EPS);
  const nd = solveND(ownedND, need);
  if (nd) {
    const gnEff = effectiveGN(gnIso, 0, nd.totalStops, 0);
    out.ndPath = { ...nd, ssReal: syncSpeedReal, ss: snap(SS, syncSpeedReal), gnEff, reach: gnEff / desiredN };
    out.warnings.push(...ndCountWarnings(nd, { baseISO, expandedISOMin, ownedND, wallStops, allowExpandedIso }));
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
    // 1/3段未満のはみ出しは「背景が明るくなる」と言うほどの差ではない（表示は1/3段グリッド）。
    // ここを 1e-6 にすると端数のたびに達成不能の警告が出て、消しようがなくなる。
    const clamped = clampStops >= THIRD_STOP;
    out.hssPath = {
      ssReal: tUsed, ss: snap(SS, tUsed), hssLoss: loss, gnEff, reach: gnEff / desiredN,
      ssClamped: clamped, clampStops, achievableOffset,
    };
    if (clamped) {
      out.warnings.push({
        level: 'warn', icon: 'hss', helpId: HELP.syncWall,
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
