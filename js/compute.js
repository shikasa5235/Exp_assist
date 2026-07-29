// compute.js — state → derived の純粋オーケストレーション。副作用ゼロ。
// DOM・localStorage・window に触らない。計算は各純粋モジュールへ委譲し、ここは束ねるだけ。
// ui.js はこの derived を描画するだけで、計算を持たない（CLAUDE.md アーキテクチャ）。

import { F, SS, ISO, snap } from './stops.js';
import { evTarget, solveSS, solveN, solveISO, handShakeLimit } from './exposure.js';
import {
  gnBase, applyModifier, applyIso, effectiveGN, overStops, resolvePower, flashDuration,
} from './flash.js';
import {
  shakeWarning, overBrightWarning, isoFloorWarning, freezeWarning,
  daylightSync, slowSyncAmbient, formatStops, formatOffset, THIRD_STOP,
} from './advisor.js';
import { SUBJECTS, MODIFIERS, POWER_STEPS } from './scenes.js';

const SLOWEST = 2 ** (-SS.minIndex / 3); // 系列最遅（= 30″ の実体 32 秒）
const F8 = 8; // 風景の固定F値

/* ---- 小さな純粋ヘルパー ------------------------------------------------ */

/** 装着中 ND の合計段数。 @param {object} st @returns {number} */
function ndStops(st) { return (st.nd || []).reduce((a, b) => a + b, 0); }

/** ND 段数 → 表示名（ND2/ND4/…）。 @param {number} stops @returns {string} */
function ndName(stops) { return `ND${2 ** stops}`; }

/** ND 段数配列 → 連結ラベル（例 "ND2+ND16"）。表示は薄い順に統一。装着なしは空文字。 */
function ndLabelOf(stopsArr) {
  if (!stopsArr || !stopsArr.length) return '';
  return [...stopsArr].sort((a, b) => a - b).map(ndName).join('+');
}

/** モディファイアキー → 減光段数。 @param {string} key @returns {number} */
function modLossOf(key) { const m = MODIFIERS.find((x) => x.key === key); return m ? m.loss : 0; }

/** 使用中プロファイル。 @param {object} st @returns {object} */
function profileOf(st) { return st.profiles.find((p) => p.id === st.flash.profileId) || st.profiles[0]; }

/** 被写体キー → 必要SS（秒, null可）。 */
function subjectSSOf(key) { const s = SUBJECTS.find((x) => x.key === key); return s ? s.ss : null; }

/** 連続F/SS/ISO をまとめて snap する。 */
function snapTriple(fReal, ssReal, isoReal) {
  return { f: snap(F, fReal), ss: snap(SS, ssReal), iso: snap(ISO, isoReal) };
}

/* ---- 意図別ロジック（アンビエント4種）。仕様 §8 ----------------------- */

/** 背景をぼかす：F開放固定→SS算出→手ブレ限界を割ったらISOを上げる。 */
function intentBlur(ev, st) {
  const { lens, camera, focal, settings } = st;
  const nd = ndStops(st), comp = settings.comp, fReal = lens.fMin;
  let iso = camera.isoMin;
  let ss = solveSS(ev, iso, fReal, comp, nd);
  const limit = handShakeLimit(focal, camera.isStops);
  if (ss > limit) { // 遅すぎる → ISO を上げて SS を稼ぐ
    const need = Math.log2(ss / limit);
    iso = Math.min(camera.isoMax, camera.isoMin * 2 ** need);
    ss = solveSS(ev, iso, fReal, comp, nd);
  }
  return { fReal, ssReal: ss, isoReal: iso };
}

