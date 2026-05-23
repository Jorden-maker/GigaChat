# -*- coding: utf-8 -*-
# Генератор тестовых файлов для Agents/file-merger.html.
# Создаёт 5 .docx (текст / таблица / mixed / multiple tables / long text)
# и 5 .xlsx (разной структуры) в этой папке.
# Использует только stdlib (zipfile + xml-строки), без внешних библиотек.
#
# Запуск:  python "Тест. Объединение файлов/_generate.py"

import os
import sys
import zipfile
from pathlib import Path

TD = Path(__file__).parent.resolve()


# ============ Утилиты ============

def esc(s):
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


# ============ DOCX ============

def make_docx(filename, body_xml):
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '</Relationships>'
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body>'
        + body_xml +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
        '</w:body></w:document>'
    )
    path = TD / filename
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', content_types)
        zf.writestr('_rels/.rels', rels)
        zf.writestr('word/document.xml', document)
    print('  + ' + filename)


def P(text):
    return '<w:p><w:r><w:t xml:space="preserve">' + esc(text) + '</w:t></w:r></w:p>'


def TBL(rows):
    cols = max(len(r) for r in rows)
    cell_w = 9000 // cols
    grid = ''.join('<w:gridCol w:w="' + str(cell_w) + '"/>' for _ in range(cols))
    tr_xml = ''
    for row in rows:
        tc_xml = ''
        for i in range(cols):
            cell = row[i] if i < len(row) else ''
            tc_xml += (
                '<w:tc><w:tcPr><w:tcW w:w="' + str(cell_w) + '" w:type="dxa"/></w:tcPr>'
                '<w:p><w:r><w:t xml:space="preserve">' + esc(cell) + '</w:t></w:r></w:p>'
                '</w:tc>'
            )
        tr_xml += '<w:tr>' + tc_xml + '</w:tr>'
    borders = ''.join(
        '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
        for side in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV')
    )
    return (
        '<w:tbl>'
        '<w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>' + borders + '</w:tblBorders></w:tblPr>'
        '<w:tblGrid>' + grid + '</w:tblGrid>'
        + tr_xml +
        '</w:tbl>'
    )


# ============ XLSX ============

def col_letter(n):
    s = ''
    while n >= 0:
        s = chr(ord('A') + n % 26) + s
        n = n // 26 - 1
    return s


def make_xlsx(filename, sheet_name, rows):
    strings = {}
    string_list = []
    for row in rows:
        for cell in row:
            if isinstance(cell, str):
                if cell not in strings:
                    strings[cell] = len(string_list)
                    string_list.append(cell)

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>'
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="' + esc(sheet_name) + '" sheetId="1" r:id="rId1"/></sheets>'
        '</workbook>'
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
        '</Relationships>'
    )
    rows_xml = ''
    for r_idx, row in enumerate(rows):
        cells_xml = ''
        for c_idx, cell in enumerate(row):
            ref = col_letter(c_idx) + str(r_idx + 1)
            if isinstance(cell, str):
                cells_xml += '<c r="' + ref + '" t="s"><v>' + str(strings[cell]) + '</v></c>'
            else:
                cells_xml += '<c r="' + ref + '"><v>' + str(cell) + '</v></c>'
        rows_xml += '<row r="' + str(r_idx + 1) + '">' + cells_xml + '</row>'
    sheet1 = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetData>' + rows_xml + '</sheetData>'
        '</worksheet>'
    )
    total = sum(1 for r in rows for c in r if isinstance(c, str))
    si_xml = ''.join('<si><t xml:space="preserve">' + esc(s) + '</t></si>' for s in string_list)
    sst = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + str(total) + '" uniqueCount="' + str(len(string_list)) + '">'
        + si_xml +
        '</sst>'
    )
    path = TD / filename
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', content_types)
        zf.writestr('_rels/.rels', rels)
        zf.writestr('xl/workbook.xml', workbook)
        zf.writestr('xl/_rels/workbook.xml.rels', wb_rels)
        zf.writestr('xl/worksheets/sheet1.xml', sheet1)
        zf.writestr('xl/sharedStrings.xml', sst)
    print('  + ' + filename)


# ============ Генерация ============

