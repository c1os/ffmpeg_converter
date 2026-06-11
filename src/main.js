import { FFmpeg } from "@ffmpeg/ffmpeg"
import { fetchFile, toBlobURL } from "@ffmpeg/util"
import JSZip from "jszip"

// ---------------------------------------------------------------------------
// Format definitions
// ---------------------------------------------------------------------------
const FORMATS = {
  webm: {
    ext: "webm",
    mime: "video/webm",
    label: "WebM",
    supportsAlpha: true,
    qualityLabel: "Quality (CRF)",
    desc: "VP9 video. Best quality-to-size and supports transparency.",
    alphaNote: "VP9 keeps the alpha channel if the source has one.",
  },
  webp: {
    ext: "webp",
    mime: "image/webp",
    label: "Animated WebP",
    supportsAlpha: true,
    qualityLabel: "Quality",
    desc: "Animated WebP image. Great for the web, supports transparency.",
    alphaNote: "Transparent pixels are preserved if present in the source.",
  },
  gif: {
    ext: "gif",
    mime: "image/gif",
    label: "GIF",
    supportsAlpha: false,
    qualityLabel: "Colors (palette)",
    desc: "Classic animated GIF. Universally supported, larger files.",
    alphaNote: "GIF can't store smooth transparency — disabled.",
  },
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ffmpeg = null
let engineReady = false
let engineLoading = false
let enginePromise = null
let isConverting = false
const files = [] // { id, file, status, progress, results: [{url, name, size}], error }
let idCounter = 0

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel)
const dropzone = $("#dropzone")
const fileInput = $("#file-input")
const fileListEl = $("#filelist")
const emptyState = $("#empty-state")
const clearBtn = $("#clear-btn")
const clearStorageBtn = $("#clear-storage-btn")
const convertBtn = $("#convert-btn")
const statusDot = $("#engine-status .engine-status__dot")
const statusText = $("#engine-status-text")
const downloadAllBtn = $("#download-all-btn")

const alphaToggle = $("#alpha-toggle")
const alphaNote = $("#alpha-note")
const loopToggle = $("#loop-toggle")
const fpsInput = $("#fps")
const fpsOut = $("#fps-out")
const qualityInput = $("#quality")
const qualityOut = $("#quality-out")
const qualityLabel = $("#quality-label")
const widthInput = $("#width")
const widthOut = $("#width-out")
const formatDesc = $("#format-desc")

const getFormat = () => document.querySelector('input[name="format"]:checked').value

// ---------------------------------------------------------------------------
// FFmpeg engine bootstrap (lazy — only loads on first conversion)
//
// We prefer the SINGLE-THREAD core (@ffmpeg/core) when the page is not
// cross-origin isolated. The multi-thread core (@ffmpeg/core-mt) provides
// much better performance but requires `crossOriginIsolated === true`
// (COOP/COEP headers) and uses a worker/SharedArrayBuffer.
//
// Per the ffmpeg.wasm docs, Vite users should use the `esm` build for the
// single-thread core and the `umd` build for the multi-thread core worker files.
// ---------------------------------------------------------------------------
const CORE_VERSION = "0.12.10"
const CORE_SINGLE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`
const CORE_MULTI = `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${CORE_VERSION}/dist/umd`

// runtime detection: only enable multi-thread when crossOriginIsolated is true
let useMultiThread = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true

// Set to `true` to eagerly load the engine on page load (costly; ~30MB)
const EAGER_LOAD = false

function setEngineStatus(state, text) {
  statusDot.dataset.state = state
  statusText.textContent = text
}

async function loadEngine() {
  if (engineReady) return true
  if (enginePromise) return enginePromise

  engineLoading = true
  setEngineStatus("loading", "Loading conversion engine…")
  refreshControls()

  enginePromise = (async () => {
    const CORE_BASE = useMultiThread ? CORE_MULTI : CORE_SINGLE
    console.log("[W&F] ffmpeg core:", useMultiThread ? "core-mt (multi-thread)" : "core (single-thread)")

    ffmpeg = new FFmpeg()
    ffmpeg.on("log", ({ message }) => console.log("[W&F][ffmpeg]", message))

    if (useMultiThread) {
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
        workerURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.worker.js`, "text/javascript"),
      })
    } else {
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      })
    }

    engineReady = true
    engineLoading = false
    setEngineStatus("ready", "Conversion engine ready")
    refreshControls()
    return true
  })()

  try {
    return await enginePromise
  } catch (err) {
    console.log("[W&F] engine load failed:", err)
    engineLoading = false
    enginePromise = null
    setEngineStatus("error", "Couldn't load the engine. Check your connection and try Convert again.")
    refreshControls()
    return false
  }
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------
const ACCEPTED = /\.(mp4|mov)$/i
const ACCEPTED_MIME = ["video/mp4", "video/quicktime"]