/** 動きを止める：被写体SS固定→F開放から→不足分をISO。 */
function intentFreeze(ev, st) {
  const { lens, camera, subject, settings } = st;
  const nd = ndStops(st), comp = settings.comp, fMin = lens.fMin;
  const req = subjectSSOf(subject);
  if (req == null) return intentBlur(ev, st); // 制約なしはぼかし相当
  const isoNeeded = solveISO(ev, fMin, req, comp, nd);
  if (isoNeeded < camera.isoMin) { // 余る → 絞る
    const iso = camera.isoMin;
    return { fReal: solveN(ev, iso, req, comp, nd), ssReal: req, isoReal: iso };
  }
  if (isoNeeded <= camera.isoMax) return { fReal: fMin, ssReal: req, isoReal: isoNeeded };
  // 上限でも足りない → SS が要求に届かず被写体ブレ
  const iso = camera.isoMax;
  return { fReal: fMin, ssReal: solveSS(ev, iso, fMin, comp, nd), isoReal: iso, missSS: req };
}

/** 風景をくっきり：F8固定・ISOベース→SS算出。 */
function intentLandscape(ev, st) {
  const { camera, settings } = st;
  const nd = ndStops(st), comp = settings.comp;
  const iso = camera.isoMin;
  return { fReal: F8, ssReal: solveSS(ev, iso, F8, comp, nd), isoReal: iso };
}

/** 夜・手持ち：SS=手ブレ限界固定→F開放→ISO算出。 */
function intentNight(ev, st) {
  const { lens, camera, focal, settings } = st;
  const nd = ndStops(st), comp = settings.comp, fReal = lens.fMin;
  const limit = handShakeLimit(focal, camera.isStops);
  const isoNeeded = solveISO(ev, fReal, limit, comp, nd);
  const iso = Math.max(camera.isoMin, Math.min(camera.isoMax, isoNeeded));
  const shortStops = isoNeeded > camera.isoMax ? Math.log2(isoNeeded / camera.isoMax) : 0;
  return { fReal, ssReal: limit, isoReal: iso, shortStops };
}

const AMBIENT_INTENTS = {
  blur: intentBlur, freeze: intentFreeze, landscape: intentLandscape, nightHandheld: intentNight,
};

/* ---- クランプと警告（アンビエント）。仕様 §9・§10 -------------------- */

/**
 * 露出可能範囲へクランプし、はみ出しを警告に変換する。入力は拒否しない。
 * @returns {{fReal,ssReal,isoReal,warnings:Array}}
 */
function clampAmbient(r, st, ev) {
  const { camera, lens, focal, settings, intent, subject } = st;
  const nd = ndStops(st), comp = settings.comp;
  const warnings = [];
  let { fReal, ssReal, isoReal } = r;

  // 明るすぎ：必要SSが機種最速より速い → ND 段数を提示
  if (ssReal < camera.maxSS) {
    const w = overBrightWarning(ssReal, camera.maxSS);
    if (w) warnings.push(w);
    ssReal = camera.maxSS;
  }
  // 暗すぎ：系列最遅を超える長秒 → クランプ
  if (ssReal > SLOWEST) ssReal = SLOWEST;

  // 光量不足：必要ISOが上限超過（夜・手持ちなど）
  if (r.shortStops > 1e-3) {
    warnings.push({ level: 'alert', icon: 'noise',
      message: `光量が${formatStops(r.shortStops)}段足りません。開放を明るく、または三脚が必要です` });
  }
  // 被写体ブレ：止めたいのに必要SSへ届かない
  if (r.missSS != null && ssReal > r.missSS) {
    const s = Math.log2(ssReal / r.missSS);
    warnings.push({ level: 'warn', icon: 'motion',
      message: `被写体が流れます。1/${Math.round(1 / r.missSS)} 以上が必要（${formatStops(s)}段不足）` });
  }
  // 手ブレ（SSを固定していない意図で、限界より遅いとき）
  if (intent !== 'nightHandheld') {
    const w = shakeWarning(ssReal, focal, camera.isStops);
    if (w) warnings.push(w);
  }
  // 被写体ブレ基準（止める意図以外でも動く被写体なら）
  const req = subjectSSOf(subject);
  if (intent !== 'freeze' && req != null && ssReal > req) {
    warnings.push({ level: 'warn', icon: 'motion',
      message: `被写体が流れます。1/${Math.round(1 / req)} 以上にしてください` });
  }
  // 回折・高感度・三脚（情報）
  if (fReal > 11) warnings.push({ level: 'info', icon: 'diffraction', message: '回折で解像が落ち始めます' });
  if (isoReal > camera.isoMax / 2) warnings.push({ level: 'info', icon: 'noise', message: 'ノイズが目立ち始める領域です' });
  if (ssReal >= 0.5) warnings.push({ level: 'info', icon: 'tripod', message: '三脚推奨（SS 1/2秒以上）' });

  return { fReal, ssReal, isoReal, warnings };
}

