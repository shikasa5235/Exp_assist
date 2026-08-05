// compute.js — state → derived の純粋オーケストレーション。副作用ゼロ。
// DOM・localStorage・window に触らない。計算は各純粋モジュールへ委譲し、ここは束ねるだけ。
// ui.js はこの derived を描画するだけで、計算を持たない（CLAUDE.md アーキテクチャ）。

import { F, SS, ISO, snap } from './stops.js';
import { evTarget, solveSS, solveN, solveISO, handShakeLimit } from './exposure.js';
import {
  gnBase, applyModifier, applyIso, effectiveGN, overStops, resolvePower, flashDuration,
  solveDistance, resolvePowerWithCeiling,
} from './flash.js';
import { ndName, ndLabel } from './filters.js';
import {
  shakeWarning, overBrightWarning, freezeWarning, ndAdvice,
  daylightSync, slowSyncAmbient, formatStops, formatOffset, THIRD_STOP,
} from './advisor.js';
import { SUBJECTS, MODIFIERS, POWER_STEPS, HELP, HELP_LINKS } from './scenes.js';

const SLOWEST = 2 ** (-SS.minIndex / 3); // 系列最遅（= 30″ の実体 32 秒）
const F8 = 8; // 風景の固定F値
/** 等価露出一覧の F値（2段刻みの3つ）。F2.8 / F5.6 / F11 に対応する 1/3段インデックス。 */
const EQUIV_F_INDEXES = [9, 15, 21];
/** 回折の閾値。「F11 を超えたら」なので F11 自身（実体 11.31）では出さない。 */
const DIFFRACTION_F_INDEX = 21;

/* ---- 小さな純粋ヘルパー ------------------------------------------------ */

/**
 * 装着中フィルターの合計減光段数。ND ＋ ブラックミスト（既定0段）。
 * レンズ前にあるのでアンビエントとストロボの両方に等しく効く。
 * @param {object} st @returns {number}
 */
function ndStops(st) {
  return ndOnly(st) + (st.filters?.blackMist ? (st.settings.blackMistStops || 0) : 0);
}

/**
 * 装着中 **ND だけ**の減光段数。組み合わせ提案（ndAdvice）の起点に使う。
 * ブラックミストを含めてはいけない：ミストの減光は「残っている過剰段数」に既に反映済みなので、
 * 合計必要量に足すと二重に数えて濃い ND を勧めてしまう。
 * @param {object} st @returns {number}
 */
function ndOnly(st) {
  return (st.nd || []).reduce((a, b) => a + b, 0);
}

/**
 * 装着中フィルターの枚数と表示ラベル。ブラックミストは減光0段でも1枚として数える
 * （レンズ前のガラス1枚なので周辺光量落ちのリスクは ND と同じ）。
 * @param {object} st
 * @returns {{count:number,label:string,ndStops:number}}
 */
function filterInfo(st) {
  const ndArr = [...(st.nd || [])].sort((a, b) => a - b);
  const mist = !!st.filters?.blackMist;
  const parts = [];
  if (ndArr.length) parts.push(ndArr.map(ndName).join('+'));
  if (mist) parts.push('ブラックミスト');
  return {
    count: ndArr.length + (mist ? 1 : 0),
    label: parts.join(' + '), // ND と光学フィルターを分けて表記
    ndStops: ndStops(st),
  };
}

/**
 * 使える最も低い ISO。拡張ISO のトグルが OFF ならベースISO、ON なら拡張下限。
 * 意図別ロジックの起点・クランプの下限・日中シンクロで使う ISO のすべてに効く。
 * @param {object} st @returns {number}
 */
function isoFloorOf(st) {
  return st.camera.allowExpandedIso ? st.camera.expandedISOMin : st.camera.isoMin;
}

/** 使用中プロファイル＋モディファイアの実測 k（未校正なら推定値の k）。 */
function kFor(prof, modifierKey) {
  const v = prof.cal ? prof.cal[modifierKey] : undefined;
  return v == null ? prof.k : v;
}

/** そのプロファイル×モディファイアが未校正か。 */
function isUncalibrated(prof, modifierKey) {
  return !prof.cal || prof.cal[modifierKey] == null;
}

/**
 * 適用すべきモディファイア減光。**校正済みの組み合わせでは 0 を返す。**
 * `cal[modifier]` はそのモディファイアを付けた状態で測った実効 k なので減光を既に含む。
 * そこに推定の減光段数を上乗せすると二重に引くことになる。
 * @param {object} prof @param {string} modifierKey @returns {number} 段
 */
function modLossFor(prof, modifierKey) {
  return isUncalibrated(prof, modifierKey) ? modLossOf(modifierKey) : 0;
}