function isAccepted(file) {
  return ACCEPTED.test(file.name) || ACCEPTED_MIME.includes(file.type)
}

function addFiles(fileList) {
  let added = 0
  for (const file of fileList) {
    if (!isAccepted(file)) continue
    // de-dupe by name + size
    if (files.some((f) => f.file.name === file.name && f.file.size === file.size)) continue
    files.push({
      id: ++idCounter,
      file,
      status: "queued",
      progress: 0,
      results: [],
      error: null,
    })
    added++
  }
  if (added === 0 && fileList.length > 0) {
    flashDropzone("No supported .mp4 / .mov files found")
  }
  render()
}

function removeFile(id) {
  const idx = files.findIndex((f) => f.id === id)
  if (idx === -1) return
  files[idx].results.forEach((r) => URL.revokeObjectURL(r.url))
  files.splice(idx, 1)
  render()
}

function clearAll() {
  files.forEach((f) => f.results.forEach((r) => URL.revokeObjectURL(r.url)))
  files.length = 0
  render()
  // Also wipe any leftover storage so memory doesn't accumulate
  clearStorage({ silent: true })
}

/**
 * Purges all browser storage used by this app:
 *  1. The "ffmpeg-converter" IndexedDB (written by the legacy ffmpeg_converter.js code)
 *  2. The ffmpeg WASM worker — terminate() kills the Web Worker and frees WASM heap memory.
 *     The engine state is reset so the next conversion re-initialises cleanly.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false]  Skip the flash message (used when called from clearAll)
 */
async function clearStorage({ silent = false } = {}) {
  // 1. Terminate the ffmpeg worker and reset engine state
  if (ffmpeg) {
    try { ffmpeg.terminate() } catch { }
    ffmpeg = null
  }
  engineReady = false
  engineLoading = false
  enginePromise = null
  setEngineStatus("idle", "Engine loads automatically the first time you convert.")
  refreshControls()

  // 2. Delete the legacy IndexedDB ("ffmpeg-converter") if it exists
  await new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase("ffmpeg-converter")
      req.onsuccess = resolve
      req.onerror = resolve   // resolve even on error — non-fatal
      req.onblocked = resolve
    } catch {
      resolve()
    }
  })

  if (!silent) flashDropzone("Browser storage cleared ✓")
}

