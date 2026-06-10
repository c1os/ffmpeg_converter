let ffmpeg = null
let loaded = false

// IndexedDB helpers for storing uploads and outputs
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ffmpeg-converter', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('uploads')) db.createObjectStore('uploads')
      if (!db.objectStoreNames.contains('outputs')) db.createObjectStore('outputs')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function saveFileToDB(name, file) {
  function readFileAsArrayBuffer(f) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(f)
    })
  }

  const data = await readFileAsArrayBuffer(file)
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('uploads', 'readwrite')
    const store = tx.objectStore('uploads')
    const req = store.put(data, name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

async function getFileFromDB(name) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('uploads', 'readonly')
    const store = tx.objectStore('uploads')
    const req = store.get(name)
    req.onsuccess = () => {
      if (req.result) resolve(new Uint8Array(req.result))
      else reject(new Error('file not found in DB: ' + name))
    }
    req.onerror = () => reject(req.error)
  })
}

async function saveOutputToDB(name, uint8array) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outputs', 'readwrite')
    const store = tx.objectStore('outputs')
    store.put(uint8array, name)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function listOutputsFromDB() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outputs', 'readonly')
    const store = tx.objectStore('outputs')
    const req = store.getAllKeys()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function loadFFmpegModule() {
  try {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg')
    const { toBlobURL } = await import('@ffmpeg/util')

    ffmpeg = new FFmpeg()

    // 1. Point to the multi-threaded core pool (-mt)
    const baseURL = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm'
    
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      // 2. CRITICAL: Provide the worker script so WebAssembly can split memory allocations safely
      workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
    })

    loaded = true
  } catch (err) {
    console.error('loadFFmpegModule error:', err)
    loaded = false
    throw new Error('Failed to load @ffmpeg/ffmpeg: ' + err.message)
  }
}

function mkOption(label, id, type = 'text', attrs = {}) {
  const el = document.createElement(type === 'textarea' ? 'textarea' : 'input')
  el.id = id
  if (type !== 'textarea') el.type = type
  for (const [k, v] of Object.entries(attrs || {})) {
    el.setAttribute(k, v)
  }
  const wrapper = document.createElement('label')
  wrapper.style.display = 'block'
  wrapper.style.margin = '6px 0'
  wrapper.appendChild(document.createTextNode(label + ': '))
  wrapper.appendChild(el)
  return { wrapper, el }
}

