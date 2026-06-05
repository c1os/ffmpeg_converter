let ffmpeg = null
let _fetchFile = null
let loaded = false

async function loadFFmpegModule() {
  try {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg')
    const { fetchFile } = await import('@ffmpeg/util')
    
    _fetchFile = fetchFile
    ffmpeg = new FFmpeg()
    
    // Modern logging syntax
    ffmpeg.on('log', ({ message }) => {
      console.log(message)
    })
    
  } catch (err) {
    console.error('loadFFmpegModule error:', err)
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
  // Import CSS
  await import('./main.css')

  const container = document.createElement('div')
  container.className = 'converter-container'
  
  container.innerHTML = `<h1>🎬 Universal Video Converter</h1>`

  // ===== FILE DROP ZONE =====
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

  // ===== FORMAT SECTION =====
  const formatSection = document.createElement('div')
  formatSection.className = 'section'
  formatSection.innerHTML = '<label class="section-title">Export Format</label>'
  
  const formatSelect = document.createElement('select')
  const formats = ['WebM (VP9)','MP4 (H264)','GIF','MOV (ProRes 4444)']
  for (const f of formats) {
    const o = document.createElement('option')
    o.value = f
    o.text = f
    formatSelect.appendChild(o)
  }
  formatSection.appendChild(formatSelect)
  container.appendChild(formatSection)

  // ===== PRESET SECTION =====
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

  // ===== OPTIONS SECTION =====
  const optionsSection = document.createElement('div')
  optionsSection.className = 'section'
  
  const { wrapper: crfWrap, el: crfEl } = mkOption('CRF (lower = better quality)', 'crf', 'number', { min: 18, max: 40, value: 28 })
  optionsSection.appendChild(crfWrap)

  const { wrapper: keepAudioWrap, el: keepAudioEl } = mkOption('Keep Audio', 'keepAudio', 'checkbox')
  optionsSection.appendChild(keepAudioWrap)

  const { wrapper: preserveAlphaWrap, el: preserveAlphaEl } = mkOption('Preserve Alpha', 'preserveAlpha', 'checkbox')
  optionsSection.appendChild(preserveAlphaWrap)

  container.appendChild(optionsSection)

  // ===== CONVERT BUTTON =====
  const convertButton = document.createElement('button')
  convertButton.className = 'convert-button'
  convertButton.textContent = '▶ Convert'
  container.appendChild(convertButton)

  // ===== LOG AREA =====
  const logContainer = document.createElement('div')
  logContainer.className = 'log-container'
  logContainer.innerHTML = '<label class="log-label">Conversion Log</label>'
  
  const log = document.createElement('textarea')
  log.id = 'log'
  log.rows = 10
  log.readOnly = true
  logContainer.appendChild(log)
  container.appendChild(logContainer)

  // ===== OUTPUT LINKS =====
  const outputLinks = document.createElement('div')
  outputLinks.className = 'output-links'
  container.appendChild(outputLinks)

  root.appendChild(container)

  // ===== EVENT HANDLERS =====
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

  // ===== DRAG AND DROP =====
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
      files.forEach(file => {
        const sizeInMB = (file.size / (1024 * 1024)).toFixed(2)
        logLine(`  ✓ ${file.name} (${sizeInMB} MB)`)
      })
    }
  })

  async function ensureLoaded() {
    if (!loaded) {
      logLine('Loading ffmpeg.wasm...')
      if (!ffmpeg) {
        try {
          await loadFFmpegModule()
        } catch (e) {
          logLine('✗ Error loading ffmpeg module: ' + e.message)
          throw e
        }
      }
      
      try {
        await ffmpeg.load()
        ffmpeg.on('log', ({ message }) => logLine(message))
        loaded = true
        logLine('✓ ffmpeg loaded.')
      } catch (e) {
        logLine('✗ Error loading ffmpeg core: ' + e.message)
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

    const cpuUsedMap = { 'Fast': '6', 'Balanced': '4', 'High Quality': '2' }
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
        const data = await _fetchFile(file)
        
        // FIXED: Modern writeFile API
        await ffmpeg.writeFile(inName, data)

        let extension = '.webm'
        let suffix = '_vp9'
        const outputFormat = formatSelect.value

        if (outputFormat === 'WebM (VP9)') {
          extension = '.webm'
          suffix = '_vp9'
        } else if (outputFormat === 'MP4 (H264)') {
          extension = '.mp4'
          suffix = '_h264'
        } else if (outputFormat === 'GIF') {
          extension = '.gif'
          suffix = '_gif'
        } else {
          extension = '.mov'
          suffix = '_prores'
        }

        const outName = `${base}${suffix}${extension}`
        const cmd = ['-y', '-i', inName]

        // Video codec and options
        if (outputFormat === 'WebM (VP9)') {
          cmd.push('-c:v','libvpx-vp9','-row-mt','1','-threads','16','-crf',String(crf),'-b:v','0','-deadline','good','-cpu-used',cpuUsed)
          if (preserveAlpha) cmd.push('-pix_fmt','yuva420p')
          else cmd.push('-pix_fmt','yuv420p')
        } else if (outputFormat === 'MP4 (H264)') {
          cmd.push('-c:v','libx264','-crf',String(crf),'-pix_fmt','yuv420p')
        } else if (outputFormat === 'GIF') {
          cmd.push('-vf','fps=15')
        } else if (outputFormat === 'MOV (ProRes 4444)') {
          cmd.push('-c:v','prores_ks','-profile:v','4444')
          if (preserveAlpha) cmd.push('-pix_fmt','yuva444p10le')
          else cmd.push('-pix_fmt','yuv422p10le')
        }

        // Audio
        if (keepAudio) {
          if (outputFormat === 'WebM (VP9)') cmd.push('-c:a','libopus')
          else if (outputFormat === 'MP4 (H264)') cmd.push('-c:a','aac')
          else if (outputFormat === 'MOV (ProRes 4444)') cmd.push('-c:a','pcm_s16le')
        } else {
          cmd.push('-an')
        }

        cmd.push(outName)

        logLine('Running ffmpeg: ' + cmd.join(' '))

        try {
          // FIXED: Modern exec API (Passing the whole array directly)
          await ffmpeg.exec(cmd)
        } catch (e) {
          logLine('ffmpeg execution error: ' + e.message)
        }

        try {
          // FIXED: Modern readFile API
          const outData = await ffmpeg.readFile(outName)
          const blob = new Blob([outData.buffer], { type: 'application/octet-stream' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = outName
          a.textContent = `Download ${outName}`
          a.style.display = 'block'
          outputLinks.appendChild(a)
          logLine(`✓ ${name} -> ${outName}`)
        } catch (e) {
          logLine('✗ Failed to read output: ' + String(e))
        }

        // Cleanup
        try {
          // FIXED: Modern deleteFile API
          await ffmpeg.deleteFile(inName)
        } catch {}
        try {
          // FIXED: Modern deleteFile API
          await ffmpeg.deleteFile(outName)
        } catch {}

      } catch (err) {
        logLine('✗ Error processing ' + name + ': ' + String(err))
      }
    }

    logLine('\nDone.')
  })
}