/* ---- 代替案（主案＋2案）。仕様 §10.1 --------------------------------- */

/**
 * ブレ回避（SSを上げてISOで補う）／画質優先（ISOを下げてSSで補う）を作る。
 * 実用範囲外・主案と同一なら出さない。
 */
function alternatives(ev, st, primary) {
  const { camera, lens, focal, settings } = st;
  const nd = ndStops(st), comp = settings.comp;
  const limit = handShakeLimit(focal, camera.isStops);
  const out = [];
  const same = (a, b) => Math.abs(Math.log2(a.isoReal / b.isoReal)) < 0.16
    && Math.abs(Math.log2(a.ssReal / b.ssReal)) < 0.16;

  // 代替A：ブレを避ける（SSを手ブレ限界まで上げ、ISOで補う）
  if (primary.ssReal > limit * 1.26) {
    let iso = Math.min(camera.isoMax, primary.isoReal * (primary.ssReal / limit));
    const ss = solveSS(ev, iso, primary.fReal, comp, nd);
    const cand = { fReal: primary.fReal, ssReal: ss, isoReal: iso };
    if (!same(cand, primary)) out.push({ tag: 'ブレを避ける', ...snapTriple(cand.fReal, cand.ssReal, cand.isoReal) });
  }
  // 代替B：画質優先（ISOを1段下げ、SSを遅くして補う）
  if (primary.isoReal > camera.isoMin * 1.9) {
    const iso = Math.max(camera.isoMin, primary.isoReal / 2);
    const ss = solveSS(ev, iso, primary.fReal, comp, nd);
    const cand = { fReal: primary.fReal, ssReal: ss, isoReal: iso };
    if (ss <= SLOWEST && !same(cand, primary)) out.push({ tag: '画質を優先', ...snapTriple(cand.fReal, cand.ssReal, cand.isoReal) });
  }
  return out;
}

/* ---- ストロボの必要発光量・到達（共通） ------------------------------ */

/**
 * 有効GN（フル発光時）・F値・距離から発光量/FEC/到達/閃光時間を求める。
 * @returns {{powerStops,powerLabel,fec,reach,durationReal,durationLabel,over}}
 */
function flashSettings(gnFull, N, distance, minPowerStops) {
  const over = overStops(gnFull, N, distance);
  const { powerStops, fec } = resolvePower(over, { maxPowerStops: minPowerStops });
  const dur = flashDuration(powerStops);
  return {
    powerStops, powerLabel: POWER_STEPS[powerStops].label, fec, over,
    reach: gnFull / N, durationReal: dur, durationLabel: snap(SS, dur).label,
  };
}

/* ---- EV ルーラー用トラック ------------------------------------------- */

/**
 * 結果パネルのトラック集合を組む。表示本数はここで確定し、ui はこれを描くだけにする。
 * snapped=null は「F/SS/ISO を出さない」（計算タブ：操作ホイールが同じ役割を担うため重複させない）。
 * powerStops=null は「発光量を出さない」（ストロボ OFF）。
 * @param {{f,ss,iso}|null} snapped
 * @param {number|null} powerStops
 * @returns {Array<{name:string,cur:string,index:number,series:string,isFlash:boolean}>}
 */
