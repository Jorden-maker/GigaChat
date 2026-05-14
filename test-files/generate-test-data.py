"""
Генератор тестовых данных для table-merger.

Создаёт 5 xlsx и 5 docx файлов в текущей папке.

Все файлы — таблица «сотрудники компании» с одинаковой по смыслу
структурой, но с РАЗНЫМ написанием заголовков и в одном файле —
дополнительный столбец «Телефон». Это позволяет протестировать:

  - нормализацию заголовков (ФИО = Ф.И.О. = фио = Ф И О = один столбец);
  - union-логику с лишним столбцом (Телефон у других файлов будет пустым);
  - объединение разного числа строк из разных файлов.

Запуск:
    cd C:\\Users\\Lenovo\\Desktop\\GigaChat\\test-files
    C:\\table-merger\\venv\\Scripts\\python.exe generate-test-data.py
"""

import random
from datetime import date, timedelta
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from docx import Document


# Фиксируем seed чтобы при повторном запуске получались те же файлы.
random.seed(42)


NAMES_M = [
    'Иванов Иван Иванович',
    'Петров Пётр Петрович',
    'Сидоров Алексей Николаевич',
    'Кузнецов Дмитрий Сергеевич',
    'Смирнов Владимир Андреевич',
    'Соколов Михаил Викторович',
    'Попов Андрей Дмитриевич',
    'Лебедев Сергей Александрович',
    'Козлов Артём Олегович',
    'Новиков Илья Романович',
]
NAMES_F = [
    'Иванова Анна Сергеевна',
    'Петрова Мария Викторовна',
    'Сидорова Ольга Дмитриевна',
    'Кузнецова Екатерина Игоревна',
    'Смирнова Татьяна Николаевна',
    'Соколова Наталья Андреевна',
    'Попова Елена Александровна',
    'Лебедева Светлана Петровна',
    'Козлова Юлия Романовна',
    'Новикова Дарья Викторовна',
]

POSITIONS = [
    'Менеджер', 'Старший менеджер', 'Аналитик', 'Старший аналитик',
    'Разработчик', 'Тимлид', 'Дизайнер', 'Бухгалтер',
    'Тестировщик', 'Специалист по продажам', 'HR-специалист',
]

DEPARTMENTS = [
    'Маркетинг', 'Разработка', 'Финансы',
    'Продажи', 'HR', 'Поддержка',
]


# Описание файлов: (имя без расширения, заголовки)
# Намеренно разные написания одного и того же столбца — для теста нормализации.
FILE_VARIATIONS = [
    ('маркетинг',  ['ФИО',     'Должность',   'Отдел',   'Зарплата',   'Дата приёма']),
    ('разработка', ['Ф.И.О.',  'Должность',   'Отдел',   'Зарплата',   'Дата приёма']),
    ('финансы',    ['фио',     'должность',   'отдел',   'зарплата',   'дата приёма']),
    ('продажи',    ['ФИО',     'Должность',   'Отдел',   'Зарплата',   'Дата приёма', 'Телефон']),
    ('hr',         ['Ф И О',   'Должность',   'Отдел',   'Зарплата',   'Дата приёма']),
]


def normalize_for_match(h: str) -> str:
    """Тот же нормализатор что в сервисе — используем здесь чтобы понимать
    какой смысл несёт каждый заголовок при генерации значений."""
    import re
    return re.sub(r'[\s._\-(){}\[\]/\\:;,!?\"\' ]+', '', str(h).strip().lower())


def gen_value_for_header(header: str) -> object:
    """По имени заголовка генерируем подходящее значение."""
    key = normalize_for_match(header)
    if 'фио' in key:
        return random.choice(NAMES_M + NAMES_F)
    if 'должность' in key:
        return random.choice(POSITIONS)
    if 'отдел' in key:
        return random.choice(DEPARTMENTS)
    if 'зарплата' in key:
        return random.randint(50_000, 250_000)
    if 'датаприёма' in key or 'датаприема' in key:
        d = date(2018, 1, 1) + timedelta(days=random.randint(0, 365 * 7))
        return d.strftime('%d.%m.%Y')
    if 'телефон' in key:
        return '+7' + ''.join(str(random.randint(0, 9)) for _ in range(10))
    return '?'


