// pyodide-client.js
// Main-thread обёртка для math-pyodide-worker.js. Экспортирует:
//
//   window.PyodideClient.executePython(code, opts?) → Promise<{
//       ok, output, lines, error, killed
//   }>
//   window.PyodideClient.terminate() — убить worker (для тестов / ручного сброса)
//   window.PyodideClient.isAlive() — true если worker инициализирован
//
// Зачем worker (а не inline Pyodide):
//   Pyodide однопоточный WASM. Если LLM написал while True или
//   очень тяжёлый sympy — runPythonAsync НЕ ВЕРНЁТСЯ. В inline-варианте
//   главный поток замораживается, кнопка отмены не работает, единственный
//   выход — релоад страницы.
//   В worker'е зависание ограничено самим worker'ом — главный поток
//   свободен. По таймауту делаем worker.terminate() (мгновенно убивает
//   фоновый поток), создаём новый worker → следующий запрос работает
//   через 1-2 сек (повторная инициализация Pyodide).
//
// Конфигурация (через window.GIGACHAT_CONFIG):
//   PYODIDE_URL — путь к pyodide.js (default lib/pyodide/pyodide.js)
//   PYODIDE_INDEX_URL — папка с бандлом (default lib/pyodide/)
//   PYODIDE_TIMEOUT_MS — таймаут на один runPythonAsync (default 15000)
//   PYODIDE_WORKER_URL — путь к worker-скрипту (default lib/math-pyodide-worker.js)