function buildTracks(snapped, powerStops) {
  const tracks = [];
  if (snapped) {
    tracks.push(
      { name: 'F', cur: snapped.f.label, index: snapped.f.index, series: 'F', isFlash: false },
      { name: 'SS', cur: snapped.ss.label, index: snapped.ss.index, series: 'SS', isFlash: false },
      { name: 'ISO', cur: snapped.iso.label, index: snapped.iso.index, series: 'ISO', isFlash: false },
    );
  }
  if (powerStops != null) {
    tracks.push({ name: '発光', cur: POWER_STEPS[powerStops].label, index: powerStops, series: 'POWER', isFlash: true });
  }
  return tracks;
}

/* ---- 等価露出一覧（計算タブ）。仕様 §10.2 ---------------------------- */

function equivalentList(ev, st, mainFIndex) {
  const { camera, lens, settings } = st;
  const nd = ndStops(st), comp = settings.comp;
  const rows = [];
  // F は1段刻み（開放F〜F16）。1段 = index 3 ステップ。同EV上でSSを算出、実用範囲のみ。
  const fStart = Math.round(F.indexFor(lens.fMin) / 3) * 3; // 開放を含む1段グリッド
  const fEnd = F.indexFor(16);
  for (let fi = fStart; fi <= fEnd + 1e-6; fi += 3) {
    const fReal = F.real(fi);
    const ss = solveSS(ev, camera.isoMin, fReal, comp, nd);
    if (ss < camera.maxSS || ss > SLOWEST) continue; // 実用範囲外
    const sf = snap(F, fReal), ss2 = snap(SS, ss), iso2 = snap(ISO, camera.isoMin);
    const flags = [];
    if (fReal > 11) flags.push('diffraction');
    if (ss > handShakeLimit(st.focal, camera.isStops)) flags.push('shake');
    rows.push({ fLabel: sf.label, ssLabel: ss2.label, isoLabel: iso2.label, flags, isMain: sf.index === mainFIndex });
  }
  if (rows.length > 9) { // 主案中心に前後を切る
    const mi = Math.max(0, rows.findIndex((r) => r.isMain));
    const start = Math.min(Math.max(0, mi - 4), rows.length - 9);
    return rows.slice(start, start + 9);
  }
  return rows;
}

/* ---- 計算タブ：2ロック→残り1つを自動算出 ---------------------------- */

/**
 * 自由軸が範囲限界に達して露出を満たせないときの警告。ロックは破らず不足段数を提示する。
 * @param {'F'|'SS'|'ISO'} axis 限界に達した自由軸
 * @param {number} stops 不足/超過の段数
 * @param {'short'|'bright'} kind short=光量不足（上限張り付き）／bright=明るすぎ（下限張り付き）
 * @param {boolean} hasND ND 装着中か
 */
function manualShort(axis, stops, kind, hasND) {
  const N = formatStops(stops);
  const inc = { F: `F を ${N}段開ける`, SS: `SS を ${N}段遅くする`, ISO: `ISO を ${N}段上げる` };
  const dec = { F: `F を ${N}段絞る`, SS: `SS を ${N}段速める`, ISO: `ISO を ${N}段下げる` };
  const others = ['F', 'SS', 'ISO'].filter((a) => a !== axis);
  if (kind === 'short') {
    const axisRem = others.map((a, i) => (i === 0 ? 'ロックを外して ' : '') + inc[a]);
    const remedies = [hasND ? 'ND を1枚外す' : null, ...axisRem].filter(Boolean);
    return { level: 'alert', icon: 'alert', message: `${axis} が ${N}段 足りません。${remedies.join('／')}` };
  }
  const axisRem = others.map((a, i) => (i === 0 ? 'ロックを外して ' : '') + dec[a]);
  return { level: 'alert', icon: 'alert', message: `明るすぎます（${N}段超過）。${['ND を足す', ...axisRem].join('／')}` };
}