/**
 * 「ND を1枚外す」を提案してよいか判定する。**提案が別の警告を生まないことの検証。**
 *
 * ND はレンズ前にあるのでアンビエントとストロボの両方に等しく効く。ストロボが足りないからと
 * ND を外すと、アンビエントがその分そのまま明るくなる。アンビエント側に吸収する余地が
 * 無ければ「明るすぎます」に置き換わるだけで、ユーザーは元の問題に戻される（袋小路）。
 *
 * **循環依存を避けるための設計：** 提案を当てた状態で `compute()` を再実行して警告を数える、
 * という方法は取らない。`advisor` から `compute` を呼ぶと循環するうえ、提案の数だけ
 * 全体計算が走る。代わりに「その提案が動かす軸に、動かす余地（slack）が何段あるか」を
 * 各計算経路が1つの数値として出し、ここで解析的に比べる。
 *
 * @param {number[]} attached 装着中 ND の段数の配列
 * @param {number} slackStops アンビエントが明るくなれる余地（段）。0 以下なら余地なし
 * @param {number} [gainStops=0] この提案で埋めたい不足段数。アンビエント自身の不足を
 *   埋める提案ならその分は行き過ぎに数えない。ストロボ側の不足なら 0（アンビエントは
 *   合っているので、外した段数がまるごと行き過ぎになる）
 * @returns {{stops:number,label:string}|null} 外すべき1枚。提案してはいけないときは null
 */
