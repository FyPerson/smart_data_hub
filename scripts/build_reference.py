#!/usr/bin/env python3
"""
build_reference.py - 构建 pandoc reference.docx 模板
基于企业汇报文稿排版规范，全局微软雅黑体系

排版规范参数：
  页面：A4，上下 2.54cm，左右 3.17cm
  正文：微软雅黑 小四(12pt)，行距 28磅固定值，首行缩进2字符
  标题：微软雅黑加粗，按层级递减
    Title:     小二(18pt)  居中
    Heading 1: 三号(16pt)  段前18磅 段后12磅
    Heading 2: 小三(15pt)  段前16磅 段后8磅
    Heading 3: 四号(14pt)  段前12磅 段后6磅
    Heading 4: 小四(12pt)加粗  段前8磅 段后4磅
"""

import subprocess
from pathlib import Path

from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.oxml.ns import qn, nsdecls
from docx.oxml import parse_xml
from docx.enum.text import WD_ALIGN_PARAGRAPH

PANDOC = r"C:\Users\FY\AppData\Local\Microsoft\WinGet\Packages\JohnMacFarlane.Pandoc_Microsoft.Winget.Source_8wekyb3d8bbwe\pandoc-3.9\pandoc.exe"
OUTPUT = str(Path(__file__).parent / "reference.docx")
FONT = "微软雅黑"
BLUE = "2C5AA0"


def set_style_font(style, font_name, size_pt, bold=False, color=None):
    """设置样式的字体属性"""
    style.font.name = font_name
    style.font.size = Pt(size_pt)
    style.font.bold = bold
    if color:
        style.font.color.rgb = color
    # 东亚字体
    rPr = style.element.find(qn("w:rPr"))
    if rPr is None:
        rPr = parse_xml(f'<w:rPr {nsdecls("w")}/>')
        style.element.append(rPr)
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = parse_xml(f'<w:rFonts {nsdecls("w")} w:eastAsia="{font_name}"/>')
        rPr.insert(0, rFonts)
    else:
        rFonts.set(qn("w:eastAsia"), font_name)


def set_paragraph_format(style, align=None, space_before=None, space_after=None,
                         line_spacing=None, first_indent=None):
    """设置样式的段落格式"""
    pf = style.paragraph_format
    if align is not None:
        pf.alignment = align
    if space_before is not None:
        pf.space_before = Pt(space_before)
    if space_after is not None:
        pf.space_after = Pt(space_after)
    if line_spacing is not None:
        pf.line_spacing = Pt(line_spacing)
    if first_indent is not None:
        pf.first_line_indent = Pt(first_indent)


def main():
    # 1. 用 pandoc 导出默认模板
    subprocess.run([PANDOC, "-o", OUTPUT, "--print-default-data-file", "reference.docx"],
                   capture_output=True)

    # 2. 用 python-docx 修改样式
    doc = Document(OUTPUT)

    # --- 页面设置 ---
    for section in doc.sections:
        section.page_width = Cm(21.0)
        section.page_height = Cm(29.7)
        section.top_margin = Cm(2.54)
        section.bottom_margin = Cm(2.54)
        section.left_margin = Cm(3.17)
        section.right_margin = Cm(3.17)

    # --- Normal（正文）---
    normal = doc.styles["Normal"]
    set_style_font(normal, FONT, 12)  # 小四 = 12pt
    set_paragraph_format(normal, line_spacing=28, space_before=0, space_after=0)

    # --- Title ---
    title = doc.styles["Title"]
    set_style_font(title, FONT, 18, bold=True)  # 小二 = 18pt
    set_paragraph_format(title, align=WD_ALIGN_PARAGRAPH.CENTER,
                         space_before=24, space_after=18)

    # --- Subtitle ---
    if "Subtitle" in [s.name for s in doc.styles]:
        subtitle = doc.styles["Subtitle"]
        set_style_font(subtitle, FONT, 15)  # 小三 = 15pt
        set_paragraph_format(subtitle, align=WD_ALIGN_PARAGRAPH.CENTER,
                             space_before=12, space_after=12)

    # --- Heading 1 ---
    h1 = doc.styles["Heading 1"]
    set_style_font(h1, FONT, 16, bold=True, color=RGBColor(0x00, 0x00, 0x00))  # 三号 = 16pt
    set_paragraph_format(h1, space_before=18, space_after=12, line_spacing=28)

    # --- Heading 2 ---
    h2 = doc.styles["Heading 2"]
    set_style_font(h2, FONT, 15, bold=True, color=RGBColor(0x00, 0x00, 0x00))  # 小三 = 15pt
    set_paragraph_format(h2, space_before=16, space_after=8, line_spacing=28)

    # --- Heading 3 ---
    h3 = doc.styles["Heading 3"]
    set_style_font(h3, FONT, 14, bold=True, color=RGBColor(0x00, 0x00, 0x00))  # 四号 = 14pt
    set_paragraph_format(h3, space_before=12, space_after=6, line_spacing=28)

    # --- Heading 4 ---
    h4 = doc.styles["Heading 4"]
    set_style_font(h4, FONT, 12, bold=True, color=RGBColor(0x00, 0x00, 0x00))  # 小四加粗
    set_paragraph_format(h4, space_before=8, space_after=4, line_spacing=28)

    # --- Block Text（引用块）--- 清理模板级装饰
    if "Block Text" in [s.name for s in doc.styles]:
        bt = doc.styles["Block Text"]
        set_style_font(bt, FONT, 10, bold=False, color=RGBColor(0x55, 0x55, 0x55))
        bt.font.italic = True
        # 清除模板级边框和背景
        pPr = bt.element.find(qn("w:pPr"))
        if pPr is not None:
            for tag in ("w:pBdr", "w:shd"):
                el = pPr.find(qn(tag))
                if el is not None:
                    pPr.remove(el)

    # --- 表格样式 ---
    for style_name in ("Table Grid", "Table"):
        if style_name in [s.name for s in doc.styles]:
            ts = doc.styles[style_name]
            if hasattr(ts, 'font'):
                set_style_font(ts, FONT, 9)

    doc.save(OUTPUT)
    print(f"模板已生成: {OUTPUT}")
    print(f"  页面: A4, 上下 2.54cm, 左右 3.17cm")
    print(f"  正文: {FONT} 小四(12pt), 行距 28磅")
    print(f"  标题: H1=16pt H2=15pt H3=14pt H4=12pt 全部加粗黑色")


if __name__ == "__main__":
    main()
