const STORAGE_KEY = 'ipl_contest_data_v1'

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export function buildDefaultData() {
  return {
    players: [],
    matches: [],
    carryForward: {},
    positionConfig: {
      maxPosition: 10,
      amountsByPosition: {},
    },
  }
}

export function ensureConfig(data) {
  const next = structuredClone(data || buildDefaultData())

  if (!next.positionConfig) next.positionConfig = { maxPosition: 10, amountsByPosition: {} }
  if (!Number.isFinite(next.positionConfig.maxPosition) || next.positionConfig.maxPosition < 1) {
    next.positionConfig.maxPosition = 10
  }
  if (!next.positionConfig.amountsByPosition || typeof next.positionConfig.amountsByPosition !== 'object') {
    next.positionConfig.amountsByPosition = {}
  }
  if (!next.carryForward || typeof next.carryForward !== 'object') {
    next.carryForward = {}
  }

  return next
}

export function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return buildDefaultData()
    return ensureConfig(JSON.parse(raw))
  } catch {
    return buildDefaultData()
  }
}

export function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ensureConfig(data)))
}

export function makePlayer(name) {
  return { id: uid(), name: name.trim() }
}

export function makeMatch({ date, position, amount, playerId }) {
  return {
    id: uid(),
    date,
    position: Number(position),
    amount: Number(amount),
    playerId,
    createdAt: new Date().toISOString(),
  }
}

function isCapacitor() {
  return typeof window !== 'undefined' && !!(window.Capacitor?.isNativePlatform?.())
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

async function triggerDownload(blob, filename) {
  if (isCapacitor()) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem')
      const { Share } = await import('@capacitor/share')
      const base64 = await blobToBase64(blob)
      const result = await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: Directory.Cache,
      })
      await Share.share({
        title: filename,
        url: result.uri,
        dialogTitle: `Save ${filename}`,
      })
      return
    } catch (e) {
      console.warn('Native download failed, falling back', e)
    }
  }
  // Web fallback
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}


export function downloadJson(data, filename = 'ipl-contest-data.json') {
  const blob = new Blob([JSON.stringify(ensureConfig(data), null, 2)], { type: 'application/json' })
  triggerDownload(blob, filename)
}

