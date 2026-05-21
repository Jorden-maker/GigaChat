-- ============================================================================
-- Миграция v3: полноценная аутентификация (planner_users + planner_sessions).
--
-- ВНИМАНИЕ: эта миграция УДАЛЯЕТ все существующие задачи в planner_tasks!
-- Старая схема хранила user_id как VARCHAR (имя из identity-flow), новая
-- использует INTEGER FK на planner_users. Без миграции старые задачи не
-- привязаны ни к одному реальному юзеру — clean slate проще и надёжнее.
-- Если задачи важны — экспортируй их вручную ДО запуска этой миграции.
--
-- Запуск:
--   psql -U postgres -d ai_agent -f migration-v3-auth.sql
-- ============================================================================

-- 1) Расширение pgcrypto — для bcrypt-хеширования паролей через crypt()/gen_salt().
-- Поставляется со стандартной PostgreSQL без доп. установки.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2) Юзеры. password_hash хранит bcrypt-хеш (с salt'ом внутри).
-- VARCHAR(255) — стандартная длина для bcrypt-хеша (~60 символов фактически).
CREATE TABLE IF NOT EXISTS planner_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    last_login_at TIMESTAMP,
    password_changed_at TIMESTAMP DEFAULT NOW()
);

-- Case-insensitive поиск по username — юзер не запомнит точный регистр.
-- Используем LOWER() в индексе, в запросах тоже LOWER(username) = LOWER($1).
CREATE INDEX IF NOT EXISTS idx_planner_users_username_lower
    ON planner_users (LOWER(username));

-- 3) Сессии. Один юзер может иметь много активных токенов (один на устройство).
-- token = 64 hex символа (32 байта = 256 бит энтропии).
-- remember=true → expires_at через 10 лет, иначе через 24 часа.
CREATE TABLE IF NOT EXISTS planner_sessions (
    token VARCHAR(64) PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES planner_users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    last_used_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    remember BOOLEAN DEFAULT FALSE
);

-- Индекс по юзеру — для GET MY sessions или DELETE при logout-all-sessions.
CREATE INDEX IF NOT EXISTS idx_planner_sessions_user
    ON planner_sessions (user_id);
-- Индекс по expires_at — для периодической чистки протухших сессий
-- (DELETE FROM planner_sessions WHERE expires_at < NOW()).
CREATE INDEX IF NOT EXISTS idx_planner_sessions_expires
    ON planner_sessions (expires_at);

-- 4) planner_tasks: переключение user_id с VARCHAR на INTEGER FK
-- Clean slate подход — удаляем все старые задачи. Старая схема (multi-user
-- через идентификацию по имени) была временная, реальной защиты не давала.
DELETE FROM planner_tasks;

ALTER TABLE planner_tasks DROP COLUMN IF EXISTS user_id;
ALTER TABLE planner_tasks ADD COLUMN user_id INTEGER NOT NULL
    REFERENCES planner_users(id) ON DELETE CASCADE;

-- Обновляем индексы под новый user_id типа INTEGER
DROP INDEX IF EXISTS idx_planner_tasks_user_session_status;
CREATE INDEX idx_planner_tasks_user_session_status
    ON planner_tasks (user_id, session_id, status, created_at DESC);

DROP INDEX IF EXISTS idx_planner_tasks_user_deadline;
CREATE INDEX idx_planner_tasks_user_deadline
    ON planner_tasks (user_id, deadline) WHERE deadline IS NOT NULL;

SELECT 'Auth schema v3 готова: planner_users + planner_sessions + planner_tasks (FK на users).' AS result;
