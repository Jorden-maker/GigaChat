-- ============================================================================
-- Миграция planner_tasks: добавление user_id для многопользовательского режима.
-- Запустить ОДИН раз на сервере после git pull последних изменений:
--   psql -U postgres -d ai_agent -f migration-add-users.sql
-- ============================================================================

-- Колонка user_id хранит идентификатор юзера (имя из login-модалки).
-- DEFAULT 'anonymous' — для совместимости с задачами созданными до миграции:
-- старые задачи останутся в БД, но не попадут в выборку новых юзеров с именами.
ALTER TABLE planner_tasks ADD COLUMN IF NOT EXISTS user_id VARCHAR(100) DEFAULT 'anonymous';

-- Композитный индекс под основной запрос:
--   SELECT * FROM planner_tasks WHERE user_id=$1 AND session_id=$2 AND status=$3
-- Старый индекс (без user_id) уже не оптимален — заменяем.
DROP INDEX IF EXISTS idx_planner_tasks_session_status;
CREATE INDEX IF NOT EXISTS idx_planner_tasks_user_session_status
    ON planner_tasks (user_id, session_id, status, created_at DESC);

-- Старый индекс по дедлайну тоже расширяем — фильтр по юзеру обычно идёт первым.
DROP INDEX IF EXISTS idx_planner_tasks_deadline;
CREATE INDEX IF NOT EXISTS idx_planner_tasks_user_deadline
    ON planner_tasks (user_id, deadline) WHERE deadline IS NOT NULL;

-- Если хочется почистить старые «безымянные» задачи (опционально, по решению админа):
--   DELETE FROM planner_tasks WHERE user_id = 'anonymous';

SELECT 'planner_tasks: user_id добавлен, индексы пересозданы.' AS result;
