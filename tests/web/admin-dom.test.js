// Тест server/admin_ui/admin.js в настоящем DOM (jsdom), а не через regex+new
// Function, как это делает admin-logic.test.js/admin-sanitize.test.js.
//
// ПОЧЕМУ ТАК: admin.js — не CommonJS-модуль (в отличие от upload-bench.js/
// chunk-upload.js/...), а monolith на 3000+ строк, который просто читает
// document.getElementById(...) и вешает addEventListener на top-level. c8
// умеет построчно атрибутировать покрытие только исполнению настоящего файла
// (vm.runInContext с filename — см. umd-browser-global.test.js), а не коду,
// вырезанному регэкспом и прогнанному через new Function — тот исполняется
// как анонимная функция без привязки к admin.js, и c8 показывает 0%.
// Здесь тот же приём, но полноценно: реальный admin.html грузится в jsdom, и
// все 8 <script> из него выполняются в её vm-контексте в том же порядке, что
// и в браузере — только так runChunkedUpload() (главный непокрытый кусок,
// пайплайн init/chunk/complete/process) можно прогнать целиком.
//
// Единственная внешняя зависимость репозитория — jsdom, добавленная
// специально ради этого теста (см. package.json и комментарий в
// .github/workflows/ci.yml про npm install перед этим job).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { TextDecoder, TextEncoder } = require('node:util');

const ADMIN_DIR = path.join(__dirname, '..', '..', 'server', 'admin_ui');
const HTML_PATH = path.join(ADMIN_DIR, 'admin.html');

// Порядок обязателен: он повторяет <script> в admin.html построчно (не
// module-система, каждый файл читает/пишет window напрямую).
const SCRIPT_ORDER = [
  'ui-throttle.js',
  'upload-bench.js',
  'speed-chart.js',
  'line-chart.js',
  'chunk-upload.js',
  'rate-estimator.js',
  'ui-status.js',
  // upload-card.js собирает обе карточки заливки из общего шаблона; без него
  // в разметке на их месте остаются пустые <div data-upload-card>, и ни один
  // из up_*/man_* элементов не существует.
  'upload-card.js',
  // Эти два в admin.html были, а здесь — нет: список «повторяет <script>
  // построчно» разошёлся с разметкой. Молча: тесты проходили, а весь код
  // галереи игры и списка игр (включая «Опасную зону» с удалением игры
  // целиком) не исполнялся ни разу и висел в отчёте нулём.
  'game-gallery.js',
  'game-list.js',
  'admin.js',
];

// fakeXHR имитирует ровно ту часть XMLHttpRequest, которую использует
// putChunkXHR (см. tests/web/chunk-upload.test.js) — здесь она же нужна
// внутри целого admin.js, потому что chunk-upload.js достаёт конструктор
// как window.XMLHttpRequest, а admin.js патчит XMLHttpRequest.prototype.open/
// send своим CSRF-шимом поверх того, что подставим мы.
function makeFakeXHRClass(script) {
  return class FakeXHR {
    constructor() {
      this.upload = {};
      this.readyState = 0;
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() { /* no-op: CSRF-шим admin.js дергает это перед send */ }
    send(body) { this.body = body; script(this); }
  };
}

// По умолчанию каждый PUT чанка сразу и без прогресс-событий отвечает 200 —
// достаточно для сценариев, которым важен не сам чанк, а пайплайн вокруг.
function defaultXHRScript(xhr) {
  xhr.status = 200;
  xhr.responseText = JSON.stringify({ writeMs: 1 });
  xhr.readyState = 4;
  xhr.onreadystatechange();
}

function jsonResponse(json, status) {
  const st = status || 200;
  return { ok: st >= 200 && st < 300, status: st, json: async () => json, text: async () => JSON.stringify(json) };
}

// NDJSON-ответ /admin/api/upload/process — читается через res.body.getReader(),
// как настоящий streaming fetch. Одна строка — один JSON.parse внутри admin.js.
function ndjsonResponse(lines) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () => {
            if (i < lines.length) {
              const value = enc.encode(lines[i] + '\n');
              i++;
              return { done: false, value };
            }
            return { done: true, value: undefined };
          },
        };
      },
    },
  };
}

// fetchStub перебирает handlers по порядку и берёт первый, чей test()
// совпал с URL — так каждый тест описывает только те эндпоинты, которые ему
// нужны, не переписывая весь пайплайн заново.
function makeFetchStub(handlers) {
  const calls = [];
  const fn = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input && input.url);
    calls.push({ url, method: (init && init.method) || 'GET' });
    for (const h of handlers) {
      if (h.test(url)) return h.respond(url, init);
    }
    throw new Error('неожиданный fetch: ' + url);
  };
  fn.calls = calls;
  return fn;
}

// Собирает jsdom-страницу из настоящего admin.html и исполняет 8 sibling-
// скриптов в её vm-контексте — тот самый приём из umd-browser-global.test.js,
// но на весь admin.js целиком, а не на вырезанных функциях.
//
// admin.js на верхнем уровне вешает setInterval(periodicVisibleTick, 60000)
// (проверка видимости вкладки) — если не закрыть dom.window по окончании
// теста, этот таймер держит event loop живым, и `node --test` зависает
// навсегда после последнего теста вместо завершения процесса. `t` — это
// TestContext текущего теста node:test, его t.after() и есть то место, где
// это можно сделать одинаково для каждого теста, не повторяя try/finally.
function loadAdminPage(t, { fetchImpl, xhrScript } = {}) {
  let html = fs.readFileSync(HTML_PATH, 'utf8');
  // Единственный внешний <script> — CDN-бандл bootstrap. jsdom без сети его
  // не загрузит (runScripts: 'outside-only' и не пытается сам), но оставлять
  // тег незачем — он не участвует ни в одном сценарии ниже.
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net[^<]*<\/script>\s*/, '');

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/admin/' });
  const { window } = dom;

  // jsdom не тащит TextDecoder/TextEncoder и fetch/Request в window — в
  // браузере они есть всегда, поэтому admin.js их не проверяет на существование.
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  window.fetch = fetchImpl || makeFetchStub([]);
  window.XMLHttpRequest = makeFakeXHRClass(xhrScript || defaultXHRScript);
  // window.confirm у jsdom не реализован (печатает "Not implemented" и
  // возвращает undefined) — для сценариев с up_cleanup/man_cleanup это и
  // так работает как "отмена", но явный stub читается понятнее.
  window.confirm = () => true;

  const ctx = dom.getInternalVMContext();
  for (const file of SCRIPT_ORDER) {
    const abs = path.join(ADMIN_DIR, file);
    const src = fs.readFileSync(abs, 'utf8');
    vm.runInContext(src, ctx, { filename: abs });
  }

  t.after(() => dom.window.close());

  return { dom, window, document: window.document };
}

function setValue(document, id, value) {
  const el = document.getElementById(id);
  el.value = value;
  return el;
}

// ---- (a) runChunkedUpload: полный успешный путь через manifestsUpload() ----

