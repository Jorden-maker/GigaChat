-- ============================================================================
-- Полная инициализация testdb под GigaChat: расширения + все таблицы проекта.
-- Прогоняется ОДИН РАЗ на свежесозданной БД.
-- ============================================================================

\echo '== Расширения =='
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

\echo '== SQL-агент: clients + orders + employees + tasks =='
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

-- employees + tasks — для тестов SQL-агента (агрегации, JOIN, фильтры).
-- Сотрудники компании по отделам, задачи привязаны к исполнителю (assignee_id).
CREATE TABLE IF NOT EXISTS employees (
    id          SERIAL PRIMARY KEY,
    full_name   VARCHAR(200) NOT NULL,
    position    VARCHAR(100),
    department  VARCHAR(100),
    salary      DECIMAL(15, 2),
    hired_at    DATE,
    email       VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees (department);

CREATE TABLE IF NOT EXISTS tasks (
    id           SERIAL PRIMARY KEY,
    title        VARCHAR(500) NOT NULL,
    description  TEXT,
    assignee_id  INTEGER REFERENCES employees(id),
    status       VARCHAR(20) DEFAULT 'open'
        CHECK (status IN ('open','in_progress','done','cancelled')),
    priority     VARCHAR(10) DEFAULT 'medium'
        CHECK (priority IN ('low','medium','high','urgent')),
    created_at   DATE DEFAULT CURRENT_DATE,
    deadline     DATE,
    completed_at DATE
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

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

-- agent_sessions: общая для всех агентов. Sync через /webhook/sessions-sync,
-- ключ (user_id, agent, session_id) — один аккаунт видит свои сессии на
-- любом ПК, разные аккаунты на одном ПК изолированы. agent ∈ {planner, chat,
-- sql, rag, math, prompt, plane}.
\echo '== agent_sessions: единый стор сессий всех агентов =='
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
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_agent_sorted
    ON agent_sessions (user_id, agent, sort_order, updated_at DESC);

\echo '== Тестовые данные для SQL-агента: 30 клиентов + 30 заказов + 30 сотрудников + 30 задач =='
INSERT INTO clients (name, city, email, revenue, created_at) VALUES
('ООО Ромашка',         'Москва',           'romashka@mail.ru',    1500000.00, '2025-03-12'),
('ООО Василёк',         'Казань',           'vasilek@mail.ru',      800000.00, '2025-05-08'),
('ИП Иванов А.В.',      'Воронеж',          'ivanov@mail.ru',       350000.00, '2025-07-21'),
('ЗАО Рассвет',         'Сочи',             'rassvet@mail.ru',     2200000.00, '2024-11-03'),
('ООО ТехноСервис',     'Москва',           'techno@mail.ru',      4100000.00, '2024-08-15'),
('ООО АвтоПарк',        'Санкт-Петербург',  'autopark@mail.ru',    1850000.00, '2025-01-22'),
('ИП Кузнецов С.М.',    'Новосибирск',      'kuznetsov@mail.ru',    420000.00, '2025-09-14'),
('ООО МедТехника',      'Екатеринбург',     'medteh@mail.ru',      3200000.00, '2024-12-05'),
('АО ТрансЛогистик',    'Краснодар',        'translogist@mail.ru', 5600000.00, '2024-06-30'),
('ООО СтройМаркет',     'Ростов-на-Дону',   'stroymarket@mail.ru', 2750000.00, '2025-02-18'),
('ИП Смирнова О.А.',    'Самара',           'smirnova@mail.ru',     280000.00, '2025-10-04'),
('ООО ЭлектроПром',     'Челябинск',        'electroprom@mail.ru', 1950000.00, '2025-04-11'),
('АО Северный Ветер',   'Мурманск',         'sevwind@mail.ru',      950000.00, '2025-06-26'),
('ООО Кофейня №1',      'Москва',           'coffee1@mail.ru',      560000.00, '2025-08-19'),
('ИП Морозов В.К.',     'Тюмень',           'morozov@mail.ru',      380000.00, '2025-11-02'),
('ООО ВектоПлюс',       'Уфа',              'vectoplus@mail.ru',   1280000.00, '2024-10-17'),
('АО ПромМаш',          'Пермь',            'prommash@mail.ru',    4800000.00, '2024-05-20'),
('ООО ФудМаркет',       'Волгоград',        'foodmarket@mail.ru',  2100000.00, '2025-03-28'),
('ИП Лебедев Д.Н.',     'Тула',             'lebedev@mail.ru',      210000.00, '2025-12-08'),
('ООО МегаСтрой',       'Санкт-Петербург',  'megastroy@mail.ru',   3850000.00, '2024-09-10'),
('АО ХимПром',          'Дзержинск',        'himprom@mail.ru',     2670000.00, '2024-07-25'),
('ООО Гермес',          'Казань',           'germes@mail.ru',       720000.00, '2025-05-30'),
('ИП Соколов Е.П.',     'Иркутск',          'sokolov@mail.ru',      490000.00, '2025-09-23'),
('ООО Северянка',       'Архангельск',      'severyanka@mail.ru',   870000.00, '2025-07-07'),
('АО ЭнергоСеть',       'Москва',           'energoset@mail.ru',   5200000.00, '2024-04-14'),
('ООО АгроТех',         'Краснодар',        'agroteh@mail.ru',     1620000.00, '2025-01-15'),
('ИП Захарова Т.И.',    'Ярославль',        'zaharova@mail.ru',     310000.00, '2025-10-21'),
('ООО НефтьТранс',      'Сургут',           'nefttrans@mail.ru',   4350000.00, '2024-08-02'),
('АО ФинГрупп',         'Москва',           'fingroup@mail.ru',    3100000.00, '2025-02-09'),
('ООО МастерКласс',     'Санкт-Петербург',  'masterclass@mail.ru',  640000.00, '2025-06-13')
ON CONFLICT DO NOTHING;

INSERT INTO orders (client_id, product, amount, status, order_date) VALUES
(1,  'Сервер HP ProLiant',         450000.00, 'delivered',  '2026-01-15'),
(2,  'Ноутбук Lenovo',             120000.00, 'delivered',  '2026-01-20'),
(3,  'Принтер Canon',               28000.00, 'delivered',  '2026-03-01'),
(4,  'Видеонаблюдение',            320000.00, 'pending',    '2026-04-15'),
(5,  'СХД NetApp',                 850000.00, 'delivered',  '2026-03-20'),
(6,  'Сервер Dell PowerEdge',      520000.00, 'delivered',  '2026-02-05'),
(7,  'Принтер HP LaserJet',         45000.00, 'cancelled',  '2026-02-12'),
(8,  'Медицинское оборудование',  1250000.00, 'delivered',  '2026-01-28'),
(9,  'Грузовик Volvo FH',         3800000.00, 'pending',    '2026-04-30'),
(10, 'Стройматериалы (партия)',    680000.00, 'delivered',  '2026-03-08'),
(11, 'Ноутбук ASUS',                89000.00, 'delivered',  '2026-02-20'),
(12, 'Электроинструмент (комплект)', 215000.00, 'processing','2026-04-02'),
(1,  'Доукомплектация серверной',  175000.00, 'delivered',  '2026-04-22'),
(14, 'Кофемашина Jura',            340000.00, 'delivered',  '2026-03-15'),
(15, 'Холодильное оборудование',   195000.00, 'pending',    '2026-04-25'),
(16, 'Маршрутизатор Cisco',        125000.00, 'delivered',  '2026-02-28'),
(17, 'Промышленный станок',       2400000.00, 'processing', '2026-04-10'),
(18, 'Кассовое оборудование',      155000.00, 'delivered',  '2026-03-25'),
(20, 'Бетоносмеситель',            420000.00, 'delivered',  '2026-02-15'),
(21, 'Химреактивы (партия)',       890000.00, 'delivered',  '2026-03-05'),
(5,  'Сетевое хранилище',          760000.00, 'delivered',  '2026-04-05'),
(22, 'Кассовый аппарат АТОЛ',       38000.00, 'delivered',  '2026-04-18'),
(8,  'Расходники для медтехники',   95000.00, 'delivered',  '2026-04-12'),
(25, 'Энергосистема резервная',   1850000.00, 'pending',    '2026-04-28'),
(26, 'Опрыскиватель сельхоз',      560000.00, 'processing', '2026-04-08'),
(28, 'Цистерна для топлива',       980000.00, 'delivered',  '2026-03-30'),
(29, 'IT-инфраструктура (проект)', 2200000.00,'processing', '2026-04-20'),
(10, 'Доп. партия стройматериалов',310000.00, 'cancelled',  '2026-04-15'),
(9,  'Прицеп грузовой',            720000.00, 'delivered',  '2026-03-18'),
(30, 'Учебный класс (оснащение)',  185000.00, 'delivered',  '2026-04-01')
ON CONFLICT DO NOTHING;

INSERT INTO employees (full_name, position, department, salary, hired_at, email) VALUES
('Иванов Иван Иванович',         'Генеральный директор',  'Руководство',  280000.00, '2018-03-15', 'ivanov@company.ru'),
('Петрова Анна Сергеевна',       'Финансовый директор',   'Финансы',      220000.00, '2019-06-01', 'petrova@company.ru'),
('Смирнов Александр Петрович',   'Технический директор',  'IT',           240000.00, '2018-09-10', 'smirnov@company.ru'),
('Кузнецова Мария Викторовна',   'HR-директор',           'HR',           180000.00, '2020-02-14', 'kuznetsova@company.ru'),
('Соколов Дмитрий Андреевич',    'Старший разработчик',   'IT',           175000.00, '2020-05-20', 'sokolov@company.ru'),
('Морозова Елена Ивановна',      'Главный бухгалтер',     'Бухгалтерия',  160000.00, '2019-11-03', 'morozova@company.ru'),
('Волков Андрей Михайлович',     'Руководитель отдела продаж', 'Продажи', 195000.00, '2019-04-08', 'volkov@company.ru'),
('Зайцева Ольга Дмитриевна',     'Менеджер по продажам',  'Продажи',      110000.00, '2021-01-12', 'zaitseva@company.ru'),
('Лебедев Сергей Николаевич',    'Разработчик Backend',   'IT',           150000.00, '2021-03-22', 'lebedev@company.ru'),
('Козлова Татьяна Юрьевна',      'Разработчик Frontend',  'IT',           140000.00, '2021-07-15', 'kozlova@company.ru'),
('Новиков Михаил Олегович',      'DevOps инженер',        'IT',           165000.00, '2020-10-05', 'novikov@company.ru'),
('Степанова Юлия Романовна',     'Маркетолог',            'Маркетинг',    105000.00, '2022-02-18', 'stepanova@company.ru'),
('Орлов Павел Викторович',       'Юрист',                 'Юридический',  140000.00, '2019-08-26', 'orlov@company.ru'),
('Беляева Анастасия Игоревна',   'Бухгалтер',             'Бухгалтерия',   85000.00, '2022-04-11', 'belyaeva@company.ru'),
('Кравцов Илья Александрович',   'Тестировщик QA',        'IT',            95000.00, '2022-06-20', 'kravtsov@company.ru'),
('Романова Виктория Петровна',   'Менеджер по продажам',  'Продажи',      115000.00, '2021-09-30', 'romanova@company.ru'),
('Тихонов Артём Сергеевич',      'Логист',                'Логистика',     90000.00, '2021-11-08', 'tihonov@company.ru'),
('Гусева Екатерина Андреевна',   'PR-менеджер',           'Маркетинг',     98000.00, '2022-03-14', 'guseva@company.ru'),
('Алексеев Денис Викторович',    'Системный администратор','IT',           115000.00, '2020-12-01', 'alekseev@company.ru'),
('Никитина Светлана Олеговна',   'Рекрутер',              'HR',            85000.00, '2022-08-22', 'nikitina@company.ru'),
('Фёдоров Глеб Романович',       'Дизайнер',              'Маркетинг',    105000.00, '2021-05-17', 'fedorov@company.ru'),
('Михайлова Ирина Дмитриевна',   'Юрист',                 'Юридический',  135000.00, '2020-07-09', 'mihailova@company.ru'),
('Поляков Антон Игоревич',       'Кладовщик',             'Логистика',     65000.00, '2023-01-20', 'polyakov@company.ru'),
('Сидорова Наталья Александровна','Бухгалтер',            'Бухгалтерия',   78000.00, '2023-03-15', 'sidorova@company.ru'),
('Жуков Кирилл Петрович',        'Руководитель проектов', 'IT',           185000.00, '2019-12-18', 'zhukov@company.ru'),
('Андреева Полина Сергеевна',    'Менеджер по продажам',  'Продажи',      120000.00, '2022-05-25', 'andreeva@company.ru'),
('Виноградов Олег Михайлович',   'Менеджер по продажам',  'Продажи',      125000.00, '2020-08-13', 'vinogradov@company.ru'),
('Сорокина Дарья Владимировна',  'Менеджер по продажам',  'Продажи',      108000.00, '2023-04-10', 'sorokina@company.ru'),
('Захаров Тимур Эдуардович',     'Водитель-экспедитор',   'Логистика',     72000.00, '2022-10-05', 'zaharov@company.ru'),
('Куликова Алина Игоревна',      'Ассистент',             'HR',            65000.00, '2023-08-01', 'kulikova@company.ru')
ON CONFLICT DO NOTHING;

INSERT INTO tasks (title, description, assignee_id, status, priority, created_at, deadline, completed_at) VALUES
('Подготовить квартальный отчёт',     'Свести данные за Q1 2026 и подготовить презентацию',  2,  'in_progress','high',   '2026-03-25', '2026-04-30', NULL),
('Обновить сервер баз данных',        'Миграция PostgreSQL 15 → 16, проверка совместимости', 3,  'done',       'urgent', '2026-02-10', '2026-03-01', '2026-02-28'),
('Найти нового middle-разработчика',  'Открыть вакансию, провести 5 собеседований',          4,  'in_progress','medium', '2026-03-15', '2026-05-15', NULL),
('Закрыть сделку с ООО Ромашка',      'Подготовить документы и подписать договор',           7,  'done',       'high',   '2026-01-10', '2026-01-31', '2026-01-25'),
('Развернуть CI/CD pipeline',         'Настроить GitLab CI для всех проектов',               11, 'in_progress','high',   '2026-02-20', '2026-04-25', NULL),
('Закрыть месячный баланс',           'Свести проводки за март, акты сверки',                6,  'done',       'high',   '2026-04-01', '2026-04-15', '2026-04-14'),
('Лендинг для нового продукта',       'Дизайн + вёрстка, согласование с маркетингом',        10, 'in_progress','medium', '2026-03-10', '2026-05-10', NULL),
('Договор с поставщиком',             'Согласовать условия, юридическая проверка',           13, 'done',       'medium', '2026-02-05', '2026-02-28', '2026-02-26'),
('Холодные звонки по базе клиентов',  '50 контактов из CRM, заполнить отчёт',                8,  'in_progress','low',    '2026-04-01', '2026-04-30', NULL),
('Запустить рекламную кампанию',      'Google Ads + Яндекс.Директ, бюджет 200к',             12, 'open',       'high',   '2026-04-10', '2026-05-01', NULL),
('Аудит безопасности систем',         'Проверка прав доступа, обновление паролей',           19, 'open',       'urgent', '2026-04-15', '2026-05-15', NULL),
('Заказ канцелярии для офиса',        'Собрать заявки от отделов, оформить закупку',         20, 'done',       'low',    '2026-03-20', '2026-03-31', '2026-03-28'),
('Рефакторинг авторизации',           'Переход на JWT, разделение сервисов',                 5,  'in_progress','medium', '2026-03-01', '2026-05-30', NULL),
('Праздничная корпоративная рассылка','Поздравление клиентам ко Дню Победы',                 18, 'open',       'low',    '2026-04-20', '2026-05-08', NULL),
('Доставка серверного оборудования',  'Партия из 5 серверов в офис заказчика',               17, 'done',       'high',   '2026-03-12', '2026-03-25', '2026-03-22'),
('Расчёт зарплат за апрель',          'Начисления, премии, налоги',                          14, 'open',       'urgent', '2026-04-25', '2026-05-05', NULL),
('Презентация для совета директоров', 'Стратегия развития IT на 2026 год',                   25, 'in_progress','high',   '2026-04-05', '2026-05-12', NULL),
('Анализ конкурентов',                'SWOT-анализ топ-5 игроков рынка',                     12, 'done',       'medium', '2026-02-25', '2026-03-15', '2026-03-14'),
('Внедрение системы мониторинга',     'Prometheus + Grafana для production-серверов',        11, 'open',       'medium', '2026-04-12', '2026-05-31', NULL),
('Обучение новых сотрудников',        'Адаптационный тренинг для junior-разработчиков',      4,  'cancelled',  'low',    '2026-03-05', '2026-04-01', NULL),
('Контракт с АО ЭнергоСеть',          'Крупная сделка на 5.2 млн, согласование условий',     7,  'in_progress','urgent', '2026-04-08', '2026-05-20', NULL),
('Резервное копирование БД',          'Настроить ежедневные бэкапы в S3',                    11, 'done',       'high',   '2026-02-15', '2026-03-01', '2026-02-27'),
('Маркетинговое исследование',        'Опрос целевой аудитории, анализ результатов',         18, 'in_progress','medium', '2026-03-20', '2026-04-30', NULL),
('Юридическая проверка договоров',    'Все договоры свыше 1 млн за Q1',                      22, 'done',       'medium', '2026-04-01', '2026-04-15', '2026-04-13'),
('Тестирование нового модуля',        'Регрессионное + нагрузочное тестирование',            15, 'in_progress','high',   '2026-04-05', '2026-04-30', NULL),
('Обработка возвратов',               'Партия некачественного товара от поставщика',         17, 'done',       'medium', '2026-03-10', '2026-03-25', '2026-03-24'),
('Презентация продаж для клиента',    'Демо для потенциального клиента из Москвы',           26, 'open',       'high',   '2026-04-22', '2026-05-05', NULL),
('Установка нового оборудования',     'Серверная стойка в дата-центре',                      19, 'open',       'high',   '2026-04-18', '2026-05-10', NULL),
('Анализ продаж за квартал',          'Свод по регионам и продуктам',                        2,  'open',       'medium', '2026-04-15', '2026-05-15', NULL),
('Перевод документации на английский','Техническая документация для зарубежных клиентов',    10, 'cancelled',  'low',    '2026-02-28', '2026-04-30', NULL)
ON CONFLICT DO NOTHING;

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
