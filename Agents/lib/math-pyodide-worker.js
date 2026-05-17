// math-pyodide-worker.js
// Запускает Pyodide в отдельном Web Worker'е (фоновый поток браузера).
// Главное преимущество перед inline-Pyodide: при бесконечном цикле или
// очень долгой задаче главный поток MOGUT её прервать через
// worker.terminate() — поток просто убивается, и можно создать новый.
//
// Протокол сообщений (main thread → worker):
//   { type: 'init', pyodideUrl: string, indexURL: string }
//     — однократная инициализация. После завершения шлёт обратно {type:'ready'}
//   { type: 'run', id: number, code: string }
//     — исполнить Python. Возвращает {type:'result', id, ok, output, lines, error}
//
// Worker → main thread:
//   { type: 'ready' }
//     — Pyodide загружен, готов к работе
//   { type: 'result', id, ok: bool, output: string, lines: string[], error: string }
//     — результат исполнения. ok=false если был exception в Python
//   { type: 'error', id?: number, error: string }
//     — внутренняя ошибка worker'а (init failed, postMessage bug и т.п.)

let pyodide = null;
let isReady = false;

self.onmessage = async function (e) {
    const msg = e.data;

    if (msg.type === 'init') {
        try {
            // importScripts грузит pyodide.js в worker (worker не имеет document
            // для добавления <script>, поэтому DOM-подход не подходит).
            importScripts(msg.pyodideUrl);
            pyodide = await loadPyodide({ indexURL: msg.indexURL });
            isReady = true;
            self.postMessage({ type: 'ready' });
        } catch (err) {
            self.postMessage({
                type: 'error',
                error: 'Pyodide init failed: ' + (err && err.message ? err.message : String(err))
            });
        }
        return;
    }

    if (msg.type === 'run') {
        if (!isReady) {
            self.postMessage({
                type: 'result',
                id: msg.id,
                ok: false,
                output: '',
                lines: [],
                error: 'Worker not initialized'
            });
            return;
        }

        const code = msg.code;
        const outputs = [];
        const stderr = [];

        // setStdout/setStderr — глобальные хэндлеры на инстансе Pyodide.
        // В worker'е этот инстанс единственный, и так как мы обрабатываем
        // run-сообщения СТРОГО ПО ОДНОМУ (main thread следит за этим
        // через mutex), гонок stdout быть не может.
        pyodide.setStdout({ batched: function (s) { outputs.push(s); } });
        pyodide.setStderr({ batched: function (s) { stderr.push(s); } });

        try {
            // loadPackagesFromImports попытается подтянуть упомянутые в коде
            // не-stdlib пакеты (sympy/numpy/scipy). На Варианте A их в бандле
            // нет — упадёт. Безопасно игнорируем: если пакета нет, runPythonAsync
            // сам выдаст ModuleNotFoundError ниже, которую и поймаем.
            try { await pyodide.loadPackagesFromImports(code); } catch (_) {}
            await pyodide.runPythonAsync(code);
            self.postMessage({
                type: 'result',
                id: msg.id,
                ok: true,
                output: outputs.join('\n'),
                lines: outputs,
                error: ''
            });
        } catch (err) {
            let errText = String(err && err.message ? err.message : err);
            if (stderr.length) errText = stderr.join('\n') + '\n' + errText;
            self.postMessage({
                type: 'result',
                id: msg.id,
                ok: false,
                output: outputs.join('\n'),
                lines: outputs,
                error: errText
            });
        }
    }
};
