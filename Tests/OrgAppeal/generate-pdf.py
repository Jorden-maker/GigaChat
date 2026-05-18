# -*- coding: utf-8 -*-
"""
Генератор PDF-аналогов 7 тестовых документов «Организация обращения».

Содержимое идентично docx (импортирует TEST_CASES из generate.py).
Используется для тестирования OCR-ветки workflow.

Требует: pip install reportlab
Cyrillic шрифт: C:\\Windows\\Fonts\\arial.ttf (или подменить в FONT_PATH).

Запуск:
    pip install reportlab
    python generate-pdf.py
"""

import os
import sys

# Импортируем тест-кейсы из соседнего скрипта — единый источник правды
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate import TEST_CASES  # noqa: E402

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

# --- Настройки ---
FONT_PATH = r'C:\Windows\Fonts\arial.ttf'
FONT_BOLD_PATH = r'C:\Windows\Fonts\arialbd.ttf'
OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))

# Регистрируем кириллический шрифт (стандартные Helvetica/Times без UTF-8)
pdfmetrics.registerFont(TTFont('Arial', FONT_PATH))
pdfmetrics.registerFont(TTFont('Arial-Bold', FONT_BOLD_PATH))


def create_pdf(filename, lines):
    """Рисует PDF: одна страница A4, ~12pt текст, поля 25 мм."""
    path = os.path.join(OUTPUT_DIR, filename)
    if os.path.exists(path):
        os.remove(path)

    c = canvas.Canvas(path, pagesize=A4)
    width, height = A4
    left = 25 * mm
    top = height - 25 * mm
    line_height = 16  # pt

    y = top
    for line in lines:
        if line == '':
            y -= line_height // 2
            continue
        # Первая строка («СЛУЖЕБНАЯ ЗАПИСКА») — заголовок жирным крупнее
        if y == top:
            c.setFont('Arial-Bold', 14)
        else:
            c.setFont('Arial', 11)
        c.drawString(left, y, line)
        y -= line_height
        if y < 25 * mm:  # переполнение страницы
            c.showPage()
            y = top

    c.save()
    print(f'  [ok] {filename}')


def main():
    print(f'Генерация тестовых .pdf -> {OUTPUT_DIR}\n')
    for case in TEST_CASES:
        # filename: меняем .docx на .pdf
        pdf_name = case['file'].replace('.docx', '.pdf')
        create_pdf(pdf_name, case['lines'])
    print(f'\nГотово, файлов: {len(TEST_CASES)}\n')

    print('Сводка ожидаемых итогов (та же, что для .docx):')
    print('-' * 80)
    for case in TEST_CASES:
        pdf_name = case['file'].replace('.docx', '.pdf')
        print(f'{pdf_name}')
        print(f'    {case["expected"]}')
        print()


if __name__ == '__main__':
    main()
