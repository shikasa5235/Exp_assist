// wheel.js — 横ホイールピッカー（UI仕様 §3 のシグネチャ要素）。
// 計算タブの操作トラックと結果パネルの表示トラックで共有する同一コンポーネント。
// DOM ビュー部品：状態は持たず、値は setIndex で外から与え、変更は onCommit で外へ返す。
// （state は ui.js が一元管理。ここは表示と入力捕捉のみで判断・計算をしない）

const STEP = 26; // 1/3段あたりの px（CSS の --wheel-step と合わせる）

/**
 * ドラッグ量から確定インデックスを求める。**この4引数だけで決まる純粋関数。**
 *
 * 状態を持たないので、途中の `pointermove` が何回来ても、どの粒度で来ても結果が変わらない
 * （累積の誤りが構造的に起こり得ない）。ジェスチャ境界の不具合はここに入り込めない。
 *
 * 配列位置（0..len-1）で扱う。系列インデックス（SS は −15 始まり）への変換は呼び出し側の仕事。
 *
 * @param {number} startIndex ジェスチャ開始時の配列位置（0..len-1）
 * @param {number} totalDxPx 開始点からの移動量(px)。**正でインデックスが増える向き**
 *   （ホイールは指を左へ動かすと値が上がるので、呼び出し側は `startX − currentX` を渡す）
 * @param {number} stepPx 1/3段あたりの px
 * @param {number} len ラベル数
 * @returns {number} 0..len-1 にクランプした整数
 */
export function indexFromDrag(startIndex, totalDxPx, stepPx, len) {
  const raw = Math.round(startIndex + totalDxPx / stepPx);
  return Math.max(0, Math.min(len - 1, raw));
}

/**
 * @typedef {Object} WheelDesc
 * @property {string[]} labels 全 1/3段ラベル
 * @property {number} minIndex 先頭ラベルの index
 * @property {number} majorEvery major(長い罫＋ラベル)を打つ間隔（F/SS/ISO=3、発光量=1）
 * @property {(index:number)=>string} valueText aria-valuetext 用の人間可読値
 */

/**
 * ホイールを生成する。
 * @param {WheelDesc} desc
 * @param {{interactive?:boolean, onCommit?:(index:number)=>void}} [opts]
 * @returns {{root:HTMLElement, setIndex:Function, setInteractive:Function, get index():number}}
 */
export function makeWheel(desc, opts = {}) {
  const { labels, minIndex, majorEvery = 3, valueText } = desc;
  const maxIndex = minIndex + labels.length - 1;
  let interactive = !!opts.interactive;
  const onCommit = opts.onCommit || (() => {});

  const root = document.createElement('div');
  root.className = 'wheel';
  root.style.setProperty('--wheel-step', `${STEP}px`);
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-valuemin', String(minIndex));
  root.setAttribute('aria-valuemax', String(maxIndex));

  const track = document.createElement('div');
  track.className = 'wheel-track';
  labels.forEach((label, i) => {
    const idx = minIndex + i;
    const tick = document.createElement('span');
    tick.className = 'wheel-tick' + ((idx - minIndex) % majorEvery === 0 ? ' major' : '');
    tick.style.width = `${STEP}px`;
    if ((idx - minIndex) % majorEvery === 0) {
      const lab = document.createElement('span');
      lab.className = 'tick-label'; lab.textContent = label;
      tick.appendChild(lab);
    }
    track.appendChild(tick);
  });
  const pointer = document.createElement('div');
  pointer.className = 'wheel-pointer';
  root.append(track, pointer);

  let index = minIndex;

  /** track を index が中央（指針）に来る位置へ動かす。 */
  function place(animate) {
    root.classList.toggle('animate', !!animate);
    const offset = -((index - minIndex) * STEP + STEP / 2);
    track.style.transform = `translateX(${offset}px)`;
  }

  /** 外部（render）から現在値を与える。 */
  function setIndex(i, { animate = true } = {}) {
    index = clamp(Math.round(i), minIndex, maxIndex);
    root.setAttribute('aria-valuenow', String(index));
    if (valueText) root.setAttribute('aria-valuetext', valueText(index));
    root.classList.toggle('wheel-edge', index === minIndex || index === maxIndex);
    place(animate);
  }

  function setInteractive(v) {
    interactive = !!v;
    root.tabIndex = interactive ? 0 : -1;
    root.classList.toggle('is-readonly', !interactive);
    root.setAttribute('aria-disabled', String(!interactive));
  }

  // ---- 入力（ドラッグ）：位置を捕捉して離した時に onCommit。判断はしない ----
  //
  // ジェスチャの状態は3つで完結させる（drag === null なら「ドラッグしていない」）。
  // 個別の変数に散らすと、どれか1つを消し忘れて前のジェスチャが次に持ち越される。
  /** @type {{pointerId:number, startX:number, startIndex:number}|null} */
  let drag = null;

  /** ドラッグ状態を捨てる。**値は確定しない。** */
  function clearDrag() { drag = null; }

  root.addEventListener('pointerdown', (e) => {
    if (!interactive) return;
    // dragging のまま来たら前のジェスチャを破棄して新しく始める（残骸を継続扱いしない）
    // startIndex は毎回 state から取り直す。前回の値を使い回さない
    drag = { pointerId: e.pointerId, startX: e.clientX, startIndex: index };
    root.setPointerCapture?.(e.pointerId);
    root.classList.remove('animate');
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return; // 別の指のイベントは無視する
    // 追従（未確定）。丸めずに連続値で動かす
    const live = clamp(drag.startIndex + (drag.startX - e.clientX) / STEP, minIndex, maxIndex);
    track.style.transform = `translateX(${-((live - minIndex) * STEP + STEP / 2)}px)`;
  });

  root.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    // 指を離した位置だけで決める。累積を持たないので途中の move が何回来ても結果は同じ
    const pos = indexFromDrag(drag.startIndex - minIndex, drag.startX - e.clientX, STEP, labels.length);
    const committed = pos + minIndex;
    clearDrag();
    navigator.vibrate?.(8);
    if (committed !== index) onCommit(committed);
    else place(true); // 変化なしなら元位置へスナップ
  });

  // **pointercancel では値を確定しない。**
  // 実機の症状：ホイールを横スワイプ中に縦スクロールが挟まるとブラウザがタッチを引き取り、
  // ここが endDrag（確定処理）に繋がっていたため、意図しない値が commit されてダイアルが飛んだ。
  // 繰り返すと飛んだ値が次の起点になるので悪化した。PC で出なかったのはマウスでは
  // スクロールと競合しないため。①として CSS 側に touch-action: pan-y も入れてある。
  //
  // **開始時の値へ戻す**（その時点の値で止めない）。システム都合の中断で
  // ユーザーが選んでいない値を残すと、選んだつもりのない設定で撮ることになる。
  // やり直しは指を置き直すだけなので、戻すほうが安全。
  root.addEventListener('pointercancel', (e) => {
    // 追跡中の指のキャンセルだけ扱う。2本目の指がキャンセルされても進行中のドラッグは壊さない
    if (!drag || e.pointerId !== drag.pointerId) return;
    clearDrag();
    place(true); // index は触っていないので、これが開始時の位置
  });

  // ---- 入力（キーボード）：1/3段ずつ ----
  root.addEventListener('keydown', (e) => {
    if (!interactive) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onCommit(clamp(index + 1, minIndex, maxIndex)); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onCommit(clamp(index - 1, minIndex, maxIndex)); }
  });

  setInteractive(interactive);
  return { root, setIndex, setInteractive, get index() { return index; } };
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
