# -*- coding: utf-8 -*-
"""
Генератор тестовых .docx-документов для алгоритма «Организация обращения».

Каждый файл — обращение от конкретного сотрудника с известным сценарием
(см. OrgAppeal-Setup.md, раздел 7). После прогона через workflow
организация-обращения они должны давать предсказуемый итог.

Не требует внешних зависимостей: только zipfile + строки.

Запуск:
    python generate.py
"""

import os
import zipfile
from xml.sax.saxutils import escape

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))

# --- Шаблоны OOXML ---

CONTENT_TYPES_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
'''

RELS_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
'''


def build_document_xml(lines):
    """Строит word/document.xml из списка строк (каждая — отдельный параграф)."""
    parts = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body>',
    ]
    for line in lines:
        if line == '':
            parts.append('<w:p/>')
        else:
            txt = escape(line)
            parts.append(
                f'<w:p><w:r><w:t xml:space="preserve">{txt}</w:t></w:r></w:p>'
            )
    parts.append('</w:body></w:document>')
    return '\n'.join(parts)


def create_docx(filename, lines):
    """Создаёт минимально валидный .docx (zip с тремя XML)."""
    path = os.path.join(OUTPUT_DIR, filename)
    if os.path.exists(path):
        os.remove(path)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', CONTENT_TYPES_XML)
        zf.writestr('_rels/.rels', RELS_XML)
        zf.writestr('word/document.xml', build_document_xml(lines))
    print(f'  [ok] {filename}')


def appeal(fio, tab_number, birth_date, reason):
    """Шаблон тела служебной записки."""
    return [
        'СЛУЖЕБНАЯ ЗАПИСКА',
        '',
        f'От: {fio}',
        f'Табельный номер: {tab_number}',
        f'Дата рождения: {birth_date}',
        '',
        f'Прошу рассмотреть моё обращение по поводу {reason}.',
        '',
        'Прошу принять решение в установленные сроки.',
        '',
        'Дата подачи: 18.05.2026',
        f'Подпись: _____________ / {fio.split()[0]} {fio.split()[1][0]}.{fio.split()[2][0]}. /',
    ]


# --- Тест-кейсы ---

TEST_CASES = [
    # 1. Полный успех — все 3 шага OK
    {
        'file': '01-ivanov-full-success.docx',
        'lines': appeal(
            'Иванов Иван Иванович',
            '10001',
            '15.03.1985',
            'предоставления дополнительного отпуска'
        ),
        'expected': 'Шаг 1 ОК -> Шаг 2 ОК -> Шаг 3 ОК -> «Для данного ФИО проводится проверка»',
    },

    # 2. ФИО есть в employees + номер совпадает, но в event1 не зарегистрирован
    {
        'file': '02-petrov-no-event1.docx',
        'lines': appeal(
            'Петров Пётр Петрович',
            '10002',
            '22.07.1990',
            'оформления командировки'
        ),
        'expected': 'Шаг 1 ОК -> Шаг 2: «Сведения о данном ФИО отсутствуют»',
    },

    # 3. ФИО + номер OK, но Мероприятие №1 НЕ выполнено
    {
        'file': '03-sidorov-event1-not-done.docx',
        'lines': appeal(
            'Сидоров Сидор Сидорович',
            '10003',
            '08.11.1978',
            'перевода в другой отдел'
        ),
        'expected': 'Шаг 1 ОК -> Шаг 2: «Мероприятие №1 для ФИО не выполнено»',
    },

    # 4. ФИО есть, но НОМЕР НЕ СОВПАДАЕТ (в БД: 10004, в документе: 99999)
    {
        'file': '04-smirnov-wrong-number.docx',
        'lines': appeal(
            'Смирнов Семён Семёнович',
            '99999',  # ← намеренно неверный
            '03.04.1982',
            'выплаты материальной помощи'
        ),
        'expected': 'Шаг 1: «Идентификация прошла частично» (ФИО есть, номер не совпал)',
    },

    # 5. ФИО ВООБЩЕ нет в БД сотрудников
    {
        'file': '05-kuznetsov-not-found.docx',
        'lines': appeal(
            'Кузнецов Алексей Сергеевич',
            '88888',
            '17.09.1995',
            'предоставления учебного отпуска'
        ),
        'expected': 'Шаг 1: «Невозможно идентифицировать» (ФИО не найдено)',
    },

    # 6. Шаги 1 и 2 OK, но event2 НЕ выполнено
    {
        'file': '06-vasilyev-event2-not-done.docx',
        'lines': appeal(
            'Васильев Андрей Сергеевич',
            '10005',
            '29.01.1987',
            'изменения графика работы'
        ),
        'expected': 'Шаг 1 ОК -> Шаг 2 ОК -> Шаг 3: «Мероприятие №2 для ФИО не выполнено»',
    },

    # 7. Шаги 1 и 2 OK, но ФИО НЕ в event2 (нет записи)
    {
        'file': '07-mikhaylov-no-event2.docx',
        'lines': appeal(
            'Михайлов Дмитрий Александрович',
            '10006',
            '11.06.1980',
            'согласования удалённой работы'
        ),
        'expected': 'Шаг 1 ОК -> Шаг 2 ОК -> Шаг 3: «Сведения о Мероприятии №2 отсутствуют»',
    },
]


def main():
    print(f'Генерация тестовых .docx -> {OUTPUT_DIR}\n')
    for case in TEST_CASES:
        create_docx(case['file'], case['lines'])
    print(f'\nГотово, файлов: {len(TEST_CASES)}\n')

    # Печатаем сводку ожидаемых результатов
    print('Сводка ожидаемых итогов:')
    print('-' * 80)
    for case in TEST_CASES:
        print(f'{case["file"]}')
        print(f'    {case["expected"]}')
        print()


if __name__ == '__main__':
    main()