test('runChunkedUpload: полный успех — init/status/chunk/complete/process, прогресс и вкладка man', async (t) => {
  const initJson = { uploadId: 'u-ok', chunkSize: 1024, totalChunks: 1 };
  const fetchStub = makeFetchStub([
    { test: (u) => u.includes('/admin/api/upload/init'), respond: () => jsonResponse(initJson) },
    { test: (u) => u.includes('/admin/api/upload/status'), respond: () => jsonResponse({ received: [] }) },
    { test: (u) => u.includes('/admin/api/upload/complete'), respond: () => jsonResponse({}) },
    { test: (u) => u.includes('/admin/api/upload/process'), respond: () => ndjsonResponse([
      JSON.stringify({ type: 'start' }),
      JSON.stringify({ type: 'unzip', path: 'a.txt' }),
      JSON.stringify({ type: 'composeStart', totalFiles: 1 }),
      JSON.stringify({ type: 'file', idx: 1, path: 'a.txt', bytesDone: 20 }),
      JSON.stringify({ type: 'done', outPath: '/x' }),
    ]) },
  ]);

  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });

  setValue(document, 'gid', 'mygame');
  setValue(document, 'ver', '1.2.3');
  document.getElementById('man_latest').checked = false;
  window.__manDroppedFile = new window.File(['x'.repeat(20)], 'build.zip', { type: 'application/zip' });

  const ok = await window.manifestsUpload();
  assert.strictEqual(ok, undefined, 'manifestsUpload ничего не возвращает, но не должна бросать');

  assert.strictEqual(document.getElementById('man_prog_pct').textContent, 'Загружено 100%');
  assert.strictEqual(document.getElementById('man_pb').style.width, '100%');
  assert.strictEqual(document.getElementById('man_prog_text').textContent, 'Готово. Манифест записан');

  const urls = fetchStub.calls.map((c) => c.url.split('?')[0]);
  assert.ok(urls.includes('/admin/api/upload/init'), 'init должен быть вызван');
  assert.ok(urls.includes('/admin/api/upload/complete'), 'complete должен быть вызван');
  assert.ok(urls.includes('/admin/api/upload/process'), 'process должен быть вызван');
  assert.ok(urls.indexOf('/admin/api/upload/init') < urls.indexOf('/admin/api/upload/complete'),
    'init должен идти раньше complete');
  assert.ok(urls.indexOf('/admin/api/upload/complete') < urls.indexOf('/admin/api/upload/process'),
    'complete должен идти раньше process');

  // dropped-файл сбрасывается после использования — иначе следующая заливка
  // молча повторила бы старый файл вместо выбранного в <input type=file>.
  assert.strictEqual(window.__manDroppedFile, null);
});

test('runChunkedUpload: вызванный напрямую с prefix=up — тоже проходит и обновляет DOM лаунчера', async (t) => {
  const fetchStub = makeFetchStub([
    { test: (u) => u.includes('/admin/api/upload/init'), respond: () => jsonResponse({ uploadId: 'u2', chunkSize: 1024, totalChunks: 1 }) },
    { test: (u) => u.includes('/admin/api/upload/status'), respond: () => jsonResponse({ received: [] }) },
    { test: (u) => u.includes('/admin/api/upload/complete'), respond: () => jsonResponse({}) },
    { test: (u) => u.includes('/admin/api/upload/process'), respond: () => ndjsonResponse([JSON.stringify({ type: 'done', outPath: '/x' })]) },
  ]);
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  const file = new window.File(['y'.repeat(5)], 'launcher.zip', { type: 'application/zip' });

  const result = await window.runChunkedUpload('up', 'launcher', 'launcher', '9.9.9', file);

  assert.strictEqual(result, true);
  assert.strictEqual(document.getElementById('up_pb').style.width, '100%');
  assert.strictEqual(document.getElementById('up_prog_wrap').style.display, 'block');
});

// ---- (b) ошибочные пути ----

test('runChunkedUpload: init отвечает не ok — возвращает false и пишет статус ошибки', async (t) => {
  const fetchStub = makeFetchStub([
    { test: (u) => u.includes('/admin/api/upload/init'), respond: () => jsonResponse({ error: 'boom' }, 500) },
  ]);
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  const file = new window.File(['z'], 'bad.zip', { type: 'application/zip' });

  const result = await window.runChunkedUpload('man', 'game', 'g', '1.0.0', file);

  assert.strictEqual(result, false);
  assert.match(document.getElementById('man_prog_text').textContent, /HTTP 500 init/);
});

test('runChunkedUpload: NDJSON-строка {type:"error"} на process — возвращает false и показывает сообщение', async (t) => {
  const fetchStub = makeFetchStub([
    { test: (u) => u.includes('/admin/api/upload/init'), respond: () => jsonResponse({ uploadId: 'u3', chunkSize: 1024, totalChunks: 1 }) },
    { test: (u) => u.includes('/admin/api/upload/status'), respond: () => jsonResponse({ received: [] }) },
    { test: (u) => u.includes('/admin/api/upload/complete'), respond: () => jsonResponse({}) },
    { test: (u) => u.includes('/admin/api/upload/process'), respond: () => ndjsonResponse([
      JSON.stringify({ type: 'start' }),
      JSON.stringify({ type: 'error', message: 'распаковка не удалась' }),
    ]) },
  ]);
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  const file = new window.File(['q'.repeat(3)], 'g.zip', { type: 'application/zip' });

  const result = await window.runChunkedUpload('man', 'game', 'g', '1.0.0', file);

  assert.strictEqual(result, false, 'ev.type===error должен переворачивать processOk в false');
  assert.match(document.getElementById('man_prog_text').textContent, /Ошибка обработки: распаковка не удалась/);
});

test('runChunkedUpload: чанк не заливается ни с одной попытки — complete не вызывается, возвращает false', async (t) => {
  const fetchStub = makeFetchStub([
    { test: (u) => u.includes('/admin/api/upload/init'), respond: () => jsonResponse({ uploadId: 'u4', chunkSize: 4, totalChunks: 1 }) },
    { test: (u) => u.includes('/admin/api/upload/status'), respond: () => jsonResponse({ received: [] }) },
    { test: (u) => u.includes('/admin/api/upload/complete'), respond: () => { throw new Error('complete не должен вызываться'); } },
  ]);
  // Каждая попытка PUT падает по сети — putChunkXHR резолвится ok:false, retry
  // исчерпывает попытки (5 штук по умолчанию), уходит в failedChunks и
  // остаётся неудачным на повторном проходе тоже.
  const xhrScript = (xhr) => { xhr.onerror(); };
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub, xhrScript });
  const file = new window.File(['abcd'], 'g.zip', { type: 'application/zip' });

  const result = await window.runChunkedUpload('man', 'game', 'g', '1.0.0', file);

  assert.strictEqual(result, false);
  assert.match(document.getElementById('man_prog_text').textContent, /Повторная загрузка неудачных чанков завершилась с ошибкой/);
}, 20000);

// ---- (c) недорогая DOM-обвязка вокруг заливки ----

test('up_conc слайдер параллельности обновляет подпись up_conc_val при input', (t) => {
  const { window, document } = loadAdminPage(t);
  const slider = document.getElementById('up_conc');
  const label = document.getElementById('up_conc_val');
  slider.value = '42';
  slider.dispatchEvent(new window.Event('input'));
  assert.strictEqual(label.textContent, '42');
});

