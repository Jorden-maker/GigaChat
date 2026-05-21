-- ============================================================================
-- Схема для инструмента «Планировщик»
-- Запустить один раз на сервере (Linux или Windows, неважно):
--   psql -U postgres -d ai_agent -f planner-schema.sql
-- ============================================================================

-- Активные и выполненные задачи юзера. Сессия = отдельный список
-- (например «Личные», «Работа», «Проект Х»). История AI-запросов
-- хранится в общей таблице chat_memory с тем же session_id.

CREATE TABLE IF NOT EXISTS planner_tasks (
    id SERIAL PRIMARY KEY,
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
--   SELECT * FROM planner_tasks WHERE session_id=$1 AND status=$2 ORDER BY ...
CREATE INDEX IF NOT EXISTS idx_planner_tasks_session_status
ON planner_tasks (session_id, status, created_at DESC);

-- Дополнительный индекс по дедлайну — пригодится для запросов
-- «что просрочено» и сортировки по дате.
CREATE INDEX IF NOT EXISTS idx_planner_tasks_deadline
ON planner_tasks (session_id, deadline) WHERE deadline IS NOT NULL;

SELECT 'planner_tasks готов.' AS result;
