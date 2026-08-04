// main.js — エントリポイント。初期化と Service Worker の登録のみ。
// ロジックは持たない：状態を復元して ui.init に渡し、SW の2本の配線を張るだけ。
//   1) 更新バー（waiting を検出したとき／§6.5）
//   2) オフライン準備完了の通知（初回インストールが activated になったとき／§6.7）

import { init, showToast } from './ui.js';
import * as storage from './storage.js';

/** 「オフラインで使えるようになりました」を出したか（一度きり）。 */
const OFFLINE_READY_FLAG = 'offlineReadyNotified';

function boot() {
  init(storage.load());
  registerServiceWorker();
}

/* ====================================================================== */
/*  Service Worker（MAINTENANCE.md §6）                                    */
/* ====================================================================== */

/**
 * SW を登録し、2本の通知を配線する（§6.7 の表を参照）。
 * **自動リロードしない。** 更新バーが押されたときだけ skipWaiting → reload（§6.5）。
 */
function registerServiceWorker() {
  // file:// では登録できない。エラーを出さず黙って何もしない
  if (!('serviceWorker' in navigator)) return;

  // 初回表示を SW の処理で遅らせないため load 後に登録する
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });

      // 初回インストールの完了を見張る（更新バーとは別の配線。§6.5 と混ぜない）
      watchFirstInstall(reg);

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
 * 初回インストールが完了した（＝プリキャッシュが端末に載った）ことを一度だけ知らせる。
 *
 * **なぜ要るか：** iOS ではホーム画面に追加しただけではキャッシュができない。追加直後に
 * 機内モードで起動すると起動に失敗する。一度オンラインで起動して初めて使えるようになるが、
 * 利用者にはその境目が見えない。現場に着いてから追加しても間に合わない、という事故になる。
 *
 * controller が居ない＝まだ SW に制御されていない＝この起動が初回インストール。
 * その worker が activated になった時点で install の waitUntil（addAll）は済んでいる。
 * @param {ServiceWorkerRegistration} reg
 */
function watchFirstInstall(reg) {
  if (navigator.serviceWorker.controller) return; // 2回目以降の起動。通知しない
  const sw = reg.installing || reg.waiting || reg.active;
  if (!sw) return;
  if (sw.state === 'activated') { notifyOfflineReady(); return; }
  sw.addEventListener('statechange', () => {
    if (sw.state === 'activated') notifyOfflineReady();
  });
}

/** 初回だけトーストを出す。フラグは storage（アプリ状態とは別の名前空間）に持つ。 */
function notifyOfflineReady() {
  if (storage.getFlag(OFFLINE_READY_FLAG)) return;
  storage.setFlag(OFFLINE_READY_FLAG, true);
  showToast('オフラインで使えるようになりました');
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
