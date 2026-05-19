# -*- coding: utf-8 -*-
"""
Генератор тестовых .docx-документов для алгоритма «Организация обращения» v2.

10 файлов — по одному на каждый возможный исход алгоритма (A-J).
См. OrgAppeal-Setup.md разделы 2 (логика) и 7 (тест-сценарии).

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
            parts.append(f'<w:p><w:r><w:t xml:space="preserve">{txt}</w:t></w:r></w:p>')
    parts.append('</w:body></w:document>')
    return '\n'.join(parts)


def create_docx(filename, lines):
    path = os.path.join(OUTPUT_DIR, filename)
    if os.path.exists(path):
        os.remove(path)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', CONTENT_TYPES_XML)
        zf.writestr('_rels/.rels', RELS_XML)
        zf.writestr('word/document.xml', build_document_xml(lines))
    print(f'  [ok] {filename}')


def appeal(fio=None, birth_date=None, personal_number=None, snils=None, reason='предоставления отпуска'):
    """
    Шаблон тела служебной записки. Любое поле = None → пропускается.
    Это позволяет создать «битый» документ для A/B/C-сценариев.
    """
    lines = [
        'СЛУЖЕБНАЯ ЗАПИСКА',
        '',
    ]
    if fio is not None:
        lines.append(f'От: {fio}')
    if birth_date is not None:
        lines.append(f'Дата рождения: {birth_date}')
    if personal_number is not None:
        lines.append(f'Личный номер: {personal_number}')
    if snils is not None:
        lines.append(f'СНИЛС: {snils}')
    lines.extend([
        '',
        f'Прошу рассмотреть моё обращение по поводу {reason}.',
        '',
        'Прошу принять решение в установленные сроки.',
        '',
        'Дата подачи: 19.05.2026',
    ])
    if fio is not None:
        parts = fio.split()
        sig_short = f'{parts[0]} {parts[1][0]}.{parts[2][0]}.' if len(parts) >= 3 else fio
        lines.append(f'Подпись: _____________ / {sig_short} /')
    else:
        lines.append('Подпись: _____________ / _____________ /')
    return lines


# --- Тест-кейсы (10 финальных исходов алгоритма) ---

TEST_CASES = [
    # A. Нет ФИО в документе
    {
        'file': '01-no-fio.docx',
        'lines': appeal(
            fio=None,
            birth_date='15.03.1985',
            personal_number='123-456',
            snils='123-456-789 01',
            reason='предоставления отпуска',
        ),
        'expected': 'Шаг 1: «ФИО заявителя отсутствует, нужно предоставить данные»',
    },

    # B. Нет даты рождения
    {
        'file': '02-no-birth.docx',
        'lines': appeal(
            fio='Иванов Иван Иванович',
            birth_date=None,
            personal_number='111-111',
            snils='111-111-111 01',
            reason='оформления командировки',
        ),
        'expected': 'Шаг 1: «Дата рождения заявителя отсутствует, нужно предоставить данные»',
    },

    # C. Нет Личного номера И нет СНИЛС
    {
        'file': '03-no-id.docx',
        'lines': appeal(
            fio='Петров Пётр Петрович',
            birth_date='22.07.1990',
            personal_number=None,
            snils=None,
            reason='перевода в другой отдел',
        ),
        'expected': 'Шаг 1: «Личный номер или СНИЛС заявителя отсутствует»',
    },

    # D. ФИО не в реестре employees
    {
        'file': '04-not-in-db.docx',
        'lines': appeal(
            fio='Кузнецов Алексей Сергеевич',
            birth_date='17.09.1995',
            personal_number='444-444',
            snils='444-444-444 04',
            reason='учебного отпуска',
        ),
        'expected': 'Шаг 2: «Заявитель не идентифицирован, нужно предоставить дополнительные данные»',
    },

    # E. ФИО в employees, но без табельного номера (NULL)
    {
        'file': '05-no-tab-number.docx',
        'lines': appeal(
            fio='Сидоров Сидор Сидорович',
            birth_date='08.11.1978',
            personal_number='555-555',
            snils='555-555-555 05',
            reason='перевода в другой отдел',
        ),
        'expected': 'Шаг 2: «Сведений о заявителе недостаточно, нужно сделать запрос»',
    },

    # F. ФИО + ТН в employees, но НЕТ в event1
    {
        'file': '06-not-in-event1.docx',
        'lines': appeal(
            fio='Богданов Богдан Богданович',
            birth_date='03.04.1982',
            personal_number='666-666',
            snils='666-666-666 06',
            reason='изменения графика работы',
        ),
        'expected': 'Шаг 3: «Сведения по данному заявителю отсутствуют»',
    },

    # G. ФИО + ТН в employees, в event1 is_done=FALSE
    {
        'file': '07-event1-not-done.docx',
        'lines': appeal(
            fio='Морозов Михаил Михайлович',
            birth_date='12.06.1988',
            personal_number='777-777',
            snils='777-777-777 07',
            reason='материальной помощи',
        ),
        'expected': 'Шаг 3: «Для данного заявителя мероприятие №1 не выполнено»',
    },

    # H. event1 done, но НЕТ в event2
    {
        'file': '08-not-in-event2.docx',
        'lines': appeal(
            fio='Михайлов Дмитрий Александрович',
            birth_date='11.06.1980',
            personal_number='888-888',
            snils='888-888-888 08',
            reason='согласования удалённой работы',
        ),
        'expected': 'Шаг 4: «Сведения по данному заявителю отсутствуют» (нет в event2)',
    },

    # I. event1 done, event2 is_done=FALSE
    {
        'file': '09-event2-not-done.docx',
        'lines': appeal(
            fio='Васильев Андрей Сергеевич',
            birth_date='29.01.1987',
            personal_number='999-999',
            snils='999-999-999 09',
            reason='разъяснения по приказу',
        ),
        'expected': 'Шаг 4: «Данному заявителю необходимо обратиться за помощью»',
    },

    # J. Полный успех — все 4 фазы пройдены
    {
        'file': '10-full-success.docx',
        'lines': appeal(
            fio='Иванова Иванна Ивановна',
            birth_date='15.03.1985',
            personal_number='100-100',
            snils='100-100-100 10',
            reason='предоставления дополнительного отпуска',
        ),
        'expected': '🎉 «Для данного заявителя все мероприятия пройдены успешно»',
    },
]


def main():
    print(f'Генерация тестовых .docx -> {OUTPUT_DIR}\n')
    for case in TEST_CASES:
        create_docx(case['file'], case['lines'])
    print(f'\nГотово, файлов: {len(TEST_CASES)}\n')

    print('Сводка ожидаемых итогов:')
    print('-' * 80)
    for case in TEST_CASES:
        print(f'{case["file"]}')
        print(f'    {case["expected"]}')
        print()


if __name__ == '__main__':
    main()
