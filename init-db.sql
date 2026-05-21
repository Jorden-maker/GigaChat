-- ============================================================================
-- Полная инициализация testdb под GigaChat: расширения + все таблицы проекта.
-- Прогоняется ОДИН РАЗ на свежесозданной БД.
-- ============================================================================

\echo '== Расширения =='
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

\echo '== SQL-агент: clients + orders =='
CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    city VARCHAR(255),
    email VARCHAR(255),
    revenue DECIMAL(15, 2),
    created_at DATE DEFAULT CURRENT_DATE
);
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id),
    product VARCHAR(255),
    amount DECIMAL(15, 2),
    status VARCHAR(50),
    order_date DATE DEFAULT CURRENT_DATE
);

\echo '== RAG-агент: documents (embedding vector(1024)) =='
CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(500) NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding vector(1024),
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT documents_filename_chunk_unique UNIQUE (filename, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_documents_embedding
    ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_documents_filename ON documents (filename);

\echo '== Память агентов: chat_memory + chat_summaries =='
CREATE TABLE IF NOT EXISTS chat_memory (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    extras JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_memory_session
    ON chat_memory (session_id, created_at);

CREATE TABLE IF NOT EXISTS chat_summaries (
    session_id VARCHAR(255) PRIMARY KEY,
    summary_text TEXT,
    messages_summarized INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

\echo '== Планировщик: planner_users + planner_sessions + planner_tasks (v3 auth) =='
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
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_tasks_user_session_status
    ON planner_tasks (user_id, session_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_planner_tasks_user_deadline
    ON planner_tasks (user_id, deadline) WHERE deadline IS NOT NULL;

\echo '== Тестовые данные для SQL-агента =='
INSERT INTO clients (name, city, email, revenue) VALUES
('ООО Ромашка', 'Москва', 'romashka@mail.ru', 1500000.00),
('ООО Василёк', 'Казань', 'vasilek@mail.ru', 800000.00),
('ИП Иванов А.В.', 'Воронеж', 'ivanov@mail.ru', 350000.00),
('ЗАО Рассвет', 'Сочи', 'rassvet@mail.ru', 2200000.00),
('ООО ТехноСервис', 'Москва', 'techno@mail.ru', 4100000.00);

INSERT INTO orders (client_id, product, amount, status, order_date) VALUES
(1, 'Сервер HP ProLiant', 450000.00, 'delivered', '2026-01-15'),
(2, 'Ноутбук Lenovo', 120000.00, 'delivered', '2026-01-20'),
(3, 'Принтер Canon', 28000.00, 'delivered', '2026-03-01'),
(4, 'Видеонаблюдение', 320000.00, 'pending', '2026-04-15'),
(5, 'СХД NetApp', 850000.00, 'delivered', '2026-03-20');

\echo '== Результат: список таблиц + расширений =='
\dt
\dx
