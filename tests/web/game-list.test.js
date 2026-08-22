// Тест server/admin_ui/game-list.js в jsdom — тот же приём, что и
// admin-dom.test.js: реальный admin.html грузится целиком, скрипты
// исполняются по порядку, а game-list.js рисует #gm_list поверх скрытой
// #mgm-table.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { TextDecoder, TextEncoder } = require('node:util');

const ADMIN_DIR = path.join(__dirname, '..', '..', 'server', 'admin_ui');
const HTML_PATH = path.join(ADMIN_DIR, 'admin.html');

const SCRIPT_ORDER = [
  'ui-throttle.js',
  'upload-bench.js',
  'speed-chart.js',
  'line-chart.js',
  'chunk-upload.js',
  'rate-estimator.js',
  'ui-status.js',
  'upload-card.js',
  'game-gallery.js',
  'game-list.js',
  'admin.js',
];

function jsonResponse(json, status) {
  const st = status || 200;
  return { ok: st >= 200 && st < 300, status: st, json: async () => json, text: async () => JSON.stringify(json) };
}

// Что-то в admin.js (загрузчики других вкладок) может запустить фоновый
// fetch, который резолвится уже после того, как тест закончился и закрыл
// jsdom-окно — тогда обработчик промиса читает document на закрытом window
// и падает unhandledRejection. Даём микротаскам несколько тиков.
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((res) => setTimeout(res, 5));
}

async function loadAdminPage(t, { fetchImpl } = {}) {
  let html = fs.readFileSync(HTML_PATH, 'utf8');
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^<]*<\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/admin/' });
  const { window } = dom;

  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  window.fetch = fetchImpl || (async () => jsonResponse({ status: 'ok' }));
  window.confirm = () => true;

  const ctx = dom.getInternalVMContext();
  for (const file of SCRIPT_ORDER) {
    const abs = path.join(ADMIN_DIR, file);
    const src = fs.readFileSync(abs, 'utf8');
    vm.runInContext(src, ctx, { filename: abs });
  }

  // jsdom fires its own DOMContentLoaded asynchronously once the parsed
  // document settles, and admin.js's own DOMContentLoaded listeners (tab
  // loaders: mtLoad/gmSelectReload/lnPrevEnsureVersionsAndRender/...) run
  // then, not synchronously. Draining it here — before the test body reads
  // the DOM — keeps that unrelated background activity from finishing after
  // t.after() has already closed the window.
  await settle();

  t.after(() => dom.window.close());

  return { dom, window, document: window.document };
}

// addRow inserts a hidden #mgm-table row the same shape mgmAppendRow builds,
// without depending on admin.js's own row-construction internals.
function addRow(document, { gameId, title, pinned, unpublished }) {
  const tb = document.querySelector('#mgm-table tbody');
  const tr = document.createElement('tr');
  if (pinned) tr.dataset.pinned = '1';
  if (unpublished) tr.dataset.unpublished = '1';
  function td(value) {
    const cell = document.createElement('td');
    const input = document.createElement('input');
    input.value = value || '';
    cell.appendChild(input);
    return cell;
  }
  tr.appendChild(td(gameId));
  tr.appendChild(td(title));
  tr.appendChild(td('')); // icon
  tr.appendChild(td('')); // exe
  tb.appendChild(tr);
  return tr;
}

test('gmListRender: пропускает строки с пустым gameId', async (t) => {
  const { document, window } = await loadAdminPage(t);
  addRow(document, { gameId: '', title: 'no id here' });
  addRow(document, { gameId: 'valid-game', title: 'Valid Game' });

  window.gmListRender();

  const items = document.querySelectorAll('#gm_list .list-group-item');
  assert.strictEqual(items.length, 1, 'строка без gameId не должна попасть в список');
  assert.match(items[0].textContent, /Valid Game/);
});

test('gmListRender: поиск фильтрует по id и по title', async (t) => {
  const { document, window } = await loadAdminPage(t);
  addRow(document, { gameId: 'lethal-company', title: 'Lethal Company' });
  addRow(document, { gameId: 'stray', title: 'Stray Cat' });

  const search = document.getElementById('gm_search');

  search.value = 'lethal';
  window.gmListRender();
  let items = document.querySelectorAll('#gm_list .list-group-item');
  assert.strictEqual(items.length, 1);
  assert.match(items[0].textContent, /Lethal Company/);

  // По title тоже находит — 'cat' есть только в title stray.
  search.value = 'cat';
  window.gmListRender();
  items = document.querySelectorAll('#gm_list .list-group-item');
  assert.strictEqual(items.length, 1);
  assert.match(items[0].textContent, /Stray Cat/);

  search.value = 'нет такого';
  window.gmListRender();
  assert.match(document.getElementById('gm_list').textContent, /Ничего не найдено/);

  search.value = '';
  window.gmListRender();
  items = document.querySelectorAll('#gm_list .list-group-item');
  assert.strictEqual(items.length, 2);
});

test('gmListRender: пустой список без строк показывает «Список пуст»', async (t) => {
  const { document, window } = await loadAdminPage(t);
  window.gmListRender();
  assert.match(document.getElementById('gm_list').textContent, /Список пуст/);
});

test('gmListRender: клик по звезде переключает pinned и вызывает mgmSave', async (t) => {
  const { document, window } = await loadAdminPage(t);
  const tr = addRow(document, { gameId: 'game-a', title: 'Game A', pinned: false });

  let saved = 0;
  window.mgmSave = () => { saved++; };
  window.mgmSetDirty = () => {};

  window.gmListRender();
  const pinBtn = document.querySelector('#gm_list .gm-pin');
  assert.strictEqual(pinBtn.textContent, '☆', 'непристёгнутая игра показывает пустую звезду');

  pinBtn.dispatchEvent(new window.Event('click', { bubbles: true }));

  assert.strictEqual(tr.dataset.pinned, '1', 'pin-toggle обновляет dataset скрытой строки');
  assert.strictEqual(saved, 1, 'пин применяется сразу через mgmSave');

  // Список перерисован — теперь звезда закрашена.
  const pinBtnAfter = document.querySelector('#gm_list .gm-pin');
  assert.strictEqual(pinBtnAfter.textContent, '★');
});

test('gmListRender: скрытая (unpublished) игра помечена бейджем', async (t) => {
  const { document, window } = await loadAdminPage(t);
  addRow(document, { gameId: 'hidden-game', title: 'Hidden Game', unpublished: true });

  window.gmListRender();

  const item = document.querySelector('#gm_list .list-group-item');
  assert.match(item.textContent, /скрыта/);
  await settle();
});
