// lasso —— 本地视频下载器（零第三方依赖，纯 Node 内置模块）
// 界面: http://127.0.0.1:8765   下载保存到 ~/Downloads
// 引擎: yt-dlp，设计思路参考了社区同类 yt-dlp 前端工具的成熟做法

import http from 'node:http'
import {spawn, execFile} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import crypto from 'node:crypto'

const HOST = '127.0.0.1'
const PORT = 8765
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEX_HTML = path.join(__dirname, 'public', 'index.html')
const OUT_DIR = path.join(os.homedir(), 'Downloads')
const YTDLP_DIR = path.join(os.homedir(), '.lasso', 'bin')
const YTDLP_EXE = path.join(YTDLP_DIR, 'yt-dlp.exe')
// 兼容旧目录：之前下载过的引擎直接复用，避免重复下载
const LEGACY_YTDLP = path.join(os.homedir(), '.yoinks', 'bin', 'yt-dlp.exe')
const RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
const CONFIG_PATH = path.join(os.homedir(), '.lasso', 'config.json')
// 保存目录可在用户主目录内切换（见 /api/outdir）；默认系统下载文件夹
let outDir = OUT_DIR

function isUnderHome(p) {
  if (!path.isAbsolute(p)) return false
  const home = path.normalize(os.homedir())
  const target = path.normalize(p)
  return target === home || target.startsWith(home + path.sep)
}

async function loadConfig() {
  try {
    const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'))
    if (typeof config.outDir === 'string' && isUnderHome(config.outDir)) {
      const stat = await fs.stat(config.outDir).catch(() => null)
      if (stat?.isDirectory()) outDir = path.resolve(config.outDir)
    }
  } catch { /* 无配置文件或损坏，用默认值 */ }
}

async function saveConfig() {
  try {
    await fs.mkdir(path.dirname(CONFIG_PATH), {recursive: true})
    await fs.writeFile(CONFIG_PATH, JSON.stringify({outDir}, null, 2))
  } catch { /* 配置写不进去不影响主流程 */ }
}

// yt-dlp.exe 在管道输出时用系统编码（中文 Windows 是 cp936），实测忽略
// PYTHONUTF8 环境变量，唯一可靠的修复是传 --encoding utf-8 参数（此处环境变量
// 保留作为兜底）
const CHILD_ENV = {...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'}

// ---------------------------------------------------------------------------
// yt-dlp 引擎引导：PATH → ~/.lasso/bin → 旧目录 → GitHub Releases 下载
// ---------------------------------------------------------------------------

function commandWorks(cmd, args, timeoutMs = 10_000) {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, {timeout: timeoutMs, windowsHide: true}, error => resolve(!error))
    } catch {
      resolve(false)
    }
  })
}

const engine = {
  status: 'checking', // checking | downloading | ready | failed
  progress: 0,
  downloaded: 0,
  total: 0,
  error: '',
  readyPath: '',
  promise: null,
}

function findSystemYtDlp() {
  return commandWorks('yt-dlp', ['--version']).then(ok => (ok ? 'yt-dlp' : ''))
}

async function downloadEngine() {
  engine.status = 'downloading'
  engine.progress = 0
  const tmp = `${YTDLP_EXE}.download`
  await fs.mkdir(YTDLP_DIR, {recursive: true})

  const response = await fetch(RELEASE_URL)
  if (!response.ok || !response.body) {
    throw new Error(`下载引擎失败（HTTP ${response.status}）`)
  }
  const total = Number(response.headers.get('content-length')) || 0
  engine.total = total

  let downloaded = 0
  let lastLogged = 0
  const source = Readable.fromWeb(response.body)
  source.on('data', chunk => {
    downloaded += chunk.length
    engine.downloaded = downloaded
    if (total > 0) engine.progress = downloaded / total
    const pct = Math.floor(engine.progress * 100)
    if (pct - lastLogged >= 10) {
      lastLogged = pct
      console.log(`[引擎] 正在下载 yt-dlp.exe … ${pct}%`)
    }
  })
  await pipeline(source, createWriteStream(tmp))
  await fs.rename(tmp, YTDLP_EXE)

  if (!(await commandWorks(YTDLP_EXE, ['--version']))) {
    throw new Error('下载的 yt-dlp.exe 无法运行')
  }
}

async function ensureEngine() {
  if (engine.promise) return engine.promise
  engine.promise = (async () => {
    if (await findSystemYtDlp()) {
      engine.status = 'ready'
      engine.readyPath = 'yt-dlp'
      console.log('[引擎] 使用系统已安装的 yt-dlp')
      return
    }
    for (const candidate of [YTDLP_EXE, LEGACY_YTDLP]) {
      if (await commandWorks(candidate, ['--version'])) {
        engine.status = 'ready'
        engine.readyPath = candidate
        console.log(`[引擎] 使用已有 yt-dlp（${candidate}）`)
        return
      }
    }
    console.log('[引擎] 首次运行，正在从 GitHub 下载 yt-dlp.exe（约 17MB）…')
    try {
      await downloadEngine()
      engine.status = 'ready'
      engine.readyPath = YTDLP_EXE
      engine.progress = 1
      console.log('[引擎] yt-dlp 就绪')
    } catch (error) {
      engine.status = 'failed'
      engine.error = error instanceof Error ? error.message : String(error)
      console.error('[引擎] 下载失败:', engine.error)
      engine.promise = null // 允许下次请求重新触发下载
      throw error
    }
  })()
  return engine.promise
}

