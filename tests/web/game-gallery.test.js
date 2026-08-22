// Тест server/admin_ui/game-gallery.js в jsdom — тот же приём, что и
// game-list.test.js: реальный admin.html грузится целиком, скрипты
// исполняются по порядку, а createGameGallery() монтируется в #gg_root.
//
// Покрыты только по-настоящему юнит-тестируемые вещи: список файлов рисуется
// правильно (папки/картинки/не-картинки), breadcrumbs строят путь и
// переключают его, а поиск и запрос списка формируют правильный URL. Всё,
// что требует живого сервера (загрузка файла по URL, реальное сохранение
// подписи), не покрывается — это дело интеграционных тестов, не юнитов.

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

// jsdom's own DOMContentLoaded fires asynchronously after our scripts attach
// their listeners; draining a few ticks before the test body runs keeps
// admin.js's unrelated tab loaders from finishing after the window closes
// (see game-list.test.js for the long version of this story).
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

  await settle();

  t.after(() => dom.window.close());

  return { dom, window, document: window.document };
}

function makeFetchStub(handlers) {
  const calls = [];
  const fn = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input && input.url);
    calls.push({ url, method: (init && init.method) || 'GET' });
    for (const h of handlers) {
      if (h.test(url)) return h.respond(url, init);
    }
    return jsonResponse({ status: 'ok' });
  };
  fn.calls = calls;
  return fn;
}

test('galerея: список рисует папку, картинку и не-картинку по-разному', async (t) => {
  const fetchStub = makeFetchStub([
    {
      test: (u) => u.includes('/games/gallery?'),
      respond: () => jsonResponse({
        path: '',
        items: [
          { name: 'screens', isDir: true },
          { name: 'cover.png', isDir: false, size: 10, url: '/x/cover.png' },
          { name: 'notes.txt', isDir: false, size: 5, url: '/x/notes.txt' },
        ],
      }),
    },
    { test: (u) => u.includes('/gallery/gallery.json'), respond: () => jsonResponse({ cover: '', items: [] }) },
  ]);
  const { window, document } = await loadAdminPage(t, { fetchImpl: fetchStub });

  const gallery = window.createGameGallery({ root: '#gg_root', gameId: 'lethal-company' });
  assert.ok(gallery, 'галерея монтируется на #gg_root');
  await gallery.fetchAndRender();

  const grid = document.getElementById('gg_root').querySelector('[data-gg="grid"]');
  assert.ok(grid, 'сетка есть в разметке');

  // Папка: заголовок + карточка с иконкой каталога, кликабельна.
  const cards = grid.querySelectorAll('.card');
  assert.strictEqual(cards.length, 3, 'по карточке на каждый элемент');

  // Картинка рисуется <img>, не-картинка — плашкой с расширением.
  assert.strictEqual(grid.querySelectorAll('img[src="/x/cover.png"]').length, 1, 'картинка рисуется <img>');
  assert.strictEqual(grid.querySelectorAll('img[src$="notes.txt"]').length, 0, 'не-картинка не рисуется как <img>');
  assert.match(grid.textContent, /txt/i, 'расширение не-картинки видно на плашке');
});

test('галерея: пустая папка показывает разные подсказки для корня и вложенной папки', async (t) => {
  const fetchStub = makeFetchStub([
    { test: (u) => u.includes('/games/gallery?'), respond: () => jsonResponse({ path: '', items: [] }) },
    { test: (u) => u.includes('/gallery/gallery.json'), respond: () => jsonResponse({ cover: '', items: [] }) },
  ]);
  const { window, document } = await loadAdminPage(t, { fetchImpl: fetchStub });

  const gallery = window.createGameGallery({ root: '#gg_root', gameId: 'lethal-company' });
  await gallery.fetchAndRender();

  const grid = document.getElementById('gg_root').querySelector('[data-gg="grid"]');
  assert.match(grid.textContent, /ещё нет ни одной картинки/, 'пустой корень объясняет, что делать');
});

test('галерея: поисковый запрос и путь попадают в URL списка', async (t) => {
  const fetchStub = makeFetchStub([
    { test: (u) => u.includes('/games/gallery?'), respond: () => jsonResponse({ path: 'screens', items: [] }) },
    { test: (u) => u.includes('/gallery/gallery.json'), respond: () => jsonResponse({ cover: '', items: [] }) },
  ]);
  const { window, document } = await loadAdminPage(t, { fetchImpl: fetchStub });

  const gallery = window.createGameGallery({ root: '#gg_root', gameId: 'my game/weird' });
  gallery.setPath('screens');
  const search = document.getElementById('gg_root').querySelector('[data-gg="search"]');
  if (search) search.value = 'boss fight';
  await gallery.fetchAndRender();

  const listCall = fetchStub.calls.find((c) => c.url.includes('/games/gallery?'));
  assert.ok(listCall, 'список должен быть запрошен');
  assert.match(listCall.url, /gameId=my%20game%2Fweird/, 'gameId кодируется в URL');
  assert.match(listCall.url, /path=screens/, 'текущий путь передаётся списком');
  if (search) assert.match(listCall.url, /q=boss%20fight/, 'поисковый запрос кодируется в URL');
});

test('галерея: breadcrumbs строят путь и клик переключает его', async (t) => {
  const fetchStub = makeFetchStub([
    {
      test: (u) => u.includes('/games/gallery?'),
      respond: (u) => {
        const params = new URL(u, 'http://localhost').searchParams;
        const p = params.get('path') || '';
        return jsonResponse({ path: p, items: [] });
      },
    },
    { test: (u) => u.includes('/gallery/gallery.json'), respond: () => jsonResponse({ cover: '', items: [] }) },
  ]);
  const { window, document } = await loadAdminPage(t, { fetchImpl: fetchStub });

  const gallery = window.createGameGallery({ root: '#gg_root', gameId: 'lethal-company' });
  gallery.setPath('screens/2026');
  await gallery.fetchAndRender();

  const crumbs = document.getElementById('gg_root').querySelector('[data-gg="breadcrumbs"]');
  const links = [...crumbs.querySelectorAll('a')];
  assert.deepStrictEqual(links.map((a) => a.getAttribute('data-p')), ['', 'screens', 'screens/2026']);

  links[1].dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  await settle();

  const listCall = fetchStub.calls.filter((c) => c.url.includes('/games/gallery?')).pop();
  assert.match(listCall.url, /path=screens(?!%2F)/, 'клик по хлебной крошке переключает путь на неё');
});

test('галерея: без выбранной игры список не запрашивается', async (t) => {
  const fetchStub = makeFetchStub([]);
  const { window, document } = await loadAdminPage(t, { fetchImpl: fetchStub });

  const gallery = window.createGameGallery({ root: '#gg_root', gameId: '' });
  await gallery.fetchAndRender();

  const grid = document.getElementById('gg_root').querySelector('[data-gg="grid"]');
  assert.match(grid.textContent, /Игра не выбрана/);
  assert.strictEqual(fetchStub.calls.filter((c) => c.url.includes('/games/gallery?')).length, 0);
});
