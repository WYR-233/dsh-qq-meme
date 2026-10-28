/**
 * dsh-qq-meme — 让 QQ 里的 agent 真的能发表情包。
 *
 * 为什么不直接用 dsh-meme 的 send_meme：
 *   send_meme 只在「Web / dsh-im / companionQq」三种通道里发得出去。官方
 *   @tencent-connect/dsh-qqbot 不是 dsh-im（它自己的 export name 是 im-qqbot，
 *   只 provide tools、不 provide companionQq），于是 QQ 会话里 send_meme 退化成
 *   Web 模式：模型拿到 `[表情: 描述]` 标记 + 相对路径，QQ 里那行标记只会显示成
 *   文字，图发不出去。
 *
 * 本插件的做法：注册一个 qq_meme 工具，模型只描述「想要什么表情」，
 * 插件自己去图库索引里搜、自己拼绝对路径、再程序化调用 qqbot 的
 * qqbot_send_file 投递。模型全程碰不到文件系统 —— 这是安全边界：
 * 群里怎么诱导也只能让它发表情包，发不了 ~/.secrets。
 *
 * 依赖：
 *   - dsh-meme 建好的图库（读它的 index.db，只读不写）
 *   - @tencent-connect/dsh-qqbot 注册的 qqbot_send_file 工具（可选，缺了就友好降级）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const name = 'dsh-qq-meme'
export const inject = ['tools']

/** 六个情绪桶（dsh-meme 的模型侧口径）+ 常见的桶内细类 */
const MOOD_ALIASES = {
  happy: ['happy', '开心', '高兴', '笑', '卖萌', '可爱'],
  angry: ['angry', '生气', '怒', '怼'],
  sad: ['sad', '难过', '哭', '委屈', '无语'],
  shy: ['shy', '害羞', '脸红'],
  confused: ['confused', '困惑', '疑惑', '懵'],
  daily: ['daily', '日常', '摸鱼', '上班', '吃'],
}

const SEND_TOOL = 'qqbot_send_file'

function expandHome(p) {
  if (!p) return p
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/** dsh-meme 的运行时配置：packsDir + enabledPacks（谁被打开，就只看谁） */
export function readMemeSettings(settingsPath) {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'))
    return {
      packsDir: raw.packsDir || '',
      memeRoot: raw.memeRoot || '',
      enabledPacks: Array.isArray(raw.enabledPacks) ? raw.enabledPacks.filter((x) => typeof x === 'string') : [],
      packId: typeof raw.packId === 'string' ? raw.packId : '',
    }
  } catch {
    return { packsDir: '', memeRoot: '', enabledPacks: [], packId: '' }
  }
}