async function ffmpegAvailable() {
  return commandWorks('ffmpeg', ['-version'], 5_000)
}

// 手动更新：重新下载最新 yt-dlp 覆盖旧版；失败保留旧版本
let engineUpdateNote = ''
async function updateEngine() {
  engineUpdateNote = ''
  engine.status = 'downloading'
  engine.progress = 0
  console.log('[引擎] 手动更新：正在下载最新 yt-dlp…')
  try {
    await downloadEngine()
    engine.status = 'ready'
    engine.readyPath = YTDLP_EXE
    engine.progress = 1
    engineUpdateNote = '已更新到最新版本'
    console.log('[引擎] 更新完成')
  } catch (error) {
    // 旧二进制仍在，恢复可用状态
    engine.status = 'ready'
    engine.progress = 0
    engineUpdateNote = '更新失败（已保留旧版本）：' + (error instanceof Error ? error.message : String(error))
    console.error('[引擎] 更新失败:', engineUpdateNote)
  }
}

// ---------------------------------------------------------------------------
// 平台识别（中文名）
// ---------------------------------------------------------------------------

const PLATFORMS = [
  {hosts: ['youtube.com', 'youtu.be', 'music.youtube.com'], label: 'YouTube'},
  {hosts: ['bilibili.com', 'b23.tv'], label: '哔哩哔哩'},
  {hosts: ['douyin.com', 'iesdouyin.com'], label: '抖音'},
  {hosts: ['x.com', 'twitter.com'], label: 'X（推特）'},
  {hosts: ['tiktok.com'], label: 'TikTok'},
  {hosts: ['instagram.com'], label: 'Instagram'},
  {hosts: ['threads.net', 'threads.com'], label: 'Threads'},
  {hosts: ['kuaishou.com'], label: '快手'},
  {hosts: ['weibo.com', 'weibo.cn'], label: '微博'},
  {hosts: ['xiaohongshu.com'], label: '小红书'},
  {hosts: ['vimeo.com'], label: 'Vimeo'},
  {hosts: ['twitch.tv'], label: 'Twitch'},
  {hosts: ['reddit.com'], label: 'Reddit'},
  {hosts: ['facebook.com', 'fb.watch'], label: 'Facebook'},
  {hosts: ['soundcloud.com'], label: 'SoundCloud'},
  {hosts: ['dailymotion.com'], label: 'Dailymotion'},
  {hosts: ['ixigua.com'], label: '西瓜视频'},
  {hosts: ['acfun.cn'], label: 'AcFun'},
  {hosts: ['huya.com'], label: '虎牙直播'},
  {hosts: ['douyu.com'], label: '斗鱼直播'},
  {hosts: ['music.163.com'], label: '网易云音乐'},
]

function detectPlatform(url) {
  let hostname
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return '未知网站'
  }
  for (const {hosts, label} of PLATFORMS) {
    if (hosts.some(h => hostname === h || hostname.endsWith(`.${h}`))) return label
  }
  return hostname
}