function manualResult(ev, st) {
  const { manual, camera, settings, lens } = st;
  const nd = ndStops(st), comp = settings.comp;
  const L = manual.locks || { f: true, ss: true, iso: false };
  // 非ロック（false）が自動算出される軸。ちょうど1つを想定、無ければ ss。
  const computedKey = ['f', 'ss', 'iso'].find((k) => !L[k]) || 'ss';
  // ロック軸は保存済み index を使い、未確定なら既定値で補完（開放F・ベースISO）。
  let fReal = manual.fIndex != null ? F.real(manual.fIndex) : lens.fMin;
  let isoReal = manual.isoIndex != null ? ISO.real(manual.isoIndex) : camera.isoMin;
  let ssReal = manual.ssIndex != null ? SS.real(manual.ssIndex) : solveSS(ev, isoReal, fReal, comp, nd);
  // 非ロック軸を残り2軸から解く（連動）
  if (computedKey === 'ss') ssReal = solveSS(ev, isoReal, fReal, comp, nd);
  else if (computedKey === 'iso') isoReal = solveISO(ev, fReal, ssReal, comp, nd);
  else fReal = solveN(ev, isoReal, ssReal, comp, nd);

  // 自由軸が範囲外＝ND等を吸収しきれない。ロックは破らずクランプし、不足/超過を段数付きで警告する。
  // 黙ってクランプ後の値を出すと、達成できない露出を正しい答えとして提示することになる。
  // 軸ごとの限界と「どちら側が不足か」を表引きにする（分岐の重複を避ける）。
  const LIMITS = {
    // stops: 段数への換算（F は面積比なので 2*log2、SS/ISO は log2）
    f: { axis: 'F', lo: lens.fMin, hi: lens.fMax, loKind: 'short', hiKind: 'bright', stops: (a, b) => 2 * Math.log2(a / b) },
    ss: { axis: 'SS', lo: camera.maxSS, hi: SLOWEST, loKind: 'bright', hiKind: 'short', stops: (a, b) => Math.log2(a / b) },
    iso: { axis: 'ISO', lo: camera.expandedISOMin, hi: camera.isoMax, loKind: 'bright', hiKind: 'short', stops: (a, b) => Math.log2(a / b) },
  };
  const spec = LIMITS[computedKey];
  const value = { f: fReal, ss: ssReal, iso: isoReal }[computedKey];
  let warning = null;
  let clampedValue = value;
  if (value < spec.lo) {
    clampedValue = spec.lo;
    warning = clampWarning(spec, spec.stops(spec.lo, value), spec.loKind, nd > 0);
  } else if (value > spec.hi) {
    clampedValue = spec.hi;
    warning = clampWarning(spec, spec.stops(value, spec.hi), spec.hiKind, nd > 0);
  }
  if (computedKey === 'f') fReal = clampedValue;
  else if (computedKey === 'ss') ssReal = clampedValue;
  else isoReal = clampedValue;

  return { ...snapTriple(fReal, ssReal, isoReal), computedKey, warning };
}

/**
 * クランプ警告を作る。1/3段未満のズレは警告しない（表示の丸め幅に埋もれるため）。
 * @param {{axis:string}} spec
 * @param {number} stops 不足/超過の段数
 * @param {'short'|'bright'} kind
 * @param {boolean} hasND
 * @returns {{level:string,icon:string,message:string}|null}
 */
function clampWarning(spec, stops, kind, hasND) {
  if (stops < THIRD_STOP) return null;
  return manualShort(spec.axis, stops, kind, hasND);
}

/* ====================================================================== */
/*  compute(state) → derived                                              */
/* ====================================================================== */

/**
 * 状態から描画に必要な派生値をすべて求める純粋関数。
 * @param {object} st アプリ状態（ui.js の単一 state）
 * @returns {object} derived
 */