test('man_conc слайдер параллельности обновляет подпись man_conc_val при input', (t) => {
  const { window, document } = loadAdminPage(t);
  const slider = document.getElementById('man_conc');
  const label = document.getElementById('man_conc_val');
  slider.value = '17';
  slider.dispatchEvent(new window.Event('input'));
  assert.strictEqual(label.textContent, '17');
});

// showSection() прячет секции классом hidden. Секция с инлайновым
// style="display:none" остаётся невидимой навсегда — класс инлайновый стиль
// не перебивает. Так «Бенчмарки» открывались пустой страницей.
test('вкладки: клик по каждой показывает её секцию и прячет остальные', async (t) => {
  const { window, document } = loadAdminPage(t);
  // jsdom не грузит <link rel="stylesheet">, а видимость секции определяется
  // именно правилом .hidden из admin.css — подставляем настоящий файл инлайном.
  const style = document.createElement('style');
  style.textContent = fs.readFileSync(path.join(ADMIN_DIR, 'admin.css'), 'utf8');
  document.head.appendChild(style);
  // Только верхняя навигация: у карточки игры есть свои вложенные вкладки.
  const tabs = Array.from(document.querySelectorAll('#mainTabs [role="tab"]'));
  assert.ok(tabs.length >= 7);
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
  for (const tab of tabs) {
    tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const secId = tab.getAttribute('aria-controls');
    for (const panel of panels) {
      const visible = window.getComputedStyle(panel).display !== 'none';
      assert.strictEqual(visible, panel.id === secId, `после клика по ${tab.id}: ${panel.id}`);
    }
    assert.strictEqual(tab.getAttribute('aria-selected'), 'true');
  }
  // Переключение запускает загрузчики вкладок (newsList, mtLoad, ...) — их
  // промисы должны отработать до того, как t.after() закроет окно.
  await new Promise(r => setTimeout(r, 0));
});

test('up_cleanup бьёт по /admin/api/upload/cleanup и пишет результат в #out', async (t) => {
  const fetchStub = makeFetchStub([
    { test: (u) => u.includes('/admin/api/upload/cleanup'), respond: () => jsonResponse({ removed: 3 }) },
  ]);
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  const btn = document.getElementById('up_cleanup');
  btn.dispatchEvent(new window.Event('click'));
  // Обработчик асинхронный (await fetch внутри) — дать микротаскам прогнаться.
  await new Promise((res) => setTimeout(res, 0));
  await new Promise((res) => setTimeout(res, 0));
  assert.strictEqual(document.getElementById('out').textContent, 'Удалено: 3');
});

// ---- (d) «Тест параметров загрузки»: план, ход прогона и остановка ----
//
// Здесь проверяется не арифметика (она в upload-bench.test.js), а обвязка,
// из-за которой карточка и выглядела зависшей: план до запуска, строка хода,
// прогресс-бары и остановка. Дефект «408 МБ/с и осталось 0:00» жил ровно тут.

// setBenchFile подкладывает файл в <input type=file>: в jsdom нет DataTransfer,
// а присвоить .files напрямую нельзя — свойство только для чтения.
//
// Размер подменяется, а не выделяется: бенчмарку от файла нужны только
// file.size и file.slice(), а честная аллокация под сценарий «сборка на
// 64 ГБ» — это 64 ГБ памяти в тесте. Первая версия так и делала, и на
// раннере CI прогон растягивался настолько, что фоновый поллинг страницы
// успевал выстрелить уже после её закрытия.
function setBenchFile(window, document, size) {
  const file = new window.File([new Uint8Array(8)], 'bench.zip', { type: 'application/zip' });
  Object.defineProperty(file, 'size', { value: size, configurable: true });
  const input = document.getElementById('bench_zip');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  return file;
}

// benchFetchStub отвечает на init/chunk/abort пробы. onChunk вызывается перед
// ответом — через него тест вмешивается в середину прогона (например, жмёт
// «Остановить»).
function benchFetchStub(chunkSize, onChunk) {
  let uploads = 0;
  return makeFetchStub([
    {
      test: (u) => u.includes('/admin/api/upload/init'),
      respond: (u, init) => {
        uploads++;
        const body = JSON.parse(init.body);
        return jsonResponse({
          uploadId: 'probe-' + uploads,
          chunkSize,
          totalChunks: Math.ceil(body.totalSize / chunkSize),
        });
      },
    },
    {
      test: (u) => u.includes('/admin/api/upload/chunk'),
      respond: () => { if (onChunk) onChunk(); return jsonResponse({}); },
    },
    { test: (u) => u.includes('/admin/api/upload/abort'), respond: () => jsonResponse({ status: 'ok' }) },
  ]);
}

function fillBenchForm(document, opts) {
  setValue(document, 'bench_probe_mb', opts.probe);
  setValue(document, 'bench_chunks_mb', opts.chunks);
  setValue(document, 'bench_concs', opts.concs);
}

test('bench: план прогона считается до запуска и обновляется при правке полей', (t) => {
  const { window, document } = loadAdminPage(t);
  const plan = document.getElementById('bench_plan');

  // Без файла считать нечего — и молчать правильнее, чем показывать ноль.
  fillBenchForm(document, { probe: '4', chunks: '1,2', concs: '2' });
  document.getElementById('bench_chunks_mb').dispatchEvent(new window.Event('input'));
  assert.strictEqual(plan.textContent, '');

  setBenchFile(window, document, 16 * 1024 * 1024);
  document.getElementById('bench_zip').dispatchEvent(new window.Event('change'));
  // 2 комбинации по 4 МБ пробы = 8 МБ.
  assert.match(plan.textContent, /Прогон: 2 комбинаций/);
  assert.match(plan.textContent, /8\.0 МБ/);
  assert.ok(!/text-warning/.test(plan.className), 'восемь мегабайт — не повод пугать');
});

test('bench: тяжёлый прогон помечается предупреждением, а не прячется в цифрах', (t) => {
  const { window, document } = loadAdminPage(t);
  setBenchFile(window, document, 64 * 1024 * 1024 * 1024);
  // 25 комбинаций по 512 МБ — те самые 12,5 ГБ, ради которых план и появился.
  fillBenchForm(document, { probe: '512', chunks: '16,32,64,128,256', concs: '4,8,16,32,64' });
  document.getElementById('bench_zip').dispatchEvent(new window.Event('change'));
  const plan = document.getElementById('bench_plan');
  assert.match(plan.textContent, /Прогон: 25 комбинаций/);
  assert.match(plan.textContent, /это много/);
  assert.match(plan.className, /text-warning/);
});

