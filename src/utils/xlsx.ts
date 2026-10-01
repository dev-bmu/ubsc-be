import { crc32, deflateRawSync } from 'node:zlib'

// ===== Penulis .xlsx minimal =====
// Import Accurate hanya menerima Excel. Yang dibutuhkan export-nya sempit: satu sheet, sel teks,
// angka, dan tanggal, baris judul tebal. Itu muat di satu berkas kecil di atas zlib bawaan Node
// (crc32 + deflate); pustaka seperti exceljs membawa puluhan dependensi untuk hal yang sama.
// Teks memakai sharedStrings seperti yang ditulis Excel sendiri, supaya pembaca apa pun di sisi
// Accurate menerimanya.

/** Tanggal kalender 'YYYY-MM-DD' — ditulis sebagai tanggal Excel sungguhan, bukan teks. */
export type XlsxCell = string | number | { date: string } | null | undefined

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** Escape XML + buang karakter kontrol yang tidak sah di XML 1.0 (bisa terbawa dari nama pelanggan). */
function xml(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- justru membuang karakter kontrol yang ditolak parser XML
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  )
}

/** 0 → 'A', 25 → 'Z', 26 → 'AA'. */
function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

/** Nomor seri tanggal Excel (sistem 1900): hari sejak 1899-12-30. */
function excelSerial(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000
}

const STYLES = `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

const STYLE_DATE = 1
const STYLE_HEADER = 2

/** Arsip ZIP (deflate) — format kontainer .xlsx. */
function zip(files: Array<{ name: string; data: string }>): Buffer {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.from(file.data, 'utf8')
    const body = deflateRawSync(raw)
    const crc = crc32(raw)

    // Header lokal: versi 2.0, flag UTF-8, deflate, waktu 00:00 1980-01-01.
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt16LE(0x21, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    directory.push(entry, name)

    offset += local.length + name.length + body.length
  }

  const directorySize = directory.reduce((sum, b) => sum + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, ...directory, end])
}

/** Satu workbook satu sheet. `header` = baris 1 (tebal); `rows` mulai baris 2. */
export function buildXlsx(sheetName: string, header: string[], rows: XlsxCell[][]): Buffer {
  const strings: string[] = []
  const stringIndex = new Map<string, number>()
  const shared = (value: string): number => {
    let index = stringIndex.get(value)
    if (index === undefined) {
      index = strings.push(value) - 1
      stringIndex.set(value, index)
    }
    return index
  }

  const rowXml = (cells: XlsxCell[], r: number, headerRow: boolean): string => {
    const out: string[] = []
    cells.forEach((cell, c) => {
      if (cell === null || cell === undefined || cell === '') return
      const ref = `${columnName(c)}${r}`
      if (typeof cell === 'number') out.push(`<c r="${ref}"><v>${cell}</v></c>`)
      else if (typeof cell === 'object') out.push(`<c r="${ref}" s="${STYLE_DATE}"><v>${excelSerial(cell.date)}</v></c>`)
      else out.push(`<c r="${ref}" t="s"${headerRow ? ` s="${STYLE_HEADER}"` : ''}><v>${shared(cell)}</v></c>`)
    })
    return `<row r="${r}">${out.join('')}</row>`
  }

  const sheetRows = [rowXml(header, 1, true), ...rows.map((cells, i) => rowXml(cells, i + 2, false))]

  return zip([
    {
      name: '[Content_Types].xml',
      data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`
    },
    {
      name: '_rels/.rels',
      data: `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      data: `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">
<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/>
<Relationship Id="rId3" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`
    },
    { name: 'xl/worksheets/sheet1.xml', data: `${XML_HEAD}<worksheet xmlns="${MAIN_NS}"><sheetData>${sheetRows.join('')}</sheetData></worksheet>` },
    { name: 'xl/styles.xml', data: STYLES },
    {
      name: 'xl/sharedStrings.xml',
      data: `${XML_HEAD}<sst xmlns="${MAIN_NS}" count="${strings.length}" uniqueCount="${strings.length}">${strings
        .map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`)
        .join('')}</sst>`
    }
  ])
}