function isProbablyUrl(input) {
  try {
    const u = new URL(String(input).trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 抖音专用通道
//
// yt-dlp 的抖音抽取器走 PC 版 API，该 API 现被字节 Argus 签名系统拦截
// （无论带什么 Cookie 都返回 403），yt-dlp 尚未实现签名，官方已长期失效。
// lasso 的方案：用系统 Edge 无头渲染播放页（视频会真实播放），通过 CDP
// 网络监听截获播放器实际使用的音视频 CDN 直链，然后直接下载并合并。
// ---------------------------------------------------------------------------

const DOUYIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
const DOUYIN_REFERER = 'https://www.douyin.com/'
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const EDGE_PROFILE_DIR = path.join(os.homedir(), '.lasso', 'edge-profile')
const HARVEST_TTL_MS = 30 * 60 * 1000
const harvestCache = new Map() // videoId -> {result, createdAt}
let harvestChain = Promise.resolve() // 串行化：Edge 用同一个调试端口和 profile

function isDouyinUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'douyin.com' || host.endsWith('.douyin.com') || host.endsWith('.iesdouyin.com')
  } catch {
    return false
  }
}

// 从各种抖音链接形态中提取视频 id（depth 防御畸形循环跳转）
async function douyinVideoId(rawUrl, depth = 0) {
  let u
  try {
    u = new URL(rawUrl.trim())
  } catch {
    return {error: '链接格式不正确'}
  }
  const host = u.hostname.toLowerCase()

  // 短链：跟随跳转拿到最终地址
  if (host === 'v.douyin.com') {
    if (depth >= 3) return {error: '抖音短链跳转异常，请直接复制视频页链接'}
    try {
      const res = await fetch(rawUrl, {redirect: 'follow'})
      return douyinVideoId(res.url, depth + 1)
    } catch {
      return {error: '无法解析抖音短链，请检查网络'}
    }
  }

  const modalId = u.searchParams.get('modal_id')
  const pageVideo = /\/(?:video|note)\/(\d+)/.exec(u.pathname)?.[1]
  const id = pageVideo || modalId
  if (!id) {
    if (u.pathname.startsWith('/user/')) {
      return {error: '这是用户主页链接，请打开具体视频后再复制链接；也可以用 App 分享得到的 v.douyin.com 短链'}
    }
    return {error: '没能从链接里识别出视频 id，请打开具体视频后复制链接'}
  }
  return {id}
}

async function findEdge() {
  for (const p of EDGE_PATHS) {
    try {
      await fs.access(p)
      return p
    } catch { /* 下一个 */ }
  }
  return ''
}

// 无头 Edge 渲染播放页并截获 CDN 直链。返回 {title, videoUrl, audioUrl}
async function harvestDouyin(videoId, signal) {
  const cached = harvestCache.get(videoId)
  if (cached && Date.now() - cached.createdAt < HARVEST_TTL_MS) return cached.result

  // 串行化执行（共用端口与 profile）
  const run = harvestChain.catch(() => {}).then(() => doHarvest(videoId, signal))
  harvestChain = run.catch(() => {})
  const result = await run
  harvestCache.set(videoId, {result, createdAt: Date.now()})
  for (const [id, entry] of harvestCache) {
    if (Date.now() - entry.createdAt > HARVEST_TTL_MS) harvestCache.delete(id)
  }
  return result
}

// 只清理占用了 lasso 专属 profile 的 Edge 残留进程（不影响用户自己的 Edge 窗口）。
// 残留进程会导致新实例"转交旧实例后退出"，调试端口永远起不来。
async function killStrayEdge() {
  const marker = EDGE_PROFILE_DIR.replaceAll('/', '\\')
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
    `ForEach-Object { taskkill /PID $($_.ProcessId) /T /F 2>$null } | Out-Null`
  await new Promise(res => {
    execFile('powershell', ['-NoProfile', '-Command', script],
      {windowsHide: true, timeout: 15_000}, () => res())
  })
}

async function doHarvest(videoId, signal) {
  const edge = await findEdge()
  if (!edge) {
    throw new Error('下载抖音需要系统自带的 Microsoft Edge（未找到），请确认 Edge 未被卸载')
  }
  await fs.mkdir(EDGE_PROFILE_DIR, {recursive: true})
  const pageUrl = `https://www.douyin.com/video/${videoId}`

  // 启动（最多两次：第一次失败通常是残留实例抢占 profile，清掉后重试）
  let version = null
  let child = null
  let port = 0
  for (let attempt = 1; attempt <= 2 && !version; attempt++) {
    await killStrayEdge()
    port = 17700 + Math.floor(Math.random() * 2000)
    child = spawn(edge, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--window-size=1366,900', '--mute-audio',
      `--remote-debugging-port=${port}`, `--user-data-dir=${EDGE_PROFILE_DIR}`, 'about:blank',
    ], {stdio: 'ignore', windowsHide: true})
    for (let i = 0; i < 24 && !version; i++) {
      await new Promise(r => setTimeout(r, 500))
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      } catch { /* Edge 启动中 */ }
    }
    if (!version) killTree(child)
  }
  if (!version) {
    throw new Error('浏览器渲染引擎启动失败：可能有残留的 Edge 进程占用了资源，请重启 lasso 再试')
  }

  let ws = null
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find(t => t.type === 'page')
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('调试通道连接失败')) })

    let msgId = 0
    const pending = new Map()
    const events = []
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
      if (m.method) events.push(m)
    }
    const call = (method, params = {}, timeoutMs = 8000) => new Promise((res, rej) => {
      const id = ++msgId
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)) }, timeoutMs)
      pending.set(id, m => {
        clearTimeout(timer)
        m.error ? rej(new Error(`${method} ${JSON.stringify(m.error)}`)) : res(m.result)
      })
      ws.send(JSON.stringify({id, method, params}))
    })
    const evalJs = async expr => {
      const r = await call('Runtime.evaluate', {expression: expr, returnByValue: true})
      return r.result?.value
    }

    await call('Network.enable')
    await call('Page.enable')
    await call('Page.navigate', {url: pageUrl})

    // 等播放器发起音视频 CDN 请求
    const videoUrls = new Map()
    const audioUrls = new Map()
    const deadline = Date.now() + 40_000
    let title = ''
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1200))
      if (signal?.aborted) {
        throw Object.assign(new Error('已取消'), {cancelled: true})
      }
      for (const ev of events) {
        if (ev.method !== 'Network.requestWillBeSent') continue
        const url = ev.params.request.url
        if (url.includes('douyinstatic')) continue
        if (url.includes('douyinvod.com') || url.includes('/video/tos/')) {
          if (url.includes('media-video')) videoUrls.set(url.split('?')[0], url)
          else if (url.includes('media-audio')) audioUrls.set(url.split('?')[0], url)
        }
      }
      if (!title) {
        title = await evalJs(`document.title.replace(/\\s*-\\s*抖音.*$/, '').trim() || ''`).catch(() => '')
      }
      if (videoUrls.size && audioUrls.size && title) break
    }

    const videoUrl = [...videoUrls.values()].at(-1)
    const audioUrl = [...audioUrls.values()].at(-1)
    if (!videoUrl || !audioUrl) {
      const loginWall = await evalJs(
        `!!document.querySelector('[class*="login"], [class*="Login"]')`).catch(() => false)
      if (loginWall) {
        throw new Error('抖音要求登录后才能查看这个视频，lasso 暂时无法下载需要登录的内容')
      }
      throw new Error('未能截获视频流：视频可能已被删除、受限，或页面加载超时，请稍后重试')
    }

    if (!title) title = '抖音视频'

    // HEAD 探测文件大小（Range 请求拿总长度）
    const probeSize = async url => {
      try {
        const res = await fetch(url, {headers: {'User-Agent': DOUYIN_UA, Referer: DOUYIN_REFERER, Range: 'bytes=0-1'}})
        const total = Number(res.headers.get('content-range')?.split('/')[1]) || 0
        try { await res.body?.cancel() } catch {}
        return total
      } catch { return 0 }
    }
    const [videoSize, audioSize] = await Promise.all([probeSize(videoUrl), probeSize(audioUrl)])

    return {title, videoUrl, audioUrl, videoSize, audioSize}
  } finally {
    try { ws?.close() } catch { /* 已断开 */ }
    killTree(child) // 整树终止，防止孤儿进程锁住 profile
    // taskkill /T 对孤儿化的孙进程可能漏杀，补一次精准清扫兜底
    await killStrayEdge().catch(() => {})
  }
}