export async function downloadExcel(data, filename = 'ipl-contest-data.xlsx') {
  const XLSX = await import('xlsx')
  const d = ensureConfig(data)

  // Build players map
  const playersById = new Map(d.players.map(p => [p.id, p.name]))

  // Collect all player ids from matches too
  const allPlayerIds = [...new Set(d.matches.map(m => m.playerId))]
  const playerNames = allPlayerIds.map(id => playersById.get(id) || id)

  // Group matches by batch
  const byBatch = new Map()
  for (const m of d.matches) {
    const key = m.batchId ? `batch:${m.batchId}` : `legacy:${m.date}`
    const row = byBatch.get(key) || { date: m.date, byPlayerId: new Map() }
    row.byPlayerId.set(m.playerId, (row.byPlayerId.get(m.playerId) || 0) + (Number(m.amount) || 0))
    byBatch.set(key, row)
  }

  const rows = Array.from(byBatch.values()).sort((a, b) => a.date < b.date ? -1 : 1)

  // Build sheet rows
  const header = ['Date', ...playerNames]
  const sheetRows = rows.map(r => [
    r.date,
    ...allPlayerIds.map(id => r.byPlayerId.get(id) || 0)
  ])

  // Add carry-forward row if present
  const cf = d.carryForward || {}
  if (Object.keys(cf).length > 0) {
    sheetRows.push(['Result', ...allPlayerIds.map(id => cf[id] || 0)])
  }

  const ws = XLSX.utils.aoa_to_sheet([header, ...sheetRows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'IPL Contest')

  // Generate blob manually for mobile compatibility
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  triggerDownload(blob, filename)
}

export async function readJsonFile(file) {
  const text = await file.text()
  const parsed = JSON.parse(text)
  return ensureConfig(parsed)
}

// Excel import: expects sheet with a "Date" column header and player name columns.
// First row may be blank (skipped). Last row with "Result" in Date cell = carry-forward P&L.
export async function readExcelFile(file, existingData) {
  const XLSX = await import('xlsx')
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  // Find the header row — first row that contains a cell matching "date" (case-insensitive)
  let headerRowIdx = -1
  for (let i = 0; i < rows.length; i++) {
    const found = rows[i].some(c => String(c).trim().toLowerCase() === 'date')
    if (found) { headerRowIdx = i; break }
  }
  if (headerRowIdx === -1) throw new Error('No "Date" column found in Excel sheet')

  const headers = rows[headerRowIdx].map(h => String(h).trim())
  const dateCol = headers.findIndex(h => h.toLowerCase() === 'date')

  // Build player name -> id map from existing data
  const base = ensureConfig(structuredClone(existingData))
  const nameToId = new Map()
  for (const p of base.players) nameToId.set(p.name.toLowerCase(), p.id)

  // Player columns — skip empty headers and the Date column
  const playerCols = []
  for (let i = 0; i < headers.length; i++) {
    if (i === dateCol) continue
    const name = headers[i]
    if (!name) continue
    if (!nameToId.has(name.toLowerCase())) {
      const p = makePlayer(name)
      base.players.push(p)
      nameToId.set(name.toLowerCase(), p.id)
    }
    playerCols.push({ colIdx: i, name, id: nameToId.get(name.toLowerCase()) })
  }

  // Data rows = everything after header, skip fully empty rows
  const dataRows = rows.slice(headerRowIdx + 1).filter(r => r.some(c => c !== ''))

  if (dataRows.length === 0) throw new Error('No data rows found')

  // Check if last row is the Result/carry-forward row
  const lastRow = dataRows[dataRows.length - 1]
  const lastDateCell = String(lastRow[dateCol] ?? '').trim().toLowerCase()
  const isCarryForwardRow = lastDateCell === 'result'

  const matchRows = isCarryForwardRow ? dataRows.slice(0, -1) : dataRows

  if (isCarryForwardRow) {
    // Overwrite carry-forward with values from Result row
    for (const { colIdx, id } of playerCols) {
      const amt = Number(lastRow[colIdx])
      base.carryForward[id] = Number.isFinite(amt) ? amt : 0
    }
  }

  // Helper: parse Excel date serial or string to YYYY-MM-DD
  function parseDate(raw) {
    if (!raw && raw !== 0) return null
    if (typeof raw === 'number') {
      const d = XLSX.SSF.parse_date_code(raw)
      if (d) {
        const mm = String(d.m).padStart(2, '0')
        const dd = String(d.d).padStart(2, '0')
        const yyyy = d.y < 100 ? (d.y <= 29 ? 2000 + d.y : 1900 + d.y) : d.y
        return `${yyyy}-${mm}-${dd}`
      }
    }
    const s = String(raw).trim()
    const parts = s.split(/[\/\-\.]/)
    if (parts.length === 3) {
      const [a, b, c] = parts.map(Number)
      const yyyy = c < 100 ? (c <= 29 ? 2000 + c : 1900 + c) : c
      return `${yyyy}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`
    }
    const d = new Date(s)
    return isNaN(d) ? null : d.toISOString().slice(0, 10)
  }

  // Import individual match rows — tagged as fromExcel so leaderboard can exclude them
  for (const row of matchRows) {
    const rawDate = row[dateCol]
    if (rawDate === '' || rawDate === null || rawDate === undefined) continue
    const date = parseDate(rawDate)
    if (!date) continue
    const batchId = uid()
    for (const { colIdx, id } of playerCols) {
      const amt = Number(row[colIdx])
      if (!Number.isFinite(amt)) continue
      base.matches.push({
        id: uid(),
        date,
        position: 0,
        amount: amt,
        playerId: id,
        matchFee: 0,
        batchId,
        fromExcel: true,
        createdAt: new Date().toISOString(),
      })
    }
  }

  return ensureConfig(base)
}