function flashDropzone(msg) {
  const orig = dropzone.querySelector(".dropzone__hint").textContent
  const hint = dropzone.querySelector(".dropzone__hint")
  hint.textContent = msg
  setTimeout(() => (hint.textContent = orig), 2200)
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function buildVideoFilters() {
  const filters = []
  const fps = parseInt(fpsInput.value, 10)
  filters.push(`fps=${fps}`)
  const width = parseInt(widthInput.value, 10)
  if (width > 0) {
    // keep aspect ratio, force even dimensions for codec compatibility
    filters.push(`scale=${width}:-2:flags=lanczos`)
  }
  return filters
}

function buildArgs(format, inputName, outputName) {
  const useAlpha = FORMATS[format].supportsAlpha && alphaToggle.checked
  const loop = loopToggle.checked
  const quality = parseInt(qualityInput.value, 10)
  const filters = buildVideoFilters()

  if (format === "webm") {
    const crf = Math.round(63 - (quality / 100) * 53)

    const args = [
      "-i", inputName,
      "-an",
      "-c:v", "libvpx-vp9",
      "-crf", String(crf),
      "-b:v", "0",
      "-deadline", "realtime",
      "-cpu-used", "8",
      "-tile-columns", "0",
      "-frame-parallel", "0",
      "-auto-alt-ref", "0",
      "-vf", useAlpha
        ? `${filters.join(",")},format=yuva420p`
        : `${filters.join(",")},format=yuv420p`,
    ]
    if (useMultiThread) args.push("-row-mt", "1")
    args.push(outputName)
    return args
  }

  if (format === "webp") {
    if (useAlpha) filters.push("format=yuva420p")
    return [
      "-i", inputName,
      "-an",
      "-vcodec", "libwebp_anim",
      "-lossless", "0",
      "-q:v", String(quality),
      "-loop", loop ? "0" : "1",
      "-preset", "default",
      "-vf", filters.join(","),
      outputName,
    ]
  }

  if (format === "gif") {
    const colors = Math.max(8, Math.round((quality / 100) * 248) + 8)
    const vf =
      `${filters.join(",")},split[s0][s1];` +
      `[s0]palettegen=max_colors=${colors}[p];` +
      `[s1][p]paletteuse=dither=bayer`
    return [
      "-i", inputName,
      "-an",
      "-loop", loop ? "0" : "-1",
      "-vsync", "0",
      "-vf", vf,
      outputName,
    ]
  }
}

async function convertOne(entry, format) {
  const fmt = FORMATS[format]
  const baseName = entry.file.name.replace(/\.[^.]+$/, "")
  const inputName = `in_${entry.id}.${entry.file.name.split(".").pop()}`
  const outputName = `out_${entry.id}.${fmt.ext}`

  entry.status = "processing"
  entry.progress = 0
  entry.error = null
  render()

  // progress handler scoped to this run
  const onProgress = ({ progress }) => {
    entry.progress = Math.max(0, Math.min(1, progress))
    updateProgress(entry)
  }
  ffmpeg.on("progress", onProgress)

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(entry.file))
    const args = buildArgs(format, inputName, outputName)
    console.log("[W&F] ffmpeg args:", args.join(" "))
    try {
      await ffmpeg.exec(args)
    } catch (execErr) {
      // Retry WebM with VP8 if VP9 isn't available or failed in this build
      if (format === "webm" && args.includes("libvpx-vp9")) {
        console.log("[W&F] retrying WebM with libvpx (VP8) due to exec error:", execErr)
        const fallbackArgs = args.map((a) => (a === "libvpx-vp9" ? "libvpx" : a))
        await ffmpeg.exec(fallbackArgs)
      } else {
        throw execErr
      }
    }

    const data = await ffmpeg.readFile(outputName)
    const blob = new Blob([data.buffer], { type: fmt.mime })
    const url = URL.createObjectURL(blob)
    entry.results = [{ url, name: `${baseName}.${fmt.ext}`, size: blob.size }]
    entry.status = "done"
    entry.progress = 1

    // cleanup virtual FS
    await ffmpeg.deleteFile(inputName).catch(() => { })
    await ffmpeg.deleteFile(outputName).catch(() => { })
  } catch (err) {
    console.log("[W&F] conversion error:", err)
    entry.status = "error"
    entry.error = "Conversion failed. The codec or source may be unsupported."
  } finally {
    ffmpeg.off("progress", onProgress)
    render()
  }
}

