# GigaChat Plane — интеграция

Эта папка — **точка входа** для всего что связано с интеграцией Plane в GigaChat. Сами файлы интеграции живут в своих рабочих местах (иначе ломаются скрипты и ссылка из дашборда), но индекс ниже даёт прямой путь к каждому.

## Что входит в интеграцию

| Что | Где лежит в репо | Размер | Назначение |
|---|---|---|---|
| **n8n workflow** | [`../Workflow/plane-agent.json`](../Workflow/plane-agent.json) | ~22 KB | Поток: validate → token-check → fetch projects → LLM/Direct → Switch → Plane API → формат → respond |
| **Frontend агента** | [`../Agents/plane-agent.html`](../Agents/plane-agent.html) | ~30 KB | Chat-UI + settings-модалка + панель «Тест без LLM» (6 action-форм) |
| **createChatAgent option** | [`../Agents/_shared.js`](../Agents/_shared.js) | строка с `extraBody` | Хук для прокидки доп. полей (token, plane settings) в тело POST |
| **Карточка на дашборде** | [`../GigaChat-Platform.html`](../GigaChat-Platform.html) | блок `<a class="card card-plane">` в разделе «Агенты» | Открывает агента + health-check |
| **Инструкция по офису** | [`OFFICE-TESTING.md`](OFFICE-TESTING.md) | этот же каталог | Подробный гайд: импорт workflow → настройка → тест |

## Архитектура (текстовая диаграмма)

```
   Юзер (браузер)                Сервер office                  
   ────────────────              ─────────────────              
                                                                
   plane-agent.html ──HTTP──>  n8n (Docker)                     
       │                          │                             
       │ (token, plane settings,  │                             
       │  action/message)         ▼                             
       │                       Workflow plane-agent.json        
       │                          │                             
       │                          ├── Postgres: verify token    
       │                          │   (planner_sessions)        
       │                          │                             
       │                          ├── GigaChat LLM (опц., NL)   
       │                          │                             
       │                          └─── Plane API ─> Plane (Docker)
       │                                                        
       <──── JSON ответ ───────────                              
```

В office все три (n8n, Postgres, Plane) живут в Docker на одном сервере. Главная задача при настройке — научить n8n-контейнер ходить в Plane-контейнер по сети Docker.

## Что НЕ входит (отдельно живёт)

- **Сам Plane** — клон upstream-репо лежит в `C:\Users\Lenovo\Desktop\GigaChat-Local\plane\` (не пушится, в `.gitignore`). Поднимается через `docker-compose.v0.27.yml`.
- **Документация по запуску Plane локально дома** — `GigaChat-Local\plane\RUN.md`

## Быстрый старт в офисе

См. [OFFICE-TESTING.md](OFFICE-TESTING.md).

Краткая суть:
1. `git pull` свежий код
2. `.\import-workflows.ps1` + `.\activate-workflows.ps1 -Force` — workflow в офисную n8n
3. В офисном Plane: создать workspace + API token
4. Найти URL по которому n8n офисная видит Plane (перебор из 6 вариантов через UI)
5. Открыть GigaChat Plane → Plane-настройки → ввести URL/slug/token
6. «Тест без LLM» → каждую из 6 кнопок → должно быть зелёное

## История изменений

- `bd86e92` — первая версия (workflow + UI + dashboard card)
- `c658539` — direct-режим (action bypass LLM)
- `c066683` — UI «Тест без LLM» (6 action-форм)
- `11e913b` — фикс `[object Object]` + client-side фильтр поиска
- `2ffedce` — фикс чата планировщика (extraBody с token)

Подробности — `git log --oneline`.
