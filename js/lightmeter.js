// lightmeter.js — EXIF の露出3値 → シーンEV。純粋関数のみ。副作用ゼロ。
//
// 露出計そのものの式（photocal-spec §3.1）：
//
//   EV(ISO100基準) = log2(N² / t) − log2(S / 100) + exposureBias + aeOffsetStops
//
// ─────────────────────────────────────────────────────────────────────
// **スマホ側の値を 1/3段グリッドへ寄せないこと。**（実機検証で確定した方針）
//
// 実機（iPhone 16 Pro Max / iOS 26.1）の EXIF は連続値だった：
//
//   ExposureTime  1/4405                      ← 1/4000 でも 1/5000 でもない（2^-12.105）
//   FNumber       1244236/699009 = 1.77999997
//   FocalLength   251773/37217   = 6.76499986
//
// スマホの AE は連続値でシャッターを制御し、実測値をそのまま記録している。
// `1/4000` へスナップすると**最大 1/6段 の誤差を自分で作り込む。**
//
//   スマホ（機能A） 実測値。**変換しない**
//   カメラ（機能B） 公称ラベル（F11・1/250）。**変換する** → `solveAeOffset` のカメラ側だけ
//
// ISO 80 は厳密には 79.37（= 100·2^(-1/3)）で 0.011段のずれがあるが、
// **一貫性のため ISO も変換しない。** このずれは AE オフセットの校正で吸収される。
//
// `compute()` 入口の `exactGear()`（公称ラベル→厳密値）とは**逆向きの方針**であり、
// 対象が違うだけで矛盾していない。サニー16 の検算（1/125 → 1/128）が意味を持つのは
// カメラの公称ラベルを扱う機能B だけ。回帰テストは `tests.html` の **L9**。
// ─────────────────────────────────────────────────────────────────────

import { F, SS, ISO, snap } from './stops.js';

/** ナイトモードの疑い：この SS（秒）以上 かつ この ISO 以上（photocal-spec §3.4）。 */
export const NIGHT_MODE_SS = 1.0;
export const NIGHT_MODE_ISO = 3200;

/** 校正時と測定時でレンズが違うとみなす焦点距離の比（photocal-spec §3.3）。 */
export const LENS_CHANGE_RATIO = 1.5;

/**
 * EXIF の露出3値からシーンEV（ISO100基準）を求める。
 *
 * @param {{fNumber:number|null, exposureTime:number|null, iso:number|null,
 *          exposureBias:number|null}} exif `exif.parseExif()` の戻り（実測値のまま）
 * @param {number} [aeOffsetStops] AE オフセット（校正値。未校正なら 0）
 * @returns {{ev:number|null, reason:string|null, suspectNightMode:boolean,
 *            exposureBias:number}} `ev` が null のとき `reason` に理由が入る
 */
export function evFromExposure(exif, aeOffsetStops = 0) {
  const e = exif || {};
  const N = e.fNumber, t = e.exposureTime, S = e.iso;
  // 露出補正は「無い」と「0」を区別しない。EXIF に出ない機種は補正なしとして扱う
  const bias = Number.isFinite(e.exposureBias) ? e.exposureBias : 0;
  const offset = Number.isFinite(aeOffsetStops) ? aeOffsetStops : 0;
  const out = { ev: null, reason: null, suspectNightMode: false, exposureBias: bias };

  // ゼロ除算・負値・欠損をここで全部弾く（t > 0 の判定がゼロ除算の防波堤）
  if (!(N > 0) || !(t > 0) || !(S > 0)) {
    const miss = [!(N > 0) && 'F値', !(t > 0) && 'シャッター速度', !(S > 0) && 'ISO'].filter(Boolean);
    out.reason = `撮影情報が不足しています（${miss.join('・')}）`;
    return out;
  }
  out.suspectNightMode = t >= NIGHT_MODE_SS && S >= NIGHT_MODE_ISO;
  // **ここで snap しない。** 上のコメント参照
  out.ev = Math.log2((N * N) / t) - Math.log2(S / 100) + bias + offset;
  return out;
}

/**
 * 公称ラベルで入力されたカメラ側の露出を厳密値へ直す。
 * `compute.exactGear()` と同じ考え方（`F11` の実体は 11.31、`1/250` は 1/256）。
 * **スマホ側には使わない**（実測値なので寄せると誤差が増える）。
 * @param {{fNumber:number, exposureTime:number, iso:number}} nominal
 * @returns {{fNumber:number, exposureTime:number, iso:number}}
 */
