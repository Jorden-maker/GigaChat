-- =============================================================================
-- Миграция: общая таблица agent_sessions (заменяет planner_session_meta)
-- =============================================================================
-- Зачем:
-- Юзеры работают с РАЗНЫХ ПК на одном аккаунте — должны видеть свои сессии
-- везде (sync через сервер). Один ПК = несколько юзеров — изолированы.
-- Запускать вручную ОДИН раз после обновления; идемпотентна.
--
-- Что делает:
--   1. Создаёт таблицу agent_sessions(session_id, user_id, agent, name, ...)
--      где agent = 'planner' | 'chat' | 'sql' | 'rag' | 'math' | 'prompt' | 'plane'
--      session_id уникальный per (user_id, agent) — глобально через timestamp+random
--      из фронта
--   2. Копирует planner_session_meta → agent_sessions (agent='planner')
--   3. Старую planner_session_meta НЕ удаляет (на случай отката)
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id  VARCHAR(255) NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES planner_users(id) ON DELETE CASCADE,
    agent       VARCHAR(32)  NOT NULL,
    name        TEXT         NOT NULL,
    sort_order  INTEGER      NOT NULL DEFAULT 0,
    created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, agent, session_id)
);

-- Главный индекс — фильтр по user_id + agent + сортировка для list-запроса
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_agent_sorted
    ON agent_sessions (user_id, agent, sort_order, updated_at DESC);

-- Миграция planner_session_meta → agent_sessions (если есть data)
INSERT INTO agent_sessions (session_id, user_id, agent, name, sort_order, created_at, updated_at)
SELECT session_id, user_id, 'planner', name, sort_order, created_at, updated_at
FROM planner_session_meta
ON CONFLICT (user_id, agent, session_id) DO NOTHING;
