-- ============================================================================
-- Схема для инструмента «Планировщик»
-- Запустить один раз на сервере (Linux или Windows, неважно):
--   psql -U postgres -d ai_agent -f planner-schema.sql
--
-- Если БД уже создана со старой версии (без user_id) — запускай
-- migration-add-users.sql вместо этого файла.
-- ============================================================================

-- Активные и выполненные задачи юзера. Сессия = отдельный список
-- (например «Личные», «Работа», «Проект Х»). user_id — идентификатор
-- пользователя из login-модалки (имя), задачи изолированы между юзерами.
-- История AI-запросов хранится в общей таблице chat_memory с тем же session_id.

CREATE TABLE IF NOT EXISTS planner_tasks (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(100) NOT NULL DEFAULT 'anonymous',
    session_id VARCHAR(255) NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    priority VARCHAR(10) DEFAULT 'medium'
        CHECK (priority IN ('low','medium','high')),
    deadline DATE,
    status VARCHAR(20) DEFAULT 'active'
        CHECK (status IN ('active','completed')),
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Композитный индекс под основной запрос:
--   SELECT * FROM planner_tasks WHERE user_id=$1 AND session_id=$2 AND status=$3
CREATE INDEX IF NOT EXISTS idx_planner_tasks_user_session_status
ON planner_tasks (user_id, session_id, status, created_at DESC);

-- Индекс по дедлайну — для запросов «что просрочено» и сортировки по дате.
CREATE INDEX IF NOT EXISTS idx_planner_tasks_user_deadline
ON planner_tasks (user_id, deadline) WHERE deadline IS NOT NULL;

SELECT 'planner_tasks готов (multi-user режим).' AS result;