def main():
    print('== Word ==')
    make_docx('word-1-только-текст.docx',
        P('Это первый Word-документ с обычным текстом.') +
        P('Он содержит несколько параграфов для теста объединителя.') +
        P('Второй параграф — про погоду в Москве. Сейчас тут солнечно.') +
        P('И третий, чтобы было что объединять.')
    )
    make_docx('word-2-только-таблица.docx',
        TBL([
            ['Имя', 'Возраст', 'Город'],
            ['Иван', '30', 'Москва'],
            ['Мария', '25', 'Санкт-Петербург'],
            ['Алексей', '35', 'Казань'],
            ['Ольга', '28', 'Новосибирск'],
        ])
    )
    make_docx('word-3-текст-плюс-таблица.docx',
        P('Заголовок раздела «Параметры заказа»') +
        P('Это пример Word-документа со смешанным содержимым: сначала параграфы, потом таблица.') +
        TBL([
            ['Параметр', 'Значение'],
            ['Цена', '1500 ₽'],
            ['Количество', '5 шт.'],
            ['Скидка', '10%'],
            ['Итого', '6750 ₽'],
        ])
    )
    make_docx('word-4-несколько-таблиц.docx',
        P('Первая таблица — продажи по месяцам') +
        TBL([
            ['Месяц', 'Сумма'],
            ['Январь', '120 000 ₽'],
            ['Февраль', '145 000 ₽'],
            ['Март', '178 000 ₽'],
        ]) +
        P('Вторая таблица — расходы') +
        TBL([
            ['Категория', 'Бюджет'],
            ['Реклама', '30 000 ₽'],
            ['Зарплата', '80 000 ₽'],
            ['Аренда', '45 000 ₽'],
        ])
    )
    make_docx('word-5-длинный-текст.docx',
        P('Глава 1. Введение') +
        P('Здесь начинается описание проекта. Документ содержит три главы для демонстрации объединения длинных текстов.') +
        P('Каждая глава имеет несколько параграфов, чтобы при склейке было заметно, как тулзе удаётся сохранить структуру.') +
        P('Глава 2. Основная часть') +
        P('Описание основной задачи. Содержит несколько предложений с разными формулировками.') +
        P('Второй параграф главы 2 со списком: первое, второе, третье.') +
        P('Третий параграф главы 2 — продолжение мысли. Просто чтобы было больше контента.') +
        P('Глава 3. Заключение') +
        P('Краткие выводы по проекту. Все основные пункты раскрыты.') +
        P('Спасибо за внимание!')
    )

    print('== Excel ==')
    make_xlsx('excel-1-сотрудники.xlsx', 'Сотрудники', [
        ['Имя', 'Должность', 'Зарплата'],
        ['Иванов И.И.', 'Менеджер', 50000],
        ['Петров П.П.', 'Разработчик', 80000],
        ['Сидорова С.С.', 'Дизайнер', 65000],
        ['Смирнов А.А.', 'Аналитик', 75000],
    ])
    make_xlsx('excel-2-товары.xlsx', 'Прайс-лист', [
        ['№', 'Товар', 'Цена', 'Количество', 'Сумма'],
        [1, 'Хлеб белый', 50, 2, 100],
        [2, 'Молоко 3.2%', 80, 3, 240],
        [3, 'Сыр Российский', 350, 1, 350],
        [4, 'Яблоки', 120, 2, 240],
        [5, 'Огурцы', 90, 5, 450],
        [6, 'Помидоры', 150, 3, 450],
    ])
    make_xlsx('excel-3-финансы.xlsx', 'Бюджет', [
        ['Месяц', 'Доход', 'Расход', 'Прибыль'],
        ['Январь', 250000, 180000, 70000],
        ['Февраль', 280000, 195000, 85000],
        ['Март', 310000, 200000, 110000],
        ['Апрель', 295000, 210000, 85000],
    ])
    make_xlsx('excel-4-контакты.xlsx', 'Контакты', [
        ['ФИО', 'Телефон', 'Email', 'Город'],
        ['Иванов Иван Иванович', '+7(495)123-45-67', 'ivanov@example.ru', 'Москва'],
        ['Петрова Мария Алексеевна', '+7(812)987-65-43', 'petrova@example.ru', 'Санкт-Петербург'],
        ['Сидоров Алексей Константинович', '+7(383)555-12-34', 'sidorov@example.ru', 'Новосибирск'],
        ['Кузнецов Дмитрий Петрович', '+7(343)444-55-66', 'kuznetsov@example.ru', 'Екатеринбург'],
    ])
    make_xlsx('excel-5-расписание.xlsx', 'Расписание', [
        ['День', 'Время', 'Аудитория', 'Преподаватель', 'Дисциплина'],
        ['Понедельник', '09:00', '101', 'Иванов И.И.', 'Математика'],
        ['Понедельник', '10:30', '203', 'Петров П.П.', 'Физика'],
        ['Вторник', '09:00', '101', 'Иванов И.И.', 'Математика'],
        ['Вторник', '11:00', '305', 'Сидорова С.С.', 'История'],
        ['Среда', '09:00', '407', 'Кузнецов Д.П.', 'Информатика'],
    ])

    print('---')
    print('Готово: 10 файлов в ' + str(TD))


if __name__ == '__main__':
    main()