async function convertAll() {
  if (isConverting) return
  // FIX: also re-queue files that previously errored so retries work
  const queue = files.filter((f) => f.status !== "done")
  if (queue.length === 0) return

  isConverting = true
  refreshControls()

  // Lazily boot the engine on first conversion.
  if (!engineReady) {
    const ok = await loadEngine()
    if (!ok) {
      isConverting = false
      refreshControls()
      return
    }
  }

  const format = getFormat()
  // FIX: process sequentially — ffmpeg.wasm can only run one exec() at a time.
  // forEach(async) would fire them all in parallel, causing the last file to hang.
  for (const entry of queue) {
    await convertOne(entry, format)
  }

  isConverting = false
  refreshControls()
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function updateProgress(entry) {
  const bar = fileListEl.querySelector(`[data-bar="${entry.id}"]`)
  const pct = fileListEl.querySelector(`[data-pct="${entry.id}"]`)
  const badge = fileListEl.querySelector(`[data-badge="${entry.id}"]`)

  const isProcessing = entry.status === "processing"

  // Cap bar at 99% while still processing — ffmpeg's progress event fires at 1.0
  // before exec() resolves (output is still being muxed/flushed to the virtual FS).
  // We only show 100% once the file is truly done.
  const rawPct = Math.round(entry.progress * 100)
  const displayPct = isProcessing ? Math.min(rawPct, 99) : rawPct

  if (bar) bar.style.width = `${displayPct}%`
  if (pct) pct.textContent = `${displayPct}%`

  // When progress hits 100% but exec() hasn't returned, switch the badge to
  // "Finalizing…" so the user knows it's wrapping up — not frozen.
  if (badge && isProcessing && entry.progress >= 1) {
    badge.textContent = "Finalizing…"
    badge.dataset.state = "finalizing"
  }
}

function render() {
  emptyState.style.display = files.length ? "none" : "block"
  clearBtn.disabled = files.length === 0 || isConverting

  fileListEl.innerHTML = ""
  for (const entry of files) {
    const li = document.createElement("li")
    li.className = "file"

    const badgeState =
      entry.status === "done" ? "done" : entry.status === "error" ? "error" : entry.status === "processing" ? "processing" : "queued"
    const badgeText =
      entry.status === "done" ? "Done" : entry.status === "error" ? "Error" : entry.status === "processing" ? "Working" : "Queued"

    // While processing, cap the displayed % at 99 so it never shows 100% while still "Working"
    const isProcessing = entry.status === "processing"
    const displayPct = isProcessing ? Math.min(Math.round(entry.progress * 100), 99) : Math.round(entry.progress * 100)

    li.innerHTML = `
      <div class="file__top">
        <span class="file__name" title="${escapeHtml(entry.file.name)}">${escapeHtml(entry.file.name)}</span>
        <span class="file__meta">${formatBytes(entry.file.size)}</span>
        <button class="file__remove" type="button" aria-label="Remove ${escapeHtml(entry.file.name)}" data-remove="${entry.id}">&times;</button>
      </div>
      <div class="file__status">
        <span class="file__badge" data-state="${badgeState}" data-badge="${entry.id}">${badgeText}</span>
        <span data-pct="${entry.id}">${displayPct}%</span>
      </div>
      <div class="progress"><div class="progress__bar" data-bar="${entry.id}" style="width:${displayPct}%"></div></div>
    `

    if (entry.results && entry.results.length) {
      const result = document.createElement("div")
      result.className = "file__result"
      for (const r of entry.results) {
        const a = document.createElement("a")
        a.className = "btn btn--download"
        a.href = r.url
        a.download = r.name
        a.innerHTML = `&darr; ${escapeHtml(r.name)} <span style="opacity:.7">(${formatBytes(r.size)})</span>`
        result.appendChild(a)
      }
      li.appendChild(result)
    }

    if (entry.status === "error" && entry.error) {
      const errEl = document.createElement("div")
      errEl.className = "file__error"
      errEl.textContent = entry.error
      li.appendChild(errEl)
    }

    fileListEl.appendChild(li)
  }

  refreshControls()
}

function refreshControls() {
  const pending = files.some((f) => f.status !== "done")
  convertBtn.disabled = isConverting || files.length === 0 || !pending
  convertBtn.textContent = engineLoading
    ? "Loading engine…"
    : isConverting
      ? "Converting…"
      : "Convert all files"
  clearBtn.disabled = files.length === 0 || isConverting
  // enable download-all when there is at least one completed result and not converting
  const anyResults = files.some((f) => f.results && f.results.length)
  if (downloadAllBtn) downloadAllBtn.disabled = isConverting || !anyResults

    // disable settings while converting
    ;[alphaToggle, loopToggle, fpsInput, qualityInput, widthInput].forEach((el) => {
      el.disabled = isConverting
    })
  document.querySelectorAll('input[name="format"]').forEach((el) => (el.disabled = isConverting))
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  )
}