function sanitizeFilename(name) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return cleaned || '抖音视频'
}

// ---------------------------------------------------------------------------
// 探测：yt-dlp -J 拿视频信息和可选格式
// ---------------------------------------------------------------------------

const MAX_VIDEO_CHOICES = 8
const PROBE_TTL_MS = 60 * 60 * 1000
const probeCache = new Map() // probeId -> {choices, infoJsonPath, info, createdAt}

function pruneProbeCache() {
  const now = Date.now()
  for (const [id, entry] of probeCache) {
    if (now - entry.createdAt > PROBE_TTL_MS) {
      fs.rm(entry.infoJsonPath, {force: true}).catch(() => {})
      probeCache.delete(id)
    }
  }
}

function scoreVideo(f) {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (String(f.vcodec ?? '').startsWith('avc')) score += 5_000
  return score
}

// 整理可选格式：≤8 档分辨率去重 + 仅音频 mp3，带预估大小
function buildChoices(info) {
  const formats = info.formats ?? []
  const choices = []

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const bestAudio = [...audioOnly].sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
  const heights = [...new Set(videos.map(f => f.height))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best.acodec && best.acodec !== 'none'
    const size = (best.filesize ?? best.filesize_approx ?? 0) + (muxed ? 0 : audioSize ?? 0)
    choices.push({
      id: `v${height}`,
      label: `▶ ${height}p · mp4${size > 0 ? ` · 约 ${formatBytes(size)}` : ''}`,
      args: [
        '-f', `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
        '--merge-output-format', 'mp4',
      ],
    })
  }

  if (choices.length === 0) {
    choices.push({
      id: 'best',
      label: '▶ 最佳画质 · mp4',
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    })
  }

  choices.push({
    id: 'mp3',
    label: `♪ 仅音频 · mp3${audioSize ? ` · 约 ${formatBytes(audioSize)}` : ''}`,
    args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  })

  return choices
}

function cleanYtDlpError(stderr) {
  const lines = stderr.split('\n').map(l => l.trim()).filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}

// 抖音探测：规范化链接 → 无头渲染截获直链
async function probeDouyin(url, signal) {
  const {id, error} = await douyinVideoId(url)
  if (error) throw new Error(error)
  const info = await harvestDouyin(id, signal)
  const mp4Size = (info.videoSize || 0) + (info.audioSize || 0)
  const choices = [
    {id: 'dv', label: `▶ 最佳画质 · mp4${mp4Size > 0 ? ` · 约 ${formatBytes(mp4Size)}` : ''}`},
    {id: 'da', label: `♪ 仅音频 · mp3${info.audioSize ? ` · 约 ${formatBytes(info.audioSize)}` : ''}`},
  ]
  const probeId = crypto.randomUUID()
  probeCache.set(probeId, {
    douyin: {...info, id},
    choices,
    info: {title: info.title, webpage_url: `https://www.douyin.com/video/${id}`},
    createdAt: Date.now(),
  })
  pruneProbeCache()
  return {
    probeId,
    title: info.title,
    uploader: '',
    duration: 0,
    webpage_url: `https://www.douyin.com/video/${id}`,
    platform: '抖音',
    choices,
  }
}

async function probe(url, signal) {
  if (isDouyinUrl(url)) return probeDouyin(url, signal)
  await ensureEngine()
  const ytdlp = engine.readyPath
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(ytdlp, ['-J', '--no-playlist', '--no-warnings', '--encoding', 'utf-8', url], {
      env: CHILD_ENV, windowsHide: true,
    })
    trackChild(child)
    let out = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    // 客户端取消（关页面/点取消）时终止探测进程，不浪费资源
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, {once: true})
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) reject(Object.assign(new Error('已取消'), {cancelled: true}))
      else if (code !== 0) reject(new Error(cleanYtDlpError(stderr) || `yt-dlp 退出码 ${code}`))
      else resolve(out)
    })
  })

  let info
  try {
    info = JSON.parse(stdout)
  } catch {
    throw new Error('无法解析视频信息')
  }

  const infoJsonPath = path.join(os.tmpdir(), `lasso-info-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(infoJsonPath, stdout)

  const probeId = crypto.randomUUID()
  probeCache.set(probeId, {
    info,
    infoJsonPath,
    choices: buildChoices(info),
    createdAt: Date.now(),
  })
  pruneProbeCache()

  return {
    probeId,
    title: info.title ?? '未知标题',
    uploader: info.uploader ?? '',
    duration: info.duration ?? 0,
    webpage_url: info.webpage_url ?? url,
    platform: detectPlatform(url),
    choices: probeCache.get(probeId).choices,
  }
}

// ---------------------------------------------------------------------------
// 下载任务：spawn yt-dlp，解析进度，支持取消与半成品清理
// ---------------------------------------------------------------------------

const PROGRESS_PREFIX = 'LASSO|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

const tasks = new Map() // taskId -> task

function toNumber(value) {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

async function removePartials(destinations) {
  await Promise.allSettled(
    destinations
      .flatMap(dest => [dest, `${dest}.part`, `${dest}.ytdl`, `${dest}.temp.mp4`])
      .map(file => fs.rm(file, {force: true})),
  )
}

// Windows 上要杀掉 yt-dlp 的整棵进程树（合并阶段 ffmpeg 是它的子进程）
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true})
  } else {
    child.kill('SIGKILL')
  }
}

// 跟踪所有活跃子进程：服务器退出时统一清理，避免孤儿 yt-dlp/ffmpeg/Edge
const activeChildren = new Set()
function trackChild(child) {
  activeChildren.add(child)
  child.on('close', () => activeChildren.delete(child))
  return child
}
function cleanupChildren() {
  for (const child of activeChildren) {
    try { killTree(child) } catch { /* 尽力而为 */ }
  }
}
process.on('exit', cleanupChildren)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanupChildren()
    process.exit(0)
  })
}

function runDownload(args, onLine, onChild) {
  return new Promise((resolve, reject) => {
    const ytdlp = engine.readyPath
    const child = spawn(ytdlp, args, {env: CHILD_ENV, windowsHide: true})
    trackChild(child)
    onChild?.(child)
    let buffer = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) onLine(line.trim())
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        reject(Object.assign(new Error('已取消'), {cancelled: true}))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `下载失败（yt-dlp 退出码 ${code}）`))
      }
    })
  })
}

async function runTask(task) {
  const entry = probeCache.get(task.probeId)
  const choice = entry?.choices.find(c => c.id === task.choiceId)
  if (!choice) {
    task.phase = 'error'
    task.error = '任务已过期，请重新解析'
    return
  }
  const outTemplate = path.join(outDir, '%(title).60s.%(ext)s')

  const buildArgs = infoJsonPath => [
    ...(infoJsonPath ? ['--load-info-json', infoJsonPath] : [task.url]),
    ...choice.args,
    '--no-playlist',
    '--no-warnings',
    '--encoding', 'utf-8',
    '--windows-filenames',
    '--newline',
    '--no-quiet',
    '--progress',
    '--progress-template', `download:${PROGRESS_TEMPLATE}`,
    '--print', 'after_move:filepath',
    '--no-simulate',
    '-o', outTemplate,
  ]

  const destinations = []
  const onLine = line => {
    if (!line) return
    if (line.startsWith(PROGRESS_PREFIX)) {
      const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
      const downloadedBytes = toNumber(downloaded) ?? 0
      if (downloadedBytes < task.lastDownloaded) task.part += 1
      task.lastDownloaded = downloadedBytes
      Object.assign(task, {
        phase: 'downloading',
        refreshing: false,
        downloadedBytes,
        totalBytes: toNumber(total) ?? toNumber(totalEstimate) ?? 0,
        speed: toNumber(speed) ?? 0,
        eta: toNumber(eta) ?? 0,
      })
    } else if (line.includes('Downloading 1 format(s):')) {
      task.totalParts = Math.max(1, (line.split('format(s):')[1] ?? '').trim().split('+').length)
    } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]') || line.includes('[VideoConvertor]')) {
      task.phase = 'processing'
      const merged = /\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
      const extracted = /\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
      const target = merged ?? extracted
      if (target) destinations.push(target)
    } else if (line.startsWith('[download] Destination: ')) {
      destinations.push(line.slice('[download] Destination: '.length))
    } else if (path.isAbsolute(line)) {
      task.filepath = line
    }
  }

  try {
    // 第一次尝试复用探测缓存（快）；媒体链接过期则全新解析重试一次
    try {
      await runDownload(buildArgs(entry?.infoJsonPath), onLine, child => (task.child = child))
    } catch (error) {
      if (error.cancelled || task.abort) throw error
      task.refreshing = true
      task.part = 0
      task.lastDownloaded = 0
      task.totalParts = 1
      await runDownload(buildArgs(undefined), onLine, child => (task.child = child))
    }
    task.phase = task.filepath ? 'done' : 'error'
    task.refreshing = false
    if (!task.filepath) task.error = '下载完成但未取得文件路径'
  } catch (error) {
    if (task.abort || error.cancelled) {
      task.phase = 'cancelled'
      await removePartials(destinations)
    } else {
      task.phase = 'error'
      task.error = error instanceof Error ? error.message : String(error)
    }
  } finally {
    task.child = undefined
    // 不能在这里删 probeCache：同一解析结果可能还要下第二种格式，或失败后重试。
    // 缓存过期由 pruneProbeCache 的 TTL 统一处理。
  }
}

// ---------------------------------------------------------------------------
// 抖音直链下载：拉取音视频两路流 → ffmpeg 合并/转码
// ---------------------------------------------------------------------------

function startDouyinDownload(info, choiceId) {
  const taskId = crypto.randomUUID()
  const task = {
    id: taskId,
    type: 'douyin',
    probeId: '',
    choiceId,
    douyin: info,
    url: `https://www.douyin.com/video/${info.id}`,
    label: choiceId === 'da' ? '♪ 仅音频 · mp3' : '▶ 最佳画质 · mp4',
    phase: 'starting',
    downloadedBytes: 0,
    totalBytes: 0,
    speed: 0,
    eta: 0,
    part: 0,
    totalParts: choiceId === 'da' ? 1 : 2,
    lastDownloaded: 0,
    refreshing: false,
    abort: false,
    filepath: '',
    error: '',
    child: undefined,
    abortControllers: [],
    createdAt: Date.now(),
  }
  tasks.set(taskId, task)
  pruneTasks()
  void runDouyinTask(task)
  return {taskId}
}