export async function setupConverter(root) {
  await import('./main.css')

  const container = document.createElement('div')
  container.className = 'converter-container'
  container.innerHTML = `<h1>🎬 Universal Video Converter</h1>`

  const dropZone = document.createElement('div')
  dropZone.className = 'drop-zone'
  dropZone.innerHTML = `
    <div class="drop-zone-text">📁 Drop files here or click to browse</div>
    <div class="drop-zone-hint">Supports: MOV, MP4, GIF, WebM</div>
  `

  const fileInput = document.createElement('input')
  fileInput.id = 'fileInput'
  fileInput.type = 'file'
  fileInput.multiple = true
  fileInput.accept = '.mov,.mp4,.gif,.webm'
  dropZone.appendChild(fileInput)

  const fileList = document.createElement('div')
  fileList.className = 'file-list'
  fileList.style.display = 'none'
  dropZone.appendChild(fileList)

  container.appendChild(dropZone)

  const formatSection = document.createElement('div')
  formatSection.className = 'section'
  formatSection.innerHTML = '<label class="section-title">Export Format</label>'
  
  const formatSelect = document.createElement('select')
  const formats = ['WebM (VP9)','WebP (Animated)','GIF']
  for (const f of formats) {
    const o = document.createElement('option')
    o.value = f
    o.text = f
    formatSelect.appendChild(o)
  }
  formatSection.appendChild(formatSelect)
  container.appendChild(formatSection)

  const presetSection = document.createElement('div')
  presetSection.className = 'section'
  presetSection.innerHTML = '<label class="section-title">Quality Preset</label>'
  
  const presetWrap = document.createElement('div')
  presetWrap.className = 'radio-group'
  const presets = ['Fast','Balanced','High Quality']
  for (const p of presets) {
    const r = document.createElement('input')
    r.type = 'radio'
    r.name = 'preset'
    r.value = p
    if (p === 'Balanced') r.checked = true
    const lab = document.createElement('label')
    lab.appendChild(r)
    lab.appendChild(document.createTextNode(p))
    presetWrap.appendChild(lab)
  }
  presetSection.appendChild(presetWrap)
  container.appendChild(presetSection)

  const optionsSection = document.createElement('div')
  optionsSection.className = 'section'
  
  const { wrapper: crfWrap, el: crfEl } = mkOption('CRF (lower = better quality)', 'crf', 'number', { min: 18, max: 40, value: 28 })
  optionsSection.appendChild(crfWrap)

  const { wrapper: keepAudioWrap, el: keepAudioEl } = mkOption('Keep Audio', 'keepAudio', 'checkbox')
  optionsSection.appendChild(keepAudioWrap)

  const { wrapper: preserveAlphaWrap, el: preserveAlphaEl } = mkOption('Preserve Alpha', 'preserveAlpha', 'checkbox')
  optionsSection.appendChild(preserveAlphaWrap)

  container.appendChild(optionsSection)

  const convertButton = document.createElement('button')
  convertButton.className = 'convert-button'
  convertButton.textContent = '▶ Convert'
  container.appendChild(convertButton)

  const logContainer = document.createElement('div')
  logContainer.className = 'log-container'
  logContainer.innerHTML = '<label class="log-label">Conversion Log</label>'
  
  const log = document.createElement('textarea')
  log.id = 'log'
  log.rows = 10
  log.readOnly = true
  logContainer.appendChild(log)
  container.appendChild(logContainer)

  const outputLinks = document.createElement('div')
  outputLinks.className = 'output-links'
  container.appendChild(outputLinks)

  root.appendChild(container)

  function logLine(s) {
    log.value += s + '\n'
    log.scrollTop = log.scrollHeight
  }

  function updateFileList() {
    const files = Array.from(fileInput.files || [])
    if (files.length > 0) {
      fileList.innerHTML = ''
      files.forEach(file => {
        const sizeInMB = (file.size / (1024 * 1024)).toFixed(2)
        const item = document.createElement('div')
        item.className = 'file-item'
        item.innerHTML = `
          <span class="file-name">${file.name}</span>
          <span class="file-size">${sizeInMB} MB</span>
        `
        fileList.appendChild(item)
      })
      fileList.style.display = 'block'
    } else {
      fileList.style.display = 'none'
    }
  }

  dropZone.addEventListener('click', () => fileInput.click())

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault()
    dropZone.classList.add('dragover')
  })

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover')
  })

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault()
    dropZone.classList.remove('dragover')
    fileInput.files = e.dataTransfer.files
    const event = new Event('change', { bubbles: true })
    fileInput.dispatchEvent(event)
  })

  fileInput.addEventListener('change', () => {
    updateFileList()
    const files = Array.from(fileInput.files || [])
    if (files.length > 0) {
      logLine(`\n📂 ${files.length} file(s) selected:`)
      files.forEach(async (file) => {
        const sizeInMB = (file.size / (1024 * 1024)).toFixed(2)
        logLine(`  ✓ ${file.name} (${sizeInMB} MB)`)
        try {
          await saveFileToDB(file.name, file)
          logLine(`    → saved ${file.name} to browser storage`)
        } catch (e) {
          logLine(`    ✗ failed saving ${file.name}: ${e.message}`)
        }
      })
    }
  })

  async function ensureLoaded() {
    if (!loaded) {
      logLine('Loading ffmpeg.wasm...')
      try {
        await loadFFmpegModule()
        ffmpeg.on('log', ({ message }) => logLine(message))
        logLine('✓ ffmpeg loaded.')
      } catch (e) {
        logLine('✗ Error loading ffmpeg: ' + e.message)
        throw e
      }
    }
  }

  convertButton.addEventListener('click', async () => {
    const files = Array.from(fileInput.files || [])
    if (!files.length) {
      alert('Please select files to convert')
      return
    }

    await ensureLoaded()
    outputLinks.innerHTML = ''

    const cpuUsedMap = { 'Fast': '8', 'Balanced': '4', 'High Quality': '1' }
    const preset = document.querySelector('input[name="preset"]:checked').value
    const cpuUsed = cpuUsedMap[preset]
    const crf = crfEl.value || 28
    const keepAudio = keepAudioEl.checked
    const preserveAlpha = preserveAlphaEl.checked

    for (const file of files) {
      const name = file.name
      const inName = 'in_' + name
      const base = name.replace(/\.[^/.]+$/, '')

      logLine('\nStarting: ' + name)

      try {
        const data = await getFileFromDB(name)
        await ffmpeg.writeFile(inName, data)

        let extension = '.webm'
        let suffix = '_vp9'
        const outputFormat = formatSelect.value

        if (outputFormat === 'WebM (VP9)') {
          extension = '.webm'
          suffix = '_vp9'
        } else if (outputFormat === 'WebP (Animated)') {
          extension = '.webp'
          suffix = '_webp'
        } else if (outputFormat === 'GIF') {
          extension = '.gif'
          suffix = '_gif'
        }

        const outName = `${base}${suffix}${extension}`
        const cmd = ['-y', '-i', inName]

        if (outputFormat === 'WebM (VP9)') {
          // FIX: Removed '-threads 16' and '-row-mt 1' to avoid breaking the sequential WASM module core structure
          cmd.push('-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-deadline', 'good', '-cpu-used', cpuUsed)
          if (preserveAlpha) cmd.push('-pix_fmt', 'yuva420p')
          else cmd.push('-pix_fmt', 'yuv420p')
        } else if (outputFormat === 'WebP (Animated)') {
          cmd.push('-c:v', 'libwebp', '-lossless', '0', '-qscale', String(Math.max(10, Math.min(100, 100 - crf))), '-preset', 'default', '-loop', '0')
        } else if (outputFormat === 'GIF') {
          cmd.push('-vf', 'fps=15,scale=512:-1:flags=lanczos')
        }

        if (keepAudio && outputFormat === 'WebM (VP9)') {
          cmd.push('-c:a', 'libopus')
        } else {
          cmd.push('-an')
        }

        cmd.push(outName)
        logLine('Running ffmpeg: ' + cmd.join(' '))

        let processingSuccess = false
        try {
          // modern API .exec returns exit code 0 if successful
          const exitCode = await ffmpeg.exec(cmd)
          if (exitCode === 0) {
            processingSuccess = true
          } else {
            logLine(`✗ ffmpeg finished with errors. Exit code: ${exitCode}`)
          }
        } catch (e) {
          logLine('✗ ffmpeg runtime execution crash: ' + (e.message || String(e)))
        }

        // Guard Check: Don't read or process missing/broken files
        if (processingSuccess) {
          try {
            const outData = await ffmpeg.readFile(outName)
            
            if (outData && outData.length > 0) {
              const blob = new Blob([outData.buffer || outData], { type: 'application/octet-stream' })
              
              try {
                await saveOutputToDB(outName, outData)
                logLine(`    → saved output ${outName} to browser storage`)
              } catch (e) {
                logLine(`    ✗ failed saving output ${outName}: ${e.message}`)
              }
              
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = outName
              a.textContent = `Download ${outName}`
              a.style.display = 'block'
              outputLinks.appendChild(a)
              logLine(`✓ ${name} -> ${outName} (${(outData.length / (1024 * 1024)).toFixed(2)} MB)`)
            } else {
              logLine('✗ Output generated successfully but the written binary block contains 0 bytes.')
            }
          } catch (e) {
            logLine('✗ Failed to read output file: ' + String(e))
          }
        }

        // Cleanup virtual environment files
        try { await ffmpeg.deleteFile(inName) } catch {}
        try { await ffmpeg.deleteFile(outName) } catch {}

      } catch (err) {
        logLine('✗ Error processing ' + name + ': ' + String(err))
      }
    }

    logLine('\nDone.')
  })
}