test('bench: прогон доходит до конца и показывает ход, а не одну строку', async (t) => {
  const chunkSize = 1024 * 1024;
  const fetchStub = benchFetchStub(chunkSize);
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });

  setBenchFile(window, document, 32 * 1024 * 1024);
  fillBenchForm(document, { probe: '4', chunks: '1,2', concs: '2' });

  await window.runUploadBench();

  // Общий прогресс дошёл до конца, а шаговый бар не остался позади.
  // jsdom нормализует значение style.width, поэтому сравниваем по смыслу,
  // а не по строке: '100.0%' у него превращается в '100%'.
  assert.strictEqual(parseFloat(document.getElementById('bench_pb').style.width), 100);
  assert.strictEqual(document.getElementById('bench_pb').textContent, '100%');
  assert.strictEqual(parseFloat(document.getElementById('bench_step_pb').style.width), 100);
  // Статус называет и время, и число проверенных комбинаций.
  assert.match(document.getElementById('bench_status').textContent, /Готово за \d+:\d\d\./);
  assert.match(document.getElementById('bench_status').textContent, /Проверено комбинаций: 2, успешно: 2/);
  // Строка хода после прогона пустеет: комбинация больше не выполняется.
  assert.strictEqual(document.getElementById('bench_step').textContent, '');
  assert.match(document.getElementById('bench_elapsed').textContent, /прошло \d+:\d\d/);

  const rows = [...document.querySelectorAll('#bench_tbody tr')];
  assert.strictEqual(rows.length, 2);
  // Лучшая комбинация предложена к применению.
  assert.notStrictEqual(document.getElementById('bench_apply_wrap').style.display, 'none');
  assert.match(document.getElementById('bench_best').textContent, /поток/);
  // Кнопка остановки видна только во время прогона.
  assert.strictEqual(document.getElementById('bench_stop').style.display, 'none');
});

test('bench: «Остановить» прерывает сетку и оставляет уже снятые замеры', async (t) => {
  const chunkSize = 1024 * 1024;
  let chunks = 0;
  let stopBtn = null;
  let win = null;
  // Жмём «Остановить» в середине второй комбинации.
  const fetchStub = benchFetchStub(chunkSize, () => {
    chunks++;
    if (chunks === 5 && stopBtn) stopBtn.dispatchEvent(new win.Event('click'));
  });
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  win = window;
  stopBtn = document.getElementById('bench_stop');

  setBenchFile(window, document, 64 * 1024 * 1024);
  fillBenchForm(document, { probe: '4', chunks: '1,2,4', concs: '1' });

  await window.runUploadBench();

  const status = document.getElementById('bench_status').textContent;
  assert.match(status, /Остановлено на \d+-й комбинации из 3/);
  assert.match(status, /Потрачено \d+:\d\d/);
  // Первая комбинация успела замериться — её результат не должен пропасть.
  assert.match(status, /Успешных замеров: 1/);
  const rows = [...document.querySelectorAll('#bench_tbody tr')].map((r) => r.textContent);
  assert.ok(rows.some((r) => /остановлено/.test(r)), 'прерванная комбинация помечена: ' + rows.join(' | '));
  assert.ok(rows.length < 3, 'оставшиеся комбинации не запускались: ' + rows.length);
  // Проба прерванного шага всё равно отброшена — иначе на диске остаются гигабайты.
  const aborts = fetchStub.calls.filter((c) => c.url.includes('/upload/abort')).length;
  assert.strictEqual(aborts, rows.length);
  assert.strictEqual(document.getElementById('bench_stop').style.display, 'none');
});

test('bench: без файла и без комбинаций прогон не стартует', async (t) => {
  const fetchStub = benchFetchStub(1024 * 1024);
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });

  const probeCalls = () => fetchStub.calls.filter((c) => c.url.includes('/upload/')).length;
  // Смотрим в журнал, а не в #out: страница на старте сама дёргает несколько
  // ручек, и последняя из них перетирает в #out наше сообщение. В журнале
  // остаётся вся история — ровно ради этого он и появился.
  const journal = () => document.getElementById('journal_log').textContent;

  await window.runUploadBench();
  assert.strictEqual(probeCalls(), 0, 'без файла пробу заливать некуда');
  assert.match(journal(), /Выберите файл/);

  setBenchFile(window, document, 1024 * 1024);
  fillBenchForm(document, { probe: '1', chunks: '', concs: '' });
  await window.runUploadBench();
  assert.strictEqual(probeCalls(), 0);
  assert.match(journal(), /хотя бы один размер чанка/);
});

test('bench: упавшая комбинация не роняет прогон и объясняет причину', async (t) => {
  const chunkSize = 1024 * 1024;
  let inits = 0;
  // Первой комбинации сервер отказывает на init, вторая проходит: сетка из
  // 25 ячеек не должна обрываться из-за одной неудачной, а причина отказа
  // обязана остаться в таблице — иначе строка просто пустая.
  const fetchStub = makeFetchStub([
    {
      test: (u) => u.includes('/admin/api/upload/init'),
      respond: (u, init) => {
        inits++;
        if (inits === 1) return jsonResponse({ error: 'нет места' }, 500);
        const body = JSON.parse(init.body);
        return jsonResponse({
          uploadId: 'probe-' + inits,
          chunkSize,
          totalChunks: Math.ceil(body.totalSize / chunkSize),
        });
      },
    },
    { test: (u) => u.includes('/admin/api/upload/chunk'), respond: () => jsonResponse({}) },
    { test: (u) => u.includes('/admin/api/upload/abort'), respond: () => jsonResponse({ status: 'ok' }) },
  ]);
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });

  setBenchFile(window, document, 32 * 1024 * 1024);
  fillBenchForm(document, { probe: '4', chunks: '1,2', concs: '1' });

  await window.runUploadBench();

  const rows = [...document.querySelectorAll('#bench_tbody tr')];
  assert.strictEqual(rows.length, 2, 'обе комбинации должны попасть в таблицу');
  assert.match(rows[0].textContent, /HTTP 500/, 'причина отказа: ' + rows[0].textContent);
  assert.ok(rows[0].querySelector('.text-danger'), 'ошибка выделена, а не спрятана в общий текст');
  assert.match(document.getElementById('bench_status').textContent, /Проверено комбинаций: 2, успешно: 1/);
  // Успешный замер всё равно можно применить — ради него прогон и продолжали.
  assert.notStrictEqual(document.getElementById('bench_apply_wrap').style.display, 'none');
});

// ---- (e) Иконки действий над ассетами ----
//
// Карандаш и корзина рисовались инлайном в шести местах, копии разошлись, и в
// двух диалогах корзина стала чёрной на тёмной кнопке. Тесты держат ровно то,
// что тогда не сошлось: разметка одна на всех, а цвет не прибит числом.

// Заглушка bootstrap.Modal: диалоги загрузки/вставки без неё отказываются
// открываться (и правильно делают — в браузере это значит, что не загрузилась
// библиотека). Тесту нужна не анимация, а построенный диалогом DOM.
function stubBootstrapModal(window) {
  const shown = [];
  class FakeModal {
    constructor(el) { this.el = el; shown.push(el); }
    show() { this.el.dispatchEvent(new window.Event('shown.bs.modal')); }
    hide() { this.el.dispatchEvent(new window.Event('hidden.bs.modal')); }
    static getInstance() { return null; }
  }
  window.bootstrap = { Modal: FakeModal };
  return shown;
}

