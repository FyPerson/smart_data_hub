#!/usr/bin/env python3
"""
md2html.py - Markdown → HTML 转换脚本（邮件友好版）
用法: python scripts/md2html.py input.md [output.html]
      如不指定 output，自动生成同名 .html

流程: pandoc 转换 → 注入邮件友好的内嵌 CSS → 清理冗余结构
依赖: pandoc 3.x

设计目标: 输出的 HTML 可以直接复制到邮件客户端（Outlook / 网页邮件）作为正文，
或作为 .html 附件打开。样式参考企业汇报邮件约定：
  - 最大宽度 800px 居中
  - 微软雅黑 + 1.8 行距
  - 正文两端对齐
  - 标题带下划线
  - 内联 CSS，无外部依赖
"""

import sys
import os
import subprocess
from pathlib import Path

PANDOC = r"C:\Users\FY\AppData\Local\Microsoft\WinGet\Packages\JohnMacFarlane.Pandoc_Microsoft.Winget.Source_8wekyb3d8bbwe\pandoc-3.9\pandoc.exe"

# 邮件友好的内嵌 CSS 样式（参考原阶段汇报 HTML）
HTML_STYLE = """
<style>
    body {
        font-family: "Microsoft YaHei", "SimSun", sans-serif;
        line-height: 1.8;
        max-width: 800px;
        margin: 40px auto;
        padding: 20px 40px;
        color: #333;
    }
    h1 {
        margin-top: 30px;
        margin-bottom: 20px;
        padding-bottom: 10px;
        border-bottom: 2px solid #2C5AA0;
        color: #2C5AA0;
        font-size: 22px;
    }
    h2 {
        margin-top: 30px;
        margin-bottom: 15px;
        padding-bottom: 8px;
        border-bottom: 1px solid #2C5AA0;
        color: #2C5AA0;
        font-size: 18px;
    }
    h3 {
        margin-top: 30px;
        margin-bottom: 15px;
        border-bottom: 1px solid #ddd;
        padding-bottom: 8px;
        font-size: 17px;
    }
    h4 {
        margin-top: 20px;
        margin-bottom: 10px;
        color: #444;
        font-size: 16px;
    }
    p {
        margin: 12px 0;
        text-align: justify;
    }
    ul, ol {
        margin: 10px 0;
        padding-left: 24px;
    }
    li {
        margin: 6px 0;
    }
    li p {
        margin: 6px 0;
    }
    strong {
        font-weight: bold;
        color: #2C5AA0;
    }
    em {
        color: #666;
    }
    blockquote {
        border-left: 3px solid #2C5AA0;
        margin: 15px 0;
        padding: 8px 16px;
        background: #F5F7FA;
        color: #555;
        font-style: italic;
    }
    hr {
        border: none;
        border-top: 1px solid #ddd;
        margin: 30px 0;
    }
    table {
        border-collapse: collapse;
        width: 100%;
        margin: 15px 0;
    }
    th, td {
        border: 1px solid #CCC;
        padding: 8px 12px;
        text-align: left;
    }
    th {
        background: #2C5AA0;
        color: white;
        font-weight: bold;
    }
    tr:nth-child(even) td {
        background: #F5F7FA;
    }
    code {
        background: #F0F0F0;
        padding: 2px 6px;
        border-radius: 3px;
        font-family: "Consolas", "Courier New", monospace;
        font-size: 14px;
    }
    a {
        color: #0066cc;
        text-decoration: none;
    }
    a:hover {
        text-decoration: underline;
    }
    .signature {
        margin-top: 40px;
        text-align: left;
    }
    @media print {
        body {
            margin: 0;
            padding: 20px;
        }
    }
</style>
"""


def convert(md_path: str, html_path: str):
    """md → html 转换"""
    md_abs = os.path.abspath(md_path)
    html_abs = os.path.abspath(html_path)
    md_dir = os.path.dirname(md_abs)
    md_name = os.path.basename(md_abs)

    # 从 md 文件第一行提取标题用作 <title>
    with open(md_abs, encoding="utf-8") as f:
        first_line = f.readline().strip()
    title = first_line.lstrip("# ").strip() if first_line.startswith("#") else Path(md_abs).stem

    print(f"转换: {md_path}")
    print(f"输出: {html_path}")

    # pandoc 生成 HTML 片段（不含 <html><head><body>）
    cmd = [PANDOC, md_name, "-f", "markdown", "-t", "html", "--no-highlight"]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=md_dir, encoding="utf-8")
    if result.returncode != 0:
        print(f"pandoc 错误: {result.stderr}")
        sys.exit(1)

    body_html = result.stdout
    print(f"  [1/2] pandoc 转换完成")

    # 组装完整 HTML
    full_html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    {HTML_STYLE}
</head>
<body>

{body_html}
</body>
</html>
"""

    with open(html_abs, "w", encoding="utf-8") as f:
        f.write(full_html)

    size_kb = os.path.getsize(html_abs) / 1024
    print(f"  [2/2] HTML 组装完成（{size_kb:.1f} KB）")
    print(f"完成: {html_path}")


def main():
    if len(sys.argv) < 2:
        print("用法: python scripts/md2html.py input.md [output.html]")
        sys.exit(1)

    md_path = sys.argv[1]
    if len(sys.argv) >= 3:
        html_path = sys.argv[2]
    else:
        html_path = str(Path(md_path).with_suffix(".html"))

    if not os.path.exists(md_path):
        print(f"错误: 文件不存在: {md_path}")
        sys.exit(1)

    convert(md_path, html_path)


if __name__ == "__main__":
    main()
