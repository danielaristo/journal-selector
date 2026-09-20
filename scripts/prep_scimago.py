#!/usr/bin/env python3
"""Convierte el export anual de Scimago Journal Rank (CSV ';'-delimited) en un
JSON compacto indexado por ISSN, listo para servir estáticamente desde la app.

Fuente del CSV: https://www.scimagojr.com/journalrank.php (export oficial).
El sitio bloquea la descarga automatizada (Cloudflare); descargar manualmente
desde el navegador (botón "Download data" -> CSV) o usar un espejo público
conocido (ej. bibliotecas universitarias que republican el export anual).

Uso:
    python3 scripts/prep_scimago.py <ruta_csv_entrada> data/scimago_2025.json
"""
import csv
import json
import re
import sys


def parse_float(value):
    if not value or value == "-":
        return None
    return float(value.replace(",", "."))


def parse_int(value):
    if not value or value == "-":
        return None
    return int(value)


def parse_issns(raw):
    return [re.sub(r"\D", "", part) for part in raw.split(",") if part.strip()]


def parse_categories(raw):
    # "Hematology (Q1); Oncology (Q1)" -> [{"name": "Hematology", "quartile": "Q1"}, ...]
    out = []
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        m = re.match(r"^(.*)\s\((Q[1-4])\)$", chunk)
        if m:
            out.append({"name": m.group(1).strip(), "quartile": m.group(2)})
        else:
            out.append({"name": chunk, "quartile": None})
    return out


def parse_areas(raw):
    return [a.strip() for a in raw.split(";") if a.strip()]


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]

    journals = []
    issn_index = {}
    with open(src, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        for row in reader:
            issns = parse_issns(row["Issn"])
            if not issns:
                continue
            idx = len(journals)
            journals.append({
                "title": row["Title"],
                "type": row["Type"],
                "issn": issns,
                "sjr": parse_float(row["SJR"]),
                "quartile": row["SJR Best Quartile"] if row["SJR Best Quartile"] != "-" else None,
                "hIndex": parse_int(row["H index"]),
                "country": row["Country"] or None,
                "publisher": row["Publisher"] or None,
                "coverage": row["Coverage"] or None,
                "categories": parse_categories(row["Categories"]),
                "areas": parse_areas(row["Areas"]),
                # tip=sid tells Scimago to resolve q= as a source ID lookup;
                # without it, the query is treated as free-text search and
                # can land on an unrelated journal.
                "scimagoUrl": f"https://www.scimagojr.com/journalsearch.php?q={row['Sourceid']}&tip=sid&clean=0",
            })
            for issn in issns:
                issn_index[issn] = idx

    payload = {"journals": journals, "issnIndex": issn_index}
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    print(f"{len(journals)} revistas, {len(issn_index)} claves ISSN -> {dst}")


if __name__ == "__main__":
    main()