test('assetIconBtn: одна разметка, цвет не прибит к иконке', (t) => {
  const { window, document } = loadAdminPage(t);
  let clicked = 0;
  const del = window.assetIconBtn('delete', () => { clicked++; }, 'ms-1');

  assert.strictEqual(del.tagName, 'BUTTON');
  assert.strictEqual(del.type, 'button', 'внутри формы кнопка не должна её отправлять');
  assert.match(del.className, /asset-icon-btn/);
  assert.match(del.className, /ms-1/);
  assert.strictEqual(del.title, 'Удалить');
  assert.strictEqual(del.getAttribute('aria-label'), 'Удалить');
  assert.ok(del.querySelector('svg path'), 'иконка на месте');
  // Ровно то, из-за чего копии разъехались: цвет задаёт CSS, а не атрибут.
  assert.ok(!/fill="#/.test(del.innerHTML), 'цвет не должен быть прибит в разметке: ' + del.innerHTML);
  // Иконка декоративная — подпись уже в aria-label, дублировать её не надо.
  assert.strictEqual(del.querySelector('svg').getAttribute('aria-hidden'), 'true');

  del.dispatchEvent(new window.Event('click'));
  assert.strictEqual(clicked, 1);

  const rn = window.assetIconBtn('rename');
  assert.strictEqual(rn.title, 'Переименовать');
  assert.ok(!/ms-1/.test(rn.className), 'отступ ставится только там, где просили');
  // Обе иконки берутся из одного места и потому не могут разойтись.
  assert.notStrictEqual(rn.innerHTML, del.innerHTML);
  assert.ok(rn.innerHTML.includes('<svg') && del.innerHTML.includes('<svg'));

  assert.strictEqual(window.assetIconBtn('нет такой').innerHTML, '', 'неизвестный вид — пустая кнопка, а не исключение');
  assert.ok(document.body);
});

test('галерея рисует кнопки действий той же функцией', (t) => {
  const { window, document } = loadAdminPage(t);
  window.renderGalleryGrid([
    { name: 'launcher', isDir: true },
    { name: 'cover.png', url: '/news/assets/cover.png' },
    { name: 'ping.txt', url: '/news/assets/ping.txt' },
  ]);
  const grid = document.getElementById('ns_gallery_grid');
  const btns = grid.querySelectorAll('.asset-icon-btn');
  // По паре «переименовать/удалить» на каждый из трёх элементов.
  assert.strictEqual(btns.length, 6);
  for (const b of btns) {
    assert.ok(!/fill="#/.test(b.innerHTML), 'цвет прибит в галерее: ' + b.innerHTML);
  }
  // Не-картинка показывается плашкой с расширением, а не битым <img>.
  // В тексте расширение как есть — в верхний регистр его переводит CSS.
  assert.match(grid.textContent, /txt/i);
  assert.strictEqual(grid.querySelectorAll('img[src$="ping.txt"]').length, 0);
});

test('диалог загрузки с диска рисует те же кнопки, что и галерея', async (t) => {
  const fetchStub = makeFetchStub([
    {
      // Шим admin.js переписывает /admin/... в /admin/api/..., поэтому
      // матчим по хвосту пути, а не по исходному адресу из кода.
      test: (u) => u.includes('/news/assets'),
      respond: () => jsonResponse({
        path: '',
        items: [{ name: 'game-night', isDir: true }, { name: 'cover.png', url: '/news/assets/cover.png' }],
      }),
    },
  ]);
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  stubBootstrapModal(window);

  window.openPickUploadDialog('inline');
  // fetchPickList уходит в сеть — даём микротаскам прогнаться.
  for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));

  const btns = document.querySelectorAll('#pick_grid .asset-icon-btn');
  assert.strictEqual(btns.length, 4, 'по паре кнопок на папку и файл');
  for (const b of btns) {
    // Ровно тот дефект: здесь корзина была чёрной, потому что fill забыли.
    assert.ok(!/fill="#/.test(b.innerHTML), 'цвет прибит в диалоге: ' + b.innerHTML);
    assert.match(b.className, /asset-icon-btn/);
  }
  const titles = [...btns].map((b) => b.title);
  assert.deepStrictEqual(titles, ['Переименовать', 'Удалить', 'Переименовать', 'Удалить']);
});

// ---- Галерея игры живёт во вкладке «Галерея», а не отдельной карточкой ----

test('галерея смонтирована во вкладке карточки игры, заглушки не осталось', (t) => {
  const { document } = loadAdminPage(t);

  const root = document.getElementById('gg_root');
  assert.ok(root, 'корень галереи есть в разметке');
  assert.ok(
    root.closest('#gmpane-gallery'),
    'корень галереи должен лежать внутри вкладки «Галерея», а не отдельной карточкой на странице',
  );
  // Ровно тот дефект: вкладка была заглушкой «Открывается тем же интерфейсом».
  assert.ok(
    !/Открывается тем же интерфейсом/.test(document.getElementById('gmpane-gallery').innerHTML),
    'во вкладке не должно остаться текста-заглушки',
  );
  assert.strictEqual(
    document.querySelectorAll('[id="gg_root"]').length,
    1,
    'разметка галереи не должна дублироваться',
  );
});

// ---- Выход из панели ----

test('кнопка «Выйти» гасит сессию запросом на /auth/logout', async (t) => {
  const calls = [];
  const fetchStub = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return jsonResponse({ status: 'ok' });
  };
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });

  // Скрипты исполняются уже после разбора документа (см. loadAdminPage), так
  // что DOMContentLoaded к этому моменту прошёл и обработчики, навешенные на
  // него, сами не сработают — в браузере они регистрируются до события.
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  const btn = document.getElementById('auth_logout');
  assert.ok(btn, 'кнопка выхода есть в шапке');
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));

  // Ровно тот дефект: эндпоинт был, кнопки к нему не было — выйти из панели
  // можно было только вычистив куки руками.
  const logout = calls.find((c) => c.url.includes('/auth/logout'));
  assert.ok(logout, 'выход должен дёрнуть /admin/api/auth/logout');
  assert.strictEqual(logout.method, 'POST', 'logout принимает только POST');
  // Уход на форму входа проверить в jsdom нечем (location не подменяется, а
  // навигация не реализована), но повторный клик по уже нажатой кнопке не
  // должен слать второй запрос.
  assert.strictEqual(btn.disabled, true, 'кнопка блокируется на время выхода');
});

// ---- Подтверждение опасных действий ----

// У трёх самых разрушительных действий админки (удалить версию, очистить
// обращения, удалить метрики) подтверждение требовало НАПЕЧАТАТЬ номер версии
// или слово «удалить». Барьер защищал плохо (администратор здесь один, а номер
// версии — прямо на экране), зато превращал рутинную чистку старых версий в
// перепечатывание строк, у каждого действия своих.
//
// Теперь подтверждение — обычный экран, который перечисляет последствия. Тест
// сторожит именно это: пользователя ни о чём не спрашивают текстом, а
// последствия до него доезжают.
test('askConfirm: подтверждение без ввода текста, с перечислением последствий', async (t) => {
  const { window } = loadAdminPage(t);

  // bootstrap в jsdom нет (CDN-тег вырезан в loadAdminPage), поэтому askConfirm
  // идёт запасным путём через window.confirm — тот же текст, без оформления.
  let shown = null;
  window.confirm = (text) => { shown = text; return true; };
  window.prompt = () => { throw new Error('askConfirm не имеет права спрашивать текст'); };

  const ok = await window.askConfirm({
    title: 'Удалить версию 1.2.3?',
    body: 'Версия 1.2.3 исчезнет с сервера.',
    bullets: ['Файлы сборки удаляются безвозвратно.', 'Вернуть можно только повторной заливкой.'],
    okText: 'Удалить версию',
    danger: true,
  });

  assert.strictEqual(ok, true, 'подтверждение возвращает решение пользователя');
  assert.match(shown, /Удалить версию 1\.2\.3\?/, 'в тексте есть заголовок');
  assert.match(shown, /Файлы сборки удаляются безвозвратно\./, 'первое последствие показано');
  assert.match(shown, /Вернуть можно только повторной заливкой\./, 'второе последствие показано');
});