// 流式下载（边下边写盘，不占内存），带进度回调与取消
async function downloadDouyinStream(url, file, task, partIdx, label) {
  const controller = new AbortController()
  task.abortControllers.push(controller)
  const res = await fetch(url, {
    headers: {'User-Agent': DOUYIN_UA, Referer: DOUYIN_REFERER},
    signal: controller.signal,
  })
  if (!res.ok || !res.body) {
    if (res.status === 403) {
      const error = new Error('抖音直链已过期')
      error.expired = true
      throw error
    }
    throw new Error(`${label}下载失败（HTTP ${res.status}）`)
  }
  const total = Number(res.headers.get('content-length')) || 0
  task.part = partIdx
  task.phase = 'downloading'

  let downloaded = 0
  let lastTick = Date.now()
  let lastBytes = 0
  const source = Readable.fromWeb(res.body)
  source.on('data', chunk => {
    downloaded += chunk.length
    const now = Date.now()
    if (now - lastTick >= 300) {
      const dt = (now - lastTick) / 1000
      task.speed = dt > 0 ? (downloaded - lastBytes) / dt : 0
      lastTick = now
      lastBytes = downloaded
      task.downloadedBytes = downloaded
      task.totalBytes = total
      task.eta = task.speed > 0 && total > 0 ? (total - downloaded) / task.speed : 0
    }
  })
  await pipeline(source, createWriteStream(file), {signal: controller.signal})
  task.downloadedBytes = downloaded
  task.totalBytes = total
  return downloaded
}

