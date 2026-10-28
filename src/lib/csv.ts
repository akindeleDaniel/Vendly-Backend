// Reads CSV text (as saved by Excel or Google Sheets) into rows of cells. Handles quoted cells with commas, quotes
// ("" inside quotes) and line breaks, CRLF or LF line ends, and a leading byte-order mark. Returns null when a quote
// is left open, which means the file is broken.
export function parseCsv(text: string): string[][] | null {
    const rows: string[][] = []
    let row: string[] = []
    let cell = ""
    let quoted = false
    let index = text.charCodeAt(0) === 0xfeff ? 1 : 0

    for (; index < text.length; index++) {
        const char = text[index]!

        if (quoted) {
            if (char === '"') {
                if (text[index + 1] === '"') {
                    cell += '"'
                    index++
                } else {
                    quoted = false
                }
            } else {
                cell += char
            }
            continue
        }

        if (char === '"' && cell.length === 0) {
            quoted = true
        } else if (char === ",") {
            row.push(cell)
            cell = ""
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[index + 1] === "\n") {
                index++
            }
            row.push(cell)
            rows.push(row)
            row = []
            cell = ""
        } else {
            cell += char
        }
    }

    if (quoted) {
        return null
    }

    if (cell.length > 0 || row.length > 0) {
        row.push(cell)
        rows.push(row)
    }

    return rows
}

// One cell for writing CSV. Text a spreadsheet would run as a formula (starting with =, +, -, @ or a tab) is kept
// as text, so nothing in it can run on the reader's computer.
export function csvCell(value: string | number): string {
    let text = String(value)

    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) {
        text = `'${text}`
    }

    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