// ---------------------------------------------------------------------------
// Settings UI sync
// ---------------------------------------------------------------------------
function syncFormatUI() {
  const fmt = FORMATS[getFormat()]
  formatDesc.textContent = fmt.desc
  qualityLabel.textContent = fmt.qualityLabel
  alphaNote.textContent = fmt.alphaNote

  // alpha availability
  alphaToggle.disabled = !fmt.supportsAlpha || isConverting
  if (!fmt.supportsAlpha) alphaToggle.checked = false

  // loop applies to webp/gif only
  const loopWrap = loopToggle.closest(".field")
  loopWrap.style.display = getFormat() === "webm" ? "none" : "block"

  syncQualityOut()
}

function syncQualityOut() {
  const fmt = getFormat()
  const q = parseInt(qualityInput.value, 10)
  if (fmt === "gif") {
    const colors = Math.max(8, Math.round((q / 100) * 248) + 8)
    qualityOut.textContent = `${colors} colors`
  } else {
    qualityOut.textContent = `${q}/100`
  }
}

function syncFps() {
  fpsOut.textContent = `${fpsInput.value} fps`
}

function syncWidth() {
  const w = parseInt(widthInput.value, 10)
  widthOut.textContent = w === 0 ? "Original" : `${w}px`
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
dropzone.addEventListener("click", () => fileInput.click())
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    fileInput.click()
  }
})
fileInput.addEventListener("change", (e) => {
  addFiles(e.target.files)
  // FIX: reset value so the same file(s) can be re-selected later
  fileInput.value = ""
})

  ;["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault()
      dropzone.classList.add("is-dragover")
    })
  )
  ;["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault()
      if (evt === "dragleave" && dropzone.contains(e.relatedTarget)) return
      dropzone.classList.remove("is-dragover")
    })
  )
dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
})

fileListEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove]")
  if (btn) removeFile(Number(btn.dataset.remove))
})

clearBtn.addEventListener("click", clearAll)
if (clearStorageBtn) clearStorageBtn.addEventListener("click", () => clearStorage())
convertBtn.addEventListener("click", convertAll)

if (downloadAllBtn) {
  downloadAllBtn.addEventListener("click", async () => {
    // collect all result entries
    const zip = new JSZip()
    let added = 0
    for (const entry of files) {
      if (!entry.results || !entry.results.length) continue
      for (const r of entry.results) {
        try {
          const resp = await fetch(r.url)
          const blob = await resp.blob()
          zip.file(r.name, blob)
          added++
        } catch (e) {
          console.log('[W&F] failed to fetch result for zip', r, e)
        }
      }
    }
    if (added === 0) return flashDropzone('No files ready to download')
    const content = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(content)
    const a = document.createElement('a')
    a.href = url
    a.download = 'converted-results.zip'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  })
}

document.querySelectorAll('input[name="format"]').forEach((el) =>
  el.addEventListener("change", () => {
    syncFormatUI()
    refreshControls()
  })
)
qualityInput.addEventListener("input", syncQualityOut)
fpsInput.addEventListener("input", syncFps)
widthInput.addEventListener("input", syncWidth)

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
syncFormatUI()
syncFps()
syncWidth()
render()
setEngineStatus("idle", "Engine loads automatically the first time you convert.")

// Optionally preload the engine on page load (toggle via EAGER_LOAD)
if (EAGER_LOAD) {
  loadEngine().catch((err) => console.log('[W&F] eager load failed', err))
}
