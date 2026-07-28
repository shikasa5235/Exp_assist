// wheel.js — 横ホイールピッカー（UI仕様 §3 のシグネチャ要素）。
// 計算タブの操作トラックと結果パネルの表示トラックで共有する同一コンポーネント。
// DOM ビュー部品：状態は持たず、値は setIndex で外から与え、変更は onCommit で外へ返す。
// （state は ui.js が一元管理。ここは表示と入力捕捉のみで判断・計算をしない）

const STEP = 26; // 1/3段あたりの px（CSS の --wheel-step と合わせる）

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
  let dragStartX = null;
  let dragStartIndex = 0;
  root.addEventListener('pointerdown', (e) => {
    if (!interactive) return;
    dragStartX = e.clientX; dragStartIndex = index;
    root.setPointerCapture?.(e.pointerId);
    root.classList.remove('animate');
  });
  root.addEventListener('pointermove', (e) => {
    if (dragStartX == null) return;
    const live = clamp(dragStartIndex - (e.clientX - dragStartX) / STEP, minIndex, maxIndex);
    track.style.transform = `translateX(${-((live - minIndex) * STEP + STEP / 2)}px)`; // 追従（未確定）
  });
  function endDrag(e) {
    if (dragStartX == null) return;
    const committed = clamp(Math.round(dragStartIndex - (e.clientX - dragStartX) / STEP), minIndex, maxIndex);
    dragStartX = null;
    navigator.vibrate?.(8);
    if (committed !== index) onCommit(committed);
    else place(true); // 変化なしなら元位置へスナップ
  }
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

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