export function compute(st) {
  const evScene = st.scene.evBase + st.scene.adjust;
  const flashOn = st.intent === 'daylightSync' || st.intent === 'slowSync';
  const prof = profileOf(st);
  const modLoss = modLossOf(st.flash.modifier);
  const d = {
    evScene, flashOn, warnings: [], badges: [],
    // 未校正バッジはストロボを使うときだけ意味を持つ（GN 推定に関わるため）。
    uncalibrated: flashOn && !prof.calibrated,
  };
  if (d.uncalibrated) d.badges.push({ kind: 'est', text: '推定値（未校正）' });

  // 入口で「何が F/SS/ISO を決めるか」を一度だけ解決する。
  //   計算タブ  → state.manual（2ロック＋自動算出）
  //   それ以外  → 意図ロジック
  // ここから先の処理と derived の形は共通。結果パネルは derived を描くだけでタブを見ない。
  if (st.ui.tab === 'calc') computeManual(st, evScene, prof, modLoss, d);
  else if (!flashOn) computeAmbient(st, evScene, d);
  else if (st.intent === 'daylightSync') computeDaylight(st, evScene, prof, modLoss, d);
  else computeSlow(st, evScene, prof, modLoss, d);

  d.equiv = equivalentList(evScene, st, d.mainFIndex);
  if (d.warnings.length === 0) d.warnings.push({ level: 'info', icon: 'info', message: 'この設定で撮れます' });
  return d;
}

/** アンビエント意図（ぼかす／止める／風景／夜手持ち）。 */
function computeAmbient(st, evScene, d) {
  const raw = AMBIENT_INTENTS[st.intent](evScene, st);
  const c = clampAmbient(raw, st, evScene);
  const snapped = snapTriple(c.fReal, c.ssReal, c.isoReal);
  d.ambient = {
    fLabel: snapped.f.label, ssLabel: snapped.ss.label, isoLabel: snapped.iso.label,
    ndLabel: ndLabelOf(st.nd),
  };
  d.mainFIndex = snapped.f.index;
  d.warnings.push(...c.warnings);
  d.alternatives = alternatives(evScene, st, { fReal: c.fReal, ssReal: c.ssReal, isoReal: c.isoReal });
  d.ruler = { deviation: 0, tracks: buildTracks(snapped, null) };
  d.evSetting = Math.log2(snapped.f.real ** 2 / snapped.ss.real);
}

/**
 * 計算タブ：state.manual が F/SS/ISO を決める。結果パネルの数値2系統もこれを映すので
 * 上段の操作ホイールと食い違わない。トラックは発光量のみ（F/SS/ISO は操作ホイールと重複するため出さない）。
 */
function computeManual(st, evScene, prof, modLoss, d) {
  const m = manualResult(evScene, st);
  d.manual = m;
  d.mainFIndex = m.f.index;
  d.ambient = {
    fLabel: m.f.label, ssLabel: m.ss.label, isoLabel: m.iso.label, ndLabel: ndLabelOf(st.nd),
  };
  if (m.warning) d.warnings.push(m.warning);
  let powerStops = null;
  if (d.flashOn) {
    // ストロボ側は SS に依存しない。manual の F/ISO と ND・距離だけで決まる。
    const gnFull = effectiveGN(applyIso(applyModifier(gnBase(prof.ws, prof.k), modLoss), m.iso.real), 0, ndStops(st), 0);
    const fs = flashSettings(gnFull, m.f.real, st.flash.distance, prof.minPowerStops);
    d.flash = flashCard(fs, st.flash.distance, d.uncalibrated, 'manual');
    flashRangeWarnings(fs, st.flash.distance, d);
    powerStops = fs.powerStops;
  }
  d.ruler = { deviation: 0, tracks: buildTracks(null, powerStops) };
  d.evSetting = Math.log2(m.f.real ** 2 / m.ss.real);
}