test('askConfirm: отказ пользователя возвращает false и ничего не запускает', async (t) => {
  const { window } = loadAdminPage(t);
  window.confirm = () => false;
  window.prompt = () => { throw new Error('askConfirm не имеет права спрашивать текст'); };

  const ok = await window.askConfirm({ title: 'Удалить всё?', body: 'Восстановить неоткуда.', danger: true });
  assert.strictEqual(ok, false);
});

// ---- Модальное подтверждение (путь с bootstrap) ----

// В jsdom bootstrap нет (CDN-тег вырезан), поэтому askConfirm по умолчанию
// уходит в запасной confirm. Настоящий путь — модалка — до сих пор не
// исполнялся ни разу: именно в нём живут и красная кнопка, и экранирование
// текста, и список последствий. Подменяем ровно тот кусок API bootstrap,
// который askConfirm использует: конструктор Modal, show/hide и события
// shown/hidden.
function installFakeBootstrap(window) {
  const shown = [];
  class Modal {
    constructor(el) { this.el = el; shown.push(el); }
    show() { this.el.dispatchEvent(new window.Event('shown.bs.modal')); }
    hide() { this.el.dispatchEvent(new window.Event('hidden.bs.modal')); }
  }
  window.bootstrap = { Modal };
  return shown;
}

test('askConfirm (модалка): последствия списком, красная кнопка, никакого поля ввода', async (t) => {
  const { window, document } = loadAdminPage(t);
  const opened = installFakeBootstrap(window);

  const answer = window.askConfirm({
    title: 'Удалить версию 1.2.3?',
    body: 'Версия 1.2.3 исчезнет с сервера.',
    bullets: ['Файлы сборки удаляются безвозвратно.', 'Вернуть можно только повторной заливкой.'],
    okText: 'Удалить версию',
    danger: true,
  });

  // Именно последняя добавленная: в admin.html есть и свои .modal, поэтому
  // querySelector('.modal') нашёл бы чужую разметку.
  const modal = opened[opened.length - 1];
  assert.ok(document.body.contains(modal), 'модалка добавлена в документ');

  // Главное требование правки: подтверждают кнопкой, а не перепечатыванием
  // номера версии.
  assert.strictEqual(modal.querySelector('input'), null, 'в диалоге не должно быть поля ввода');

  const items = [...modal.querySelectorAll('li')].map((li) => li.textContent);
  assert.deepStrictEqual(items, [
    'Файлы сборки удаляются безвозвратно.',
    'Вернуть можно только повторной заливкой.',
  ], 'каждое последствие — отдельным пунктом');

  const ok = modal.querySelector('#__ask_ok');
  assert.ok(ok.className.includes('btn-danger'), 'опасное действие красное');
  assert.strictEqual(ok.disabled, false, 'кнопка сразу активна: ждать нечего');

  ok.dispatchEvent(new window.Event('click'));
  assert.strictEqual(await answer, true, 'нажатие на кнопку подтверждает действие');
  assert.strictEqual(document.body.contains(modal), false, 'модалка убирается из документа');
});

test('askConfirm (модалка): закрытие без нажатия — это отказ, разметка экранируется', async (t) => {
  const { window, document } = loadAdminPage(t);
  const opened = installFakeBootstrap(window);

  const answer = window.askConfirm({
    title: '<img src=x onerror=alert(1)>',
    body: 'Папка «<b>logs</b>» будет удалена.',
    bullets: ['<script>alert(2)</script>'],
    okText: 'Удалить',
    danger: true,
  });

  const modal = opened[opened.length - 1];
  assert.ok(document.body.contains(modal));
  assert.strictEqual(modal.querySelector('img'), null, 'разметка из заголовка не должна исполняться');
  assert.strictEqual(modal.querySelector('script'), null, 'разметка из списка последствий — тоже');
  assert.match(modal.querySelector('.modal-title').textContent, /<img src=x onerror=alert\(1\)>/);

  // Крестик и «Отмена» в настоящем bootstrap закрывают модалку сами
  // (data-bs-dismiss), поэтому отказ приходит событием hidden, а не кликом.
  modal.dispatchEvent(new window.Event('hidden.bs.modal'));
  assert.strictEqual(await answer, false, 'закрытая без подтверждения модалка = отказ');
});

// ---- Удаление версии игры ----

test('удаление версии: подтверждение, POST на /admin/deleteVersion и обновление вида', async (t) => {
  const calls = [];
  const fetchStub = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return jsonResponse({ status: 'ok' });
  };
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  const opened = installFakeBootstrap(window);

  const root = document.createElement('div');
  root.innerHTML = '<button class="vr-delete" data-ver="1.4.2">Удалить</button>';
  document.body.appendChild(root);

  let refreshed = 0;
  window.bindVersionActions(root, 'vr', 'lethal-company', async () => { refreshed++; });

  root.querySelector('.vr-delete').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 0));

  const modal = opened[opened.length - 1];
  assert.match(modal.querySelector('.modal-title').textContent, /Удалить версию 1\.4\.2\?/);
  assert.ok(
    [...modal.querySelectorAll('li')].some((li) => /повторной заливкой/.test(li.textContent)),
    'администратору сказано, чем это отменяется',
  );

  modal.querySelector('#__ask_ok').dispatchEvent(new window.Event('click'));
  for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));

  // Путь с /admin/api — admin.js разворачивает относительные адреса сам.
  const del = calls.find((c) => c.url.includes('deleteVersion'));
  assert.ok(del, 'удаление уходит на сервер');
  assert.strictEqual(del.method, 'POST');
  assert.match(del.url, /gameId=lethal-company/);
  assert.match(del.url, /version=1\.4\.2/);
  assert.strictEqual(refreshed, 1, 'список версий перечитывается после удаления');
});

test('удаление версии: отказ в диалоге не шлёт ни одного запроса', async (t) => {
  const calls = [];
  const fetchStub = async (url) => { calls.push(String(url)); return jsonResponse({}); };
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  const opened = installFakeBootstrap(window);

  const root = document.createElement('div');
  root.innerHTML = '<button class="vr-delete" data-ver="1.4.2">Удалить</button>';
  document.body.appendChild(root);
  window.bindVersionActions(root, 'vr', 'lethal-company', async () => {});

  root.querySelector('.vr-delete').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 0));
  opened[opened.length - 1].dispatchEvent(new window.Event('hidden.bs.modal'));
  for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));

  assert.strictEqual(calls.filter((u) => u.includes('deleteVersion')).length, 0);
});