async function runDouyinTask(task) {
  const audioOnly = task.choiceId === 'da'
  const tmpDir = path.join(os.tmpdir(), `lasso-dy-${task.id}`)
  try {
    await fs.mkdir(tmpDir, {recursive: true})
    const videoFile = path.join(tmpDir, 'video.mp4')
    const audioFile = path.join(tmpDir, 'audio.mp4')

    // 下载两路流；直链过期（403）时自动重新收割一次，不用用户手动重新解析
    const fetchStreams = async () => {
      if (audioOnly) {
        await downloadDouyinStream(task.douyin?.audioUrl, audioFile, task, 0, '音频')
      } else {
        await downloadDouyinStream(task.douyin?.videoUrl, videoFile, task, 0, '视频流')
        await downloadDouyinStream(task.douyin?.audioUrl, audioFile, task, 1, '音频流')
      }
    }
    try {
      await fetchStreams()
    } catch (error) {
      if (!error.expired || task.abort) throw error
      task.refreshing = true
      task.douyin = await harvestDouyin(task.douyin.id)
      task.refreshing = false
      task.part = 0
      task.lastDownloaded = 0
      await fetchStreams()
    }

    const finalName = sanitizeFilename(task.douyin?.title || '抖音视频')

    // 合并 / 转码
    task.phase = 'processing'
    const ext = audioOnly ? '.mp3' : '.mp4'
    const finalPath = path.join(outDir, finalName + ext)
    const ffmpegArgs = audioOnly
      ? ['-y', '-i', audioFile, '-vn', '-c:a', 'libmp3lame', '-q:a', '0', finalPath]
      : ['-y', '-i', videoFile, '-i', audioFile, '-c', 'copy', '-movflags', '+faststart', finalPath]

    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ffmpegArgs, {windowsHide: true})
      trackChild(child)
      task.child = child
      let stderr = ''
      child.stderr.on('data', c => (stderr += c))
      child.on('error', reject)
      child.on('close', code => {
        if (task.abort) reject(Object.assign(new Error('已取消'), {cancelled: true}))
        else if (code === 0) resolve()
        else reject(new Error(`合并失败：${stderr.slice(-200).trim() || 'ffmpeg 退出码 ' + code}`))
      })
    })

    task.phase = 'done'
    task.filepath = finalPath
  } catch (error) {
    if (task.abort || error.cancelled) {
      task.phase = 'cancelled'
    } else {
      task.phase = 'error'
      task.error = error instanceof Error ? error.message : String(error)
    }
  } finally {
    task.child = undefined
    task.abortControllers = []
    await fs.rm(tmpDir, {recursive: true, force: true}).catch(() => {})
  }
}

