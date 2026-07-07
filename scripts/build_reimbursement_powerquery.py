import os
import shutil
import sys
from pathlib import Path

import win32com.client as win32


SUMMARY_SHEET = "\u62a5\u9500\u7edf\u8ba1\u8868"
TEMPLATE_SHEET = "\u4eba\u5458\u6a21\u677f"

PERSON_SHEETS = [
    "\u7530\u7acb\u65b0",
    "\u738b\u7ee7\u5f6a",
    "\u5218\u950b",
    "\u4e8e\u4fca\u6d77",
    "\u738b\u4e91\u6625",
    "\u6b27\u9633\u677e\u6797",
    "\u5b59\u6052\u53cc",
    "\u962e\u6587\u4fca",
    "\u738b\u5e86\u4eae",
    "\u6768\u5fd7\u521a",
    "\u5f20\u8302\u52c7",
    "\u6731\u6625\u7701",
    "\u5218\u5efa\u5f3a",
    "\u7530\u91ce(\u5916\u8058)",
    "\u738b\u6653\u4e1c(\u5916\u8058)",
]

VISIBLE_PERSON_HEADERS = [
    "\u8239\u540d",
    "\u8239\u53f7",
    "\u76d1\u88c5\u5929\u6570",
    "\u62a5\u9500\u91d1\u989d",
    "\u8865\u8d34\u91d1\u989d",
]

VISIBLE_SUMMARY_HEADERS = [
    "\u8239\u540d",
    "\u8239\u53f7",
    "\u76d1\u88c5\u4eba\u5458",
    "\u76d1\u88c5\u5929\u6570",
    "\u62a5\u9500\u91d1\u989d",
    "\u8865\u8d34\u91d1\u989d",
    "\u8239\u4e1c\u540d\u79f0",
    "\u76d1\u88c5\u8d39(USD)",
    "\u6c47\u7387",
    "\u4eba\u6c11\u5e01\u91d1\u989d",
    "\u5229\u6da6",
]

INTERNAL_HEADERS = ["ship", "ship_no", "days", "expense", "subsidy", "person"]


def set_visible_headers(ws, headers, fill_color):
    for idx, header in enumerate(headers, start=1):
        cell = ws.Cells(1, idx)
        cell.Value = header
        cell.Font.Bold = True
        cell.Interior.Color = fill_color
        cell.HorizontalAlignment = -4108


def build_person_sheet(ws, table_name, note_text):
    set_visible_headers(ws, VISIBLE_PERSON_HEADERS, 0xD9EAD3)
    ws.Range("A2:F2").Value = [INTERNAL_HEADERS]
    ws.Range("A3:F3").Value = [["", "", "", "", "", ""]]
    ws.Cells(3, 6).Formula = '=IF(A3="","",MID(CELL("filename",A3),FIND("]",CELL("filename",A3))+1,255))'

    lo = ws.ListObjects.Add(1, ws.Range("A2:F3"), None, 1)
    lo.Name = table_name
    lo.TableStyle = "TableStyleMedium2"

    ws.Rows(2).Hidden = True
    ws.Columns("F").Hidden = True
    ws.Range("A:E").ColumnWidth = 14
    ws.Columns("F").ColumnWidth = 2
    ws.Range("G1").Value = "\u8bf4\u660e"
    ws.Range("G1").Font.Bold = True
    ws.Range("G2").Value = note_text
    ws.Range("G2").WrapText = True
    ws.Columns("G").ColumnWidth = 34
    ws.Rows(1).RowHeight = 24
    ws.Rows(2).Hidden = True
    ws.Range("A1:E1").Borders.Weight = 2
    ws.Range("A3:E200").Borders.Weight = 2
    ws.Activate()
    ws.Application.ActiveWindow.FreezePanes = False
    ws.Range("A3").Select()
    ws.Application.ActiveWindow.FreezePanes = True