// ---- Остальные удаления: обращения, метрики, игра целиком, галерея ----

test('очистка обращений: диалог перечисляет последствия и шлёт POST', async (t) => {
  const calls = [];
  const fetchStub = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    if (String(url).includes('/feedback/list')) return jsonResponse({ items: [] });
    return jsonResponse({ status: 'ok' });
  };
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  const opened = installFakeBootstrap(window);

  // Кнопки вкладки обращений привязываются на DOMContentLoaded, а он к моменту
  // исполнения скриптов уже прошёл (см. loadAdminPage).
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  document.getElementById('fb_clear').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 0));

  const modal = opened[opened.length - 1];
  assert.match(modal.querySelector('.modal-title').textContent, /Удалить все обращения\?/);
  assert.strictEqual(modal.querySelector('input'), null, 'подтверждение без ввода текста');
  assert.ok(
    [...modal.querySelectorAll('li')].some((li) => /восстановить обращения неоткуда/i.test(li.textContent)),
    'сказано, что копии нет',
  );

  modal.querySelector('#__ask_ok').dispatchEvent(new window.Event('click'));
  for (let i = 0; i < 6; i++) await new Promise((res) => setTimeout(res, 0));
  const clear = calls.find((c) => c.url.includes('/feedback/clear'));
  assert.ok(clear && clear.method === 'POST', 'очистка уходит POST-ом');
});

test('очистка метрик: диалог перечисляет последствия и шлёт POST', async (t) => {
  const calls = [];
  const fetchStub = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return jsonResponse({ events: [], items: [] });
  };
  const { window } = loadAdminPage(t, { fetchImpl: fetchStub });
  const opened = installFakeBootstrap(window);

  const done = window.mxClear();
  await new Promise((res) => setTimeout(res, 0));

  const modal = opened[opened.length - 1];
  assert.match(modal.querySelector('.modal-title').textContent, /Удалить все метрики\?/);
  assert.strictEqual(modal.querySelector('input'), null, 'подтверждение без ввода текста');
  assert.ok(
    [...modal.querySelectorAll('li')].some((li) => /историю неоткуда/i.test(li.textContent)),
    'сказано, что историю не вернуть',
  );

  modal.querySelector('#__ask_ok').dispatchEvent(new window.Event('click'));
  await done;
  const clear = calls.find((c) => c.url.includes('/metrics/clear'));
  assert.ok(clear && clear.method === 'POST', 'очистка метрик уходит POST-ом');
});

test('метрики: время в играх рисует тайлы, дни и таблицу по играм', async (t) => {
  const summary = {
    from: '2026-08-01T00:00:00Z',
    to: '2026-08-02T00:00:00Z',
    totals: {
      events: 5, gameSessions: 5, playtimeMs: 15000,
      avgSessionMs: 3000, medianSessionMs: 3000, uniquePlayers: 2,
    },
    byDay: [
      { date: '2026-08-01', sessions: 5, playtimeMs: 15000 },
    ],
    byGame: [
      {
        gameId: 'g1', installs: 0, updates: 0, errors: 0, bytes: 0,
        sessions: 3, playtimeMs: 9000, avgSessionMs: 3000, medianSessionMs: 3000, uniquePlayers: 2,
      },
    ],
    topErrors: [], appVersions: [], os: [],
  };
  const fetchStub = makeFetchStub([
    { test: (u) => u.includes('/metrics/summary'), respond: () => jsonResponse(summary) },
  ]);
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  // jsdom не реализует ResizeObserver; в браузере он есть всегда, и
  // mxRenderChart/mxRenderPtChart полагаются на него без проверки.
  window.ResizeObserver = class { observe() {} disconnect() {} };

  await window.mxLoad();

  const totalsText = document.getElementById('mx_pt_totals').textContent;
  assert.match(totalsText, /Уникальных игроков/);
  assert.match(totalsText, /2/, 'значение uniquePlayers попало в тайл');

  const daysRow = document.getElementById('mx_pt_days_body').textContent;
  assert.match(daysRow, /2026-08-01/);

  const gamesRow = document.getElementById('mx_games_body').textContent;
  assert.match(gamesRow, /g1/);

  // Хост графика не пуст — drawMultiLineChart отработал без исключений на
  // тестовых данных, а не молчаливо оставил заглушку «нечего рисовать».
  assert.ok(document.getElementById('mx_pt_chart_host').querySelector('canvas'));
});

// Ради этой пары чисел лаунчер и написан: «скачано 500 Б» само по себе не
// значит ничего, смысл появляется только рядом с полным весом сборки. Поля
// приходили с клиента давно, а сводка их выбрасывала — панель показывала
// голое «Скачано» и ни слова о том, сколько качать НЕ пришлось.
test('метрики: сводка показывает сэкономленный трафик и проверки целостности', async (t) => {
  const summary = {
    from: '2026-08-01T00:00:00Z',
    to: '2026-08-02T00:00:00Z',
    totals: {
      events: 4, launcherStarts: 1, installs: 1, installOk: 1, installFail: 0,
      updates: 1, updateOk: 1, updateFail: 0, gameLaunches: 0, errors: 0,
      uniqueInstalls: 1, bytesDownloaded: 500, fullBytes: 5000,
      filesDownloaded: 5, filesTotal: 100,
      avgInstallMs: 1000, avgUpdateMs: 500,
      integrityChecks: 3, integrityFailed: 2, hashMismatches: 4,
    },
    byDay: [{ date: '2026-08-01', launcherStarts: 1, installs: 1, updates: 1, gameLaunches: 0, errors: 0 }],
    byGame: [
      {
        gameId: 'g1', installs: 1, updates: 1, errors: 0, bytes: 500, fullBytes: 5000,
        integrityChecks: 3, integrityFailed: 2, hashMismatches: 4,
        sessions: 0, playtimeMs: 0, avgSessionMs: 0, medianSessionMs: 0, uniquePlayers: 0,
      },
    ],
    topErrors: [], appVersions: [], os: [],
  };
  const fetchStub = makeFetchStub([
    { test: (u) => u.includes('/metrics/summary'), respond: () => jsonResponse(summary) },
  ]);
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  window.ResizeObserver = class { observe() {} disconnect() {} };

  await window.mxLoad();

  const totalsText = document.getElementById('mx_totals').textContent;
  // 500 из 5000 — девять десятых сборки качать не пришлось.
  assert.match(totalsText, /вместо/, 'под «Скачано» назван полный вес сборки');
  assert.match(totalsText, /90,0 %/, 'доля сэкономленного посчитана');

  // Проверку целостности запускает сам пользователь, когда игра уже ведёт
  // себя странно: голое число проверок ничего не стоит без числа расхождений.
  assert.match(totalsText, /Проверок целостности/);
  assert.match(totalsText, /с расхождением 2/);
  assert.match(totalsText, /файлов не сошлось 4/);

  const gamesRow = document.getElementById('mx_games_body').textContent;
  assert.match(gamesRow, /g1/);
});

