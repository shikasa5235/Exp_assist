// main.js — エントリポイント。初期化と Service Worker の登録のみ。
// ロジックは持たない：状態を復元して ui.init に渡し、更新バーを配線するだけ。

import { init } from './ui.js';
import * as storage from './storage.js';

function boot() {
  init(storage.load());
  registerServiceWorker();
}

/* ====================================================================== */
/*  Service Worker（MAINTENANCE.md §6）                                    */
/* ====================================================================== */

/**
 * SW を登録し、waiting が現れたときだけ更新バーを出す。
 * **自動リロードしない。** 押されたときだけ skipWaiting → reload（§6.5）。
 */
function registerServiceWorker() {
  // file:// では登録できない。エラーを出さず黙って何もしない
  if (!('serviceWorker' in navigator)) return;

  // 初回表示を SW の処理で遅らせないため load 後に登録する
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });

      // すでに待機中の新版があるか（前回のセッションで検出されたもの）
      showUpdateBarIf(reg.waiting);

      // 新版が見つかったら、インストール完了（installed）した時点で待機に入る
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          // controller が居ないときは初回インストール。更新ではないのでバーを出さない
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBarIf(reg.waiting || sw);
          }
        });
      });
    } catch (e) {
      // localhost と https 以外では登録できない。機能は落とさない
    }
  }, { once: true });
}

/**
 * 更新バーを表示して［更新］を配線する。waiting が無ければ何もしない
 * （SW 未登録・登録済みで waiting 無しのときはバーを出さない）。
 * @param {ServiceWorker|null|undefined} waiting
 */
function showUpdateBarIf(waiting) {
  if (!waiting) return;
  const bar = document.getElementById('update-bar');
  const apply = document.getElementById('update-apply');
  if (!bar || !apply) return;
  bar.hidden = false;
  apply.addEventListener('click', () => {
    apply.disabled = true;
    // 新しい SW がアクティブになったら1度だけ再読み込みする
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    }, { once: true });
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }, { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
