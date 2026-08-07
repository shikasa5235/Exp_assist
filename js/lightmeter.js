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
 * 公称ラベルで記録／入力された**カメラ側**の露出を厳密値へ直す。
 * `compute.exactGear()` と同じ考え方（`F11` の実体は 11.3137、`1/250` は 1/256）。
 *
 * ─────────────────────────────────────────────────────────────────
 * **フェーズ1（変換しない）と矛盾しているように見えるが、対象が違う。**
 *
 * | 出所 | 値の性格 | 変換 |
 * | --- | --- | --- |
 * | スマホ | AE が**連続値**で制御し実測値を記録（`1/4405`・`F1.77999997`） | **しない** |
 * | カメラ | ユーザーが**1/3段グリッドから選ぶ**。記録されるのは公称ラベル（`F11`・`1/250`） | **する** |
 *
 * 校正の `k` は F値と距離から求めるので、`F11` を 11.0 のまま使うと k が 0.08段 ずれる
 * （200Ws・3m・ISO100・1/1 で **2.400 → 2.3335**）。回帰テストは `tests.html` の **I3**。
 *
 * **どちらの出所かはメタデータから判別しない。** `Make` が Apple なら…という判別は脆い
 * （機種名は増える／PC 経由でメーカーが書き換わる／エミュレータ）。
 * **呼び出し側は自分がどちらの UI かを知っている**ので、`parseExif` は生の値を返し、
 * 変換するかどうかは呼び出し側（校正UI = する／測定UI = しない）が決める。
 * ─────────────────────────────────────────────────────────────────
 *
 * @param {{fNumber:number|null, exposureTime:number|null, iso:number|null}} nominal
 * @returns {{fNumber:number|null, exposureTime:number|null, iso:number|null}}
 */
export function exactFromLabels(nominal) {
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
 * ストロボ校正に使う写真の整合検証（photocal-spec §4.3）。
 *
 * **`lightmeter.js` に置く理由：** 「EXIF の値をどう解釈するか」を持つ唯一の純粋モジュール。
 * `advisor.js` は露出計算の判定で EXIF を知らず、`compute.js` は state からしか値を受けない。
 * `measurementNotes` と同じ形（判定＋文言）なので隣に置く。
 *
 * @param {object} exif `parseExif()` の戻り（**生の値。変換前でよい**）
 * @param {{syncSpeed:number, inputF:number|null}} ctx
 *   syncSpeed = カメラの同調速度（秒）、inputF = 校正欄に入っている F値（公称ラベル）
 * @returns {Array<{level:'alert'|'warn', text:string}>} 空なら問題なし
 */
export function calibrationNotes(exif, ctx) {
  const notes = [];
  if (!exif) return notes;
  const { syncSpeed, inputF } = ctx || {};
  // ① 非発光。校正はストロボ光の量を測るものなので、光っていない写真は使えない
  if (exif.flashFired === false) {
    notes.push({ level: 'alert', text: 'この写真ではストロボが発光していません。校正には使えません' });
  }
  // ② 同調速度超過。通常発光なら幕に切られているので露出が信用できない
  if (exif.flashFired === true && exif.exposureTime > 0 && syncSpeed > 0
      && exif.exposureTime < syncSpeed) {
    const ss = snap(SS, exif.exposureTime).label, sync = snap(SS, syncSpeed).label;
    notes.push({ level: 'warn', text: `SS ${ss} は同調速度 ${sync} より速いため、通常発光では同期しません。HSS で撮影しましたか` });
  }
  // ③ 手入力と EXIF の食い違い。**転記ミスをその場で気づけるのでこれが実用上いちばん効く。**
  //   どちらも公称ラベルなので、1/3段グリッドの同じ位置に落ちるかで比べる
  if (exif.fNumber > 0 && inputF > 0) {
    const a = snap(F, exif.fNumber), b = snap(F, inputF);
    if (a.index !== b.index) {
      notes.push({ level: 'warn', text: `EXIF は F${a.label}、入力は F${b.label} です。どちらを使いますか` });
    }
  }
  return notes;
}

/**
 * 校正の出所を1行にまとめる（設定タブの読み取り結果表示）。
 * @param {object} exif @returns {{head:string, body:string}}
 */
export function exifSummary(exif) {
  if (!exif) return { head: '', body: '' };
  const date = exif.dateTimeOriginal
    ? exif.dateTimeOriginal.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').slice(0, 16) : '';
  const head = [exif.model || exif.make || '機種不明', date].filter(Boolean).join(' / ');
  const body = [
    exif.fNumber > 0 ? `F${snap(F, exif.fNumber).label}` : null,
    exif.exposureTime > 0 ? snap(SS, exif.exposureTime).label : null,
    exif.iso > 0 ? `ISO${snap(ISO, exif.iso).label}` : null,
    exif.focalLength > 0 ? `${Math.round(exif.focalLength)}mm` : null,
    exif.flashFired === null ? null : (exif.flashFired ? '発光あり' : '発光なし'),
  ].filter(Boolean).join(' ・ ');
  return { head, body };
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