test('метрики: время в играх без сессий не рисует график, тайлы — прочерки', async (t) => {
  const summary = {
    from: '2026-08-01T00:00:00Z',
    to: '2026-08-02T00:00:00Z',
    totals: { events: 0, gameSessions: 0, playtimeMs: 0, avgSessionMs: 0, medianSessionMs: 0, uniquePlayers: 0 },
    byDay: [], byGame: [], topErrors: [], appVersions: [], os: [],
  };
  const fetchStub = makeFetchStub([
    { test: (u) => u.includes('/metrics/summary'), respond: () => jsonResponse(summary) },
  ]);
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  window.ResizeObserver = class { observe() {} disconnect() {} };

  await window.mxLoad();

  assert.strictEqual(document.getElementById('mx_pt_chart_host').querySelector('canvas'), null);
  assert.match(document.getElementById('mx_pt_totals').textContent, /—/, 'нулевые метрики показаны прочерком');
});

test('удаление игры целиком: предупреждение про всех пользователей и POST на purge', async (t) => {
  const calls = [];
  const fetchStub = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
    if (String(url).includes('/admin/games')) return jsonResponse({ games: [] });
    return jsonResponse({ status: 'ok' });
  };
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  const opened = installFakeBootstrap(window);

  // Обработчики «Опасной зоны» вешаются на DOMContentLoaded (скрипты здесь
  // исполняются уже после разбора документа — см. loadAdminPage).
  document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  setValue(document, 'gid', 'lethal-company');

  document.getElementById('gm_dz_delete').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 0));

  const modal = opened[opened.length - 1];
  assert.match(modal.querySelector('.modal-title').textContent, /Удалить игру «lethal-company» и все версии\?/);
  assert.strictEqual(modal.querySelector('input'), null, 'подтверждение без ввода текста');
  const bullets = [...modal.querySelectorAll('li')].map((li) => li.textContent).join(' | ');
  assert.match(bullets, /пропадает у всех пользователей/i, 'сказано, что игра исчезнет у всех');
  assert.match(bullets, /Отменить нельзя/i, 'сказано, что отменить нельзя');

  modal.querySelector('#__ask_ok').dispatchEvent(new window.Event('click'));
  for (let i = 0; i < 6; i++) await new Promise((res) => setTimeout(res, 0));
  // Путь с /admin/api — admin.js разворачивает относительные адреса сам.
  const purge = calls.find((c) => c.url.includes('games/purge'));
  assert.ok(purge, 'удаление игры уходит на сервер');
  assert.strictEqual(purge.method, 'POST');
  assert.match(String(purge.body), /gameId=lethal-company/);
});

test('галерея игры: удаление файла и папки предупреждает о битых ссылках', async (t) => {
  const calls = [];
  const fetchStub = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
    if (String(url).includes('/games/gallery/meta')) return jsonResponse({ items: [], cover: '' });
    if (String(url).includes('/games/gallery?')) {
      return jsonResponse({ path: '', items: [{ name: 'screens', isDir: true }, { name: 'cover.png', isDir: false, size: 10, url: '/x.png' }] });
    }
    return jsonResponse({ status: 'ok' });
  };
  const { window, document } = loadAdminPage(t, { fetchImpl: fetchStub });
  const opened = installFakeBootstrap(window);

  const gallery = window.createGameGallery({ root: '#gg_root', gameId: 'lethal-company' });
  assert.ok(gallery, 'галерея монтируется в разметку админки');
  await gallery.fetchAndRender();
  for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));

  const deleteButtons = [...document.querySelectorAll('#gg_root [aria-label="Удалить"]')];
  assert.strictEqual(deleteButtons.length, 2, 'кнопка удаления есть и у папки, и у файла');

  // Папка идёт первой: у неё предупреждение про ссылки в карточке и новостях.
  deleteButtons[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 0));
  let modal = opened[opened.length - 1];
  assert.match(modal.querySelector('.modal-title').textContent, /Удалить папку\?/);
  assert.match(
    [...modal.querySelectorAll('li')].map((li) => li.textContent).join(' | '),
    /в карточке игры и в новостях/i,
  );
  modal.querySelector('#__ask_ok').dispatchEvent(new window.Event('click'));
  for (let i = 0; i < 6; i++) await new Promise((res) => setTimeout(res, 0));

  const del = calls.find((c) => c.url.includes('/games/gallery/delete'));
  assert.ok(del && del.method === 'POST', 'удаление папки уходит POST-ом');
  assert.match(String(del.body), /name=screens/);

  // И то же самое для файла.
  const fileBtn = [...document.querySelectorAll('#gg_root [aria-label="Удалить"]')].pop();
  fileBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 0));
  modal = opened[opened.length - 1];
  assert.match(modal.querySelector('.modal-title').textContent, /Удалить файл\?/);
  modal.querySelector('#__ask_ok').dispatchEvent(new window.Event('click'));
  for (let i = 0; i < 6; i++) await new Promise((res) => setTimeout(res, 0));

  const fileDel = calls.filter((c) => c.url.includes('/games/gallery/delete')).pop();
  assert.match(String(fileDel.body), /name=cover\.png/);
});

// ---- Добавление игры из карточки «Игры» (mgmAddRow) ----

test('mgmAddRow: запрашивает id и добавляет строку в #mgm-table', (t) => {
  const { window, document } = loadAdminPage(t);
  window.prompt = () => 'new-game';

  window.mgmAddRow();

  const rows = document.querySelectorAll('#mgm-table tbody tr');
  assert.strictEqual(rows.length, 1, 'строка добавлена');
  const gidInput = rows[0].querySelectorAll('td')[0].querySelector('input');
  assert.strictEqual(gidInput.value, 'new-game');
});

test('mgmAddRow: пустой ввод в prompt ничего не добавляет', (t) => {
  const { window, document } = loadAdminPage(t);

  window.prompt = () => '';
  window.mgmAddRow();
  assert.strictEqual(document.querySelectorAll('#mgm-table tbody tr').length, 0, 'пустая строка не добавляется');

  window.prompt = () => null;
  window.mgmAddRow();
  assert.strictEqual(document.querySelectorAll('#mgm-table tbody tr').length, 0, 'отмена prompt тоже ничего не добавляет');

  window.prompt = () => '   ';
  window.mgmAddRow();
  assert.strictEqual(document.querySelectorAll('#mgm-table tbody tr').length, 0, 'один пробел — тоже пустой ввод');
});

test('mgmAddRow: отклоняет дубликат gameId и предупреждает через notify', (t) => {
  const { window, document } = loadAdminPage(t);
  window.prompt = () => 'lethal-company';
  window.mgmAddRow();
  assert.strictEqual(document.querySelectorAll('#mgm-table tbody tr').length, 1);

  const notified = [];
  window.notify = (msg) => notified.push(msg);
  // Дубликат сравнивается без учёта регистра — та же строка входит в тот же
  // registry-файл, что и оригинал, поэтому регистр не должен обманывать проверку.
  window.prompt = () => 'Lethal-Company';
  window.mgmAddRow();

  assert.strictEqual(document.querySelectorAll('#mgm-table tbody tr').length, 1, 'вторая строка не добавлена');
  assert.strictEqual(notified.length, 1, 'notify вызван ровно один раз');
  assert.match(notified[0], /lethal-company/i);
  assert.match(notified[0], /уже есть/);
});