function startDownload(probeId, choiceId) {
  const entry = probeCache.get(probeId)
  const choice = entry?.choices.find(c => c.id === choiceId)
  if (!choice) return {error: '任务已过期，请重新解析'}

  // 抖音直链任务（不经 yt-dlp）
  if (choiceId === 'dv' || choiceId === 'da') {
    if (!entry.douyin) return {error: '任务已过期，请重新解析'}
    return startDouyinDownload(entry.douyin, choiceId)
  }

  const taskId = crypto.randomUUID()
  const task = {
    id: taskId,
    probeId,
    choiceId,
    url: entry.info.webpage_url ?? '',
    label: choice.label,
    phase: 'starting',
    downloadedBytes: 0,
    totalBytes: 0,
    speed: 0,
    eta: 0,
    part: 0,
    totalParts: 1,
    lastDownloaded: 0,
    refreshing: false,
    abort: false,
    filepath: '',
    error: '',
    child: undefined,
    createdAt: Date.now(),
  }
  tasks.set(taskId, task)
  pruneTasks()
  void runTask(task)
  return {taskId}
}

const TASK_TTL_MS = 60 * 60 * 1000
function pruneTasks() {
  const now = Date.now()
  for (const [id, task] of tasks) {
    if (now - task.createdAt > TASK_TTL_MS && task.phase !== 'downloading' && task.phase !== 'processing') {
      tasks.delete(id)
    }
  }
}

function cancelTask(taskId) {
  const task = tasks.get(taskId)
  if (!task) return {error: '任务不存在'}
  if (task.phase === 'done' || task.phase === 'error' || task.phase === 'cancelled') {
    return {}
  }
  task.abort = true
  if (task.child) killTree(task.child)
  for (const c of task.abortControllers ?? []) {
    try { c.abort() } catch { /* 已结束 */ }
  }
  return {}
}

// ---------------------------------------------------------------------------
// 工具与 HTTP 路由
// ---------------------------------------------------------------------------

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

// 只允许打开/选中下载目录里的文件，防止路径穿越
function isInsideOutDir(filepath) {
  if (!filepath || !path.isAbsolute(filepath)) return false
  const resolved = path.normalize(filepath)
  const dir = path.normalize(outDir)
  return resolved === dir || resolved.startsWith(dir + path.sep)
}

function openFolder(filepath) {
  if (filepath && isInsideOutDir(filepath)) {
    // 选中具体文件，比只打开文件夹更贴心
    spawn('explorer.exe', [`/select,${filepath}`], {windowsHide: true})
    return
  }
  spawn('explorer.exe', [outDir], {windowsHide: true})
}

let ffmpegOk = false

// Host/Origin 校验：本服务只允许从 127.0.0.1:8765 访问。
// - Host 校验阻断 DNS rebinding（外部域名解析到本机后浏览器视其为同源）
// - Origin 校验阻断浏览器里其他网页对本服务的跨站调用
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])

function requestAllowed(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  if (!ALLOWED_HOSTS.has(host)) return false
  const origin = req.headers.origin
  if (origin && !ALLOWED_ORIGINS.has(String(origin).toLowerCase())) return false
  return true
}

// 启动时清扫上次崩溃/强杀留下的临时文件（探测缓存 JSON 与抖音流目录）
async function cleanupStaleTmp() {
  try {
    const dir = await fs.readdir(os.tmpdir())
    await Promise.allSettled(dir
      .filter(name => name.startsWith('lasso-info-') || name.startsWith('lasso-dy-'))
      .map(name => fs.rm(path.join(os.tmpdir(), name), {recursive: true, force: true})))
  } catch { /* 清不了就算了 */ }
}

