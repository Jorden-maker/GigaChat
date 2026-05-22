-- ============================================================================
-- Схема для инструмента «Планировщик» (v3 — с полноценной аутентификацией)
-- Запустить один раз на сервере (Linux или Windows, неважно):
--   psql -U postgres -d ai_agent -f "База данных/planner-schema.sql"
--
-- Если БД уже создана со старой версии (без planner_users/planner_sessions) —
-- запускай migration-v3-auth.sql вместо этого файла.
--
-- ⚡ Для полной инициализации БД (все таблицы проекта одним прогоном) —
-- используй init-db.sql из этой же папки (см. README.md).
-- ============================================================================

-- pgcrypto для bcrypt-хешей паролей.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Юзеры. password_hash — bcrypt-хеш через crypt() из pgcrypto.
CREATE TABLE IF NOT EXISTS planner_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    last_login_at TIMESTAMP,
    password_changed_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_users_username_lower
    ON planner_users (LOWER(username));

-- 2) Сессии. token = 64 hex символа (32 байта = 256 бит).
-- remember=true → expires_at через 10 лет, иначе через 24 часа.
CREATE TABLE IF NOT EXISTS planner_sessions (
    token VARCHAR(64) PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES planner_users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    last_used_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    remember BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_planner_sessions_user
    ON planner_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_planner_sessions_expires
    ON planner_sessions (expires_at);

-- 3) Задачи. user_id — FK на planner_users.id (целостность гарантирована).
-- Сессия (session_id) = отдельный список задач юзера («Личные», «Работа»).
CREATE TABLE IF NOT EXISTS planner_tasks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES planner_users(id) ON DELETE CASCADE,
    session_id VARCHAR(255) NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    priority VARCHAR(10) DEFAULT 'medium'
        CHECK (priority IN ('low','medium','high')),
    deadline DATE,
    status VARCHAR(20) DEFAULT 'active'
        CHECK (status IN ('active','completed')),
    completed_at TIMESTAMP,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_tasks_user_session_status
    ON planner_tasks (user_id, session_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_planner_tasks_user_deadline
    ON planner_tasks (user_id, deadline) WHERE deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_planner_tasks_sort
    ON planner_tasks (user_id, session_id, sort_order);

SELECT 'planner-schema v3 готов (auth + tasks).' AS result;