/** 日中シンクロ。ND経路とHSS経路を両方組み立てる。仕様 §8.1 */
function computeDaylight(st, evScene, prof, modLoss, d) {
  const { flash, lens, camera, settings } = st;
  const desiredN = lens.fMin; // 希望F=レンズ開放
  const dp = daylightSync({
    evScene, iso: camera.isoMin, comp: settings.comp, syncSpeedReal: camera.syncSpeed,
    ambientOffset: flash.ambientOffset, desiredN, ownedND: settings.ownedND,
    ws: prof.ws, k: prof.k, modLoss, hssCapable: prof.hss, hssBaseLoss: settings.hssBaseLoss,
    baseISO: camera.isoMin, expandedISOMin: camera.expandedISOMin,
    maxSSReal: camera.maxSS, // SS 上限。超える要求はクランプし達成可能な背景段数を返す
  });
  d.warnings.push(...dp.warnings);

  // 同調速度の壁（最重要出力）
  if (dp.wallStops != null && dp.wallStops > 1 / 3) {
    d.wall = { stops: dp.wallStops, text: `＋${formatStops(dp.wallStops)} 段` };
  }

  // アンビエント側カード
  const ndPathLabel = dp.ndPath ? ndLabelOf(dp.ndPath.filters) : '';
  const ambSnap = { f: snap(F, desiredN), ss: snap(SS, camera.syncSpeed), iso: snap(ISO, camera.isoMin) };
  d.ambient = {
    fLabel: ambSnap.f.label, ssLabel: ambSnap.ss.label, isoLabel: ambSnap.iso.label,
    ndLabel: ndPathLabel, offset: flash.ambientOffset,
  };

  // 経路比較表（ND / HSS を並べる。自動選択しない）。ストロボ側の既定表示は ND 経路。
  let powerStops = null;
  d.paths = { nd: null, hss: null };
  if (dp.ndPath) {
    const fs = flashSettings(dp.ndPath.gnEff, desiredN, flash.distance, prof.minPowerStops);
    powerStops = fs.powerStops;
    d.flash = flashCard(fs, flash.distance, d.uncalibrated, 'nd');
    flashRangeWarnings(fs, flash.distance, d);
    d.paths.nd = { ss: snap(SS, camera.syncSpeed).label, nd: ndPathLabel || '—',
      power: fs.powerLabel, reach: fs.reach, lossStops: dp.ndPath.totalStops };
  }
  if (dp.hssPath) {
    const fs = flashSettings(dp.hssPath.gnEff, desiredN, flash.distance, prof.minPowerStops);
    d.paths.hss = { ss: dp.hssPath.ss.label, nd: 'なし', power: fs.powerLabel, reach: fs.reach,
      lossStops: dp.hssPath.hssLoss,
      ssClamped: dp.hssPath.ssClamped, achievableOffset: dp.hssPath.achievableOffset,
      note: dp.hssPath.ssClamped ? `背景 ${formatOffset(dp.hssPath.achievableOffset)}段まで` : '' };
  }
  if (d.paths.nd && d.paths.hss) {
    // 有利段数は損失差そのもの（lossHSS − lossND）。到達距離比から求めるなら 2*log2(比)。
    // 光量は距離の2乗に反比例するため log2(比) では半分になる（仕様テスト #23 が定義する関係）。
    const adv = d.paths.hss.lossStops - d.paths.nd.lossStops;
    d.paths.advantageStops = adv;
    if (adv > 0.1) d.paths.advantage = `ND経路が${formatStops(adv)}段有利`;
    else if (adv < -0.1) d.paths.advantage = `HSS経路が${formatStops(-adv)}段有利`;
  }
  if (!dp.ndPath && !dp.hssPath) {
    d.warnings.push({ level: 'alert', icon: 'alert', message: '同調速度の壁を越えられません。F を絞ってください' });
  }

  d.ruler = { deviation: 0, tracks: buildTracks(ambSnap, powerStops) };
  d.mainFIndex = ambSnap.f.index;
}

