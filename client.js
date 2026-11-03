/* global window, document, crypto */
window.__ModuleLoader__.load({
  id: '@local/dsh-sticky-notes',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Fragment, useCallback, useEffect, useRef, useState } = React

    const NS = 'dsh-sticky-notes'
    const PANEL_ID = 'sticky-notes'
    /** 排在「插件」(0)、「插件市场」(1) 之后，「计划任务」(10) 之前。 */
    const PANEL_ORDER = 2
    const API_PATH = '/api/dsh-sticky-notes/state'
    const MARKER_HEADER = 'x-dsh-sticky-notes'
    const SAVE_DELAY = 600

    /** 便签纸配色：id 与 index.js 的白名单、CSS 里的 dsn-palette 区块三处保持一致。 */
    const PAPERS = [
      { id: 'pink', label: 'colorPink' },
      { id: 'yellow', label: 'colorYellow' },
      { id: 'mint', label: 'colorMint' },
      { id: 'sky', label: 'colorSky' },
      { id: 'violet', label: 'colorViolet' },
    ]
    const PAPER_IDS = new Set(PAPERS.map((paper) => paper.id))

    const DICT = {
      zh: {
        nav: '便签',
        title: '便签',
        noteUnit: '条便签',
        newNote: '新建',
        untitled: '新便签',
        titlePlaceholder: '新便签',
        bodyPlaceholder: '写点什么…',
        more: '更多',
        colorLabel: '纸张颜色',
        colorPink: '粉色',
        colorYellow: '黄色',
        colorMint: '薄荷绿',
        colorSky: '天蓝',
        colorViolet: '藕紫',
        delete: '删除',
        confirmDelete: '再点一次确认删除',
        statusSaving: '保存中…',
        statusPending: '未保存',
        statusSaved: '已保存',
        statusError: '保存失败',
        statusLoading: '加载中…',
        emptyTitle: '还没有便签',
        emptyBody: '点击右上角「新建」，贴上一张新便签。',
        emptyAction: '新建便签',
        loadFailed: '加载失败',
        retry: '重试',
      },
      en: {
        nav: 'Notes',
        title: 'Notes',
        noteUnit: 'notes',
        newNote: 'New',
        untitled: 'New note',
        titlePlaceholder: 'New note',
        bodyPlaceholder: 'Write something…',
        more: 'More',
        colorLabel: 'Paper color',
        colorPink: 'Pink',
        colorYellow: 'Yellow',
        colorMint: 'Mint',
        colorSky: 'Sky blue',
        colorViolet: 'Violet',
        delete: 'Delete',
        confirmDelete: 'Click again to confirm',
        statusSaving: 'Saving…',
        statusPending: 'Unsaved',
        statusSaved: 'Saved',
        statusError: 'Save failed',
        statusLoading: 'Loading…',
        emptyTitle: 'No notes yet',
        emptyBody: 'Click “New” in the corner to stick your first note.',
        emptyAction: 'New note',
        loadFailed: 'Failed to load',
        retry: 'Retry',
      },
    }

    const CSS = `
.dsn-panel, .dsn-panel * { box-sizing: border-box; }
/* dsn:palette:begin — 便签纸是本插件唯一允许出现颜色字面量的地方，其余一律用 DSH 主题 token。 */
.dsn-panel {
  --dsn-shadow: 0 6px 18px rgba(0, 0, 0, 0.14), 0 1px 2px rgba(0, 0, 0, 0.10);
  --dsn-shadow-lift: 0 14px 32px rgba(0, 0, 0, 0.22), 0 2px 6px rgba(0, 0, 0, 0.12);
}
.dsn-paper-pink { --dsn-paper: #e79595; --dsn-paper-head: #e0898b; --dsn-paper-line: rgba(84, 28, 33, 0.16); --dsn-ink: #3d1f21; }
.dsn-paper-yellow { --dsn-paper: #f2dd8c; --dsn-paper-head: #ebd378; --dsn-paper-line: rgba(92, 72, 12, 0.18); --dsn-ink: #3f3413; }
.dsn-paper-mint { --dsn-paper: #a9d8b8; --dsn-paper-head: #9ccfad; --dsn-paper-line: rgba(20, 74, 43, 0.18); --dsn-ink: #17392a; }
.dsn-paper-sky { --dsn-paper: #a8c9e8; --dsn-paper-head: #9bbfe0; --dsn-paper-line: rgba(21, 54, 86, 0.18); --dsn-ink: #17334e; }
.dsn-paper-violet { --dsn-paper: #c8b3e2; --dsn-paper-head: #bda5da; --dsn-paper-line: rgba(57, 33, 84, 0.18); --dsn-ink: #33224a; }
/* dsn:palette:end */
.dsn-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; line-height: 1.5; }
.dsn-toolbar { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; min-height: 52px; padding: 0 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsn-heading { margin: 0; color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
.dsn-count { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsn-grow { flex: 1 1 auto; }
.dsn-status { color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; }
.dsn-status--error { color: var(--dsw-alias-state-error-primary); }
.dsn-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.dsn-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dsn-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsn-btn--primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base)); font-weight: 500; }
.dsn-btn--primary:hover { opacity: 0.92; }
.dsn-board { display: flex; flex: 1 1 auto; flex-wrap: wrap; align-content: flex-start; gap: 18px; min-height: 0; padding: 20px; overflow-y: auto; }
.dsn-board--empty { align-content: center; justify-content: center; }
.dsn-note { position: relative; display: flex; flex: 0 0 auto; flex-direction: column; width: 300px; max-width: 100%; min-height: 240px; border-radius: 12px; background: var(--dsn-paper); color: var(--dsn-ink); box-shadow: var(--dsn-shadow); transition: transform 140ms ease, box-shadow 140ms ease; }
.dsn-note:hover { transform: translateY(-1px); }
.dsn-note[data-focus="true"] { box-shadow: var(--dsn-shadow-lift); }
.dsn-note-head { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; min-height: 36px; padding: 0 6px 0 12px; background: var(--dsn-paper-head); border-bottom: 1px solid var(--dsn-paper-line); border-radius: 12px 12px 0 0; }
.dsn-note-title { flex: 1 1 auto; min-width: 0; padding: 9px 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; font-weight: 600; text-overflow: ellipsis; outline: none; }
.dsn-note-title::placeholder, .dsn-note-body::placeholder { color: var(--dsn-ink); opacity: 0.42; }
.dsn-icon-btn { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 15px; line-height: 1; opacity: 0.55; cursor: pointer; }
.dsn-icon-btn:hover { background: var(--dsn-paper-line); opacity: 1; }
.dsn-icon-btn:focus-visible { outline: 2px solid var(--dsn-ink); outline-offset: 1px; opacity: 1; }
.dsn-icon-btn--close { font-size: 16px; }
.dsn-icon-btn--close[data-confirm="true"] { background: var(--dsn-paper-line); color: var(--dsw-alias-state-error-primary); font-size: 13px; font-weight: 700; opacity: 1; }
.dsn-note-body { flex: 1 1 auto; width: 100%; min-height: 150px; padding: 10px 14px; border: 0; background: transparent; color: inherit; font: inherit; line-height: 1.7; resize: none; outline: none; }
.dsn-note-foot { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; padding: 0 14px 10px; color: inherit; font-size: 11px; opacity: 0.55; }
.dsn-menu { position: absolute; z-index: 3; top: 40px; right: 8px; display: flex; flex-direction: column; gap: 6px; min-width: 132px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); box-shadow: var(--dsn-shadow-lift); }
.dsn-swatches { display: flex; gap: 6px; }
.dsn-swatch { width: 20px; height: 20px; padding: 0; border: 1px solid var(--dsn-paper-line); border-radius: 50%; background: var(--dsn-paper); cursor: pointer; }
.dsn-swatch:hover { transform: scale(1.08); }
.dsn-swatch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsn-swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)), 0 0 0 3px var(--dsw-alias-brand-primary); }
.dsn-menu-item { padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.dsn-menu-item:hover { background: var(--dsw-alias-bg-layer-2); }
.dsn-menu-item--danger { color: var(--dsw-alias-state-error-primary); }
.dsn-empty { display: flex; flex: 1 1 320px; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 320px; padding: 40px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dsn-empty-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; }
.dsn-empty-body { max-width: 280px; font-size: 12px; }
`

    /** 插件路由按页面基址解析，兼容 DSH 挂在反向代理子路径下的情况。 */
    function resolveApiUrl(path) {
      if (!path.startsWith('/')) return path
      try {
        const base = new URL(document.baseURI)
        if (!base.pathname.endsWith('/')) base.pathname += '/'
        return new URL(path.slice(1), base).href
      } catch {
        return path
      }
    }

    function uid() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      } catch {
        // 旧浏览器没有 randomUUID，走下面的降级。
      }
      return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    function formatTime(ts) {
      if (!Number.isFinite(ts)) return ''
      try {
        return new Date(ts).toLocaleString(undefined, {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return ''
      }
    }

    /** 老数据没有 color 字段时，按位置分配一张纸，避免整墙一个颜色。 */
    function paperOf(note, index) {
      if (note && PAPER_IDS.has(note.color)) return note.color
      return PAPERS[index % PAPERS.length].id
    }

    function statusText(status, t) {
      if (status === 'saving') return t('statusSaving')
      if (status === 'pending') return t('statusPending')
      if (status === 'saved') return t('statusSaved')
      if (status === 'error') return t('statusError')
      return ''
    }

    function GlyphPlus() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M6 2.25v7.5M2.25 6h7.5',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      )
    }

    /** 侧栏入口图标：便签纸 + 三条横线，跟随当前文字色。 */
    function NotesGlyph(props) {
      const owner = props || {}
      const size = typeof owner.size === 'number' && owner.size > 0 ? owner.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block', opacity: owner.active === true ? 1 : 0.75 },
        },
        h('rect', {
          x: 2.75,
          y: 2.25,
          width: 10.5,
          height: 11.5,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.4,
        }),
        h('path', {
          d: 'M5.5 6.25h5M5.5 9h5M5.5 11h3',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      )
    }

    function NotesPage(props) {
      const t = props && typeof props.t === 'function' ? props.t : (key) => key
      const [notes, setNotes] = useState([])
      const [activeId, setActiveId] = useState(null)
      const [loaded, setLoaded] = useState(false)
      /** idle | pending | saving | saved | error */
      const [status, setStatus] = useState('idle')
      const [errorText, setErrorText] = useState('')
      /** 正在等待二次确认删除的便签 id。 */
      const [confirmId, setConfirmId] = useState(null)
      /** 打开了「···」菜单的便签 id。 */
      const [menuId, setMenuId] = useState(null)

      const boardRef = useRef(null)
      const latestRef = useRef(null)
      const dirtyRef = useRef(false)
      const savingRef = useRef(false)
      const timerRef = useRef(null)
      const confirmTimerRef = useRef(null)
      const aliveRef = useRef(true)

      /** 串行保存：保存期间又有改动，则本轮结束后再保存一次。 */
      const persist = useCallback(async () => {
        if (savingRef.current) {
          dirtyRef.current = true
          return
        }
        savingRef.current = true
        dirtyRef.current = false
        try {
          for (;;) {
            const doc = latestRef.current || []
            if (aliveRef.current) setStatus('saving')
            const response = await fetch(resolveApiUrl(API_PATH), {
              method: 'PUT',
              headers: { 'content-type': 'application/json', [MARKER_HEADER]: '1' },
              body: JSON.stringify({ notes: doc }),
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok || !payload || payload.ok !== true) {
              throw new Error((payload && payload.error) || `HTTP ${response.status}`)
            }
            if (!dirtyRef.current) {
              if (aliveRef.current) setStatus('saved')
              break
            }
            dirtyRef.current = false
          }
        } catch (caught) {
          dirtyRef.current = true
          if (aliveRef.current) {
            setStatus('error')
            setErrorText(String((caught && caught.message) || caught))
          }
        } finally {
          savingRef.current = false
        }
      }, [])

      /** 先更新界面，再防抖落盘。 */
      const push = useCallback(
        (next) => {
          latestRef.current = next
          dirtyRef.current = true
          setNotes(next)
          if (aliveRef.current) setStatus('pending')
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => {
            timerRef.current = null
            void persist()
          }, SAVE_DELAY)
        },
        [persist],
      )

      const load = useCallback(async () => {
        try {
          const response = await fetch(resolveApiUrl(API_PATH), {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          const list = payload.data && Array.isArray(payload.data.notes) ? payload.data.notes : []
          latestRef.current = list
          setNotes(list)
          setActiveId((current) => {
            if (current && list.some((note) => note.id === current)) return current
            return list.length > 0 ? list[0].id : null
          })
          setLoaded(true)
          setStatus('idle')
          setErrorText('')
        } catch (caught) {
          if (!aliveRef.current) return
          setLoaded(true)
          setStatus('error')
          setErrorText(String((caught && caught.message) || caught))
        }
      }, [])

      useEffect(() => {
        aliveRef.current = true
        void load()
        return () => {
          aliveRef.current = false
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
          if (confirmTimerRef.current) {
            clearTimeout(confirmTimerRef.current)
            confirmTimerRef.current = null
          }
          if (dirtyRef.current) void persist()
        }
      }, [load, persist])

      // 菜单打开时，点空白处或按 Esc 收起。
      useEffect(() => {
        if (!menuId) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (target && typeof target.closest === 'function' && target.closest('.dsn-menu, [data-menu-toggle="true"]')) return
          setMenuId(null)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setMenuId(null)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [menuId])

      const updateNote = (id, patch) => {
        const now = Date.now()
        push(notes.map((note) => (note.id === id ? Object.assign({}, note, patch, { updatedAt: now }) : note)))
      }

      const createNote = () => {
        const now = Date.now()
        const note = {
          id: uid(),
          title: '',
          body: '',
          color: PAPERS[notes.length % PAPERS.length].id,
          createdAt: now,
          updatedAt: now,
        }
        setMenuId(null)
        setActiveId(note.id)
        push([note, ...notes])
        if (boardRef.current) boardRef.current.scrollTop = 0
      }

      /** 第一次点只进入确认态，4 秒内再点才真的删。 */
      const requestDelete = (note) => {
        if (confirmId !== note.id) {
          setConfirmId(note.id)
          if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
          confirmTimerRef.current = setTimeout(() => {
            confirmTimerRef.current = null
            setConfirmId(null)
          }, 4000)
          return
        }
        if (confirmTimerRef.current) {
          clearTimeout(confirmTimerRef.current)
          confirmTimerRef.current = null
        }
        setConfirmId(null)
        setMenuId(null)
        const next = notes.filter((item) => item.id !== note.id)
        if (activeId === note.id) setActiveId(next.length > 0 ? next[0].id : null)
        push(next)
      }

      const cards = notes.map((note, index) => {
        const color = paperOf(note, index)
        const confirming = confirmId === note.id
        return h(
          'article',
          {
            key: note.id,
            className: `dsn-note dsn-paper-${color}`,
            'data-focus': note.id === activeId ? 'true' : 'false',
            onPointerDown: () => setActiveId(note.id),
          },
          h(
            'header',
            { className: 'dsn-note-head' },
            h('input', {
              className: 'dsn-note-title',
              value: note.title,
              placeholder: t('titlePlaceholder'),
              'aria-label': t('titlePlaceholder'),
              spellCheck: false,
              onChange: (event) => updateNote(note.id, { title: event.target.value }),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsn-icon-btn',
                'data-menu-toggle': true,
                title: t('more'),
                'aria-label': t('more'),
                'aria-haspopup': 'true',
                'aria-expanded': menuId === note.id ? 'true' : 'false',
                onClick: () => setMenuId(menuId === note.id ? null : note.id),
              },
              '···',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsn-icon-btn dsn-icon-btn--close',
                'data-confirm': confirming ? 'true' : 'false',
                title: confirming ? t('confirmDelete') : t('delete'),
                'aria-label': confirming ? t('confirmDelete') : t('delete'),
                onClick: () => requestDelete(note),
              },
              '×',
            ),
          ),
          h('textarea', {
            className: 'dsn-note-body',
            value: note.body,
            placeholder: t('bodyPlaceholder'),
            'aria-label': t('bodyPlaceholder'),
            spellCheck: false,
            onChange: (event) => updateNote(note.id, { body: event.target.value }),
          }),
          h('footer', { className: 'dsn-note-foot' }, formatTime(note.updatedAt)),
          menuId === note.id
            ? h(
                'div',
                { className: 'dsn-menu', role: 'menu' },
                h(
                  'div',
                  { className: 'dsn-swatches', role: 'group', 'aria-label': t('colorLabel') },
                  PAPERS.map((paper) =>
                    h('button', {
                      key: paper.id,
                      type: 'button',
                      className: `dsn-swatch dsn-paper-${paper.id}`,
                      title: t(paper.label),
                      'aria-label': t(paper.label),
                      'aria-pressed': color === paper.id ? 'true' : 'false',
                      onClick: () => {
                        setMenuId(null)
                        updateNote(note.id, { color: paper.id })
                      },
                    }),
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsn-menu-item dsn-menu-item--danger',
                    role: 'menuitem',
                    onClick: () => {
                      setMenuId(null)
                      requestDelete(note)
                    },
                  },
                  confirming ? t('confirmDelete') : t('delete'),
                ),
              )
            : null,
        )
      })

      let board
      if (!loaded) {
        board = h('div', { className: 'dsn-empty' }, t('statusLoading'))
      } else if (notes.length === 0) {
        const failed = status === 'error'
        board = h(
          'div',
          { className: 'dsn-empty' },
          h('div', { className: 'dsn-empty-title' }, failed ? t('loadFailed') : t('emptyTitle')),
          h('div', { className: 'dsn-empty-body' }, failed ? errorText : t('emptyBody')),
          h(
            'button',
            {
              type: 'button',
              className: 'dsn-btn dsn-btn--primary',
              onClick: failed ? () => void load() : createNote,
            },
            failed ? t('retry') : t('emptyAction'),
          ),
        )
      } else {
        board = cards
      }

      return h(
        Fragment,
        null,
        h('style', { key: 'dsn-style' }, CSS),
        h(
          'div',
          { className: 'dsn-panel' },
          h(
            'header',
            { className: 'dsn-toolbar' },
            h('div', { className: 'dsn-heading', role: 'heading', 'aria-level': '1' }, t('title')),
            h('span', { className: 'dsn-count' }, `${notes.length} ${t('noteUnit')}`),
            h('span', { className: 'dsn-grow' }),
            h(
              'span',
              {
                className: status === 'error' ? 'dsn-status dsn-status--error' : 'dsn-status',
                title: status === 'error' ? errorText : undefined,
              },
              statusText(status, t),
            ),
            h(
              'button',
              { type: 'button', className: 'dsn-btn dsn-btn--primary', onClick: createNote, title: t('newNote') },
              h(GlyphPlus, null),
              t('newNote'),
            ),
          ),
          h(
            'div',
            { className: loaded && notes.length > 0 ? 'dsn-board' : 'dsn-board dsn-board--empty', ref: boardRef },
            board,
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 一个会抛错的客户端插件可能带崩整个外壳，这里自己兜住。
        try {
          ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-sticky-notes: dictionaries')
          const t = ctx.locale.bind(NS)

          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: PANEL_ORDER,
                label: () => t('nav'),
              },
              NotesGlyph,
            ),
          )

          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, (props) =>
              h(NotesPage, Object.assign({}, props, { t })),
            ),
          )
        } catch (caught) {
          console.error('[dsh-sticky-notes] failed to mount', caught)
        }
      },
    }
  },
})
