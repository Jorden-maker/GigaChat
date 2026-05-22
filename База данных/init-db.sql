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
    sort_order INTEGER NOT NULL DEFAULT 0,
    parent_id INTEGER REFERENCES planner_tasks(id) ON DELETE CASCADE,
    recurrence VARCHAR(20) CHECK (recurrence IS NULL OR recurrence IN ('daily','weekly','monthly')),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_tasks_user_session_status
    ON planner_tasks (user_id, session_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_planner_tasks_user_deadline
    ON planner_tasks (user_id, deadline) WHERE deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_planner_tasks_sort
    ON planner_tasks (user_id, session_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_planner_tasks_parent
    ON planner_tasks (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS planner_session_meta (
    user_id INTEGER NOT NULL REFERENCES planner_users(id) ON DELETE CASCADE,
    session_id VARCHAR(255) NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, session_id)
);

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

\echo '== Организация обращения: appeal_employees + appeal_event1 + appeal_event2 =='
-- Подробности по алгоритму и сценариям тестов: см. OrgAppeal-Setup.md.
-- employee_number NULLABLE — отличает «нет в реестре» (D) от «есть, но без ТН» (E).
CREATE TABLE IF NOT EXISTS appeal_employees (
    id              SERIAL PRIMARY KEY,
    full_name       VARCHAR(200) NOT NULL,
    employee_number VARCHAR(50),
    created_at      TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appeal_employees_name ON appeal_employees (full_name);

CREATE TABLE IF NOT EXISTS appeal_event1 (
    id          SERIAL PRIMARY KEY,
    full_name   VARCHAR(200) NOT NULL,
    is_done     BOOLEAN NOT NULL DEFAULT FALSE,
    done_at     TIMESTAMP,
    created_at  TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appeal_event1_name ON appeal_event1 (full_name);

CREATE TABLE IF NOT EXISTS appeal_event2 (
    id          SERIAL PRIMARY KEY,
    full_name   VARCHAR(200) NOT NULL,
    is_done     BOOLEAN NOT NULL DEFAULT FALSE,
    done_at     TIMESTAMP,
    created_at  TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appeal_event2_name ON appeal_event2 (full_name);

\echo '== Тестовые данные для алгоритма: 58 сотрудников + 40 event1 + 28 event2 =='
INSERT INTO appeal_employees (full_name, employee_number) VALUES
('Иванов Иван Иванович', '10001'),
('Петров Пётр Петрович', '10002'),
('Сидоров Сидор Сидорович', NULL),
('Богданов Богдан Богданович', '10004'),
('Морозов Михаил Михайлович', '10005'),
('Михайлов Дмитрий Александрович', '10006'),
('Васильев Андрей Сергеевич', '10007'),
('Иванова Иванна Ивановна', '10008'),
('Фёдоров Алексей Николаевич', '10010'),
('Волков Артём Денисович', '10011'),
('Алексеев Максим Игоревич', '10012'),
('Лебедев Кирилл Андреевич', '10013'),
('Семёнов Илья Михайлович', '10014'),
('Егоров Антон Юрьевич', '10015'),
('Павлов Роман Олегович', '10016'),
('Козлов Степан Петрович', '10017'),
('Соколов Глеб Дмитриевич', '10018'),
('Виноградов Тимофей Алексеевич', '10019'),
('Никитин Артемий Никитич', '10020'),
('Орлов Матвей Александрович', '10021'),
('Андреев Захар Тимофеевич', '10022'),
('Макаров Лев Юрьевич', '10023'),
('Беляев Марк Романович', '10024'),
('Тарасов Михаил Дмитриевич', '10025'),
('Соловьёв Григорий Петрович', '10026'),
('Захаров Аркадий Степанович', '10027'),
('Борисов Виктор Глебович', '10028'),
('Королёв Платон Кириллович', '10029'),
('Гусев Владимир Семёнович', '10030'),
('Киселёв Олег Артурович', '10031'),
('Куликов Анатолий Игнатьевич', '10032'),
('Романов Кирилл Германович', '10033'),
('Сергеев Никита Аркадьевич', '10034'),
('Фролов Эдуард Тимурович', '10035'),
('Жуков Илья Владиславович', '10036'),
('Антонов Денис Леонидович', '10037'),
('Маркин Богдан Олегович', '10038'),
('Зайцев Сергей Михайлович', '10039'),
('Соболев Виталий Эдуардович', '10040'),
('Зимин Захар Эдуардович', NULL),
('Селезнёв Михаил Витальевич', NULL),
('Дроздов Артур Дмитриевич', NULL),
('Петрова Мария Петровна', '10045'),
('Смирнова Елена Викторовна', '10046'),
('Кузнецова Ольга Андреевна', '10047'),
('Соколова Татьяна Сергеевна', '10048'),
('Попова Наталья Михайловна', '10049'),
('Лебедева Ирина Алексеевна', '10050'),
('Козлова Екатерина Дмитриевна', '10051'),
('Новикова Светлана Петровна', '10052'),
('Морозова Юлия Александровна', '10053'),
('Васильева Виктория Юрьевна', '10054'),
('Соловьёва Алла Семёновна', '10055'),
('Михайлова Полина Романовна', '10056'),
('Полякова Софья Игоревна', '10057'),
('Тихонова Анастасия Павловна', '10058'),
('Калинина Дарья Степановна', '10059'),
('Кузьмина Татьяна Андреевна', NULL)
ON CONFLICT (full_name) DO NOTHING;

INSERT INTO appeal_event1 (full_name, is_done, done_at) VALUES
('Морозов Михаил Михайлович', FALSE, NULL),
('Михайлов Дмитрий Александрович', TRUE,  NOW() - INTERVAL '60 days'),
('Васильев Андрей Сергеевич', TRUE,  NOW() - INTERVAL '45 days'),
('Иванова Иванна Ивановна', TRUE,  NOW() - INTERVAL '30 days'),
('Иванов Иван Иванович', TRUE,  NOW() - INTERVAL '30 days'),
('Петров Пётр Петрович', TRUE,  NOW() - INTERVAL '25 days'),
('Сидоров Сидор Сидорович', TRUE,  NOW() - INTERVAL '20 days'),
('Фёдоров Алексей Николаевич', TRUE,  NOW() - INTERVAL '12 days'),
('Волков Артём Денисович', TRUE,  NOW() - INTERVAL '90 days'),
('Алексеев Максим Игоревич', TRUE,  NOW() - INTERVAL '21 days'),
('Лебедев Кирилл Андреевич', TRUE,  NOW() - INTERVAL '7 days'),
('Семёнов Илья Михайлович', TRUE,  NOW() - INTERVAL '14 days'),
('Егоров Антон Юрьевич', TRUE,  NOW() - INTERVAL '33 days'),
('Павлов Роман Олегович', TRUE,  NOW() - INTERVAL '120 days'),
('Соколов Глеб Дмитриевич', TRUE,  NOW() - INTERVAL '40 days'),
('Виноградов Тимофей Алексеевич', TRUE,  NOW() - INTERVAL '8 days'),
('Орлов Матвей Александрович', TRUE,  NOW() - INTERVAL '17 days'),
('Андреев Захар Тимофеевич', TRUE,  NOW() - INTERVAL '52 days'),
('Беляев Марк Романович', TRUE,  NOW() - INTERVAL '3 days'),
('Соловьёв Григорий Петрович', TRUE,  NOW() - INTERVAL '74 days'),
('Королёв Платон Кириллович', TRUE,  NOW() - INTERVAL '28 days'),
('Петрова Мария Петровна', TRUE,  NOW() - INTERVAL '19 days'),
('Смирнова Елена Викторовна', TRUE,  NOW() - INTERVAL '46 days'),
('Соколова Татьяна Сергеевна', TRUE,  NOW() - INTERVAL '11 days'),
('Лебедева Ирина Алексеевна', TRUE,  NOW() - INTERVAL '6 days'),
('Морозова Юлия Александровна', TRUE,  NOW() - INTERVAL '85 days'),
('Михайлова Полина Романовна', TRUE,  NOW() - INTERVAL '23 days'),
('Романов Кирилл Германович', TRUE,  NOW() - INTERVAL '55 days'),
('Антонов Денис Леонидович', TRUE,  NOW() - INTERVAL '17 days'),
('Зайцев Сергей Михайлович', TRUE,  NOW() - INTERVAL '9 days'),
('Козлов Степан Петрович', FALSE, NULL),
('Никитин Артемий Никитич', FALSE, NULL),
('Макаров Лев Юрьевич', FALSE, NULL),
('Тарасов Михаил Дмитриевич', FALSE, NULL),
('Куликов Анатолий Игнатьевич', FALSE, NULL),
('Кузнецова Ольга Андреевна', FALSE, NULL),
('Попова Наталья Михайловна', FALSE, NULL),
('Полякова Софья Игоревна', FALSE, NULL),
('Маркин Богдан Олегович', FALSE, NULL),
('Соболев Виталий Эдуардович', FALSE, NULL)
ON CONFLICT (full_name) DO NOTHING;

INSERT INTO appeal_event2 (full_name, is_done, done_at) VALUES
('Васильев Андрей Сергеевич', FALSE, NULL),
('Иванова Иванна Ивановна', TRUE,  NOW() - INTERVAL '10 days'),
('Иванов Иван Иванович', TRUE,  NOW() - INTERVAL '10 days'),
('Петров Пётр Петрович', TRUE,  NOW() - INTERVAL '5 days'),
('Фёдоров Алексей Николаевич', TRUE,  NOW() - INTERVAL '4 days'),
('Волков Артём Денисович', TRUE,  NOW() - INTERVAL '38 days'),
('Лебедев Кирилл Андреевич', TRUE,  NOW() - INTERVAL '1 day'),
('Семёнов Илья Михайлович', TRUE,  NOW() - INTERVAL '9 days'),
('Егоров Антон Юрьевич', TRUE,  NOW() - INTERVAL '13 days'),
('Орлов Матвей Александрович', TRUE,  NOW() - INTERVAL '7 days'),
('Беляев Марк Романович', TRUE,  NOW() - INTERVAL '2 days'),
('Соловьёв Григорий Петрович', TRUE,  NOW() - INTERVAL '20 days'),
('Петрова Мария Петровна', TRUE,  NOW() - INTERVAL '11 days'),
('Соколова Татьяна Сергеевна', TRUE,  NOW() - INTERVAL '16 days'),
('Михайлова Полина Романовна', TRUE,  NOW() - INTERVAL '8 days'),
('Смирнова Елена Викторовна', TRUE,  NOW() - INTERVAL '14 days'),
('Сидоров Сидор Сидорович', FALSE, NULL),
('Алексеев Максим Игоревич', FALSE, NULL),
('Соколов Глеб Дмитриевич', FALSE, NULL),
('Виноградов Тимофей Алексеевич', FALSE, NULL),
('Андреев Захар Тимофеевич', FALSE, NULL),
('Королёв Платон Кириллович', FALSE, NULL),
('Лебедева Ирина Алексеевна', FALSE, NULL),
('Морозова Юлия Александровна', FALSE, NULL),
('Романов Кирилл Германович', FALSE, NULL),
('Антонов Денис Леонидович', FALSE, NULL),
('Зайцев Сергей Михайлович', FALSE, NULL),
('Морозов Михаил Михайлович', FALSE, NULL)
ON CONFLICT (full_name) DO NOTHING;

\echo '== Результат: список таблиц + расширений =='
\dt
\dx