(function (global) {
    var cfg = global.GIGACHAT_CONFIG || {};
    var PYODIDE_DEFAULT_VERSION = 'v0.26.4';
    var PYODIDE_URL = cfg.PYODIDE_URL ||
        'https://cdn.jsdelivr.net/pyodide/' + PYODIDE_DEFAULT_VERSION + '/full/pyodide.js';
    var PYODIDE_INDEX_URL = cfg.PYODIDE_INDEX_URL ||
        'https://cdn.jsdelivr.net/pyodide/' + PYODIDE_DEFAULT_VERSION + '/full/';
    var PYODIDE_TIMEOUT_MS = cfg.PYODIDE_TIMEOUT_MS || 15000;
    var WORKER_URL = cfg.PYODIDE_WORKER_URL || 'lib/math-pyodide-worker.js';

    // Текущий worker. null до первого запроса или после terminate.
    var worker = null;
    // True когда worker получил инициализацию и готов принимать run-сообщения.
    var workerReady = false;
    // Очередь resolvers ожидающих готовности worker'а.
    var readyResolvers = [];
    // Текущий выполняющийся запрос. Worker обрабатывает по одному за раз —
    // setStdout/setStderr глобальны на инстанс, и параллельные run смешивали
    // бы вывод. Mutex на main-thread'е гарантирует sequential.
    var pendingRun = null;
    // Очередь запросов, ожидающих своей очереди.
    var runQueue = [];
    var nextRequestId = 1;

    function absUrl(u) {
        if (/^https?:\/\//.test(u)) return u;
        return new URL(u, location.href).href;
    }

    function createWorker() {
        workerReady = false;
        var w = new Worker(absUrl(WORKER_URL));
        w.onmessage = function (e) {
            var d = e.data || {};
            if (d.type === 'ready') {
                workerReady = true;
                var resolvers = readyResolvers.slice();
                readyResolvers = [];
                for (var i = 0; i < resolvers.length; i++) resolvers[i]();
                return;
            }
            if (d.type === 'result') {
                if (pendingRun && pendingRun.id === d.id) {
                    clearTimeout(pendingRun.timeoutId);
                    var resolve = pendingRun.resolve;
                    pendingRun = null;
                    resolve({
                        ok: d.ok, output: d.output, lines: d.lines,
                        error: d.error, killed: false
                    });
                    processQueue();
                }
                return;
            }
            if (d.type === 'error') {
                // Внутренняя ошибка worker'а (init failed, или unhandled).
                // Если есть pending run — фейлим его. Если нет — это init-фейл,
                // фейлим всех ждущих ready.
                if (pendingRun && pendingRun.id === d.id) {
                    clearTimeout(pendingRun.timeoutId);
                    var r = pendingRun.resolve;
                    pendingRun = null;
                    r({ ok: false, output: '', lines: [], error: d.error, killed: false });
                    processQueue();
                } else {
                    // Init failure — отвергаем всех ожидающих, помечаем worker
                    // как мёртвый чтобы при следующем executePython создался новый.
                    var initError = d.error || 'Worker error';
                    var resolvers = readyResolvers.slice();
                    readyResolvers = [];
                    terminate();
                    for (var i = 0; i < resolvers.length; i++) {
                        // ready-resolver не имеет reject — он только сигнал.
                        // Реальный фейл уйдёт следующему executePython через
                        // catch в ensureReady (которое не сработает потому что
                        // воркер null'итcя). Чтобы не зависнуть — резолвим всех
                        // (executePython увидит что worker всё ещё null или
                        // ensureReady вернёт новую попытку).
                        resolvers[i]();
                    }
                    // Уведомим пользователя через консоль для диагностики
                    if (global.console && global.console.error) {
                        global.console.error('Pyodide worker init failed:', initError);
                    }
                }
            }
        };
        w.onerror = function (err) {
            if (global.console && global.console.error) {
                global.console.error('Pyodide worker crashed:', err.message || err);
            }
            if (pendingRun) {
                clearTimeout(pendingRun.timeoutId);
                var r = pendingRun.resolve;
                pendingRun = null;
                r({
                    ok: false, output: '', lines: [],
                    error: 'Worker crashed: ' + (err.message || 'unknown'),
                    killed: true
                });
            }
            terminate();
            processQueue();
        };
        w.postMessage({
            type: 'init',
            pyodideUrl: absUrl(PYODIDE_URL),
            indexURL: absUrl(PYODIDE_INDEX_URL)
        });
        return w;
    }

    function ensureReady() {
        if (!worker) worker = createWorker();
        if (workerReady) return Promise.resolve();
        return new Promise(function (resolve) {
            readyResolvers.push(resolve);
        });
    }

    function processQueue() {
        if (pendingRun || runQueue.length === 0) return;
        var req = runQueue.shift();
        runOne(req);
    }

    function runOne(req) {
        ensureReady().then(function () {
            if (!worker) {
                // Init упал — создали новый, но он тоже мог упасть. Прерываем
                // чтобы не зависнуть.
                req.resolve({
                    ok: false, output: '', lines: [],
                    error: 'Pyodide worker не инициализировался. Проверьте Agents/lib/pyodide/ и Console на ошибки.',
                    killed: false
                });
                processQueue();
                return;
            }
            var id = nextRequestId++;
            var timeoutMs = req.timeoutMs || PYODIDE_TIMEOUT_MS;
            var timeoutId = setTimeout(function () {
                if (pendingRun && pendingRun.id === id) {
                    var resolve = pendingRun.resolve;
                    pendingRun = null;
                    // Убиваем застрявший worker — главное преимущество Worker
                    // подхода над inline-Pyodide. Следующий executePython
                    // спавнит новый worker (init ~1-2 сек), всё снова работает.
                    terminate();
                    resolve({
                        ok: false, output: '', lines: [],
                        error: 'Python timeout (' + Math.round(timeoutMs / 1000) + ' сек) — задача убита, можно отправить новый запрос',
                        killed: true
                    });
                    processQueue();
                }
            }, timeoutMs);
            pendingRun = { id: id, resolve: req.resolve, timeoutId: timeoutId };
            worker.postMessage({ type: 'run', id: id, code: req.code });
        }).catch(function (err) {
            req.resolve({
                ok: false, output: '', lines: [],
                error: 'ensureReady failed: ' + (err && err.message ? err.message : String(err)),
                killed: false
            });
            processQueue();
        });
    }

    function executePython(code, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            runQueue.push({ code: code, resolve: resolve, timeoutMs: opts.timeoutMs });
            processQueue();
        });
    }

    function terminate() {
        if (worker) {
            try { worker.terminate(); } catch (_) {}
            worker = null;
        }
        workerReady = false;
    }

    function isAlive() {
        return worker !== null && workerReady;
    }

    global.PyodideClient = {
        executePython: executePython,
        terminate: terminate,
        isAlive: isAlive
    };
})(window);
