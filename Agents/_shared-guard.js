// GigaChat shared-guard
// Подключается ДО _shared.js. Если _shared.js не выполнился до конца
// (битый кеш в Yandex/старый Chromium/network truncation),
// пользователь увидит friendly "Перезагрузите" вместо TypeError'а.
//
// Когда _shared.js успешно отрабатывает — он перезаписывает window.GigaChat
// целиком, наш stub пропадает. Когда падает раньше времени — stub остаётся,
// и любой вызов GigaChat.auth.requireAuth() показывает понятный экран.
(function () {
    if (!window.GigaChat) window.GigaChat = {};
    if (!window.GigaChat.auth) window.GigaChat.auth = {};
    if (!window.GigaChat.auth.requireAuth) {
        window.GigaChat.auth.requireAuth = function () {
            try { document.documentElement.classList.remove('gc-pending-auth'); } catch (e) {}
            var html =
                '<div style="padding:60px 40px;max-width:520px;margin:80px auto;' +
                'text-align:center;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;' +
                'color:#2a2a28;background:#faf9f5;border-radius:12px;' +
                'box-shadow:0 4px 24px rgba(0,0,0,0.08)">' +
                '<h2 style="margin:0 0 16px;font-size:22px">GigaChat не загрузился</h2>' +
                '<p style="margin:0 0 24px;color:#666;line-height:1.5">' +
                'Скрипт <code style="background:#eee;padding:2px 6px;border-radius:3px">_shared.js</code> ' +
                'не выполнился до конца. Скорее всего виноват кеш браузера.</p>' +
                '<button onclick="location.reload(true)" ' +
                'style="padding:12px 28px;background:#d97757;color:#fff;border:0;' +
                'border-radius:8px;cursor:pointer;font-size:14px;font-weight:500">' +
                'Перезагрузить страницу</button>' +
                '<p style="margin:20px 0 0;color:#999;font-size:12px">' +
                'Если не помогло — нажмите Ctrl+F5 (жёсткое обновление с очисткой кеша).</p>' +
                '</div>';
            try {
                document.body.style.background = '#f4f1e8';
                document.body.innerHTML = html;
            } catch (e) {
                // body ещё не готов — запишем когда DOMContentLoaded
                document.addEventListener('DOMContentLoaded', function () {
                    document.body.style.background = '#f4f1e8';
                    document.body.innerHTML = html;
                });
            }
        };
    }
})();