function ndRemovalOption(attached, slackStops, gainStops = 0) {
  const list = attached || [];
  if (!list.length) return null;
  const thinnest = Math.min(...list); // いちばん薄い1枚＝副作用が最小
  const overshoot = thinnest - gainStops;
  // 行き過ぎが余地に収まらない（1/3段の許容つき）なら、明るすぎ警告に化けるだけ
  if (overshoot > slackStops + THIRD_STOP) return null;
  return { stops: thinnest, label: `${ndName(thinnest)} を外す` };
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
  let iso = isoFloorOf(st);
  let ss = solveSS(ev, iso, fReal, comp, nd);
  const limit = handShakeLimit(focal, camera.isStops);
  if (ss > limit) { // 遅すぎる → ISO を上げて SS を稼ぐ
    const need = Math.log2(ss / limit);
    iso = Math.min(camera.isoMax, isoFloorOf(st) * 2 ** need);
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
  if (isoNeeded < isoFloorOf(st)) { // 余る → 絞る
    const iso = isoFloorOf(st);
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
  const iso = isoFloorOf(st);
  return { fReal: F8, ssReal: solveSS(ev, iso, F8, comp, nd), isoReal: iso };
}

/** 夜・手持ち：SS=手ブレ限界固定→F開放→ISO算出。 */
function intentNight(ev, st) {
  const { lens, camera, focal, settings } = st;
  const nd = ndStops(st), comp = settings.comp, fReal = lens.fMin;
  const limit = handShakeLimit(focal, camera.isStops);
  const isoNeeded = solveISO(ev, fReal, limit, comp, nd);
  const iso = Math.max(isoFloorOf(st), Math.min(camera.isoMax, isoNeeded));
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

  // 明るすぎ：必要SSが機種最速より速い → 必要減光量と ND の組み合わせを提示
  if (ssReal < camera.maxSS) {
    const w = overBrightWarning(ssReal, camera.maxSS, { ownedND: settings.ownedND, attachedStops: ndOnly(st) });
    if (w) warnings.push(w);
    ssReal = camera.maxSS;
  }
  // 暗すぎ：系列最遅（30″＝実体32秒）を超える長秒 → クランプ。**黙って切らない。**
  // ND を足しすぎた（行き過ぎた）ときにここへ来る。明るすぎ側と対称に段数を出す。
  if (ssReal > SLOWEST) {
    const stops = Math.log2(ssReal / SLOWEST);
    ssReal = SLOWEST;
    if (stops >= THIRD_STOP) { // 明るすぎ側と同じ 1/3段の閾値
      // 自由軸は SS。ND を外すと SS は速くなる方向へ動けるので、その余地を渡す
      const drop = ndRemovalOption(st.nd, Math.log2(SLOWEST / camera.maxSS), stops);
      const remedies = [drop ? drop.label : null, `ISO を ${formatStops(stops)}段上げる`, '三脚で長秒に耐える'].filter(Boolean);
      warnings.push({ level: 'alert', icon: 'noise', helpId: HELP.lightShort,
        message: `暗すぎます。SS は ${snap(SS, SLOWEST).label} が限界で ${formatStops(stops)}段 足りません。${remedies.join('／')}` });
    }
  }

  // 光量不足：必要ISOが上限超過（夜・手持ちなど）
  if (r.shortStops >= THIRD_STOP) {
    warnings.push({ level: 'alert', icon: 'noise', helpId: HELP.lightShort,
      message: `光量が${formatStops(r.shortStops)}段足りません。開放を明るく、または三脚が必要です` });
  }
  // 被写体ブレ：止めたいのに必要SSへ届かない
  if (r.missSS != null && Math.log2(ssReal / r.missSS) >= THIRD_STOP) {
    const s = Math.log2(ssReal / r.missSS);
    warnings.push({ level: 'warn', icon: 'motion', helpId: HELP.motion,
      message: `被写体が流れます。1/${Math.round(1 / r.missSS)} 以上が必要（${formatStops(s)}段不足）` });
  }
  // 手ブレ（SSを固定していない意図で、限界より遅いとき）
  if (intent !== 'nightHandheld') {
    const w = shakeWarning(ssReal, focal, camera.isStops);
    if (w) warnings.push(w);
  }
  // 被写体ブレ基準（止める意図以外でも動く被写体なら）
  const req = subjectSSOf(subject);
  if (intent !== 'freeze' && req != null && Math.log2(ssReal / req) >= THIRD_STOP) {
    warnings.push({ level: 'warn', icon: 'motion', helpId: HELP.motion,
      message: `被写体が流れます。1/${Math.round(1 / req)} 以上にしてください` });
  }
  // 回折・高感度・三脚（情報）
  // 回折は「F11 を超えたら」。段位置で比べる（F11 の実体は 11.31 なので単純な > 11 では F11 自身が出る）
  if (snap(F, fReal).index > DIFFRACTION_F_INDEX) {
    warnings.push({ level: 'info', icon: 'diffraction', helpId: HELP.diffraction, message: '回折で解像が落ち始めます' });
  }
  if (isoReal > camera.isoMax / 2) warnings.push({ level: 'info', icon: 'noise', helpId: HELP.highIso, message: 'ノイズが目立ち始める領域です' });
  if (ssReal >= 0.5) warnings.push({ level: 'info', icon: 'tripod', helpId: HELP.tripod, message: '三脚推奨（SS 1/2秒以上）' });

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
  if (primary.isoReal > isoFloorOf(st) * 1.9) {
    const iso = Math.max(isoFloorOf(st), primary.isoReal / 2);
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

/* ---- ストロボ側の解決（発光量モード）。仕様 §5.3 -------------------- */

/**
 * ストロボ側を解決する。auto は発光量を解き、fixed は距離を解く。
 * どちらのモードでも SS には依存しない（ストロボは SS に効かない）。
 * @param {object} st 状態
 * @param {object} prof 使用プロファイル
 * @param {number} gnIso ISO 反映後の GN（ND・HSS・発光量はまだ引いていない）
 * @param {number} N F値（厳密値）
 * @param {number} ndTotal ND 減光段数
 * @param {number} hssLossStops HSS 損失段数
 * @param {object} d derived（警告を積む）
 * @returns {{powerStops:number,card:object}}
 */
function resolveFlashSide(st, prof, gnIso, N, ndTotal, hssLossStops, d) {
  const { flash } = st;
  const ceiling = prof.powerCeilingStops ?? 0;
  const minPower = prof.minPowerStops ?? 7;
  const setDistance = flash.distance;
  const fixed = flash.powerMode === 'fixed';

  // 発光量：fixed はユーザー選択（上限・下限でクランプ）、auto は必要量から決める
  const gnFull = effectiveGN(gnIso, 0, ndTotal, hssLossStops);
  const over = overStops(gnFull, N, setDistance);
  let powerStops, fec, shortStops = 0, excessStops = 0;
  if (fixed) {
    // fixed はユーザーの明示的な選択。上限（auto の主案選択にだけ効く）は無視する
    // ——「入力を拒否しない」原則。弱い側の限界（機材の物理）だけでクランプする。
    powerStops = Math.max(0, Math.min(minPower, flash.powerStops));
    fec = 0; // 距離を解くので端数は距離側に寄せる
  } else {
    ({ powerStops, fec, shortStops, excessStops } = resolvePowerWithCeiling(over, { ceilingStops: ceiling, minPowerStops: minPower }));
  }

  // 推奨距離（fixed の主出力）。距離は背景に影響しないので安全に動かせる軸。
  const { gnEff, distance: recommended } = solveDistance({ gnIso, N, powerStops, ndStops: ndTotal, hssLossStops });
  const duration = flashDuration(powerStops);
  const powerLabel = POWER_STEPS[powerStops].label;

  if (fixed) {
    // 過剰決定：距離も固定されている → 過不足を段数で出す。自動でどちらも変えない。
    const diff = 2 * Math.log2(recommended / setDistance); // 正なら設定距離が近すぎ＝強すぎ
    if (Math.abs(diff) >= THIRD_STOP) {
      const n = formatStops(Math.abs(diff));
      const dTxt = recommended.toFixed(1);
      d.warnings.push(diff > 0
        ? { level: 'warn', icon: 'flash', helpId: HELP.powerMode, message: `発光量 ${powerLabel} では ${n}段 強すぎます。${dTxt}m まで下がる／F を ${n}段絞る／ISO を ${n}段下げる` }
        : { level: 'warn', icon: 'flash', helpId: HELP.powerMode, message: `発光量 ${powerLabel} では ${n}段 足りません。${dTxt}m まで詰める／F を ${n}段開ける／ISO を ${n}段上げる` });
    }
  } else {
    // auto が上限に当たった：黙って丸めず不足段数と代替案を出す
    if (shortStops >= THIRD_STOP) {
      const dTxt = recommended.toFixed(1);
      if (over < -1e-9) {
        // フル発光でも届かない＝**この機材では届かない**（到達距離 < 設定距離）。上限を上げても
        // 解決しないのでその案は出さない。アンビエント側の光量不足とは対処が違うので別セクション。
        const n = formatStops(-over);
        const remedies = [`距離を ${(gnFull / N).toFixed(1)}m まで詰める`, `ISO を ${n}段上げる`, `F を ${n}段開ける`];
        // ND を外す提案は、アンビエントに明るくなる余地があるときだけ（袋小路を作らない）
        const rm = d.ndRemovable || { filters: [], slack: 0 };
        const drop = ndRemovalOption(rm.filters, rm.slack);
        if (drop) remedies.push(drop.label);
        d.warnings.push({ level: 'alert', icon: 'flash', helpId: HELP.flashShort,
          message: `この機材では届きません。フル発光でも ${n}段 足りません（到達 ${(gnFull / N).toFixed(1)}m／設定 ${setDistance}m）。${remedies.join('／')}` });
      } else {
        // 光は足りているが、発光量の上限（強い側の限界）に当たって使えない＝**設定の問題**。
        // powerCeilingStops は機材の限界ではなくユーザーの好み。いちばん簡単な解決は設定を戻すこと。
        // だから「上限を上げる」を第一候補にする。**ここで「ND を1枚外す」は出さない**：
        // ND を外すとアンビエントが明るすぎに戻り、その対処でまた ND を足すことになる（袋小路）。
        const n = formatStops(shortStops);
        // 必要量を満たす最も弱い上限＝**over 以下でいちばん大きい整数段**。over ≧ 0 なのでこの
        // 分岐では必ず存在する（存在しない＝上げても届かない場合は上の over < 0 側に入る）。
        //
        // round ではなく floor である理由：上限は「これより強い側は選ばない」線なので、
        // over を上回る上限を残すと shortStops = 上限 − over が正のまま警告が消えない。
        // 例）over 0.6 で上限 1（1/2）にしても 0.4段 足りない → 上限は 0（1/1）まで開ける必要がある。
        //
        // 範囲外の添字で POWER_STEPS[to] が undefined になるのを防ぐため念のためクランプする。
        const to = Math.max(0, Math.min(minPower, Math.floor(over + 1e-9)));
        // **上限と、その上限で実際に使われる発光量は一致しない。** 発光量は round(over) なので
        // 上限より1段弱いことがある（over 0.6 → 上限 1/1・発光量 1/2）。文言に両方出さないと
        // 「1/1 に上げると言われたのに 1/2 になった」と読めてしまう（実機で報告された混乱）。
        // 計算は resolvePowerWithCeiling と同じ式を使うこと（ずれると表示だけが嘘になる）。
        const resultPower = Math.max(to, Math.min(minPower, Math.round(over)));
        const action = {
          kind: 'raiseCeiling', to, resultPowerStops: resultPower,
          label: `上限を ${POWER_STEPS[to].label} に上げる`,
        };
        const remedies = [
          `${action.label}（発光量 ${POWER_STEPS[resultPower].label} で撮れます）`,
          `距離を ${dTxt}m まで詰める`,
          `ISO を ${n}段上げる`,
        ];
        d.warnings.push({ level: 'alert', icon: 'flash', helpId: HELP.powerCeiling, action,
          message: `上限 ${powerLabel} では ${n}段 足りません。${remedies.join('／')}` });
      }
    }
    if (excessStops >= THIRD_STOP) {
      d.warnings.push({ level: 'warn', icon: 'flash', helpId: HELP.flashStrong,
        message: `最小発光量 ${powerLabel} でも ${formatStops(excessStops)}段 強すぎます。距離を ${recommended.toFixed(1)}m まで離すか ISO を下げてください` });
    }
  }

  const fecText = Math.abs(fec) < 0.05 ? '' : `FEC ${fec > 0 ? '−' : '＋'}${Math.abs(fec).toFixed(1)}`;
  const card = {
    powerLabel, powerStops, fecText, mode: flash.powerMode,
    reach: gnEff / N,          // 選んだ発光量での到達距離
    reachFull: gnFull / N,     // フル発光時の到達（機材の能力比較用）
    recommendedDistance: recommended,
    reachText: fixed
      ? `推奨距離 ${recommended.toFixed(1)}m（設定 ${setDistance}m）`
      : `到達 ${(gnEff / N).toFixed(1)}m（設定 ${setDistance}m）`,
    durationLabel: snap(SS, duration).label, durationReal: duration,
    uncalibrated: d.uncalibrated, over,
  };
  return { powerStops, card };
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

/**
 * 等価露出の一覧。**F2.8 / F5.6 / F11 の3行固定（2段刻み）。**
 * 6行（1段刻み）は結果パネル内でスクロールが必要になり現場で読めないため。
 * 2段刻みなら「ぼかす・標準・パンフォーカス」の3択として一覧性が保てる。
 * 開放より明るい行は**消さずに使用不可として示す**（3つ固定のほうが位置が安定し理由も伝わる）。
 * @returns {Array<{fLabel,ssLabel,isoLabel,flags,isMain,disabled,reason}>}
 */
function equivalentList(ev, st, mainFIndex) {
  const { camera, lens, settings } = st;
  const nd = ndStops(st), comp = settings.comp;
  const iso = isoFloorOf(st);
  return EQUIV_F_INDEXES.map((fi) => {
    const fReal = F.real(fi);
    const sf = snap(F, fReal); // ラベルは表引き（実体と表示は別）
    const ss = solveSS(ev, iso, fReal, comp, nd);
    const row = {
      fLabel: sf.label, ssLabel: snap(SS, ss).label, isoLabel: snap(ISO, iso).label,
      flags: [], isMain: sf.index === mainFIndex, disabled: false, reason: '',
    };
    if (fReal < lens.fMin - 1e-9) {
      row.disabled = true;
      row.reason = `開放F${snap(F, lens.fMin).label}のため使用不可`;
      row.ssLabel = '—'; row.isoLabel = '—';
    } else if (ss < camera.maxSS) {
      row.disabled = true;
      row.reason = `SS上限（${snap(SS, camera.maxSS).label}）を超える`;
    } else if (ss > SLOWEST) {
      row.disabled = true;
      row.reason = `30秒を超える`;
    } else {
      // 回折は「F11 を超えたら」。F11 の実体は 11.31 なので、段位置で比べて F11 自身は出さない。
      // 現在の一覧3値（F2.8/F5.6/F11）では到達しない（F13 以上で発火）。
      // 一覧値が可変になった場合に機能するため判定を保持する。仕様 §10.2 参照
      if (sf.index > DIFFRACTION_F_INDEX) row.flags.push('diffraction');
      if (ss > handShakeLimit(st.focal, camera.isStops)) row.flags.push('shake');
    }
    return row;
  });
}

/* ---- 計算タブ：2ロック→残り1つを自動算出 ---------------------------- */

/**
 * 自由軸が範囲限界に達して露出を満たせないときの警告。ロックは破らず不足段数を提示する。
 * @param {'F'|'SS'|'ISO'} axis 限界に達した自由軸
 * @param {number} stops 不足/超過の段数
 * @param {'short'|'bright'} kind short=光量不足（上限張り付き）／bright=明るすぎ（下限張り付き）
 * @param {{filters:number[],attached:number,owned:number[],slack:number}} nd
 *   装着中 ND・その合計段数・所有 ND・自由軸が明るくなれる余地
 */
function manualShort(axis, stops, kind, nd) {
  const N = formatStops(stops);
  const inc = { F: `F を ${N}段開ける`, SS: `SS を ${N}段遅くする`, ISO: `ISO を ${N}段上げる` };
  const dec = { F: `F を ${N}段絞る`, SS: `SS を ${N}段速める`, ISO: `ISO を ${N}段下げる` };
  const others = ['F', 'SS', 'ISO'].filter((a) => a !== axis);
  if (kind === 'short') {
    const axisRem = others.map((a, i) => (i === 0 ? 'ロックを外して ' : '') + inc[a]);
    // ND を外す提案は、外して明るくなる分を自由軸が吸収できるときだけ出す。
    // 不足を埋めるのが目的なので、埋まる分（stops）は行き過ぎに数えない。
    const drop = ndRemovalOption(nd.filters, nd.slack, stops);
    const remedies = [drop ? drop.label : null, ...axisRem].filter(Boolean);
    return { level: 'alert', icon: 'alert', helpId: HELP.calcClamp, message: `${axis} が ${N}段 足りません。${remedies.join('／')}` };
  }
  const axisRem = others.map((a, i) => (i === 0 ? 'ロックを外して ' : '') + dec[a]);
  // 「ND を足す」で止めると、何段のどれを足すかはユーザーが計算することになる。
  // solveND は所有 ND から答えを出せるので、持っている答えを出す（かんたんタブと同じ扱い）。
  const adv = ndAdvice(nd.owned, stops, nd.attached);
  const ndRem = adv.text ? `${adv.text}${adv.note}` : 'ND を足す';
  return { level: 'alert', icon: 'alert', helpId: HELP.calcClamp, message: `明るすぎます（${N}段超過）。${[ndRem, ...axisRem].join('／')}` };
}

function manualResult(ev, st) {
  const { manual, camera, settings, lens } = st;
  const nd = ndStops(st), comp = settings.comp;
  const L = manual.locks || { f: true, ss: true, iso: false };
  // 非ロック（false）が自動算出される軸。ちょうど1つを想定、無ければ ss。
  const computedKey = ['f', 'ss', 'iso'].find((k) => !L[k]) || 'ss';
  // ロック軸は保存済み index を使い、未確定なら既定値で補完（開放F・ベースISO）。
  let fReal = manual.fIndex != null ? F.real(manual.fIndex) : lens.fMin;
  let isoReal = manual.isoIndex != null ? ISO.real(manual.isoIndex) : isoFloorOf(st);
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
    // 下限は「使える最も低い ISO」。expandedISOMin を直接読むと拡張ISO トグルが効かない
    iso: { axis: 'ISO', lo: isoFloorOf(st), hi: camera.isoMax, loKind: 'bright', hiKind: 'short', stops: (a, b) => Math.log2(a / b) },
  };
  const spec = LIMITS[computedKey];
  const value = { f: fReal, ss: ssReal, iso: isoReal }[computedKey];
  // 自由軸が「明るくなる方向」へまだ何段動けるか。ND を1枚外すとシーンはその段数ぶん
  // 明るくなるので、この余地を超える提案は「明るすぎます」に化ける（ndRemovalOption が使う）。
  // どちらの端が明るい側かは軸ごとに違うので、LIMITS の loKind/hiKind から引く。
  const brightIsLo = spec.loKind === 'bright';
  const ndSlack = brightIsLo ? spec.stops(value, spec.lo) : spec.stops(spec.hi, value);
  const ndCtx = { filters: st.nd || [], attached: ndOnly(st), owned: settings.ownedND, slack: ndSlack };
  let warning = null;
  let clampedValue = value;
  if (value < spec.lo) {
    clampedValue = spec.lo;
    warning = clampWarning(spec, spec.stops(spec.lo, value), spec.loKind, ndCtx);
  } else if (value > spec.hi) {
    clampedValue = spec.hi;
    warning = clampWarning(spec, spec.stops(value, spec.hi), spec.hiKind, ndCtx);
  }
  if (computedKey === 'f') fReal = clampedValue;
  else if (computedKey === 'ss') ssReal = clampedValue;
  else isoReal = clampedValue;

  return { ...snapTriple(fReal, ssReal, isoReal), computedKey, warning, ndSlack };
}

/**
 * クランプ警告を作る。1/3段未満のズレは警告しない（表示の丸め幅に埋もれるため）。
 * @param {{axis:string}} spec
 * @param {number} stops 不足/超過の段数
 * @param {'short'|'bright'} kind
 * @param {{attached:number,owned:number[]}} nd
 * @returns {{level:string,icon:string,message:string}|null}
 */
function clampWarning(spec, stops, kind, nd) {
  if (stops < THIRD_STOP) return null;
  return manualShort(spec.axis, stops, kind, nd);
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
  // 校正済みの組み合わせでは 0（実測 k が減光を含むため二重計上しない）
  const modLoss = modLossFor(prof, st.flash.modifier);
  const d = {
    evScene, flashOn, warnings: [], badges: [],
    // 未校正バッジはストロボを使うときだけ意味を持つ（GN 推定に関わるため）。
    // 校正はプロファイル×モディファイアごとなので、モディファイアを切り替えると追従する。
    uncalibrated: flashOn && isUncalibrated(prof, st.flash.modifier),
    filters: filterInfo(st),
  };
  // バッジにも helpId を持たせる。警告には ? が付くのにバッジからは校正手順へ行けない、
  // という非対称を作らないため（report-a2 §6 で未実装として記録されていた導線）。
  if (d.uncalibrated) d.badges.push({ kind: 'est', text: '推定値（未校正）', helpId: HELP_LINKS.calibration });
  attachedFilterWarnings(st, d);

  // 入口で「何が F/SS/ISO を決めるか」を一度だけ解決する。
  //   計算タブ  → state.manual（2ロック＋自動算出）
  //   それ以外  → 意図ロジック
  // ここから先の処理と derived の形は共通。結果パネルは derived を描くだけでタブを見ない。
  if (st.ui.tab === 'calc') computeManual(st, evScene, prof, modLoss, d);
  else if (!flashOn) computeAmbient(st, evScene, d);
  else if (st.intent === 'daylightSync') computeDaylight(st, evScene, prof, modLoss, d);
  else computeSlow(st, evScene, prof, modLoss, d);

  d.equiv = equivalentList(evScene, st, d.mainFIndex);
  if (d.warnings.length === 0) d.warnings.push({ level: 'info', icon: 'info', helpId: HELP.ok, message: 'この設定で撮れます' });
  d.summary = summaryOf(d);
  return d;
}

/**
 * 結果パネルを最小表示にしたときに残す1行。**核心の数値は必ず見えている**
 * （UI仕様の設計原則2「結果は常に見えている」を満たすため、完全に隠す状態は作らない）。
 * 警告があることはレベルとアイコンだけ伝える（文言は畳む）。
 * @param {object} d derived
 * @returns {{parts:string[],text:string,level:string|null,icon:string|null}}
 */
function summaryOf(d) {
  const a = d.ambient;
  const parts = a ? [`F${a.fLabel}`, a.ssLabel, `ISO${a.isoLabel}`] : [];
  if (d.flash) parts.push(`発光 ${d.flash.powerLabel}`);
  // いちばん強いレベルの警告を1つだけ拾う（alert > warn > info）
  const rank = { alert: 3, warn: 2, info: 1 };
  const top = (d.warnings || []).reduce((best, w) => (!best || rank[w.level] > rank[best.level] ? w : best), null);
  return {
    parts,
    text: parts.join(' ・ '),
    level: top ? top.level : null,
    icon: top ? top.icon : null,
  };
}

/**
 * 装着中フィルターの枚数警告。3枚以上でケラレ・周辺光量落ちの注意（ブラックミストも1枚）。
 * @param {object} st @param {object} d
 */
function attachedFilterWarnings(st, d) {
  const f = d.filters;
  if (f.count >= 3) {
    d.warnings.push({ level: 'warn', icon: 'nd', helpId: HELP.nd,
      message: `フィルター${f.count}枚（${f.label}）。${st.focal}mm では周辺が落ちる可能性があります` });
  }
}

/** アンビエント意図（ぼかす／止める／風景／夜手持ち）。 */
function computeAmbient(st, evScene, d) {
  const raw = AMBIENT_INTENTS[st.intent](evScene, st);
  const c = clampAmbient(raw, st, evScene);
  const snapped = snapTriple(c.fReal, c.ssReal, c.isoReal);
  d.ambient = {
    fLabel: snapped.f.label, ssLabel: snapped.ss.label, isoLabel: snapped.iso.label,
    ndLabel: d.filters.label,
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
    fLabel: m.f.label, ssLabel: m.ss.label, isoLabel: m.iso.label, ndLabel: d.filters.label,
  };
  if (m.warning) d.warnings.push(m.warning);
  // 「ND を1枚外す」を提案してよいかの材料。自由軸が明るくなる方向に動ける段数が余地。
  d.ndRemovable = { filters: st.nd || [], slack: m.ndSlack };
  let powerStops = null;
  if (d.flashOn) {
    // ストロボ側は SS に依存しない。manual の F/ISO と ND・距離だけで決まる。
    const gnIso = applyIso(applyModifier(gnBase(prof.ws, kFor(prof, st.flash.modifier)), modLoss), m.iso.real);
    const r = resolveFlashSide(st, prof, gnIso, m.f.real, ndStops(st), 0, d);
    d.flash = r.card;
    powerStops = r.powerStops;
  }
  d.ruler = { deviation: 0, tracks: buildTracks(null, powerStops) };
  d.evSetting = Math.log2(m.f.real ** 2 / m.ss.real);
}

/** 日中シンクロ。ND経路とHSS経路を両方組み立てる。仕様 §8.1 */
function computeDaylight(st, evScene, prof, modLoss, d) {
  const { flash, lens, camera, settings } = st;
  const desiredN = lens.fMin; // 希望F=レンズ開放
  const dp = daylightSync({
    evScene, iso: isoFloorOf(st), comp: settings.comp, syncSpeedReal: camera.syncSpeed,
    ambientOffset: flash.ambientOffset, desiredN, ownedND: settings.ownedND,
    ws: prof.ws, k: kFor(prof, st.flash.modifier), modLoss, hssCapable: prof.hss, hssBaseLoss: settings.hssBaseLoss,
    baseISO: camera.isoMin, expandedISOMin: camera.expandedISOMin,
    allowExpandedIso: camera.allowExpandedIso, // ON のときは拡張ISOの提案を出さない（既に使っている）
    maxSSReal: camera.maxSS, // SS 上限。超える要求はクランプし達成可能な背景段数を返す
  });
  d.warnings.push(...dp.warnings);

  // 同調速度の壁（最重要出力）
  // daylightSync 側は wallStops <= THIRD_STOP で経路を組まずに返す。同じ境界を使うこと
  // （ここだけ緩いと、経路が無いのに壁の数値だけ出る）。
  if (dp.wallStops != null && dp.wallStops > THIRD_STOP) {
    d.wall = { stops: dp.wallStops, text: `＋${formatStops(dp.wallStops)} 段` };
  }

  // アンビエント側カード
  const ndPathLabel = dp.ndPath ? ndLabel(dp.ndPath.filters) : '';
  const ambSnap = { f: snap(F, desiredN), ss: snap(SS, camera.syncSpeed), iso: snap(ISO, isoFloorOf(st)) };
  d.ambient = {
    fLabel: ambSnap.f.label, ssLabel: ambSnap.ss.label, isoLabel: ambSnap.iso.label,
    ndLabel: ndPathLabel, offset: flash.ambientOffset,
  };

  // 経路比較表（ND / HSS を並べる。自動選択しない）。ストロボ側の既定表示は ND 経路。
  let powerStops = null;
  d.paths = { nd: null, hss: null };
  if (dp.ndPath) {
    // 外せる ND は「この経路が提案した組み合わせ」。余地は壁を越えるのに要る量を上回る分だけで、
    // それ以上外すと同調速度の壁が再び開く（ここが袋小路になりやすい）。
    d.ndRemovable = { filters: dp.ndPath.filters, slack: dp.ndPath.totalStops - dp.wallStops };
    // ND 経路を主案として、発光量モードに応じて発光量 or 距離を解く
    const gnIso = applyIso(applyModifier(gnBase(prof.ws, kFor(prof, st.flash.modifier)), modLoss), isoFloorOf(st));
    const r = resolveFlashSide(st, prof, gnIso, desiredN, dp.ndPath.totalStops, 0, d);
    powerStops = r.powerStops;
    d.flash = r.card;
    // 経路比較の到達距離は「その経路のフル発光時の能力」。選んだ発光量では変えない
    // （発光量を絞れば到達は設定距離に近づくので、経路の優劣が比較できなくなる）。
    d.paths.nd = { ss: snap(SS, camera.syncSpeed).label, nd: ndPathLabel || '—',
      power: r.card.powerLabel, reach: dp.ndPath.gnEff / desiredN, lossStops: dp.ndPath.totalStops };
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
    d.warnings.push({ level: 'alert', icon: 'alert', helpId: HELP.syncWall, message: '同調速度の壁を越えられません。F を絞ってください' });
  }

  d.ruler = { deviation: 0, tracks: buildTracks(ambSnap, powerStops) };
  d.mainFIndex = ambSnap.f.index;
}

/** スローシンクロ。閃光時間で主被写体が止まるか判定。仕様 §8.2 */
function computeSlow(st, evScene, prof, modLoss, d) {
  const { flash, lens, camera, focal, settings, subject } = st;
  const desiredN = lens.fMin;
  let iso = isoFloorOf(st);
  const nd = ndStops(st);
  let amb = slowSyncAmbient({ evScene, iso, comp: settings.comp, N: desiredN, ambientOffset: flash.ambientOffset, nd });
  const limit = handShakeLimit(focal, camera.isStops);

  if (!flash.tripod && amb.ssReal > limit) { // 手持ちで手ブレ限界を割る → ISO を上げる
    iso = Math.min(camera.isoMax, isoFloorOf(st) * (amb.ssReal / limit));
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
    ndLabel: d.filters.label, offset: flash.ambientOffset,
  };

  // 外せる ND は装着中のもの。余地は SS が速くなれる段数（SS が自由に動く軸なので）。
  d.ndRemovable = { filters: st.nd || [], slack: Math.log2(amb.ssReal / camera.maxSS) };

  // ストロボ側（発光量モードに応じて発光量 or 距離を解く。SS には依存しない）
  const gnIso = applyIso(applyModifier(gnBase(prof.ws, kFor(prof, st.flash.modifier)), modLoss), iso);
  const { powerStops, card } = resolveFlashSide(st, prof, gnIso, desiredN, nd, 0, d);
  d.flash = card;

  // 閃光時間で主被写体が止まるか（止めているのはSSでなく閃光時間）
  const fw = freezeWarning(card.durationReal, subjectSSOf(subject));
  if (fw) d.warnings.push(fw);

  // 後幕シンクロ推奨（SS < 1/60）
  if (amb.ssReal > 1 / 60) {
    d.warnings.push({ level: 'info', icon: 'info', helpId: HELP.slowSync, message: '後幕シンクロ推奨。被写体が動くと残像が出ます' });
  }
  if (powerStops === 0) {
    d.warnings.push({ level: 'info', icon: 'flash', helpId: HELP.recycle, message: 'フル発光に近く、連写ではチャージが追いつきません' });
  }

  d.ruler = { deviation: 0, tracks: buildTracks(ambSnap, powerStops) };
  d.mainFIndex = ambSnap.f.index;
}