# ---------- XLSX ----------

def make_xlsx(filepath: Path, headers: list, n_rows: int) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = 'Сотрудники'

    header_font = Font(bold=True, color='FFFFFFFF')
    header_fill = PatternFill('solid', fgColor='FF4F46E5')
    header_align = Alignment(horizontal='center', vertical='center')

    for col_idx, h in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_align

    for r in range(n_rows):
        for col_idx, h in enumerate(headers, start=1):
            ws.cell(row=r + 2, column=col_idx, value=gen_value_for_header(h))

    # Авто-ширина (грубая)
    for col_idx, h in enumerate(headers, start=1):
        max_len = max(len(str(h)), 20)
        for r in range(n_rows):
            v = ws.cell(row=r + 2, column=col_idx).value
            if v is not None and len(str(v)) > max_len:
                max_len = len(str(v))
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = min(max_len + 2, 40)

    ws.freeze_panes = 'A2'
    wb.save(filepath)


# ---------- DOCX ----------

def make_docx(filepath: Path, headers: list, n_rows: int, dept_label: str) -> None:
    doc = Document()
    # «Шапка» над таблицей — текстовый заголовок и параграф. Нужен чтобы
    # проверить: python-docx берёт ПЕРВУЮ ТАБЛИЦУ в документе, игнорируя
    # текст до неё.
    doc.add_heading(f'Отчёт по отделу: {dept_label}', level=1)
    doc.add_paragraph(
        'Источник: HR-отдел. Период: 2024 год. '
        'Документ сгенерирован автоматически для тестирования table-merger.'
    )
    doc.add_paragraph()  # пустая строка перед таблицей

    table = doc.add_table(rows=1 + n_rows, cols=len(headers))
    table.style = 'Light Grid Accent 1'

    # Заголовок таблицы
    hdr_cells = table.rows[0].cells
    for i, h in enumerate(headers):
        hdr_cells[i].text = h
        for paragraph in hdr_cells[i].paragraphs:
            for run in paragraph.runs:
                run.bold = True

    # Данные
    for r in range(n_rows):
        row_cells = table.rows[r + 1].cells
        for col_idx, h in enumerate(headers):
            v = gen_value_for_header(h)
            row_cells[col_idx].text = str(v)

    doc.add_paragraph()
    doc.add_paragraph(
        'Этот текст идёт ПОСЛЕ таблицы — он также должен быть проигнорирован.'
    )
    doc.save(filepath)


# ---------- main ----------

def main() -> None:
    out_dir = Path(__file__).parent
    print(f'Генерирую файлы в: {out_dir}')
    print()

    summary = []
    for idx, (name, headers) in enumerate(FILE_VARIATIONS, start=1):
        n_rows_x = random.randint(5, 12)
        xlsx_path = out_dir / f'{name}.xlsx'
        make_xlsx(xlsx_path, headers, n_rows_x)

        n_rows_d = random.randint(5, 12)
        docx_path = out_dir / f'{name}.docx'
        # Dept label для заголовка в docx — берём имя файла с большой буквы
        make_docx(docx_path, headers, n_rows_d, name.capitalize())

        summary.append((name, headers, n_rows_x, n_rows_d))
        print(f'  [{idx}/{len(FILE_VARIATIONS)}] {name}: '
              f'{len(headers)} колонок | xlsx={n_rows_x} строк | docx={n_rows_d} строк')

    print()
    print('Готово.')
    print()
    print('Сводка по заголовкам (видно вариативность для теста нормализации):')
    for name, headers, _, _ in summary:
        print(f'  {name}: {headers}')

    print()
    print('Что должно произойти при объединении ВСЕХ 5 файлов одного формата:')
    print('  • Колонка ФИО будет одна — нормализатор склеит разные написания')
    print('    (ФИО = Ф.И.О. = фио = Ф И О).')
    print('  • Колонки Должность / Отдел / Зарплата / Дата приёма — по одной.')
    print('  • Колонка Телефон будет в итоге — она есть только в файле «продажи».')
    print('    У строк из остальных файлов в этой колонке будет пусто.')


if __name__ == '__main__':
    main()
