-- ============================================================================
-- init-rel-db.sql — ДОМАШНЯЯ тестовая копия офисной базы документов `rel_db`.
--
-- Зачем: чтобы дома работала RAG dual-source ветка (Поиск внешний / Список
-- внешний), которая в офисе ходит в `rel_db._vectordocuments.v_general`.
--
-- ВАЖНО: офисная v_general создана ДРУГОЙ системой; точные типы столбцов нам
-- неизвестны. Здесь — приближённая структура под те столбцы, что реально
-- использует RAG (file_name, text, vector, document_id, uploaded_at). Для
-- ДОМАШНЕГО теста этого достаточно. В офисе этот скрипт прогонять НЕ нужно —
-- там база уже наполнена.
--
-- Запуск (один раз):
--   psql -U postgres -f "init-rel-db.sql"
-- (создаст базу rel_db, переключится в неё, создаст схему/таблицу + тестовые
--  документы; vector=NULL — список/подсчёт документов заработает, а
--  семантический поиск дома не заработает без локального embedding-сервера —
--  это ожидаемо).
-- ============================================================================

\echo '== Создаю базу rel_db (если ещё нет) =='
SELECT 'CREATE DATABASE rel_db'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'rel_db')\gexec

\c rel_db

\echo '== Расширение pgvector =='
CREATE EXTENSION IF NOT EXISTS vector;

\echo '== Схема _vectordocuments + таблица v_general =='
CREATE SCHEMA IF NOT EXISTS _vectordocuments;

CREATE TABLE IF NOT EXISTS _vectordocuments.v_general (
    id            SERIAL PRIMARY KEY,
    vector        vector(1024),           -- та же размерность что у нас (1024)
    text          TEXT,
    document_id   TEXT,                   -- ключ группировки документов (в офисе тип может отличаться)
    file_name     VARCHAR(500),
    chunk_index   INTEGER,
    total_chunks  INTEGER,
    metadata      JSONB,
    uploaded_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_vgeneral_document ON _vectordocuments.v_general (document_id);

\echo '== Тестовые документы (3 документа / 4 чанка, vector=NULL) =='
INSERT INTO _vectordocuments.v_general (vector, text, document_id, file_name, chunk_index, total_chunks, uploaded_at) VALUES
(NULL, 'Регламент по охране труда. Общие положения и требования к рабочим местам.', 'doc-1', 'Регламент_ОТ.pdf',           0, 2, NOW() - INTERVAL '5 days'),
(NULL, 'Регламент по охране труда. Порядок проведения инструктажей и проверок.',   'doc-1', 'Регламент_ОТ.pdf',           1, 2, NOW() - INTERVAL '5 days'),
(NULL, 'Положение о служебных командировках: оформление, суточные, отчётность.',   'doc-2', 'Командировки.docx',          0, 1, NOW() - INTERVAL '3 days'),
(NULL, 'Инструкция по пожарной безопасности: эвакуация, огнетушители, ответственные.', 'doc-3', 'Пожарная_безопасность.pdf', 0, 1, NOW() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;

\echo '== Готово. Проверка структуры и количества: =='
SELECT
  COUNT(*)                    AS всего_строк,
  COUNT(DISTINCT document_id) AS документов
FROM _vectordocuments.v_general;