def build_summary_sheet(ws):
    set_visible_headers(ws, VISIBLE_SUMMARY_HEADERS, 0xD9E2F3)
    ws.Range("A:K").ColumnWidth = 14
    ws.Columns("G").ColumnWidth = 16
    ws.Columns("H").ColumnWidth = 14
    ws.Columns("I").ColumnWidth = 10
    ws.Columns("J").ColumnWidth = 14
    ws.Columns("M").ColumnWidth = 42
    ws.Range("M1").Value = "\u8bf4\u660e"
    ws.Range("M1").Font.Bold = True
    ws.Range("M2").Value = (
        "\u586b\u5b8c\u4eba\u5458\u9875\u540e\uff0c"
        "\u7528\u201c\u6570\u636e -> \u5168\u90e8\u5237\u65b0\u201d\u66f4\u65b0\u603b\u8868\uff1b"
        "\u6587\u4ef6\u91cd\u65b0\u6253\u5f00\u65f6\u4e5f\u4f1a\u81ea\u52a8\u5237\u65b0\u3002"
    )
    ws.Range("M2").WrapText = True
    ws.Rows(1).RowHeight = 24
    ws.Range("A1:K1").Borders.Weight = 2

    for row in range(3, 1001):
        ws.Cells(row, 10).Formula = f'=IF(OR(H{row}="",I{row}=""),"",H{row}*I{row})'

    ws.Range("A3:K1000").Borders.Weight = 2
    ws.Activate()
    ws.Application.ActiveWindow.FreezePanes = False
    ws.Range("A3").Select()
    ws.Application.ActiveWindow.FreezePanes = True


def create_query_output(wb, summary_ws):
    formula = (
        "let "
        "Source = Excel.CurrentWorkbook(), "
        "Filtered = Table.SelectRows(Source, each Text.StartsWith([Name], \"tb_person_\")), "
        "Combined = Table.Combine(Filtered[Content]), "
        "Cleaned = Table.SelectRows(Combined, each [ship] <> null and [ship] <> \"\"), "
        "Reordered = Table.ReorderColumns(Cleaned,{\"ship\",\"ship_no\",\"person\",\"days\",\"expense\",\"subsidy\"}) "
        "in Reordered"
    )

    wb.Queries.Add("qry_summary", formula)
    lo = summary_ws.ListObjects.Add(
        0,
        'OLEDB;Provider=Microsoft.Mashup.OleDb.1;Data Source=$Workbook$;Location=qry_summary;Extended Properties=""',
        True,
        1,
        summary_ws.Range("A2"),
    )
    lo.Name = "tb_summary_result"
    qt = lo.QueryTable
    qt.CommandType = 2
    qt.CommandText = ["SELECT * FROM [qry_summary]"]
    qt.EnableRefresh = True
    qt.BackgroundQuery = False
    qt.RefreshOnFileOpen = True
    qt.RefreshPeriod = 1
    qt.Refresh(False)
    summary_ws.Rows(2).Hidden = True


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: build_reimbursement_powerquery.py <target_path> <backup_path>")

    target_path = Path(sys.argv[1])
    backup_path = Path(sys.argv[2])
    temp_output = Path(os.environ["TEMP"]) / "reimbursement_clean_build.xlsx"

    if target_path.exists():
        shutil.copy2(target_path, backup_path)

    excel = win32.DispatchEx("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False

    try:
        wb = excel.Workbooks.Add()
        summary_ws = wb.Worksheets(1)
        summary_ws.Name = SUMMARY_SHEET
        build_summary_sheet(summary_ws)

        person_note = (
            "\u7b2c3\u884c\u5f00\u59cb\u586b\u5199\uff1b"
            "\u65b0\u589e\u4eba\u5458\u8bf7\u590d\u5236\u201c\u4eba\u5458\u6a21\u677f\u201d\u5e76\u91cd\u547d\u540d sheet\u3002"
        )
        for idx, name in enumerate(PERSON_SHEETS, start=1):
            ws = wb.Worksheets.Add(After=wb.Worksheets(wb.Worksheets.Count))
            ws.Name = name
            build_person_sheet(ws, f"tb_person_{idx:03d}", person_note)

        template_ws = wb.Worksheets.Add(After=wb.Worksheets(wb.Worksheets.Count))
        template_ws.Name = TEMPLATE_SHEET
        build_person_sheet(
            template_ws,
            "tb_person_template",
            "\u590d\u5236\u672c\u9875\u5e76\u628a sheet \u540d\u6539\u6210\u4eba\u5458\u59d3\u540d\uff0c"
            "\u7136\u540e\u4ece\u7b2c3\u884c\u5f00\u59cb\u586b\u5199\u3002",
        )

        create_query_output(wb, summary_ws)

        wb.SaveAs(str(temp_output), 51)
        wb.Close(False)
    finally:
        excel.Quit()

    shutil.copy2(temp_output, target_path)


if __name__ == "__main__":
    main()

