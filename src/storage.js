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

// Detect if running inside a Capacitor native app
function isCapacitor() {
  return typeof window !== 'undefined' && !!(window.Capacitor?.isNativePlatform?.())
}

// Convert blob to base64 string
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// Save file natively via Capacitor Filesystem + Share
async function nativeDownload(blob, filename) {
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
}

function triggerDownload(blob, filename) {
  if (isCapacitor()) {
    nativeDownload(blob, filename)
    return
  }
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

// Excel import: expects sheet with first column "Date" and remaining columns as player names.
// Last row with a non-date label in the Date column is treated as carry-forward (past P&L).
// Each other row is one match batch. Merges into existing data (players created if not found).
export async function readExcelFile(file, existingData) {
  const XLSX = await import('xlsx')
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  if (rows.length < 2) throw new Error('Excel sheet has no data rows')

  const headers = rows[0].map((h) => String(h).trim())
  const dateCol = headers.findIndex((h) => h.toLowerCase() === 'date')
  if (dateCol === -1) throw new Error('No "Date" column found in Excel sheet')

  // Build player name -> id map from existing data
  const base = ensureConfig(structuredClone(existingData))
  const nameToId = new Map()
  for (const p of base.players) nameToId.set(p.name.toLowerCase(), p.id)

  // Ensure players exist for every column header (except Date)
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

  // Detect if last data row is a carry-forward summary (non-date text in date column)
  const dataRows = rows.slice(1).filter((r) => r.some((c) => c !== ''))
  let matchRows = dataRows
  const lastRow = dataRows[dataRows.length - 1]
  const lastDateCell = lastRow ? String(lastRow[dateCol] ?? '').trim() : ''
  const isCarryForwardRow = lastDateCell !== '' && !(lastRow[dateCol] instanceof Date) && Number.isNaN(Number(new Date(lastDateCell)))

  if (isCarryForwardRow) {
    matchRows = dataRows.slice(0, -1)
    // Store carry-forward amounts per player
    for (const { colIdx, id } of playerCols) {
      const amt = Number(lastRow[colIdx])
      if (Number.isFinite(amt)) {
        base.carryForward[id] = (base.carryForward[id] || 0) + amt
      }
    }
  }

  // Parse match rows
  for (const row of matchRows) {
    const rawDate = row[dateCol]
    if (!rawDate) continue

    // Normalise date to YYYY-MM-DD
    let date
    if (rawDate instanceof Date) {
      date = rawDate.toISOString().slice(0, 10)
    } else {
      const d = new Date(rawDate)
      date = Number.isNaN(d.getTime()) ? String(rawDate).trim() : d.toISOString().slice(0, 10)
    }

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
        createdAt: new Date().toISOString(),
      })
    }
  }

  return ensureConfig(base)
}

