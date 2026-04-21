import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildDefaultData,
  downloadExcel,
  ensureConfig,
  loadData,
  makeMatch,
  makePlayer,
  readExcelFile,
  saveData,
} from '../storage.js'
import './Home.css'

function currency(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function sortPlayers(players) {
  return [...players].sort((a, b) => a.name.localeCompare(b.name))
}

export default function Home() {
  const [tab, setTab] = useState('results') // results | add | players
  const [data, setData] = useState(() => loadData())
  const [successMsg, setSuccessMsg] = useState('')
  const xlsxRef = useRef(null)
  const menuBtnRef = useRef(null)
  const menuRef = useRef(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    saveData(data)
  }, [data])

  useEffect(() => {
    if (!menuOpen) return

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        menuBtnRef.current?.focus()
      }
    }

    function onPointerDown(e) {
      const target = e.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target)) return
      if (menuBtnRef.current?.contains(target)) return
      setMenuOpen(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [menuOpen])

  const playersById = useMemo(() => {
    const map = new Map()
    for (const p of data.players) map.set(p.id, p)
    return map
  }, [data.players])

  const maxPosition = data.positionConfig?.maxPosition || 10
  const amountsByPosition = data.positionConfig?.amountsByPosition || {}

  const totals = useMemo(() => {
    const byPlayerId = new Map()
    const feesByPlayerId = new Map()
    for (const m of data.matches) {
      if (m.fromExcel) continue  // Excel rows shown in sheet only; carry-forward covers their P&L
      const winnings = Number(m.amount) || 0
      const fee = Number(m.matchFee) || 0
      byPlayerId.set(m.playerId, (byPlayerId.get(m.playerId) || 0) + (winnings - fee))
      feesByPlayerId.set(m.playerId, (feesByPlayerId.get(m.playerId) || 0) + fee)
    }
    const carryForward = data.carryForward || {}
    const rows = data.players.map((p) => {
      const matchTotal = byPlayerId.get(p.id) || 0
      return {
        playerId: p.id,
        name: p.name,
        total: matchTotal + (Number(carryForward[p.id]) || 0),
        totalFees: feesByPlayerId.get(p.id) || 0,
      }
    })
    rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    return rows
  }, [data.matches, data.players, data.carryForward])

  const matchesNewestFirst = useMemo(() => {
    return [...data.matches].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }, [data.matches])

  function resetAll() {
    setData(buildDefaultData())
    setTab('results')
  }

  async function onImportExcel(e) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const merged = await readExcelFile(file, data)
      setData(merged)
      setTab('results')
    } catch (err) {
      alert(`Excel import failed: ${err.message}`)
    } finally {
      e.target.value = ''
    }
  }

  function addPlayer(name) {
    const trimmed = name.trim()
    if (!trimmed) return
    const exists = data.players.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())
    if (exists) return
    setData((prev) => ({ ...prev, players: [...prev.players, makePlayer(trimmed)] }))
  }

  function removePlayer(playerId) {
    setData((prev) => {
      const player = prev.players.find((p) => p.id === playerId)
      const playerName = player?.name

      return {
        ...prev,
        players: prev.players.filter((p) => p.id !== playerId),
        // Keep historical results even if player is removed.
        // Also make the Results sheet name stable by stamping playerName into old entries if missing.
        matches: prev.matches.map((m) => {
          if (m.playerId !== playerId) return m
          if (m.playerName) return m
          if (!playerName) return m
          return { ...m, playerName }
        }),
      }
    })
  }

  function setMaxPosition(nextMax) {
    const n = Math.max(1, Math.min(50, Number(nextMax) || 1))
    setData((prev) => ({
      ...prev,
      positionConfig: {
        ...prev.positionConfig,
        maxPosition: n,
      },
    }))
  }

  function setPositionAmount(position, amount) {
    const p = String(position)
    const n = Number(amount)
    setData((prev) => ({
      ...prev,
      positionConfig: {
        ...prev.positionConfig,
        amountsByPosition: {
          ...(prev.positionConfig?.amountsByPosition || {}),
          [p]: Number.isFinite(n) ? n : 0,
        },
      },
    }))
  }

  function addMatch({ date, position, amount, playerId }) {
    if (!playerId) return
    if (!date) return
    const pos = Number(position)
    if (!Number.isFinite(pos) || pos < 1 || pos > maxPosition) return
    const amt = Number(amount)
    if (!Number.isFinite(amt)) return

    setData((prev) => ({ ...prev, matches: [...prev.matches, makeMatch({ date, position: pos, amount: amt, playerId })] }))
  }

  function addMatches(entries) {
    const safe = Array.isArray(entries) ? entries : []
    if (safe.length === 0) return

    setData((prev) => {
      const batchId =
        (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
        `batch_${Date.now()}_${Math.random().toString(16).slice(2)}`
      const nameById = new Map()
      for (const p of prev.players) nameById.set(p.id, p.name)
      for (const m of prev.matches) {
        if (!nameById.has(m.playerId) && m.playerName) nameById.set(m.playerId, m.playerName)
      }

      const nextMatches = [...prev.matches]
      for (const e of safe) {
        if (!e?.playerId || !e?.date) continue
        const pos = Number(e.position)
        const amt = Number(e.amount)
        const fee = Number(e.matchFee) || 0
        if (!Number.isFinite(pos) || pos < 1 || pos > (prev.positionConfig?.maxPosition || 10)) continue
        if (!Number.isFinite(amt)) continue
        const base = makeMatch({ date: e.date, position: pos, amount: amt, playerId: e.playerId })
        nextMatches.push({
          ...base,
          batchId,
          playerName: nameById.get(e.playerId) || base.playerName,
          matchFee: fee,
        })
      }
      return { ...prev, matches: nextMatches }
    })
  }

  function removeMatch(matchId) {
    setData((prev) => ({ ...prev, matches: prev.matches.filter((m) => m.id !== matchId) }))
  }

  function deleteBatch(batchKey) {
    setData((prev) => ({
      ...prev,
      matches: prev.matches.filter((m) => {
        const key = m.batchId ? `batch:${m.batchId}` : `legacy:${m.date}`
        return key !== batchKey
      }),
    }))
  }

  function editBatch(batchKey, { date, matchFee, positionsByPlayerId }) {
    setData((prev) => ({
      ...prev,
      matches: prev.matches.map((m) => {
        const key = m.batchId ? `batch:${m.batchId}` : `legacy:${m.date}`
        if (key !== batchKey) return m
        const pos = Number(positionsByPlayerId[m.playerId])
        const fee = Number(matchFee) || 0
        const players = prev.players
        const totalPlayers = players.length || 1
        const prizePool = fee * totalPlayers
        const autoAmounts = {
          1: prizePool * 0.5,
          2: prizePool * 0.3,
          3: prizePool * 0.2,
        }
        const amount = autoAmounts[pos] ?? 0
        return { ...m, date, matchFee: fee, position: pos, amount }
      }),
    }))
  }

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-header-row">
          <h1 className="home-title">IPL Contest</h1>

          <div className="home-actions">
            <input ref={xlsxRef} onChange={onImportExcel} type="file" accept=".xlsx,.xls" hidden />
            <div className="menu">
              <button
                ref={menuBtnRef}
                className="btn menu-trigger"
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More options"
                onClick={() => setMenuOpen((v) => !v)}
              >
                ⋮
              </button>
              {menuOpen ? (
                <div ref={menuRef} className="menu-popover" role="menu" aria-label="Actions">
                  <button className="menu-item" type="button" role="menuitem" onClick={() => downloadExcel(data)}>
                    Export Excel
                  </button>
                  <button
                    className="menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      xlsxRef.current?.click()
                    }}
                  >
                    Import Excel
                  </button>
                  <div className="menu-sep" role="separator" />
                  <button
                    className="menu-item menu-item--danger"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      resetAll()
                    }}
                  >
                    Reset
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label="Tabs">
        <button className="tab" type="button" aria-selected={tab === 'results'} onClick={() => setTab('results')}>
          Results
        </button>
        <button className="tab" type="button" aria-selected={tab === 'add'} onClick={() => setTab('add')}>
          Add Result
        </button>
        <button className="tab" type="button" aria-selected={tab === 'players'} onClick={() => setTab('players')}>
          Players
        </button>
      </nav>

      {tab === 'results' ? (
        <ResultsTab
          playersById={playersById}
          totals={totals}
          matches={matchesNewestFirst}
          onDeleteMatch={removeMatch}
          onDeleteBatch={deleteBatch}
          onEditBatch={editBatch}
          successMsg={successMsg}
        />
      ) : tab === 'add' ? (
        <AddTab
          data={ensureConfig(data)}
          onSetMaxPosition={setMaxPosition}
          onSetPositionAmount={setPositionAmount}
          onAddMatches={addMatches}
          onSuccess={(msg) => {
            setSuccessMsg(msg)
            setTab('results')
            window.setTimeout(() => setSuccessMsg(''), 2000)
          }}
          playersSorted={sortPlayers(data.players)}
        />
      ) : (
        <PlayersTab playersSorted={sortPlayers(data.players)} onAddPlayer={addPlayer} onRemovePlayer={removePlayer} />
      )}

      <nav className="bottom-nav" aria-label="Bottom navigation">
        <button
          className="bottom-nav-item"
          type="button"
          aria-current={tab === 'results' ? 'page' : undefined}
          onClick={() => setTab('results')}
        >
          <span className="bottom-nav-icon" aria-hidden="true">
            🏆
          </span>
          <span className="bottom-nav-label">Results</span>
        </button>
        <button
          className="bottom-nav-item bottom-nav-item--primary"
          type="button"
          aria-current={tab === 'add' ? 'page' : undefined}
          onClick={() => setTab('add')}
        >
          <span className="bottom-nav-icon" aria-hidden="true">
            ＋
          </span>
          <span className="bottom-nav-label">Add</span>
        </button>
        <button
          className="bottom-nav-item"
          type="button"
          aria-current={tab === 'players' ? 'page' : undefined}
          onClick={() => setTab('players')}
        >
          <span className="bottom-nav-icon" aria-hidden="true">
            👤
          </span>
          <span className="bottom-nav-label">Players</span>
        </button>
      </nav>
    </div>
  )
}