function exactFromLabels(nominal) {
  const g = (series, v) => (Number.isFinite(v) && v > 0 ? snap(series, v).real : v);
  return {
    fNumber: g(F, nominal.fNumber),
    exposureTime: g(SS, nominal.exposureTime),
    iso: g(ISO, nominal.iso),
  };
}

/**
 * スマホとカメラの測定値から AE オフセットを求める。
 *
 * `offset = EV_camera − EV_phone`。**基準はカメラ。** アプリの目的は
 * 「カメラがどう写すか」の予測なので、合わせる先はカメラでなければならない。
 *
 * **非対称：カメラ側だけ公称ラベル→厳密値に変換する。**
 * スマホ側は EXIF の実測値（1/4405 など）で、グリッド上に存在しない。
 * カメラ側は人が読んだラベル（F11・1/250）で、実体は 11.31・1/256。
 * 同じ扱いにするとどちらかに誤差が入る。
 *
 * @param {{fNumber:number|null, exposureTime:number|null, iso:number|null,
 *          exposureBias:number|null}} phoneExposure スマホの EXIF（実測値）
 * @param {{fNumber:number|null, exposureTime:number|null, iso:number|null}} cameraExposure
 *   カメラで読んだ適正値（**公称ラベル**）
 * @returns {{offsetStops:number|null, reason:string|null,
 *            evPhone:number|null, evCamera:number|null}}
 */
export function solveAeOffset(phoneExposure, cameraExposure) {
  const phone = evFromExposure(phoneExposure, 0);
  if (phone.ev === null) {
    return { offsetStops: null, reason: `スマホ側の${phone.reason}`, evPhone: null, evCamera: null };
  }
  const c = cameraExposure || {};
  if (!(c.fNumber > 0) || !(c.exposureTime > 0) || !(c.iso > 0)) {
    return { offsetStops: null, reason: 'カメラ側の F値・SS・ISO をすべて入れてください', evPhone: phone.ev, evCamera: null };
  }
  // カメラ側は公称ラベルなので厳密値へ直す（スマホ側は直さない）
  const exact = exactFromLabels(c);
  const camera = evFromExposure({ ...exact, exposureBias: 0 }, 0);
  if (camera.ev === null) {
    return { offsetStops: null, reason: `カメラ側の${camera.reason}`, evPhone: phone.ev, evCamera: null };
  }
  return { offsetStops: camera.ev - phone.ev, reason: null, evPhone: phone.ev, evCamera: camera.ev };
}

/**
 * 校正時と別のレンズで撮られていないか。
 * iPhone は超広角13mm・主24mm・望遠120mm相当とレンズが複数あり、AE の傾向が異なりうる。
 * **レンズごとにオフセットを持つのは過剰**なので注記だけ出す（photocal-spec §3.3）。
 * @param {number|null} nowFocal35 測定した写真の35mm換算焦点距離
 * @param {number|null} calFocal35 校正時の35mm換算焦点距離
 * @returns {string|null} 注記（問題なければ null）
 */
export function lensChangeNote(nowFocal35, calFocal35) {
  if (!(nowFocal35 > 0) || !(calFocal35 > 0)) return null;
  const ratio = Math.max(nowFocal35 / calFocal35, calFocal35 / nowFocal35);
  if (ratio < LENS_CHANGE_RATIO) return null;
  return `校正時と別のレンズで撮影されています（校正 ${Math.round(calFocal35)}mm / 今回 ${Math.round(nowFocal35)}mm）。精度が落ちる可能性があります`;
}

/**
 * 測定結果に添える注記をまとめる。**値は出したうえで注記する**（黙って隠さない）。
 * @param {{suspectNightMode:boolean, exposureBias:number}} meas `evFromExposure` の戻り
 * @param {number|null} nowFocal35
 * @param {{aeCalibrated:boolean, aeCalFocal35:number|null}} phone
 * @returns {string[]}
 */
export function measurementNotes(meas, nowFocal35, phone) {
  const notes = [];
  if (meas.suspectNightMode) {
    notes.push('ナイトモードで撮影された可能性があります。値が正確でない場合があります');
  }
  if (Math.abs(meas.exposureBias) > 1e-9) {
    const sign = meas.exposureBias > 0 ? '+' : '−';
    notes.push(`露出補正 ${sign}${Math.abs(meas.exposureBias).toFixed(1)} の写真です。補正なしで撮ると精度が上がります`);
  }
  const lens = phone && phone.aeCalibrated ? lensChangeNote(nowFocal35, phone.aeCalFocal35) : null;
  if (lens) notes.push(lens);
  return notes;
}