const server = http.createServer(async (req, res) => {
  if (!requestAllowed(req)) {
    sendJson(res, 403, {error: 'Forbidden'})
    return
  }
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const route = `${req.method} ${url.pathname}`

  try {
    if (route === 'GET /' || route === 'GET /index.html') {
      const html = await fs.readFile(INDEX_HTML)
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'})
      res.end(html)
      return
    }

    if (route === 'GET /api/ping') {
      sendJson(res, 200, {ok: true})
      return
    }

    if (route === 'GET /api/health') {
      sendJson(res, 200, {
        engine: engine.status,
        engineProgress: engine.progress,
        engineError: engine.error,
        engineUpdateNote,
        ffmpeg: ffmpegOk,
        downloadsDir: outDir,
      })
      return
    }

    // 保存目录：预设列表 + 切换（仅允许用户主目录内的已存在目录）
    if (route === 'GET /api/outdir') {
      const home = os.homedir()
      const presets = []
      for (const [label, sub] of [
        ['下载', 'Downloads'], ['桌面', 'Desktop'], ['视频', 'Videos'],
        ['图片', 'Pictures'], ['文档', 'Documents'],
      ]) {
        const dir = path.join(home, sub)
        if (await fs.stat(dir).then(s => s.isDirectory()).catch(() => false)) {
          presets.push({label, dir})
        }
      }
      sendJson(res, 200, {current: outDir, presets})
      return
    }

    if (route === 'POST /api/outdir') {
      const body = JSON.parse(await readBody(req))
      const dir = path.resolve(String(body.dir ?? '').trim())
      if (!isUnderHome(dir)) {
        sendJson(res, 400, {error: '只能切换到用户主目录内的文件夹'})
        return
      }
      const stat = await fs.stat(dir).catch(() => null)
      if (!stat?.isDirectory()) {
        sendJson(res, 400, {error: '文件夹不存在：' + dir})
        return
      }
      outDir = dir
      await saveConfig()
      console.log(`[配置] 保存目录切换为 ${outDir}`)
      sendJson(res, 200, {downloadsDir: outDir})
      return
    }

    // 手动更新引擎（抖音/各站抽取器失效时自助修复的第一招）
    if (route === 'POST /api/update-engine') {
      if (engine.readyPath === 'yt-dlp') {
        sendJson(res, 400, {error: '当前使用系统安装的 yt-dlp，请用系统包管理器自行更新'})
        return
      }
      if (engine.status === 'downloading') {
        sendJson(res, 200, {started: true})
        return
      }
      void updateEngine()
      sendJson(res, 200, {started: true})
      return
    }

    if (route === 'POST /api/probe') {
      const body = JSON.parse(await readBody(req))
      const target = String(body.url ?? '').trim()
      if (!isProbablyUrl(target)) {
        sendJson(res, 400, {error: '这不是一个有效的链接，请粘贴完整的视频网址'})
        return
      }
      // 客户端取消（点取消/关页面）时中止服务端探测
      const abort = new AbortController()
      req.on('close', () => {
        if (!res.writableEnded) abort.abort()
      })
      try {
        const result = await probe(target, abort.signal)
        sendJson(res, 200, result)
      } catch (error) {
        if (error.cancelled || abort.signal.aborted) {
          sendJson(res, 499, {error: '已取消'})
        } else {
          throw error
        }
      }
      return
    }

    if (route === 'POST /api/download') {
      const body = JSON.parse(await readBody(req))
      const result = startDownload(String(body.probeId ?? ''), String(body.choiceId ?? ''))
      sendJson(res, result.error ? 400 : 200, result)
      return
    }

    if (route === 'GET /api/status') {
      const taskId = url.searchParams.get('taskId') ?? ''
      const task = tasks.get(taskId)
      if (!task) {
        sendJson(res, 404, {error: '任务不存在或已过期'})
        return
      }
      sendJson(res, 200, {
        phase: task.phase,
        label: task.label,
        refreshing: task.refreshing,
        downloadedBytes: task.downloadedBytes,
        totalBytes: task.totalBytes,
        speed: task.speed,
        eta: task.eta,
        part: task.part,
        totalParts: task.totalParts,
        filepath: task.filepath,
        error: task.error,
      })
      return
    }

    if (route === 'POST /api/cancel') {
      const body = JSON.parse(await readBody(req))
      sendJson(res, 200, cancelTask(String(body.taskId ?? '')))
      return
    }

    if (route === 'POST /api/open-folder') {
      let filepath = ''
      try {
        const body = JSON.parse(await readBody(req))
        if (body.filepath && typeof body.filepath === 'string') {
          filepath = body.filepath
        } else if (body.taskId) {
          filepath = tasks.get(String(body.taskId))?.filepath ?? ''
        }
      } catch {
        // 无 body 时只打开下载目录
      }
      openFolder(filepath)
      sendJson(res, 200, {ok: true})
      return
    }

    sendJson(res, 404, {error: '接口不存在'})
  } catch (error) {
    sendJson(res, 500, {error: error instanceof Error ? error.message : String(error)})
  }
})

process.on('uncaughtException', error => {
  console.error('[异常]', error)
})
process.on('unhandledRejection', reason => {
  console.error('[Promise 异常]', reason)
})

server.listen(PORT, HOST, async () => {
  console.log(`lasso 已启动: http://${HOST}:${PORT}`)
  await loadConfig()
  console.log(`保存目录: ${outDir}`)
  void cleanupStaleTmp()
  ffmpegOk = await ffmpegAvailable()
  if (!ffmpegOk) {
    console.log('[提示] 未找到 ffmpeg：高清合并与 mp3 转换将不可用（普通下载不受影响）')
  }
  void ensureEngine().catch(() => {}) // 后台预热引擎
})
