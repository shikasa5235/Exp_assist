// main.js — エントリポイント。初期化のみ（Service Worker 登録は手順10で追加）。
// ロジックは持たない：状態復元して ui.init に渡すだけ。

import { init } from './ui.js';
import * as storage from './storage.js';

function boot() {
  init(storage.load());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