function ResultsTab({ totals, matches, playersById, onDeleteMatch, onDeleteBatch, onEditBatch, successMsg }) {
  const [editRow, setEditRow] = useState(null)   // { key, date, matchFee, positionsByPlayerId }
  const [deleteKey, setDeleteKey] = useState(null) // batchKey to confirm delete
  const [editToast, setEditToast] = useState(false)

  function showEditToast() {
    setEditToast(true)
    setTimeout(() => setEditToast(false), 2500)
  }

  // Count distinct matches (by batchId or date for legacy) and sum all fees
  const { matchCount, totalFees } = useMemo(() => {
    const seen = new Set()
    let fees = 0
    for (const m of matches) {
      const key = m.batchId ? `batch:${m.batchId}` : `legacy:${m.date}`
      if (!seen.has(key)) seen.add(key)
      fees += Number(m.matchFee) || 0
    }
    return { matchCount: seen.size, totalFees: fees }
  }, [matches])

  const sheetPlayers = useMemo(() => {
    // Column list should include:
    // - current players (data.players) and
    // - any past players present in matches
    // so removing a player doesn't remove old results from the sheet.
    const byId = new Map()

    // Prefer stable names stored in past entries.
    for (const m of matches) {
      if (!byId.has(m.playerId) && m.playerName) byId.set(m.playerId, m.playerName)
    }

    for (const t of totals) {
      if (!byId.has(t.playerId)) byId.set(t.playerId, t.name)
    }

    for (const m of matches) {
      if (!byId.has(m.playerId)) {
        byId.set(m.playerId, m.playerName || playersById.get(m.playerId)?.name || 'Removed player')
      }
    }

    return Array.from(byId.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [totals, matches, playersById])

  const sheet = useMemo(() => {
    // Row = one "Add result" submission (batch).
    // Older records (no batchId) fall back to one row per date.
    const byBatchKey = new Map()

    for (const m of matches) {
      const date = m.date
      if (!date) continue

      const key = m.batchId ? `batch:${m.batchId}` : `legacy:${date}`
      const existing = byBatchKey.get(key) || {
        key,
        date,
        createdAt: m.createdAt || '',
        byPlayerId: new Map(),
      }

      existing.byPlayerId.set(m.playerId, (existing.byPlayerId.get(m.playerId) || 0) + (Number(m.amount) || 0))

      if (!existing.createdAt && m.createdAt) existing.createdAt = m.createdAt
      byBatchKey.set(key, existing)
    }

    const rows = Array.from(byBatchKey.values()).sort((a, b) => {
      // Newest first: createdAt if present, else by date
      const ca = a.createdAt || ''
      const cb = b.createdAt || ''
      if (ca && cb) return ca < cb ? 1 : ca > cb ? -1 : 0
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0
    })

    return { rows }
  }, [matches])

  return (
    <>
    <div className="grid">
      {successMsg && (
        <div className="toast-slide" role="status" aria-live="polite">
          <span className="toast-icon" aria-hidden="true">✅</span>
          <span className="toast-message">{successMsg}</span>
        </div>
      )}
      {editToast && (
        <div className="toast-slide toast-slide--warn" role="status" aria-live="polite">
          <span className="toast-icon" aria-hidden="true">⚠️</span>
          <span className="toast-message">Cannot edit — match fee & position data not available</span>
        </div>
      )}
      <section className="card">
        <h2>Leaderboard</h2>
        <div className="inline" style={{ marginBottom: '2vh' }}>
          <span className="pill">
            Matches: <strong>{matchCount}</strong>
          </span>
          <span className="pill">
            Players: <strong>{totals.length}</strong>
          </span>
        </div>

        {totals.length === 0 ? (
          <p className="hint">Add players first, then add match results.</p>
        ) : (
          <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Player</th>
                <th>Profit / Loss</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((r, idx) => (
                <tr key={r.playerId}>
                  <td>{idx + 1}</td>
                  <td>{r.name}</td>
                  <td>
                    <span
                      className={
                        Number(r.total) > 0
                          ? 'amt amt--pos'
                          : Number(r.total) < 0
                            ? 'amt amt--neg'
                            : 'amt'
                      }
                    >
                      {Number(r.total) > 0 ? '▲ ' : Number(r.total) < 0 ? '▼ ' : ''}
                      {currency(r.total)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Results sheet</h2>
        {matches.length === 0 ? (
          <p className="hint">No match entries yet.</p>
        ) : (
          <div className="table-scroll-container" aria-label="Results sheet table">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  {sheetPlayers.map((p) => (
                    <th key={p.id}>{p.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((r) => (
                  <tr key={r.key} className="tr-clickable" onClick={() => {
                    const batchMatches = matches.filter(m => {
                      const k = m.batchId ? `batch:${m.batchId}` : `legacy:${m.date}`
                      return k === r.key
                    })
                    const fee = batchMatches[0]?.matchFee || 0
                    const hasPositions = batchMatches.some(m => m.position && m.position > 0)
                    // Excel-imported rows or legacy rows without fee/position can't be edited
                    if (!fee && !hasPositions) {
                      showEditToast()
                      return
                    }
                    const pos = {}
                    for (const m of batchMatches) pos[m.playerId] = m.position || 1
                    setEditRow({ key: r.key, date: r.date, matchFee: fee, positionsByPlayerId: pos })
                  }}>
                    <td>{r.date ? r.date.split('-').reverse().join('/') : ''}</td>
                    {sheetPlayers.map((p) => (
                      <td key={p.id}>{currency(r.byPlayerId.get(p.id) || 0)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>

    {/* Edit batch popup */}
    {editRow && (
      <div className="popup-backdrop" onClick={() => setEditRow(null)}>
        <div className="popup-card" onClick={e => e.stopPropagation()}>
          <h2>Edit Match</h2>
          <form className="grid" onSubmit={e => {
            e.preventDefault()
            onEditBatch(editRow.key, {
              date: editRow.date,
              matchFee: editRow.matchFee,
              positionsByPlayerId: editRow.positionsByPlayerId,
            })
            setEditRow(null)
          }}>
            <label className="field">
              Date
              <input type="date" value={editRow.date} onChange={e => setEditRow(r => ({ ...r, date: e.target.value }))} required />
            </label>
            <label className="field">
              Match Fee
              <input type="number" min="0" value={editRow.matchFee} onChange={e => setEditRow(r => ({ ...r, matchFee: e.target.value }))} required />
            </label>
            {Object.entries(editRow.positionsByPlayerId).map(([pid, pos]) => {
              const name = playersById.get(pid)?.name || pid
              return (
                <label key={pid} className="field">
                  {name} — Position
                  <input type="number" min="1" max="10" value={pos}
                    onChange={e => setEditRow(r => ({ ...r, positionsByPlayerId: { ...r.positionsByPlayerId, [pid]: e.target.value } }))}
                    required />
                </label>
              )
            })}
            <div className="inline">
              <button className="btn btn-primary" type="submit">Save</button>
              <button className="btn btn-danger" type="button" onClick={() => { setEditRow(null); setDeleteKey(editRow.key) }}>Delete</button>
              <button className="btn" type="button" onClick={() => setEditRow(null)}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    )}

    {/* Delete confirmation popup */}
    {deleteKey && (
      <div className="popup-backdrop" onClick={() => setDeleteKey(null)}>
        <div className="popup-card" onClick={e => e.stopPropagation()}>
          <h2>Delete Match?</h2>
          <p style={{ marginBottom: '16px', color: 'var(--text)' }}>This will remove the match and deduct all winnings and fees from the leaderboard.</p>
          <div className="inline">
            <button className="btn btn-danger" type="button" onClick={() => { onDeleteBatch(deleteKey); setDeleteKey(null) }}>Delete</button>
            <button className="btn" type="button" onClick={() => setDeleteKey(null)}>Cancel</button>
          </div>
        </div>
      </div>
    )}
  </>
  )
}

function PlayersTab({ playersSorted, onAddPlayer, onRemovePlayer }) {
  const [playerName, setPlayerName] = useState('')

  function submitPlayer(e) {
    e.preventDefault()
    onAddPlayer(playerName)
    setPlayerName('')
  }

  return (
    <div className="grid">
      <section className="card">
        <h2>Players</h2>
        <form className="inline inline--add-player" onSubmit={submitPlayer}>
          <label className="field" style={{ flex: '1 1 240px' }}>
            Add player
            <input
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="Enter player name"
            />
          </label>
          <button className="btn btn-primary" type="submit">
            Add
          </button>
        </form>

        {playersSorted.length === 0 ? (
          <p className="hint">Add players here. They will appear in the Add Result dropdown.</p>
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {playersSorted.map((p) => (
              <div key={p.id} className="player-row">
                <span className="pill">{p.name}</span>
                <button className="btn" type="button" onClick={() => onRemovePlayer(p.id)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function AddTab({
  data,
  playersSorted,
  onSetMaxPosition,
  onSetPositionAmount,
  onAddMatches,
  onSuccess,
}) {
  const maxPosition = data.positionConfig.maxPosition

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [matchFee, setMatchFee] = useState(20)
  const effectiveMaxPosition = Math.max(1, playersSorted.length || 1)
  const [positionsByPlayerId, setPositionsByPlayerId] = useState(() => {
    const init = {}
    for (const p of playersSorted) init[p.id] = 1
    return init
  })
  const [success, setSuccess] = useState('')

  useEffect(() => {
    setPositionsByPlayerId((prev) => {
      const next = { ...prev }
      const existing = new Set(playersSorted.map((p) => p.id))
      for (const id of Object.keys(next)) {
        if (!existing.has(id)) delete next[id]
      }
      for (const p of playersSorted) {
        if (next[p.id] === undefined) next[p.id] = 1
      }
      return next
    })
  }, [playersSorted])

  useEffect(() => {
    if (maxPosition !== effectiveMaxPosition) onSetMaxPosition(effectiveMaxPosition)
  }, [effectiveMaxPosition, maxPosition, onSetMaxPosition])

  const payoutsByPlayerId = useMemo(() => {
    // Auto-compute prize pool: matchFee × players, split 50/30/20 for pos 1/2/3
    const pool = Number(matchFee) * playersSorted.length
    const autoAmounts = { '1': pool * 0.5, '2': pool * 0.3, '3': pool * 0.2 }

    if (playersSorted.length === 0) return {}

    const ids = playersSorted.map((p) => p.id)
    const requested = ids.map((id) => {
      const raw = Number(positionsByPlayerId[id] || 1)
      const pos = Math.min(effectiveMaxPosition, Math.max(1, raw))
      return { id, pos }
    })

    // Group by requested position
    const groups = new Map()
    for (const r of requested) {
      const list = groups.get(r.pos) || []
      list.push(r.id)
      groups.set(r.pos, list)
    }

    const uniquePositions = Array.from(groups.keys()).sort((a, b) => a - b)

    const payout = {}
    let cursor = 1

    for (const pos of uniquePositions) {
      const tiedIds = groups.get(pos) || []
      if (tiedIds.length === 0) continue

      // Advance cursor to at least pos (keeps order stable even if user picks gaps)
      cursor = Math.max(cursor, pos)

      const occupied = tiedIds.length
      let pool = 0
      for (let p = cursor; p < cursor + occupied; p += 1) {
        pool += Number(autoAmounts[String(p)] ?? 0) || 0
      }

      const each = pool / occupied
      for (const id of tiedIds) payout[id] = each

      cursor += occupied
    }

    // Any player not covered (shouldn't happen) gets 0
    for (const id of ids) {
      if (payout[id] === undefined) payout[id] = 0
    }

    return payout
  }, [playersSorted, positionsByPlayerId, matchFee, effectiveMaxPosition])

  function submitMatch(e) {
    e.preventDefault()
    if (playersSorted.length === 0) return

    const fee = Number(matchFee)
    const safeFee = Number.isFinite(fee) ? fee : 0

    const entries = playersSorted.map((p) => {
      const pos = Number(positionsByPlayerId[p.id] || 1)
      const amount = payoutsByPlayerId[p.id] ?? 0
      return { date, playerId: p.id, position: pos, amount, matchFee: safeFee }
    })

    onAddMatches(entries)

    // Reset form and notify parent
    const msg = `Saved results for ${playersSorted.length} player(s) on ${date}.`
    setDate(new Date().toISOString().slice(0, 10))
    setMatchFee(20)
    setPositionsByPlayerId(() => {
      const init = {}
      for (const p of playersSorted) init[p.id] = 1
      return init
    })

    window.clearTimeout(submitMatch._t)
    submitMatch._t = window.setTimeout(() => {
      setSuccess('')
      onSuccess(msg)
    }, 0)
  }

  return (
    <div className="grid">
      <section className="card">
        <h2>Add match entry</h2>
        {playersSorted.length === 0 ? (
          <p className="hint">Add players in Players tab first.</p>
        ) : (
          <form className="grid" onSubmit={submitMatch}>
            <div className="row">
              <label className="field">
                Date
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </label>
              <label className="field">
                Match fee (per player)
                <input
                  type="number"
                  value={matchFee}
                  onChange={(e) => setMatchFee(e.target.value)}
                  placeholder="20"
                />
              </label>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Position</th>
                  <th>Winning</th>
                </tr>
              </thead>
              <tbody>
                {playersSorted.map((p) => {
                  const pos = Math.min(effectiveMaxPosition, Math.max(1, Number(positionsByPlayerId[p.id] || 1)))
                  const amt = payoutsByPlayerId[p.id] ?? 0
                  return (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>
                        <select
                          className="select-lg"
                          value={pos}
                          onChange={(e) =>
                            setPositionsByPlayerId((prev) => ({
                              ...prev,
                              [p.id]: Number(e.target.value),
                            }))
                          }
                        >
                          {Array.from({ length: effectiveMaxPosition }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>{currency(amt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <div className="inline">
              <button className="btn btn-primary" type="submit">
                Add result
              </button>
            </div>
          </form>
        )}
      </section>


    </div>
  )
}