/** 在 packsDir 下枚举候选图库目录（只要含 index.db 的就算） */
export function listPacks(packsDir) {
  const out = []
  try {
    for (const entry of readdirSync(packsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(packsDir, entry.name)
      if (existsSync(join(dir, 'index.db'))) out.push({ id: entry.name, dir })
    }
  } catch { /* packsDir 不存在就是还没装库 */ }
  return out
}

function normalizeMood(input) {
  const t = String(input || '').trim().toLowerCase()
  if (!t) return ''
  for (const [bucket, words] of Object.entries(MOOD_ALIASES)) {
    if (bucket === t || words.includes(t)) return bucket
  }
  return t
}

/** 中文按相邻双字切词，英文按整词 —— 和 dsh-meme 内置检索同口径，够用 */
function terms(text) {
  const t = String(text || '').toLowerCase()
  const out = new Set()
  for (const w of t.split(/[\s，,。！!？?~～…、;；:：()（）[\]【】"'“”]+/)) {
    if (w.length >= 2) out.add(w)
  }
  for (let i = 0; i + 1 < t.length; i++) {
    const bi = t.slice(i, i + 2)
    if (/[\u4e00-\u9fa5]{2}/.test(bi)) out.add(bi)
  }
  return [...out]
}

/** 打分：描述命中 caption 权重最高，关键词次之，分类只作加分 */
function score(row, queryTerms, mood) {
  const cap = String(row.caption || '').toLowerCase()
  const kw = String(row.keywords || '').toLowerCase()
  const tag = String(row.tag || '').toLowerCase()
  let s = 0
  for (const t of queryTerms) {
    if (cap.includes(t)) s += 6
    if (kw.includes(t)) s += 4
  }
  if (mood) {
    if (tag === mood) s += 8
    else if (MOOD_ALIASES[mood] && MOOD_ALIASES[mood].includes(tag)) s += 4
  }
  return s
}

export function searchPacks(packs, { query, mood, limit }) {
  const qs = terms(query)
  const hits = []
  for (const pack of packs) {
    let db
    try {
      db = new DatabaseSync(join(pack.dir, 'index.db'), { readOnly: true })
      const rows = db.prepare('SELECT path, tag, file_name, caption, COALESCE(keywords, \'\') AS keywords FROM memes').all()
      for (const r of rows) {
        const s = score(r, qs, mood)
        if (s > 0) hits.push({ ...r, packId: pack.id, packDir: pack.dir, score: s })
      }
    } catch {
      /* 单个库坏了不影响别的库 */
    } finally {
      try { db?.close() } catch {}
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

/** 把索引里的相对路径解析成图库内的绝对路径（拒绝跳出图库根） */
export function resolveInsidePack(packDir, stored) {
  const root = resolve(packDir)
  const target = resolve(root, String(stored || ''))
  if (target !== root && !target.startsWith(root + sep)) throw new Error('路径越界：' + stored)
  if (!existsSync(target)) throw new Error('文件不存在：' + stored)
  return target
}

/** 统计各图库可用的分类，搜不到时给模型真实的换词建议 */
function tagOverview(packs) {
  const agg = new Map()
  for (const pack of packs) {
    let db
    try {
      db = new DatabaseSync(join(pack.dir, 'index.db'), { readOnly: true })
      for (const r of db.prepare('SELECT tag, COUNT(*) AS c FROM memes GROUP BY tag').all()) {
        agg.set(r.tag, (agg.get(r.tag) || 0) + r.c)
      }
    } catch {} finally { try { db?.close() } catch {} }
  }
  return [...agg.entries()].sort((a, b) => b[1] - a[1]).map(([tag, c]) => `${tag}(${c})`).join(' / ')
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), 'dsh-home')
  const settingsPath = expandHome(config.memeSettingsFile || process.env.DSH_MEME_SETTINGS || join(homedir(), '.dsh', 'dsh-expression.json'))
  const defaultPacksDir = expandHome(config.packsDir || join(home, '.dsh', 'meme-packs'))
  const logger = ctx.logger ?? console

  ctx.effect(() => {
    const dispose = ctx.tools.register({
      name: 'qq_meme',
      description:
        '发一张表情包到当前 QQ 会话（原生图片消息）。'
        + '只描述你想表达的情绪或梗，插件自己去图库挑图并发送，你不需要也不应该提供文件路径。'
        + '气氛到位就主动用：斗图、接梗、吐槽、卖萌的时候，发图优先于纯文字；对方说正事/干活时克制。',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: '想发的表情包要表达什么，用中文描述或关键词，例如「气鼓鼓」「无语」「干饭好香」「夸他」。',
          },
          mood: {
            type: 'string',
            description: '可选：情绪桶。happy 开心 / angry 生气 / sad 难过 / shy 害羞 / confused 困惑 / daily 日常。',
          },
        },
        required: ['description'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            caption: { type: 'string' },
            library: { type: 'string' },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value && value.ok
            ? `已发送表情包：${value.caption || ''}`
            : `没发出去：${(value && value.message) || '未知原因'}`,
        }],
      },
      async execute(args, exec) {
        const description = String((args && args.description) || '').trim()
        if (!description) return { ok: false, message: 'description 不能为空' }

        // 1) 图库在哪：以 dsh-meme 的运行时设置为准，读不到就退回默认目录
        const st = readMemeSettings(settingsPath)
        const packsDir = resolve(st.packsDir || defaultPacksDir)
        if (!existsSync(packsDir)) {
          return { ok: false, message: '图库目录不存在：' + packsDir + '（先在 dsh-meme 里装一个图库）' }
        }
        const all = listPacks(packsDir)
        // 内置图库随插件包分发，不在 packsDir 下：单独按 memeRoot 补一个
        const builtinRoot = expandHome(st.memeRoot || '')
        if (builtinRoot && existsSync(join(builtinRoot, 'index.db'))) {
          const known = new Set(all.map((p) => resolve(p.dir)))
          if (!known.has(resolve(builtinRoot))) {
            const id = (st.packId && resolve(builtinRoot).includes(st.packId)) ? st.packId : 'builtin'
            all.unshift({ id, dir: builtinRoot })
          }
        }
        // 只搜「已打开」的库；没有 enabledPacks 记录时退化成搜全部
        const packs = st.enabledPacks.length
          ? all.filter((p) => st.enabledPacks.includes(p.id) || p.id === 'builtin' || p.dir === resolve(builtinRoot))
          : all
        if (!packs.length) return { ok: false, message: '没有已启用的图库，先去 dsh-meme 设置页打开一个' }

        // 2) 搜图
        const mood = normalizeMood(args && args.mood)
        let hits = searchPacks(packs, { query: description, mood, limit: 8 })
        if (!hits.length && mood) hits = searchPacks(packs, { query: description, mood: '', limit: 8 })
        if (!hits.length) {
          return { ok: false, message: '没搜到贴题的表情包。现有分类：' + tagOverview(packs) + '。换个词再试。' }
        }

        // 3) 发图：路径由插件拼，模型碰不到文件系统
        const pick = hits[0]
        let absPath
        try {
          absPath = resolveInsidePack(pick.packDir, pick.path)
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) }
        }

        if (typeof ctx.tools.execute !== 'function') {
          return { ok: false, message: 'tools 服务不支持程序化调用，无法投递' }
        }
        const sendTool = ctx.tools.get(SEND_TOOL, exec && exec.agent)
        if (!sendTool) {
          return { ok: false, message: `未找到 ${SEND_TOOL} 工具（需要安装并启用 @tencent-connect/dsh-qqbot）` }
        }

        try {
          const result = await ctx.tools.execute({
            callId: (exec && exec.callId ? String(exec.callId) + ':qq_meme' : 'qq_meme:' + Date.now()),
            rootCallId: exec && exec.rootCallId,
            name: SEND_TOOL,
            arguments: { file_path: absPath },
            agent: exec && exec.agent,
            parent: exec && exec.token,
            signal: exec && exec.signal ? exec.signal : new AbortController().signal,
          })
          if (result && result.isError) {
            const msg = (result.content || []).map((c) => (c && c.text) || '').join(' ').trim()
            return { ok: false, message: '投递失败：' + (msg || '发送工具返回错误') }
          }
        } catch (err) {
          return { ok: false, message: '投递异常：' + (err instanceof Error ? err.message : String(err)) }
        }

        logger.info?.(`[dsh-qq-meme] 发送 ${pick.packId}/${pick.path} ← "${description}"`)
        return {
          ok: true,
          caption: pick.caption,
          library: pick.packId,
          message: '已作为图片消息发出',
        }
      },
    })
    return () => dispose()
  }, 'dsh-qq-meme.tool')
}

export default { name, inject, apply }