/** スローシンクロ。閃光時間で主被写体が止まるか判定。仕様 §8.2 */
function computeSlow(st, evScene, prof, modLoss, d) {
  const { flash, lens, camera, focal, settings, subject } = st;
  const desiredN = lens.fMin;
  let iso = camera.isoMin;
  const nd = ndStops(st);
  let amb = slowSyncAmbient({ evScene, iso, comp: settings.comp, N: desiredN, ambientOffset: flash.ambientOffset, nd });
  const limit = handShakeLimit(focal, camera.isStops);

  if (!flash.tripod && amb.ssReal > limit) { // 手持ちで手ブレ限界を割る → ISO を上げる
    iso = Math.min(camera.isoMax, camera.isoMin * (amb.ssReal / limit));
    amb = slowSyncAmbient({ evScene, iso, comp: settings.comp, N: desiredN, ambientOffset: flash.ambientOffset, nd });
    const w = shakeWarning(amb.ssReal, focal, camera.isStops);
    if (w) d.warnings.push(w);
  } else if (flash.tripod && amb.ssReal > SLOWEST) {
    amb = { ...amb, ssReal: SLOWEST, ss: snap(SS, SLOWEST) };
  } else if (!flash.tripod) {
    const w = shakeWarning(amb.ssReal, focal, camera.isStops);
    if (w) d.warnings.push(w);
  }

  const ambSnap = { f: snap(F, desiredN), ss: amb.ss, iso: snap(ISO, iso) };
  d.ambient = {
    fLabel: ambSnap.f.label, ssLabel: ambSnap.ss.label, isoLabel: ambSnap.iso.label,
    ndLabel: ndLabelOf(st.nd), offset: flash.ambientOffset,
  };

  // ストロボ側
  const gnFull = effectiveGN(applyIso(applyModifier(gnBase(prof.ws, prof.k), modLoss), iso), 0, nd, 0);
  const fs = flashSettings(gnFull, desiredN, flash.distance, prof.minPowerStops);
  d.flash = flashCard(fs, flash.distance, d.uncalibrated, 'slow');
  flashRangeWarnings(fs, flash.distance, d);

  // 閃光時間で主被写体が止まるか（止めているのはSSでなく閃光時間）
  const fw = freezeWarning(fs.durationReal, subjectSSOf(subject));
  if (fw) d.warnings.push(fw);

  // 後幕シンクロ推奨（SS < 1/60）
  if (amb.ssReal > 1 / 60) {
    d.warnings.push({ level: 'info', icon: 'info', message: '後幕シンクロ推奨。被写体が動くと残像が出ます' });
  }
  if (fs.powerStops === 0) {
    d.warnings.push({ level: 'info', icon: 'flash', message: 'フル発光に近く、連写ではチャージが追いつきません' });
  }

  d.ruler = { deviation: 0, tracks: buildTracks(ambSnap, fs.powerStops) };
  d.mainFIndex = ambSnap.f.index;
}

/** ストロボ側カードの表示オブジェクト。 */
function flashCard(fs, distance, uncalibrated, path) {
  // FEC は残差の逆補正：残りが過強(fec>0)なら −、過弱なら ＋。
  const fecText = Math.abs(fs.fec) < 0.05 ? '' : `FEC ${fs.fec > 0 ? '−' : '＋'}${Math.abs(fs.fec).toFixed(1)}`;
  return {
    powerLabel: fs.powerLabel, fecText, path,
    reach: fs.reach, // 数値（テスト・比較用）。表示は reachText を使う
    reachText: `到達 ${fs.reach.toFixed(1)}m（設定 ${distance}m）`,
    durationLabel: fs.durationLabel, uncalibrated,
  };
}

/** ストロボの到達・発光量レンジ警告。仕様 §9 ストロボ系。 */
function flashRangeWarnings(fs, distance, d) {
  if (fs.reach < distance) {
    d.warnings.push({ level: 'alert', icon: 'flash',
      message: `光が届きません（到達 ${fs.reach.toFixed(1)}m／設定 ${distance}m）` });
  }
  if (fs.over < 0) { // 光量不足
    d.warnings.push({ level: 'alert', icon: 'flash',
      message: `ストロボが${formatStops(-fs.over)}段足りません。距離を詰める／ISOを上げる／Fを開ける／NDを外す` });
  }
  if (fs.fec > 0.05 && fs.powerStops >= 7) { // 最小発光量でも強すぎる
    d.warnings.push({ level: 'warn', icon: 'flash',
      message: `光が強すぎます。距離を離すか ISO を下げてください（FEC ${fs.fec.toFixed(1)}段）` });
  }
}
