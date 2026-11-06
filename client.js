/* global window, document, crypto */
window.__ModuleLoader__.load({
  id: '@local/dsh-sticky-notes',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-sticky-notes'
    const PANEL_ID = 'sticky-notes'
    /** 排在「插件」(0)、「插件市场」(1) 之后，「计划任务」(10) 之前。 */
    const PANEL_ORDER = 2
    const API_PREFIX = '/api/dsh-sticky-notes'
    const API_PATH = `${API_PREFIX}/state`
    const CONFIG_PATH = `${API_PREFIX}/config`
    const NOTES_PATH = `${API_PREFIX}/notes`
    const TRASH_PATH = `${API_PREFIX}/trash`
    const ASSETS_PATH = `${API_PREFIX}/assets`
    const MARKER_HEADER = 'x-dsh-sticky-notes'
    const SAVE_DELAY = 600
    /** 与 index.js 的 MAX_TITLE / MAX_NOTE_BODY / MAX_NOTES 保持一致。 */
    const MAX_TITLE = 200
    const MAX_NOTE_BODY = 20000
    const MAX_NOTES = 200
    /** 与 index.js 的 MAX_ASSET_BYTES 一致。 */
    const MAX_ASSET_BYTES = 8 * 1024 * 1024
    /** 卡片手动缩放的边界，与 index.js 的 MIN/MAX_CARD_* 一致。 */
    const MIN_CARD_WIDTH = 220
    const MAX_CARD_WIDTH = 720
    const MIN_CARD_HEIGHT = 180
    const MAX_CARD_HEIGHT = 720
    /** 保存失败后的退避重试间隔（毫秒），用完后保持最后一档。 */
    const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000]
    /** 删除后撤销窗口。 */
    const UNDO_MS = 6000
    /** 面板可见时对齐后台改动的轮询间隔（MCP server / 另一个窗口）。 */
    const SYNC_INTERVAL = 20000
    /** 同一个冲突连续出现这么多次就放弃自动合并，转为报错。 */
    const MAX_CONFLICT_ROUNDS = 4

    /** 便签纸配色：id 与 index.js 的白名单、CSS 里的 dsn-palette 区块三处保持一致。 */
    const PAPERS = [
      { id: 'pink', label: 'colorPink' },
      { id: 'yellow', label: 'colorYellow' },
      { id: 'mint', label: 'colorMint' },
      { id: 'sky', label: 'colorSky' },
      { id: 'violet', label: 'colorViolet' },
    ]
    const PAPER_IDS = new Set(PAPERS.map((paper) => paper.id))

    const SORTS = [
      { id: 'manual', label: 'sortManual' },
      { id: 'created', label: 'sortCreated' },
      { id: 'updated', label: 'sortUpdated' },
      { id: 'title', label: 'sortTitle' },
    ]

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
        deleted: '便签已删除',
        undo: '撤销',
        dismiss: '知道了',
        search: '搜索便签…',
        searchEmpty: '没有匹配的便签',
        sortLabel: '排序方式',
        sortManual: '手动排序',
        sortCreated: '创建时间',
        sortUpdated: '最近编辑',
        sortTitle: '标题',
        dragHint: '拖拽排序',
        matchUnit: '处匹配',
        limitReached: '最多 200 条便签',
        recovered: '便签数据文件损坏，已备份并重置',
        conflictMerged: '检测到其他窗口的修改，已合并',
        imageTooBig: '图片太大（上限 8MB）',
        imageFailed: '图片上传失败',
        shortcutHint: '快捷键：Alt+N 新建 · Ctrl/⌘+F 搜索 · Ctrl/⌘+S 保存',
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
        storage: '目录',
        storageTitle: '便签存放目录',
        storageCurrent: '当前目录',
        storagePlaceholder: 'D:\\Notes\\Sticky',
        storageHint: '填绝对路径。切换时会把现有便签和图片复制到新目录；新目录里已有便签则不覆盖。',
        storageApply: '应用并迁移',
        storageReset: '恢复默认',
        storageCancel: '取消',
        storageBusy: '处理中…',
        storageDone: '已迁移',
        storageSkipped: '目标目录已有便签，没有覆盖',
        storagePending: '还有未保存的改动，稍后再试',
        storageFailed: '切换目录失败',
        assetUnit: '张图片',
        trash: '回收站',
        trashTitle: '回收站',
        trashEmpty: '回收站是空的',
        trashRestore: '还原',
        trashPurge: '彻底删除',
        trashPurgeAll: '清空回收站',
        trashClose: '关闭',
        trashFailed: '回收站操作失败',
        trashPurgeAllConfirm: '再点一次清空',
        todoToggle: '切换完成状态',
        tableCellEdit: '点击编辑单元格',
        insertTable: '插入表格',
        pin: '置顶',
        unpin: '取消置顶',
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
        deleted: 'Note deleted',
        undo: 'Undo',
        dismiss: 'Dismiss',
        search: 'Search notes…',
        searchEmpty: 'No matching notes',
        sortLabel: 'Sort by',
        sortManual: 'Manual',
        sortCreated: 'Created',
        sortUpdated: 'Edited',
        sortTitle: 'Title',
        dragHint: 'Drag to reorder',
        matchUnit: 'matches',
        limitReached: 'Up to 200 notes',
        recovered: 'Notes file was corrupted — backed up and reset',
        conflictMerged: 'Merged changes from another window',
        imageTooBig: 'Image too large (8MB max)',
        imageFailed: 'Image upload failed',
        shortcutHint: 'Shortcuts: Alt+N new · Ctrl/⌘+F search · Ctrl/⌘+S save',
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
        storage: 'Folder',
        storageTitle: 'Notes folder',
        storageCurrent: 'Current folder',
        storagePlaceholder: 'D:\\Notes\\Sticky',
        storageHint: 'Absolute path only. Existing notes and images are copied to the new folder; an existing notes file there is left untouched.',
        storageApply: 'Apply & migrate',
        storageReset: 'Use default',
        storageCancel: 'Cancel',
        storageBusy: 'Working…',
        storageDone: 'Migrated',
        storageSkipped: 'Target folder already has notes — not overwritten',
        storagePending: 'Unsaved changes are still pending, try again shortly',
        storageFailed: 'Failed to switch folder',
        assetUnit: 'images',
        trash: 'Trash',
        trashTitle: 'Trash',
        trashEmpty: 'Trash is empty',
        trashRestore: 'Restore',
        trashPurge: 'Delete forever',
        trashPurgeAll: 'Empty trash',
        trashClose: 'Close',
        trashFailed: 'Trash action failed',
        trashPurgeAllConfirm: 'Click again to empty',
        todoToggle: 'Toggle done',
        tableCellEdit: 'Click to edit cell',
        insertTable: 'Insert table',
        pin: 'Pin to top',
        unpin: 'Unpin',
      },
    }

    const CSS = `
.dsn-panel, .dsn-panel * { box-sizing: border-box; }
/* dsn:palette:begin — 便签纸是本插件唯一允许出现颜色字面量的地方，其余一律用 DSH 主题 token。 */
.dsn-panel {
  --dsn-shadow: 0 6px 18px rgba(0, 0, 0, 0.14), 0 1px 2px rgba(0, 0, 0, 0.10);
  --dsn-shadow-lift: 0 14px 32px rgba(0, 0, 0, 0.22), 0 2px 6px rgba(0, 0, 0, 0.12);
  --dsn-scrim: rgba(0, 0, 0, 0.35);
}
.dsn-paper-pink { --dsn-paper: #e79595; --dsn-paper-head: #e0898b; --dsn-paper-line: rgba(84, 28, 33, 0.16); --dsn-ink: #3d1f21; }
.dsn-paper-yellow { --dsn-paper: #f2dd8c; --dsn-paper-head: #ebd378; --dsn-paper-line: rgba(92, 72, 12, 0.18); --dsn-ink: #3f3413; }
.dsn-paper-mint { --dsn-paper: #a9d8b8; --dsn-paper-head: #9ccfad; --dsn-paper-line: rgba(20, 74, 43, 0.18); --dsn-ink: #17392a; }
.dsn-paper-sky { --dsn-paper: #a8c9e8; --dsn-paper-head: #9bbfe0; --dsn-paper-line: rgba(21, 54, 86, 0.18); --dsn-ink: #17334e; }
.dsn-paper-violet { --dsn-paper: #c8b3e2; --dsn-paper-head: #bda5da; --dsn-paper-line: rgba(57, 33, 84, 0.18); --dsn-ink: #33224a; }
/* 暗色主题换成压暗纸色 + 浅墨字，避免浅色便签在深色界面里刺眼。 */
.dsn-panel[data-tone="dark"] .dsn-paper-pink { --dsn-paper: #6d4043; --dsn-paper-head: #7a484b; --dsn-paper-line: rgba(255, 255, 255, 0.16); --dsn-ink: #f4e3e3; }
.dsn-panel[data-tone="dark"] .dsn-paper-yellow { --dsn-paper: #5d5029; --dsn-paper-head: #695a2e; --dsn-paper-line: rgba(255, 255, 255, 0.16); --dsn-ink: #f6eed6; }
.dsn-panel[data-tone="dark"] .dsn-paper-mint { --dsn-paper: #2e5040; --dsn-paper-head: #375d4b; --dsn-paper-line: rgba(255, 255, 255, 0.16); --dsn-ink: #ddf2e6; }
.dsn-panel[data-tone="dark"] .dsn-paper-sky { --dsn-paper: #2f4661; --dsn-paper-head: #385271; --dsn-paper-line: rgba(255, 255, 255, 0.16); --dsn-ink: #ddeaf8; }
.dsn-panel[data-tone="dark"] .dsn-paper-violet { --dsn-paper: #42345a; --dsn-paper-head: #4c3c67; --dsn-paper-line: rgba(255, 255, 255, 0.16); --dsn-ink: #ece2f8; }
/* dsn:palette:end */
.dsn-panel { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; line-height: 1.5; }
.dsn-toolbar { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 52px; padding: 8px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsn-heading { margin: 0; color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
.dsn-count { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsn-grow { flex: 1 1 auto; }
.dsn-search { flex: 0 1 168px; min-width: 120px; width: 168px; height: 26px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; outline: none; -webkit-appearance: none; appearance: none; }
.dsn-search:focus { border-color: var(--dsw-alias-border-l2); }
.dsn-search::placeholder { color: var(--dsw-alias-label-secondary); }
.dsn-sort { height: 26px; padding: 0 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; outline: none; cursor: pointer; }
.dsn-sort:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsn-status { color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; }
.dsn-status--error { color: var(--dsw-alias-state-error-primary); }
.dsn-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.dsn-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dsn-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsn-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dsn-btn--primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base)); font-weight: 500; }
.dsn-btn--primary:hover:not(:disabled) { opacity: 0.92; }
.dsn-banner { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; padding: 6px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsn-banner-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsn-banner-btn { flex: 0 0 auto; padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
.dsn-banner-btn:hover { background: var(--dsw-alias-bg-layer-1); }
.dsn-board { display: flex; flex: 1 1 auto; flex-wrap: wrap; align-content: flex-start; gap: 18px; min-height: 0; padding: 20px; overflow-y: auto; scrollbar-width: thin; }
.dsn-board--empty { align-content: center; justify-content: center; }
.dsn-board::-webkit-scrollbar { width: 8px; height: 8px; }
.dsn-board::-webkit-scrollbar-thumb { border-radius: 4px; background: var(--dsw-alias-border-l2); }
.dsn-board::-webkit-scrollbar-track { background: transparent; }
.dsn-note { position: relative; display: flex; flex: 0 0 auto; flex-direction: column; width: 300px; min-width: 220px; max-width: 720px; min-height: 240px; max-height: 720px; border-radius: 12px; background: var(--dsn-paper); color: var(--dsn-ink); box-shadow: var(--dsn-shadow); resize: both; overflow: hidden; transition: transform 140ms ease, box-shadow 140ms ease; }
.dsn-note:hover { transform: translateY(-1px); }
.dsn-note[data-focus="true"] { box-shadow: var(--dsn-shadow-lift); }
/* 置顶的卡片常驻抬起阴影，方便一眼分辨「钉在最上面」的那几张。 */
.dsn-note[data-pinned="true"] { box-shadow: var(--dsn-shadow-lift); }
.dsn-note[data-dragging="true"] { opacity: 0.4; transform: scale(0.98); box-shadow: var(--dsn-shadow-lift); }
/* 拖拽落点：贴在目标卡片左/右边缘的竖条，明确「插到这一侧」。 */
.dsn-note[data-drop]::after { content: ''; position: absolute; z-index: 4; top: 6px; bottom: 6px; width: 3px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.dsn-note[data-drop="before"]::after { left: 3px; }
.dsn-note[data-drop="after"]::after { right: 3px; }
.dsn-note-head { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; min-height: 36px; padding: 0 6px 0 4px; background: var(--dsn-paper-head); border-bottom: 1px solid var(--dsn-paper-line); border-radius: 12px 12px 0 0; }
.dsn-drag { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 20px; height: 24px; margin-left: -2px; color: inherit; font-size: 13px; opacity: 0.35; cursor: grab; user-select: none; }
.dsn-drag:active { cursor: grabbing; }
.dsn-drag:hover { opacity: 1; }
.dsn-note-title { flex: 1 1 auto; min-width: 0; padding: 9px 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; font-weight: 600; text-overflow: ellipsis; outline: none; }
.dsn-note-title::placeholder, .dsn-note-body::placeholder { color: var(--dsn-ink); opacity: 0.42; }
.dsn-icon-btn { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 15px; line-height: 1; opacity: 0.55; cursor: pointer; }
.dsn-icon-btn:hover { background: var(--dsn-paper-line); opacity: 1; }
.dsn-icon-btn:focus-visible { outline: 2px solid var(--dsn-ink); outline-offset: 1px; opacity: 1; }
.dsn-icon-btn--close { font-size: 16px; }
.dsn-icon-btn--pin { width: 20px; }
.dsn-icon-btn--pin[data-pinned="true"] { opacity: 1; }
.dsn-icon-btn--pin[data-pinned="false"] { opacity: 0.35; }
.dsn-icon-btn--pin[data-pinned="false"]:hover { opacity: 1; }
.dsn-note-body { flex: 1 1 auto; width: 100%; min-height: 150px; padding: 10px 14px; border: 0; background: transparent; color: inherit; font: inherit; line-height: 1.7; resize: none; outline: none; scrollbar-width: thin; }
.dsn-note-body::-webkit-scrollbar { width: 6px; }
.dsn-note-body::-webkit-scrollbar-thumb { border-radius: 3px; background: var(--dsn-paper-line); }
.dsn-note-body::-webkit-scrollbar-track { background: transparent; }
.dsn-note-attach { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 6px; padding: 0 12px 8px; }
.dsn-thumb { display: block; width: 56px; height: 42px; border: 1px solid var(--dsn-paper-line); border-radius: 6px; object-fit: cover; }
.dsn-chip { max-width: 100%; padding: 2px 8px; border-radius: 999px; background: var(--dsn-paper-line); color: inherit; font-size: 11px; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsn-chip:hover { text-decoration: underline; }
.dsn-todo { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; cursor: pointer; }
.dsn-todo-check { flex: 0 0 auto; width: 13px; height: 13px; margin: 0; accent-color: var(--dsn-ink); cursor: pointer; }
.dsn-todo-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsn-todo-text[data-done="true"] { text-decoration: line-through; opacity: 0.55; }
/* 正文里的管道表格：只读渲染 + 点格就地编辑，颜色全走纸张变量，暗色自动跟随。 */
/* 预览态：正文按块渲染，表格就是表格，不再重复显示管道原文。 */
.dsn-preview { display: flex; flex: 1 1 auto; flex-direction: column; gap: 6px; width: 100%; min-height: 150px; padding: 10px 14px; overflow: auto; line-height: 1.7; cursor: text; scrollbar-width: thin; }
.dsn-preview-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsn-preview-todo { margin: 0; }
.dsn-preview-empty { opacity: 0.45; }
.dsn-table-wrap { max-width: 100%; overflow-x: auto; scrollbar-width: thin; }
.dsn-table { border-collapse: collapse; font-size: 11px; }
.dsn-table th, .dsn-table td { padding: 3px 6px; border: 1px solid var(--dsn-paper-line); text-align: left; vertical-align: top; }
/* 单格超长文本在 160px 处截断，避免一格把整张表撑爆。 */
.dsn-table-text { display: block; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsn-table th { background: var(--dsn-paper-head); font-weight: 600; }
.dsn-table td { cursor: text; }
.dsn-table td:hover { background: var(--dsn-paper-line); }
.dsn-table td:focus-visible { outline: 2px solid var(--dsn-ink); outline-offset: -2px; }
.dsn-table-cell--editing { padding: 0; }
.dsn-table-input { width: 100%; min-width: 64px; padding: 3px 6px; border: 0; background: var(--dsn-paper); color: var(--dsn-ink); font: inherit; outline: none; }
.dsn-note-foot { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; padding: 0 14px 10px; color: inherit; font-size: 11px; opacity: 0.55; }
.dsn-note-count { margin-left: auto; font-variant-numeric: tabular-nums; }
.dsn-note-foot[data-limit="true"] { opacity: 0.85; font-weight: 600; }
.dsn-menu { position: absolute; z-index: 3; top: 40px; right: 8px; display: flex; flex-direction: column; gap: 6px; min-width: 132px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); box-shadow: var(--dsn-shadow-lift); }
.dsn-swatches { display: flex; gap: 6px; }
.dsn-swatch { width: 20px; height: 20px; padding: 0; border: 1px solid var(--dsn-paper-line); border-radius: 50%; background: var(--dsn-paper); cursor: pointer; }
.dsn-swatch:hover { transform: scale(1.08); }
.dsn-swatch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsn-swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)), 0 0 0 3px var(--dsw-alias-brand-primary); }
.dsn-menu-item { padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.dsn-menu-item:hover { background: var(--dsw-alias-bg-layer-2); }
.dsn-menu-item--danger { color: var(--dsw-alias-state-error-primary); }
.dsn-toast { position: absolute; z-index: 5; left: 50%; bottom: 18px; display: flex; align-items: center; gap: 12px; padding: 8px 10px 8px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); box-shadow: var(--dsn-shadow-lift); color: var(--dsw-alias-label-primary); font-size: 12px; transform: translateX(-50%); }
.dsn-toast-btn { padding: 3px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
.dsn-toast-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dsn-toast-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsn-empty { display: flex; flex: 1 1 320px; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 320px; padding: 40px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dsn-empty-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; }
.dsn-empty-body { max-width: 280px; font-size: 12px; }
.dsn-empty-hint { font-size: 11px; opacity: 0.7; }
.dsn-modal { position: absolute; z-index: 20; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--dsn-scrim); }
.dsn-modal-card { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 420px; padding: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsn-shadow-lift); }
.dsn-modal-title { font-size: 14px; font-weight: 600; }
.dsn-modal-row { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsn-modal-path { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.dsn-input { width: 100%; height: 30px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; outline: none; }
.dsn-input:focus { border-color: var(--dsw-alias-border-l2); }
.dsn-modal-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.6; }
.dsn-modal-status { color: var(--dsw-alias-label-primary); font-size: 12px; }
.dsn-modal-status--error { color: var(--dsw-alias-state-error-primary); }
.dsn-modal-foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.dsn-modal-card--wide { max-width: 520px; }
.dsn-btn--danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsn-btn--danger:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsn-trash-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; margin: 0; padding: 0; overflow-y: auto; list-style: none; scrollbar-width: thin; }
.dsn-trash-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); }
.dsn-trash-text { flex: 1 1 auto; min-width: 0; }
.dsn-trash-name { overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.dsn-trash-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsn-trash-actions { display: flex; flex: 0 0 auto; gap: 6px; }
.dsn-trash-empty { padding: 18px 0; color: var(--dsw-alias-label-secondary); font-size: 12px; text-align: center; }
.dsn-trash-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; padding-right: 2px; scrollbar-width: thin; }
.dsn-trash-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.dsn-trash-main { flex: 1 1 auto; min-width: 0; }
.dsn-trash-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dsn-trash-time { color: var(--dsw-alias-label-secondary); font-size: 11px; }
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

    /** 正文第一行：标题为空时拿它当标题用（和 macOS 便签一样，标题只是首行的别名）。 */
    function firstLine(text) {
      const lines = String(text || '').split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed
      }
      return ''
    }

    function titleKey(note) {
      return String((note && note.title) || '').trim() || firstLine(note && note.body)
    }

    /** 手动排序位置：没有 order 的老数据按创建时间倒序回推，和新便签默认插队的行为一致。 */
    function orderOf(note) {
      if (note && Number.isFinite(note.order)) return note.order
      return -Number((note && note.createdAt) || 0)
    }

    /** 置顶的便签永远排在最前面，与当前选的是哪种排序无关。 */
    function pinRank(note) {
      return note && note.pinned === true ? 0 : 1
    }

    /** 老数据没有 color 字段时按 id 稳定散列取色，避免每次渲染换色。 */
    function paperOf(note) {
      if (note && PAPER_IDS.has(note.color)) return note.color
      const value = String((note && note.id) || '')
      let hash = 0
      for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0
      return PAPERS[hash % PAPERS.length].id
    }

    function isEmptyNote(note) {
      return note !== null && typeof note === 'object' && String(note.title || '').trim() === '' && String(note.body || '').trim() === ''
    }

    /** 待办行的正则定义在下方 dsn:body 区块里，和表格解析放在一起便于整块求值测试。 */
    function todosOf(body) {
      const lines = String(body || '').split('\n')
      const todos = []
      for (let index = 0; index < lines.length; index += 1) {
        const match = TODO_PATTERN.exec(lines[index])
        if (!match) continue
        todos.push({ index, done: match[2].toLowerCase() === 'x', text: match[3].trim() })
      }
      return todos
    }

    /** 只翻转那一行的勾选标记，其余字符原样保留。 */
    function toggleTodo(body, lineIndex) {
      const lines = String(body || '').split('\n')
      const line = lines[lineIndex]
      if (typeof line !== 'string') return body
      const match = TODO_PATTERN.exec(line)
      if (!match) return body
      const done = match[2].toLowerCase() === 'x'
      lines[lineIndex] = `${match[1]}- [${done ? ' ' : 'x'}] ${match[3]}`
      return lines.join('\n')
    }

    /* dsn:body:begin — 正文的纯文本语义：待办 / 表格的解析、单格写回、TSV 转换、预览分块。check-client.mjs 会整块求值。 */
    /** `- [ ]` / `- [x]` 待办行；不改数据结构，正文本身就是唯一事实。 */
    const TODO_PATTERN = /^(\s*)[-*]\s+\[( |x|X)\]\s?(.*)$/
    /** 表格行必须以 `|` 开头，正文里随手写的 `a | b` 不算表格。 */
    const TABLE_LINE = /^\s*\|/
    /** 分隔行 `|---|:--:|`，决定上一行是表头。 */
    const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/

    /** 拆一行：处理 `\|` 转义与首尾竖线。 */
    function splitRow(line) {
      let text = String(line == null ? '' : line).trim()
      if (text.startsWith('|')) text = text.slice(1)
      if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
      const cells = []
      let current = ''
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (char === '\\' && text[index + 1] === '|') {
          current += '|'
          index += 1
          continue
        }
        if (char === '|') {
          cells.push(current.trim())
          current = ''
          continue
        }
        current += char
      }
      cells.push(current.trim())
      return cells
    }

    /** 一格里的竖线和换行都要收拾掉，否则会把表格拆坏。 */
    function cellOf(value) {
      return String(value == null ? '' : value)
        .replace(/\r?\n/g, ' ')
        .replace(/\|/g, '\\|')
        .trim()
    }

    function rowOf(cells) {
      return `| ${cells.map(cellOf).join(' | ')} |`
    }

    /** 解析正文里的管道表格，返回起始行号 + 表头 + 数据行。 */
    function tablesOf(body) {
      const lines = String(body || '').split('\n')
      const tables = []
      for (let index = 0; index < lines.length - 1; index += 1) {
        if (!TABLE_LINE.test(lines[index]) || !TABLE_DIVIDER.test(lines[index + 1])) continue
        const rows = []
        let cursor = index + 2
        while (cursor < lines.length && TABLE_LINE.test(lines[cursor]) && !TABLE_DIVIDER.test(lines[cursor])) {
          rows.push(splitRow(lines[cursor]))
          cursor += 1
        }
        tables.push({ startLine: index, header: splitRow(lines[index]), rows })
        index = cursor - 1
      }
      return tables
    }

    /** 写回一格：`row` 为 -1 时写表头，只动这一行，其余字符原样保留。 */
    function setTableCell(body, startLine, row, col, value) {
      const text = String(body || '')
      const lines = text.split('\n')
      const table = tablesOf(text).find((item) => item.startLine === startLine)
      if (!table) return body
      const lineIndex = row < 0 ? startLine : startLine + 2 + row
      if (typeof lines[lineIndex] !== 'string') return body
      const cells = splitRow(lines[lineIndex])
      while (cells.length <= col) cells.push('')
      cells[col] = value
      lines[lineIndex] = rowOf(cells)
      return lines.join('\n')
    }

    /** Excel 复制的区域是 TSV：至少两列才当表格，首行按表头处理。 */
    function tableFromTsv(text) {
      const rows = String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n+$/, '')
        .split('\n')
        .map((line) => line.split('\t').map((cell) => cell.replace(/\s+/g, ' ').trim()))
      if (rows.length === 0) return ''
      const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
      if (width < 2) return ''
      const pad = (row) => {
        const next = row.slice()
        while (next.length < width) next.push('')
        return next
      }
      const [header, ...rest] = rows
      const divider = `| ${pad([]).map(() => '---').join(' | ')} |`
      return [rowOf(pad(header)), divider, ...rest.map((row) => rowOf(pad(row)))].join('\n')
    }

    /** 菜单里「插入表格」：正文末尾补一张 3×3 空表，表头留空由用户点着填。 */
    function appendTable(body) {
      const empty = ['|  |  |  |', '| --- | --- | --- |', '|  |  |  |', '|  |  |  |']
      const text = String(body || '').replace(/\s+$/, '')
      return text === '' ? empty.join('\n') : `${text}\n\n${empty.join('\n')}`
    }

    /** 整行只有一个图片引用时，预览里由底部缩略图代表，正文行不再重复显示。 */
    const IMAGE_LINE = /^\s*!\[[^\]]*\]\(\s*assets\/[A-Za-z0-9._-]+\s*\)\s*$/

    /**
     * 预览态把正文切成块：表格整块、待办逐行、其余行按段落合并（图片行隐藏）。
     * 每块记着正文里的字符偏移，点哪一块就能把光标放到那一行。
     */
    function blocksOf(body) {
      const lines = String(body || '').split('\n')
      const offsets = []
      let offset = 0
      for (const line of lines) {
        offsets.push(offset)
        offset += line.length + 1
      }
      const tableStarts = new Map(tablesOf(body).map((table) => [table.startLine, table]))
      const blocks = []
      let paragraph = null
      const flush = () => {
        if (!paragraph) return
        blocks.push(paragraph)
        paragraph = null
      }
      let index = 0
      while (index < lines.length) {
        const table = tableStarts.get(index)
        if (table) {
          flush()
          blocks.push({ type: 'table', table, offset: offsets[index] })
          let cursor = index + 2
          while (cursor < lines.length && TABLE_LINE.test(lines[cursor]) && !TABLE_DIVIDER.test(lines[cursor])) cursor += 1
          index = cursor
          continue
        }
        const line = lines[index]
        const todo = TODO_PATTERN.exec(line)
        if (todo) {
          flush()
          blocks.push({
            type: 'todo',
            index,
            offset: offsets[index],
            done: todo[2].toLowerCase() === 'x',
            text: todo[3].trim(),
          })
          index += 1
          continue
        }
        if (line.trim() === '' || IMAGE_LINE.test(line)) {
          flush()
          index += 1
          continue
        }
        if (!paragraph) paragraph = { type: 'text', offset: offsets[index], lines: [] }
        paragraph.lines.push(line)
        index += 1
      }
      flush()
      return blocks
    }

    /**
     * 拖拽落点的 order：只在同一个组（置顶 / 普通）内取前后邻居。
     * 跨组时拿置顶卡的 order 当锚点会算出落在普通区之外的中值，松手就被排回原位。
     */
    function orderForDrop(list, insertAt, pinned, orderOfNote) {
      const sameGroup = (note) => Boolean(note) && (note.pinned === true) === pinned
      let prev = null
      for (let index = insertAt - 1; index >= 0; index -= 1) {
        if (!sameGroup(list[index])) continue
        prev = list[index]
        break
      }
      let next = null
      for (let index = insertAt; index < list.length; index += 1) {
        if (!sameGroup(list[index])) continue
        next = list[index]
        break
      }
      if (prev && next) return (orderOfNote(prev) + orderOfNote(next)) / 2
      if (next) return orderOfNote(next) - 1000
      if (prev) return orderOfNote(prev) + 1000
      return 0
    }
    /* dsn:body:end */

    /** 正文里引用的截图（相对路径，由 Host 端 assets 路由提供）。 */
    function imagesOf(body) {
      const found = []
      const pattern = /!\[[^\]]*\]\(\s*(assets\/[A-Za-z0-9._-]+)\s*\)/g
      for (const match of String(body || '').matchAll(pattern)) {
        if (!found.includes(match[1])) found.push(match[1])
        if (found.length >= 3) break
      }
      return found
    }

    /** 正文里的外链，做成可点的小胶囊。 */
    function linksOf(body) {
      const found = []
      const pattern = /\bhttps?:\/\/[^\s<>"'）】]+/g
      for (const match of String(body || '').matchAll(pattern)) {
        const url = match[0].replace(/[.,;!?]+$/, '')
        if (!found.includes(url)) found.push(url)
        if (found.length >= 3) break
      }
      return found
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

    /** 置顶图钉：实心=已置顶，空心=未置顶；跟随当前文字色。 */
    function GlyphPin(props) {
      const filled = Boolean(props && props.filled)
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
          fill: filled ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M12 17v5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
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

    /**
     * 单张便签。用 memo 包住，输入时只有当前这张会重渲染 ——
     * 200 条便签时逐字重绘整面墙是之前最卡的地方。
     */
    const NoteCard = React.memo(function NoteCard(props) {
      const note = props.note
      const t = props.t
      const bodyLength = String(note.body || '').length
      const nearLimit = bodyLength >= MAX_NOTE_BODY * 0.8
      const images = imagesOf(note.body)
      const links = linksOf(note.body)
      const todos = todosOf(note.body)
      const doneTodos = todos.filter((todo) => todo.done).length
      const tables = tablesOf(note.body)
      const cardRef = useRef(null)
      const bodyRef = useRef(null)
      /** preview：正文按块渲染（表格就是表格）；edit：显示原始文本。空便签直接从编辑态开始。 */
      const [mode, setMode] = useState(() => (String(note.body || '').trim() === '' ? 'edit' : 'preview'))
      const blocks = useMemo(() => blocksOf(note.body), [note.body])
      /** 正在编辑的单元格：`{ startLine, row, col, value }`，row 为 -1 表示表头。 */
      const [editingCell, setEditingCell] = useState(null)
      const editingRef = useRef(null)
      editingRef.current = editingCell
      /** Escape 退出时不要再把草稿写回。 */
      const cancelRef = useRef(false)
      /** 只有按在右下角缩放柄上的拖拽才算「用户改尺寸」。 */
      const resizingRef = useRef(false)
      /** 预览区按下的位置，用来区分「点击」和「拖动」。 */
      const pressRef = useRef(null)

      const style = {}
      if (Number.isFinite(note.width)) style.width = `${note.width}px`
      if (Number.isFinite(note.height)) style.height = `${note.height}px`

      // 原生缩放结束后量一次尺寸落库，避免把行内自动拉伸也记成用户设定。
      useEffect(() => {
        const finish = () => {
          if (!resizingRef.current) return
          resizingRef.current = false
          const element = cardRef.current
          if (!element) return
          const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)))
          const width = clamp(element.offsetWidth, MIN_CARD_WIDTH, MAX_CARD_WIDTH)
          const height = clamp(element.offsetHeight, MIN_CARD_HEIGHT, MAX_CARD_HEIGHT)
          if (Math.abs(width - (note.width || 0)) <= 2 && Math.abs(height - (note.height || 0)) <= 2) return
          props.onChange(note.id, { width, height })
        }
        window.addEventListener('pointerup', finish)
        window.addEventListener('pointercancel', finish)
        return () => {
          window.removeEventListener('pointerup', finish)
          window.removeEventListener('pointercancel', finish)
        }
      }, [note.id, note.width, note.height, props.onChange])

      /** Tab 缩进两格、Shift+Tab 回退、Esc 收起真身回到预览；受控 textarea 要在重渲染后再摆光标。 */
      const onBodyKeyDown = (event) => {
        if (event.key === 'Escape' && !event.isComposing) {
          event.preventDefault()
          setMode('preview')
          return
        }
        if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return
        const element = bodyRef.current
        if (!element) return
        event.preventDefault()
        const start = element.selectionStart
        const end = element.selectionEnd
        const value = note.body
        if (!event.shiftKey) {
          const next = `${value.slice(0, start)}  ${value.slice(end)}`
          props.onChange(note.id, { body: next })
          requestAnimationFrame(() => {
            try {
              element.setSelectionRange(start + 2, start + 2)
            } catch {
              // 控件可能已经卸载。
            }
          })
          return
        }
        const before = value.slice(0, start)
        const removed = before.endsWith('  ') ? 2 : before.endsWith(' ') ? 1 : 0
        if (removed === 0) return
        const next = `${before.slice(0, before.length - removed)}${value.slice(end)}`
        props.onChange(note.id, { body: next })
        requestAnimationFrame(() => {
          try {
            element.setSelectionRange(start - removed, start - removed)
          } catch {
            // 控件可能已经卸载。
          }
        })
      }

      /** 提交当前单元格：先退出编辑态，值没变就不产生一次保存。 */
      const commitCell = () => {
        const target = editingRef.current
        setEditingCell(null)
        if (!target) return
        if (cancelRef.current) {
          cancelRef.current = false
          return
        }
        const table = tables.find((item) => item.startLine === target.startLine)
        if (!table) return
        const cells = target.row < 0 ? table.header : table.rows[target.row]
        const before = cells && typeof cells[target.col] === 'string' ? cells[target.col] : ''
        if (before === target.value) return
        props.onChange(note.id, {
          body: setTableCell(note.body, target.startLine, target.row, target.col, target.value),
        })
      }

      const beginCellEdit = (startLine, row, col, value) => {
        cancelRef.current = false
        setEditingCell({ startLine, row, col, value })
      }

      /** 一格：平时是只读文本，点一下换成同尺寸输入框。 */
      const renderCell = (table, rowIndex, colIndex, text) => {
        const active = editingCell && editingCell.startLine === table.startLine && editingCell.row === rowIndex && editingCell.col === colIndex
        if (active) {
          return h(
            'td',
            { key: colIndex, className: 'dsn-table-cell dsn-table-cell--editing' },
            h('input', {
              className: 'dsn-table-input',
              value: editingCell.value,
              maxLength: 200,
              autoFocus: true,
              'aria-label': t('tableCellEdit'),
              onChange: (event) => setEditingCell({ ...editingCell, value: event.target.value }),
              onBlur: commitCell,
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitCell()
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelRef.current = true
                  setEditingCell(null)
                }
              },
            }),
          )
        }
        return h(
          'td',
          {
            key: colIndex,
            className: 'dsn-table-cell',
            tabIndex: 0,
            title: t('tableCellEdit'),
            onClick: () => beginCellEdit(table.startLine, rowIndex, colIndex, text),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              beginCellEdit(table.startLine, rowIndex, colIndex, text)
            },
          },
          text === '' ? '\u00a0' : h('span', { className: 'dsn-table-text' }, text),
        )
      }

      /** 粘贴截图：交给上层上传，正文里补一行 ![](assets/xxx.png)。 */
      const onBodyPaste = (event) => {
        const clipboard = event.clipboardData
        if (!clipboard || !clipboard.items) return
        for (const item of clipboard.items) {
          if (item.kind !== 'file' || String(item.type).indexOf('image/') !== 0) continue
          const file = item.getAsFile()
          if (!file) continue
          event.preventDefault()
          props.onPasteImage(note.id, file)
          return
        }
        // 从 Excel 复制的区域是 TSV：两列以上就转成管道表格插到光标处。
        const plain = typeof clipboard.getData === 'function' ? clipboard.getData('text/plain') : ''
        if (!plain || plain.indexOf('\t') < 0) return
        const table = tableFromTsv(plain)
        if (table === '') return
        event.preventDefault()
        const element = bodyRef.current
        const value = note.body
        const start = element && Number.isFinite(element.selectionStart) ? element.selectionStart : value.length
        const end = element && Number.isFinite(element.selectionEnd) ? element.selectionEnd : value.length
        const lead = start > 0 && value[start - 1] !== '\n' ? '\n' : ''
        const tail = end < value.length && value[end] !== '\n' ? '\n' : ''
        const caret = start + lead.length + table.length
        // 正文上限与 textarea 的 maxLength 一致，超了就按服务端规则截断。
        const next = `${value.slice(0, start)}${lead}${table}${tail}${value.slice(end)}`
        props.onChange(note.id, { body: next.slice(0, MAX_NOTE_BODY) })
        if (!element) return
        requestAnimationFrame(() => {
          try {
            element.setSelectionRange(caret, caret)
          } catch {
            // 控件可能已经卸载。
          }
        })
      }

      /** 从预览进原文编辑：光标落到点到的那一行。 */
      const enterEdit = (offset) => {
        setMode('edit')
        const position = Math.max(0, Math.min(Number(offset) || 0, String(note.body || '').length))
        requestAnimationFrame(() => {
          const element = bodyRef.current
          if (!element) return
          try {
            element.focus()
            element.setSelectionRange(position, position)
          } catch {
            // 控件可能已经卸载。
          }
        })
      }

      /** 点预览空白处进编辑；表格和待办自己吃掉点击，不会整块跳去编辑态。 */
      const onPreviewClick = (event) => {
        // 按下后拖动超过 4px 算拖拽，不算点击 —— 免得想挪卡片反而进了编辑态。
        const press = pressRef.current
        pressRef.current = null
        if (press && (Math.abs(event.clientX - press.x) > 4 || Math.abs(event.clientY - press.y) > 4)) return
        const node = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-offset]') : null
        enterEdit(node ? Number(node.getAttribute('data-offset')) || 0 : 0)
      }

      const onPreviewPointerDown = (event) => {
        pressRef.current = { x: event.clientX, y: event.clientY }
      }

      // 点卡片外面就收起真身，回到「表格就是表格」的样子。
      useEffect(() => {
        if (mode !== 'edit') return
        const onDown = (event) => {
          const element = cardRef.current
          if (!element || element.contains(event.target)) return
          setMode('preview')
        }
        window.addEventListener('pointerdown', onDown)
        return () => window.removeEventListener('pointerdown', onDown)
      }, [mode])

      /** 一张表：表头 + 全部数据行，不去截断（卡片不够高就在预览里滚动）。 */
      const renderTable = (table) => {
        const width = table.rows.reduce((max, row) => Math.max(max, row.length), table.header.length)
        const cellsOf = (row) =>
          Array.from({ length: width }, (_, colIndex) => (typeof row[colIndex] === 'string' ? row[colIndex] : ''))
        return h(
          'div',
          { className: 'dsn-table-wrap', key: `table-${table.startLine}` },
          h(
            'table',
            { className: 'dsn-table' },
            h(
              'thead',
              null,
              h('tr', null, cellsOf(table.header).map((text, colIndex) => renderCell(table, -1, colIndex, text))),
            ),
            h(
              'tbody',
              null,
              table.rows.map((row, rowIndex) =>
                h(
                  'tr',
                  { key: rowIndex },
                  cellsOf(row).map((text, colIndex) => renderCell(table, rowIndex, colIndex, text)),
                ),
              ),
            ),
          ),
        )
      }

      /** 预览态一块：表格 / 待办 / 文本段落，都带着自己在正文里的偏移。 */
      const renderBlock = (block) => {
        if (block.type === 'table') {
          return h(
            'div',
            {
              key: `table-block-${block.offset}`,
              className: 'dsn-preview-table',
              'data-offset': block.offset,
              onClick: (event) => event.stopPropagation(),
            },
            renderTable(block.table),
          )
        }
        if (block.type === 'todo') {
          return h(
            'label',
            {
              key: `todo-${block.index}`,
              className: 'dsn-todo dsn-preview-todo',
              'data-offset': block.offset,
              onClick: (event) => event.stopPropagation(),
            },
            h('input', {
              type: 'checkbox',
              className: 'dsn-todo-check',
              checked: block.done,
              'aria-label': t('todoToggle'),
              onChange: () => props.onChange(note.id, { body: toggleTodo(note.body, block.index) }),
            }),
            h('span', { className: 'dsn-todo-text', 'data-done': block.done ? 'true' : 'false' }, block.text || '—'),
          )
        }
        return h(
          'div',
          { key: `text-${block.offset}`, className: 'dsn-preview-text', 'data-offset': block.offset },
          block.lines.join('\n'),
        )
      }

      const previewNodes = blocks.map((block) => renderBlock(block))
      if (blocks.length === 0) {
        previewNodes.push(h('div', { key: 'preview-empty', className: 'dsn-preview-empty' }, t('bodyPlaceholder')))
      }

      return h(
        'article',
        {
          ref: (element) => {
            cardRef.current = element
            props.onCardRef(note.id, element)
          },
          className: `dsn-note dsn-paper-${props.color}`,
          'data-note-id': note.id,
          'data-focus': props.focused ? 'true' : 'false',
          'data-dragging': props.dragging ? 'true' : 'false',
          'data-pinned': note.pinned === true ? 'true' : 'false',
          'data-drop': props.dropEdge || null,
          style,
          onPointerDown: (event) => {
            props.onFocus(note.id)
            const element = cardRef.current
            if (!element) return
            const rect = element.getBoundingClientRect()
            // 右下角 18px 内按下去就是拖缩放柄。
            if (rect.right - event.clientX <= 18 && rect.bottom - event.clientY <= 18) resizingRef.current = true
          },
          onDragOver: (event) => {
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            // 指针越过卡片中线才插到右边，否则插到左边 —— 前后都能拖。
            props.onDragOver(note.id, event.clientX > rect.left + rect.width / 2 ? 'after' : 'before')
          },
          onDrop: (event) => {
            event.preventDefault()
            // 来源 id 优先从 dataTransfer 读：拖拽期间卡片会重渲染，ref 里的 id 可能已经清掉。
            const source = event.dataTransfer ? event.dataTransfer.getData('text/plain') : ''
            props.onDrop(note.id, source)
          },
        },
        h(
          'header',
          { className: 'dsn-note-head' },
          h(
            'span',
            {
              className: 'dsn-drag',
              draggable: props.dragEnabled ? true : false,
              title: t('dragHint'),
              'aria-label': t('dragHint'),
              onDragStart: (event) => {
                const element = cardRef.current
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', note.id)
                  // 默认拖影是这个小把手，换成整张卡片，并让落点贴着抓取的位置。
                  if (element && typeof event.dataTransfer.setDragImage === 'function') {
                    const rect = element.getBoundingClientRect()
                    event.dataTransfer.setDragImage(element, event.clientX - rect.left, event.clientY - rect.top)
                  }
                }
                props.onDragStart(note.id)
              },
              onDragEnd: () => props.onDragEnd(),
            },
            '⠿',
          ),
          h('input', {
            ref: (element) => props.onTitleRef(note.id, element),
            className: 'dsn-note-title',
            value: note.title,
            maxLength: MAX_TITLE,
            placeholder: firstLine(note.body) || t('untitled'),
            'aria-label': t('titlePlaceholder'),
            spellCheck: false,
            onChange: (event) => props.onChange(note.id, { title: event.target.value }),
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsn-icon-btn dsn-icon-btn--pin',
              'data-pinned': note.pinned === true ? 'true' : 'false',
              'aria-pressed': note.pinned === true ? 'true' : 'false',
              title: note.pinned === true ? t('unpin') : t('pin'),
              'aria-label': note.pinned === true ? t('unpin') : t('pin'),
              onClick: () => props.onChange(note.id, { pinned: note.pinned !== true }),
            },
            h(GlyphPin, { filled: note.pinned === true }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsn-icon-btn',
              'data-menu-toggle': true,
              title: t('more'),
              'aria-label': t('more'),
              'aria-haspopup': 'true',
              'aria-expanded': props.menuOpen ? 'true' : 'false',
              onClick: () => props.onToggleMenu(note.id),
            },
            '···',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsn-icon-btn dsn-icon-btn--close',
              title: t('delete'),
              'aria-label': t('delete'),
              onClick: () => props.onDelete(note.id),
            },
            '×',
          ),
        ),
        mode === 'edit'
          ? h('textarea', {
              ref: bodyRef,
              className: 'dsn-note-body',
              value: note.body,
              maxLength: MAX_NOTE_BODY,
              placeholder: t('bodyPlaceholder'),
              'aria-label': t('bodyPlaceholder'),
              spellCheck: false,
              onChange: (event) => props.onChange(note.id, { body: event.target.value }),
              onKeyDown: onBodyKeyDown,
              onPaste: onBodyPaste,
            })
          : h(
              'div',
              {
                className: 'dsn-preview',
                'aria-label': t('bodyPlaceholder'),
                onClick: onPreviewClick,
                onPointerDown: onPreviewPointerDown,
              },
              previewNodes,
            ),
        images.length > 0 || links.length > 0
          ? h(
              'div',
              { className: 'dsn-note-attach' },
              images.map((reference) =>
                h(
                  'a',
                  {
                    key: reference,
                    href: resolveApiUrl(`${API_PREFIX}/${reference}`),
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    title: reference,
                  },
                  h('img', {
                    className: 'dsn-thumb',
                    src: resolveApiUrl(`${API_PREFIX}/${reference}`),
                    alt: reference,
                    loading: 'lazy',
                  }),
                ),
              ),
              links.map((link) =>
                h(
                  'a',
                  {
                    key: link,
                    className: 'dsn-chip',
                    href: link,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    title: link,
                  },
                  link.replace(/^https?:\/\//, ''),
                ),
              ),
            )
          : null,
        h(
          'footer',
          { className: 'dsn-note-foot', 'data-limit': nearLimit ? 'true' : 'false' },
          formatTime(note.updatedAt),
          todos.length > 0 ? h('span', null, `${doneTodos}/${todos.length}`) : null,
          props.matchCount > 0 ? h('span', null, `${props.matchCount} ${t('matchUnit')}`) : null,
          nearLimit ? h('span', { className: 'dsn-note-count' }, `${bodyLength}/${MAX_NOTE_BODY}`) : null,
        ),
        props.menuOpen
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
                    'aria-pressed': props.color === paper.id ? 'true' : 'false',
                    onClick: () => props.onColor(note.id, paper.id),
                  }),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsn-menu-item',
                  role: 'menuitem',
                  onClick: () => {
                    props.onChange(note.id, { body: appendTable(note.body).slice(0, MAX_NOTE_BODY) })
                    props.onToggleMenu(note.id)
                  },
                },
                t('insertTable'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsn-menu-item dsn-menu-item--danger',
                  role: 'menuitem',
                  onClick: () => props.onDelete(note.id),
                },
                t('delete'),
              ),
            )
          : null,
      )
    })

    function NotesPage(props) {
      const t = props && typeof props.t === 'function' ? props.t : (key) => key
      const tRef = useRef(t)
      tRef.current = t

      const [notes, setNotes] = useState([])
      const [activeId, setActiveId] = useState(null)
      const [loaded, setLoaded] = useState(false)
      /** idle | pending | saving | saved | error */
      const [status, setStatus] = useState('idle')
      const [errorText, setErrorText] = useState('')
      const [notice, setNotice] = useState(null)
      /** 打开了「···」菜单的便签 id。 */
      const [menuId, setMenuId] = useState(null)
      const [query, setQuery] = useState('')
      const [sort, setSort] = useState('manual')
      /** 删除后待撤销的便签 { note, index }。 */
      const [undoEntry, setUndoEntry] = useState(null)
      const [tone, setTone] = useState('light')
      const [dragId, setDragId] = useState(null)
      const [dragOverId, setDragOverId] = useState(null)
      /** 落点相对目标卡片的位置：before | after。 */
      const [dragEdge, setDragEdge] = useState(null)
      const [storageOpen, setStorageOpen] = useState(false)
      const [storagePath, setStoragePath] = useState('')
      const [storageInfo, setStorageInfo] = useState({ current: '', isDefault: true })
      const [storageBusy, setStorageBusy] = useState(false)
      const [storageMessage, setStorageMessage] = useState(null)
      const [trashOpen, setTrashOpen] = useState(false)
      const [trashEntries, setTrashEntries] = useState([])
      const [trashCount, setTrashCount] = useState(0)
      const [trashBusy, setTrashBusy] = useState(false)
      const [trashMessage, setTrashMessage] = useState(null)
      /** 「清空回收站」需要点两次，避免手滑把 30 天的退路一次性抹掉。 */
      const [trashConfirmAll, setTrashConfirmAll] = useState(false)

      const panelRef = useRef(null)
      const boardRef = useRef(null)
      const searchRef = useRef(null)
      const titleRefs = useRef(new Map())
      const notesRef = useRef([])
      const versionRef = useRef(0)
      /** 待发送的改动：id → { type: 'save', note } | { type: 'delete' }。 */
      const pendingRef = useRef(new Map())
      const activeIdRef = useRef(null)
      const undoRef = useRef(null)
      const pendingFocusRef = useRef(null)
      const dragIdRef = useRef(null)
      const dragEdgeRef = useRef(null)
      const dragFrameRef = useRef(0)
      /** 当前显示顺序，拖拽落点按它算。 */
      const visibleRef = useRef([])
      /** 卡片元素表，用于重排时做 FLIP 位移动画。 */
      const cardElsRef = useRef(new Map())
      const layoutRef = useRef(new Map())
      const savingRef = useRef(false)
      const timerRef = useRef(null)
      const retryTimerRef = useRef(null)
      const retryCountRef = useRef(0)
      const undoTimerRef = useRef(null)
      const aliveRef = useRef(true)

      /** 串行发送待提交改动；版本冲突时并入服务端状态再重发。 */
      const flush = useCallback(async () => {
        if (savingRef.current) return
        if (pendingRef.current.size === 0) return
        savingRef.current = true
        if (aliveRef.current) setStatus('saving')

        const url = (path) => resolveApiUrl(path)
        const sendSave = async (note) => {
          const response = await fetch(url(`${NOTES_PATH}/${encodeURIComponent(note.id)}`), {
            method: 'PUT',
            headers: { 'content-type': 'application/json', [MARKER_HEADER]: '1' },
            body: JSON.stringify({ note, baseVersion: versionRef.current }),
          })
          const payload = await response.json().catch(() => null)
          if (response.status === 409) return { conflict: payload && payload.data }
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          if (payload.data && Number.isFinite(payload.data.version)) versionRef.current = payload.data.version
          return {}
        }
        const sendDelete = async (id) => {
          const path = `${NOTES_PATH}/${encodeURIComponent(id)}?baseVersion=${versionRef.current}`
          const response = await fetch(url(path), {
            method: 'DELETE',
            headers: { [MARKER_HEADER]: '1' },
          })
          const payload = await response.json().catch(() => null)
          if (response.status === 409) return { conflict: payload && payload.data }
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          if (payload.data && Number.isFinite(payload.data.version)) versionRef.current = payload.data.version
          if (payload.data && payload.data.removed === true && Number.isFinite(payload.data.trashCount)) {
            setTrashCount(payload.data.trashCount)
          }
          return {}
        }
        /** 服务端现状 + 本端还没发出去的改动 = 合并结果。 */
        const adopt = (doc) => {
          if (!doc || !Array.isArray(doc.notes)) return
          if (Number.isFinite(doc.version)) versionRef.current = doc.version
          const pending = pendingRef.current
          const merged = []
          for (const note of doc.notes) {
            const op = pending.get(note.id)
            if (op && op.type === 'delete') continue
            merged.push(op && op.type === 'save' ? op.note : note)
          }
          for (const [id, op] of pending) {
            if (op.type !== 'save') continue
            if (!merged.some((note) => note.id === id)) merged.unshift(op.note)
          }
          notesRef.current = merged
          setNotes(merged)
          if (activeIdRef.current && !merged.some((note) => note.id === activeIdRef.current)) {
            activeIdRef.current = merged.length > 0 ? merged[0].id : null
            setActiveId(activeIdRef.current)
          }
          setNotice({ text: tRef.current('conflictMerged'), detail: '' })
        }

        let rounds = 0
        try {
          for (;;) {
            const entries = [...pendingRef.current.entries()]
            if (entries.length === 0) break
            let conflictDoc = null
            for (const [id, op] of entries) {
              const result = op.type === 'delete' ? await sendDelete(id) : await sendSave(op.note)
              if (result.conflict) {
                conflictDoc = result.conflict
                break
              }
              // 期间用户又改了同一条，就留着下一轮再发。
              if (pendingRef.current.get(id) === op) pendingRef.current.delete(id)
            }
            if (conflictDoc) {
              rounds += 1
              adopt(conflictDoc)
              if (rounds > MAX_CONFLICT_ROUNDS) throw new Error('state conflict')
              continue
            }
            if (pendingRef.current.size === 0) break
          }
          retryCountRef.current = 0
          if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current)
            retryTimerRef.current = null
          }
          if (aliveRef.current) setStatus('saved')
        } catch (caught) {
          if (!aliveRef.current) return
          setStatus('error')
          setErrorText(String((caught && caught.message) || caught))
          const attempt = retryCountRef.current
          retryCountRef.current = attempt + 1
          const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null
            void flushRef.current()
          }, delay)
        } finally {
          savingRef.current = false
          // 极端时序兜底：本轮已收尾但期间又攒下改动，就补一次。
          if (pendingRef.current.size > 0 && aliveRef.current && !retryTimerRef.current && !timerRef.current) {
            timerRef.current = setTimeout(() => {
              timerRef.current = null
              void flushRef.current()
            }, 50)
          }
        }
      }, [])
      const flushRef = useRef(null)
      flushRef.current = flush

      /** 登记一条改动并防抖发送。 */
      const schedule = useCallback((id, op) => {
        pendingRef.current.set(id, op)
        if (aliveRef.current) setStatus('pending')
        if (timerRef.current) clearTimeout(timerRef.current)
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current)
          retryTimerRef.current = null
        }
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          void flushRef.current()
        }, SAVE_DELAY)
      }, [])

      const saveNow = useCallback(() => {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        if (retryTimerRef.current) {
          clearTimeout(retryTimerRef.current)
          retryTimerRef.current = null
        }
        retryCountRef.current = 0
        void flushRef.current()
      }, [])

      const commit = useCallback((next) => {
        notesRef.current = next
        setNotes(next)
      }, [])

      const onCardRef = useCallback((id, element) => {
        if (element) cardElsRef.current.set(id, element)
        else cardElsRef.current.delete(id)
      }, [])

      /** 结构变化前先记下每张卡的位置，重排后按差值补位移动画。 */
      const captureLayout = useCallback(() => {
        const snapshot = new Map()
        for (const [id, element] of cardElsRef.current) {
          const rect = element.getBoundingClientRect()
          snapshot.set(id, { left: rect.left, top: rect.top })
        }
        layoutRef.current = snapshot
      }, [])

      // FLIP：先让卡片瞬移回原位，再过渡到新位置，让「换位」看得见。
      useLayoutEffect(() => {
        const previous = layoutRef.current
        if (previous.size === 0) return
        layoutRef.current = new Map()
        for (const [id, element] of cardElsRef.current) {
          const before = previous.get(id)
          if (!before) continue
          const rect = element.getBoundingClientRect()
          const dx = before.left - rect.left
          const dy = before.top - rect.top
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
          element.style.transition = 'none'
          element.style.transform = `translate(${dx}px, ${dy}px)`
          void element.offsetWidth
          element.style.transition = 'transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1)'
          element.style.transform = 'translate(0px, 0px)'
          window.setTimeout(() => {
            element.style.transition = ''
            element.style.transform = ''
          }, 300)
        }
      }, [notes])

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
          const data = payload.data || {}
          const list = Array.isArray(data.notes) ? data.notes : []
          if (Number.isFinite(data.version)) versionRef.current = data.version
          if (Number.isFinite(data.trashCount)) setTrashCount(data.trashCount)
          commit(list)
          const nextActive =
            activeIdRef.current && list.some((note) => note.id === activeIdRef.current)
              ? activeIdRef.current
              : list.length > 0
                ? list[0].id
                : null
          activeIdRef.current = nextActive
          setActiveId(nextActive)
          setLoaded(true)
          setStatus('idle')
          setErrorText('')
          if (data.recovered) setNotice({ text: tRef.current('recovered'), detail: data.backup || '' })
        } catch (caught) {
          if (!aliveRef.current) return
          setLoaded(true)
          setStatus('error')
          setErrorText(String((caught && caught.message) || caught))
        }
      }, [commit])

      /**
       * 后台对齐：MCP server 或另一个窗口可能在背后改过数据。
       * 只在「本端没有待保存改动」时按版本号整体接管，避免把用户正在写的内容冲掉；
       * 有改动就交给保存流程，遇到 409 时现有的合并逻辑会兜住。
       */
      const syncIfStale = useCallback(async () => {
        if (!aliveRef.current || savingRef.current) return
        if (pendingRef.current.size > 0) return
        try {
          const response = await fetch(resolveApiUrl(API_PATH), {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok !== true) return
          const data = payload.data || {}
          if (!Number.isFinite(data.version) || data.version === versionRef.current) return
          // 期间用户又改了东西，就让下一轮再看。
          if (pendingRef.current.size > 0 || savingRef.current) return
          const list = Array.isArray(data.notes) ? data.notes : []
          versionRef.current = data.version
          if (Number.isFinite(data.trashCount)) setTrashCount(data.trashCount)
          captureLayout()
          commit(list)
          if (activeIdRef.current && !list.some((note) => note.id === activeIdRef.current)) {
            const nextActive = list.length > 0 ? list[0].id : null
            activeIdRef.current = nextActive
            setActiveId(nextActive)
          }
        } catch {
          // 面板可能离线，下次聚焦再试。
        }
      }, [captureLayout, commit])

      /** 打开存放目录弹窗时读一次当前路径。 */
      const openStorage = useCallback(async () => {
        setStorageOpen(true)
        setStorageMessage(null)
        setStorageBusy(true)
        try {
          const response = await fetch(resolveApiUrl(CONFIG_PATH), {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          const data = payload.data || {}
          setStorageInfo({ current: String(data.dir || ''), isDefault: data.custom !== true })
          setStoragePath(data.custom === true ? String(data.dir || '') : '')
        } catch (caught) {
          setStorageMessage({
            text: `${tRef.current('storageFailed')}：${String((caught && caught.message) || caught)}`,
            error: true,
          })
        } finally {
          setStorageBusy(false)
        }
      }, [])

      /** 切换目录：先把待保存改动落盘，再让 Host 端迁移并重载。 */
      const applyStorage = useCallback(async (dir) => {
        setStorageBusy(true)
        setStorageMessage(null)
        try {
          await flushRef.current()
          if (pendingRef.current.size > 0) throw new Error(tRef.current('storagePending'))
          const response = await fetch(resolveApiUrl(CONFIG_PATH), {
            method: 'POST',
            headers: { 'content-type': 'application/json', [MARKER_HEADER]: '1' },
            body: JSON.stringify({ dir }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          const data = payload.data || {}
          pendingRef.current.clear()
          versionRef.current = 0
          setStorageInfo({ current: String(data.dir || ''), isDefault: data.custom !== true })
          setStoragePath(data.custom === true ? String(data.dir || '') : '')
          await load()
          const summary = data.skipped
            ? tRef.current('storageSkipped')
            : `${tRef.current('storageDone')}: ${Number(data.notes) || 0} ${tRef.current('noteUnit')} · ${Number(data.assets) || 0} ${tRef.current('assetUnit')}`
          setStorageMessage({ text: `${summary} → ${String(data.dir || '')}`, error: false })
        } catch (caught) {
          setStorageMessage({
            text: `${tRef.current('storageFailed')}：${String((caught && caught.message) || caught)}`,
            error: true,
          })
        } finally {
          setStorageBusy(false)
        }
      }, [load])

      /** 拉一次回收站列表；打开弹窗和每次操作后都走这里。 */
      const fetchTrash = useCallback(async () => {
        const response = await fetch(resolveApiUrl(TRASH_PATH), {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error((payload && payload.error) || `HTTP ${response.status}`)
        }
        const data = payload.data || {}
        const entries = Array.isArray(data.entries) ? data.entries : []
        if (Number.isFinite(data.version)) versionRef.current = data.version
        setTrashEntries(entries)
        setTrashCount(entries.length)
      }, [])

      const openTrash = useCallback(async () => {
        setTrashOpen(true)
        setTrashMessage(null)
        setTrashConfirmAll(false)
        setTrashBusy(true)
        try {
          await fetchTrash()
        } catch (caught) {
          setTrashMessage({
            text: `${tRef.current('trashFailed')}：${String((caught && caught.message) || caught)}`,
            error: true,
          })
        } finally {
          setTrashBusy(false)
        }
      }, [fetchTrash])

      /** 回收站写操作：restore 放回便签墙，purge 单条彻底删除，empty 清空。 */
      const mutateTrash = useCallback(
        async (action, id) => {
          setTrashBusy(true)
          setTrashMessage(null)
          setTrashConfirmAll(false)
          try {
            if (action === 'restore') {
              // 还原会重排便签列表，先把待保存的改动落盘，免得被重新拉取覆盖。
              await flushRef.current()
              if (pendingRef.current.size > 0) throw new Error(tRef.current('storagePending'))
            }
            const path =
              action === 'restore'
                ? `${TRASH_PATH}/${encodeURIComponent(id)}/restore`
                : action === 'purge'
                  ? `${TRASH_PATH}/${encodeURIComponent(id)}`
                  : TRASH_PATH
            const response = await fetch(resolveApiUrl(path), {
              method: action === 'restore' ? 'POST' : 'DELETE',
              // 还原是改列表的写接口，Host 端要求带 JSON 体与自定义头。
              headers:
                action === 'restore'
                  ? { 'content-type': 'application/json', [MARKER_HEADER]: '1' }
                  : { [MARKER_HEADER]: '1' },
              body: action === 'restore' ? '{}' : undefined,
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok || !payload || payload.ok !== true) {
              throw new Error((payload && payload.error) || `HTTP ${response.status}`)
            }
            const data = payload.data || {}
            if (Number.isFinite(data.version)) versionRef.current = data.version
            await fetchTrash()
            if (action === 'restore') await load()
          } catch (caught) {
            setTrashMessage({
              text: `${tRef.current('trashFailed')}：${String((caught && caught.message) || caught)}`,
              error: true,
            })
          } finally {
            setTrashBusy(false)
          }
        },
        [fetchTrash, load],
      )

      useEffect(() => {
        aliveRef.current = true
        void load()
        return () => {
          aliveRef.current = false
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
          if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current)
            retryTimerRef.current = null
          }
          if (undoTimerRef.current) {
            clearTimeout(undoTimerRef.current)
            undoTimerRef.current = null
          }
          // 卸载兜底：逐条发会互相顶着版本号，改成一次整份覆盖（不带 baseVersion，关页面时以本端为准）。
          if (pendingRef.current.size > 0) {
            try {
              void fetch(resolveApiUrl(API_PATH), {
                method: 'PUT',
                keepalive: true,
                headers: { 'content-type': 'application/json', [MARKER_HEADER]: '1' },
                body: JSON.stringify({ notes: notesRef.current }),
              })
            } catch {
              // 页面已经走了，失败也没处提示。
            }
          }
        }
      }, [load])

      // 暗色主题判定：直接读面板背景亮度，主题切换（属性变化）时重算。
      useEffect(() => {
        const measure = () => {
          const element = panelRef.current
          if (!element || typeof window.getComputedStyle !== 'function') return
          const value = window.getComputedStyle(element).backgroundColor || ''
          const match = /rgba?\(([^)]+)\)/.exec(value)
          if (!match) return
          const parts = match[1].split(',').map((part) => Number.parseFloat(part))
          if (!Number.isFinite(parts[0]) || !Number.isFinite(parts[1]) || !Number.isFinite(parts[2])) return
          if (parts.length > 3 && parts[3] === 0) return
          const luminance = (0.299 * parts[0] + 0.587 * parts[1] + 0.114 * parts[2]) / 255
          setTone(luminance < 0.5 ? 'dark' : 'light')
        }
        measure()
        const observer = typeof MutationObserver === 'function' ? new MutationObserver(measure) : null
        if (observer && document.documentElement) observer.observe(document.documentElement, { attributes: true })
        const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
        if (media && typeof media.addEventListener === 'function') media.addEventListener('change', measure)
        return () => {
          if (observer) observer.disconnect()
          if (media && typeof media.removeEventListener === 'function') media.removeEventListener('change', measure)
        }
      }, [])

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

      // 目录 / 回收站弹窗：Esc 关闭。
      useEffect(() => {
        if (!storageOpen && !trashOpen) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          setStorageOpen(false)
          setTrashOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [storageOpen, trashOpen])

      // 面板重新可见或窗口聚焦时对齐一次版本号，可见期间再低频兜底轮询。
      useEffect(() => {
        const tick = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void syncIfStale()
        }
        document.addEventListener('visibilitychange', tick)
        window.addEventListener('focus', tick)
        const timer = window.setInterval(tick, SYNC_INTERVAL)
        return () => {
          document.removeEventListener('visibilitychange', tick)
          window.removeEventListener('focus', tick)
          window.clearInterval(timer)
        }
      }, [syncIfStale])

      // 新建后把光标送进标题；用 ref 注册表拿控件，卡片本身保持 memo 不重渲染。
      useEffect(() => {
        const id = pendingFocusRef.current
        if (!id) return
        const element = titleRefs.current.get(id)
        if (!element) return
        pendingFocusRef.current = null
        try {
          element.focus()
        } catch {
          // 控件可能已经被卸载。
        }
      }, [notes])

      const onTitleRef = useCallback((id, element) => {
        if (element) titleRefs.current.set(id, element)
        else titleRefs.current.delete(id)
      }, [])

      const updateNote = useCallback((id, patch) => {
        const list = notesRef.current
        const index = list.findIndex((note) => note.id === id)
        if (index < 0) return
        const note = Object.assign({}, list[index], patch, { updatedAt: Date.now() })
        const next = list.slice()
        next[index] = note
        commit(next)
        schedule(id, { type: 'save', note })
      }, [commit, schedule])

      const clearUndo = useCallback(() => {
        if (undoTimerRef.current) {
          clearTimeout(undoTimerRef.current)
          undoTimerRef.current = null
        }
        undoRef.current = null
        setUndoEntry(null)
      }, [])

      const showUndo = useCallback((entry) => {
        if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
        undoRef.current = entry
        setUndoEntry(entry)
        undoTimerRef.current = setTimeout(() => {
          undoTimerRef.current = null
          undoRef.current = null
          setUndoEntry(null)
        }, UNDO_MS)
      }, [])

      const onToggleMenu = useCallback((id) => {
        setMenuId((current) => (current === id ? null : id))
      }, [])

      const onColor = useCallback((id, color) => {
        setMenuId(null)
        updateNote(id, { color })
      }, [updateNote])

      const onFocus = useCallback((id) => {
        const previous = activeIdRef.current
        if (previous && previous !== id) {
          // 切走时把「一个字都没写」的便签顺手清掉，别在墙上堆空白纸。
          const list = notesRef.current
          const previousNote = list.find((note) => note.id === previous)
          if (previousNote && isEmptyNote(previousNote)) {
            captureLayout()
            commit(list.filter((note) => note.id !== previous))
            schedule(previous, { type: 'delete' })
          }
        }
        activeIdRef.current = id
        setActiveId(id)
      }, [captureLayout, commit, schedule])

      const onDelete = useCallback((id) => {
        const list = notesRef.current
        const index = list.findIndex((note) => note.id === id)
        if (index < 0) return
        const note = list[index]
        const next = list.filter((item) => item.id !== id)
        setMenuId(null)
        captureLayout()
        commit(next)
        schedule(id, { type: 'delete' })
        showUndo({ note, index })
        if (activeIdRef.current === id) {
          const fallback = next[Math.min(index, next.length - 1)] || null
          activeIdRef.current = fallback ? fallback.id : null
          setActiveId(activeIdRef.current)
        }
      }, [captureLayout, commit, schedule, showUndo])

      const undoDelete = useCallback(() => {
        const entry = undoRef.current
        if (!entry) return
        const list = notesRef.current
        const next = list.slice()
        next.splice(Math.min(entry.index, next.length), 0, entry.note)
        // 删除已经落盘时回收站里已有这条，撤销会顺带把条目清掉，条数跟着减。
        if (!pendingRef.current.has(entry.note.id)) setTrashCount((current) => (current > 0 ? current - 1 : 0))
        clearUndo()
        captureLayout()
        commit(next)
        schedule(entry.note.id, { type: 'save', note: entry.note })
        activeIdRef.current = entry.note.id
        setActiveId(entry.note.id)
      }, [captureLayout, clearUndo, commit, schedule])

      const createNote = useCallback(() => {
        const list = notesRef.current
        if (list.length >= MAX_NOTES) {
          setNotice({ text: tRef.current('limitReached'), detail: '' })
          return
        }
        const now = Date.now()
        const note = {
          id: uid(),
          title: '',
          body: '',
          color: PAPERS[list.length % PAPERS.length].id,
          createdAt: now,
          updatedAt: now,
        }
        setMenuId(null)
        clearUndo()
        activeIdRef.current = note.id
        setActiveId(note.id)
        pendingFocusRef.current = note.id
        setQuery('')
        captureLayout()
        commit([note, ...list])
        schedule(note.id, { type: 'save', note })
        if (boardRef.current) boardRef.current.scrollTop = 0
      }, [captureLayout, clearUndo, commit, schedule])

      const insertText = useCallback((id, text) => {
        const note = notesRef.current.find((item) => item.id === id)
        if (!note) return
        updateNote(id, { body: `${note.body}${text}` })
      }, [updateNote])

      /** 粘贴图片：先传到 Host 端 assets，再在正文末尾补一行引用。 */
      const uploadImage = useCallback(async (id, file) => {
        if (!file) return
        if (file.size > MAX_ASSET_BYTES) {
          setNotice({ text: tRef.current('imageTooBig'), detail: '' })
          return
        }
        try {
          const response = await fetch(resolveApiUrl(ASSETS_PATH), {
            method: 'POST',
            headers: { 'content-type': file.type, [MARKER_HEADER]: '1' },
            body: file,
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          }
          const reference = payload.data && payload.data.url
          if (typeof reference !== 'string') throw new Error('invalid asset response')
          insertText(id, `\n![](${reference})\n`)
        } catch (caught) {
          setNotice({ text: tRef.current('imageFailed'), detail: String((caught && caught.message) || caught) })
        }
      }, [insertText])

      const onDragStart = useCallback((id) => {
        dragIdRef.current = id
        dragEdgeRef.current = null
        // 浏览器是在 dragstart 之后才给拖影截图的。等一帧再上「拖拽中」的半透明样式，
        // 否则跟着鼠标走的那张卡片也会被截成半透明。
        if (dragFrameRef.current) cancelAnimationFrame(dragFrameRef.current)
        dragFrameRef.current = requestAnimationFrame(() => {
          dragFrameRef.current = 0
          if (dragIdRef.current !== id) return
          setDragId(id)
          setDragEdge(null)
        })
      }, [])

      const onDragOverCard = useCallback((id, edge) => {
        if (!dragIdRef.current || dragIdRef.current === id) return
        if (dragEdgeRef.current !== edge) {
          dragEdgeRef.current = edge
          setDragEdge(edge)
        }
        setDragOverId((current) => (current === id ? current : id))
      }, [])

      const onDragEnd = useCallback(() => {
        dragIdRef.current = null
        dragEdgeRef.current = null
        if (dragFrameRef.current) {
          cancelAnimationFrame(dragFrameRef.current)
          dragFrameRef.current = 0
        }
        setDragId(null)
        setDragEdge(null)
        setDragOverId(null)
      }, [])

      /**
       * 放下时按「指针在目标卡片左半还是右半」决定插前还是插后，
       * 只改被拖动那一条的 order（取前后邻居的中点），不发整份文档。
       */
      const onDrop = useCallback((targetId, sourceId) => {
        // dataTransfer 里的来源 id 比 ref 可靠：拖拽期间卡片会重渲染，ref 可能已经被 dragend 清掉。
        const dragged = typeof sourceId === 'string' && sourceId !== '' ? sourceId : dragIdRef.current
        const edge = dragEdgeRef.current === 'after' ? 'after' : 'before'
        onDragEnd()
        if (!dragged || dragged === targetId) return
        // 拖拽排序按当前显示顺序算，用户看到什么顺序就得到什么结果。
        const ordered = visibleRef.current.length > 0 ? visibleRef.current : notesRef.current
        const moved = ordered.find((note) => note.id === dragged)
        if (!moved) return
        const rest = ordered.filter((note) => note.id !== dragged)
        const targetIndex = rest.findIndex((note) => note.id === targetId)
        if (targetIndex < 0) return
        const insertAt = edge === 'after' ? targetIndex + 1 : targetIndex
        // 拖到另一组（置顶 / 普通）就跟着换组，否则松手后会被置顶权重弹回原位。
        const anchor = rest[insertAt] || rest[insertAt - 1]
        const pinned = Boolean(anchor && anchor.pinned === true)
        const order = orderForDrop(rest, insertAt, pinned, orderOf)
        const updated = Object.assign({}, moved, { order })
        if ((moved.pinned === true) !== pinned) updated.pinned = pinned
        const reordered = rest.slice()
        reordered.splice(insertAt, 0, updated)
        captureLayout()
        commit(reordered)
        schedule(dragged, { type: 'save', note: updated })
        setSort('manual')
      }, [captureLayout, commit, onDragEnd, schedule])

      // 快捷键：Alt+N 新建、Ctrl/⌘+F 搜索、Ctrl/⌘+S 立即保存。
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.isComposing) return
          const key = String(event.key || '').toLowerCase()
          if (event.altKey && !event.ctrlKey && !event.metaKey && key === 'n') {
            event.preventDefault()
            createNote()
            return
          }
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return
          if (key === 'f') {
            event.preventDefault()
            if (searchRef.current) {
              searchRef.current.focus()
              searchRef.current.select()
            }
          } else if (key === 's') {
            event.preventDefault()
            saveNow()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [createNote, saveNow])

      const retryNow = useCallback(() => {
        retryCountRef.current = 0
        setStatus('pending')
        void flushRef.current()
      }, [])

      const matchCounts = useMemo(() => {
        const counts = new Map()
        const keyword = query.trim().toLowerCase()
        if (!keyword) return counts
        for (const note of notes) {
          const haystack = `${String(note.title || '')}\n${String(note.body || '')}`.toLowerCase()
          let count = 0
          let index = haystack.indexOf(keyword)
          while (index >= 0) {
            count += 1
            index = haystack.indexOf(keyword, index + keyword.length)
          }
          counts.set(note.id, count)
        }
        return counts
      }, [notes, query])

      const visible = useMemo(() => {
        const keyword = query.trim().toLowerCase()
        let list = notes
        if (keyword) {
          list = list.filter((note) =>
            `${String(note.title || '')}\n${String(note.body || '')}`.toLowerCase().includes(keyword),
          )
        }
        const sorted = list.slice()
        const pinnedFirst = (a, b) => pinRank(a) - pinRank(b)
        if (sort === 'updated') sorted.sort((a, b) => pinnedFirst(a, b) || (b.updatedAt || 0) - (a.updatedAt || 0))
        else if (sort === 'title') sorted.sort((a, b) => pinnedFirst(a, b) || titleKey(a).localeCompare(titleKey(b)))
        else if (sort === 'created') sorted.sort((a, b) => pinnedFirst(a, b) || (b.createdAt || 0) - (a.createdAt || 0))
        else sorted.sort((a, b) => pinnedFirst(a, b) || orderOf(a) - orderOf(b))
        return sorted
      }, [notes, query, sort])

      // 拖拽落点按显示顺序算，这里同步一份给 onDrop 用。
      visibleRef.current = visible

      const atLimit = notes.length >= MAX_NOTES
      const dragEnabled = !query.trim()

      const cards = visible.map((note) =>
        h(NoteCard, {
          key: note.id,
          note,
          color: paperOf(note),
          focused: note.id === activeId,
          menuOpen: menuId === note.id,
          dragging: dragId === note.id,
          dropEdge: dragOverId === note.id && dragId !== note.id ? dragEdge : null,
          dragEnabled,
          matchCount: matchCounts.get(note.id) || 0,
          t,
          onChange: updateNote,
          onFocus,
          onToggleMenu,
          onColor,
          onDelete,
          onTitleRef,
          onCardRef,
          onPasteImage: uploadImage,
          onDragStart,
          onDragOver: onDragOverCard,
          onDrop,
          onDragEnd,
        }),
      )

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
              disabled: !failed && atLimit,
              title: atLimit && !failed ? t('limitReached') : undefined,
              onClick: failed ? () => void load() : createNote,
            },
            failed ? t('retry') : t('emptyAction'),
          ),
          failed ? null : h('div', { className: 'dsn-empty-hint' }, t('shortcutHint')),
        )
      } else if (visible.length === 0) {
        board = h('div', { className: 'dsn-empty' }, h('div', { className: 'dsn-empty-body' }, t('searchEmpty')))
      } else {
        board = cards
      }

      const showBoard = loaded && visible.length > 0

      return h(
        Fragment,
        null,
        h('style', { key: 'dsn-style' }, CSS),
        h(
          'div',
          { className: 'dsn-panel', 'data-tone': tone, ref: panelRef },
          h(
            'header',
            { className: 'dsn-toolbar' },
            h('div', { className: 'dsn-heading', role: 'heading', 'aria-level': '1' }, t('title')),
            h('span', { className: 'dsn-count' }, `${notes.length} ${t('noteUnit')}`),
            h('input', {
              ref: searchRef,
              className: 'dsn-search',
              type: 'search',
              value: query,
              placeholder: t('search'),
              'aria-label': t('search'),
              onChange: (event) => setQuery(event.target.value),
            }),
            h(
              'select',
              {
                className: 'dsn-sort',
                value: sort,
                title: t('sortLabel'),
                'aria-label': t('sortLabel'),
                onChange: (event) => setSort(event.target.value),
              },
              SORTS.map((option) => h('option', { key: option.id, value: option.id }, t(option.label))),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsn-btn',
                title: t('storageTitle'),
                onClick: () => void openStorage(),
              },
              t('storage'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsn-btn',
                title: t('trashTitle'),
                onClick: () => void openTrash(),
              },
              trashCount > 0 ? `${t('trash')} ${trashCount}` : t('trash'),
            ),
            h('span', { className: 'dsn-grow' }),
            h(
              'span',
              {
                className: status === 'error' ? 'dsn-status dsn-status--error' : 'dsn-status',
                title: status === 'error' ? errorText : undefined,
                'aria-live': 'polite',
              },
              statusText(status, t),
            ),
            status === 'error'
              ? h('button', { type: 'button', className: 'dsn-btn', onClick: retryNow }, t('retry'))
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'dsn-btn dsn-btn--primary',
                onClick: createNote,
                disabled: atLimit,
                title: atLimit ? t('limitReached') : t('newNote'),
              },
              h(GlyphPlus, null),
              t('newNote'),
            ),
          ),
          notice
            ? h(
                'div',
                { className: 'dsn-banner', role: 'status' },
                h('span', { className: 'dsn-banner-text', title: notice.detail || undefined }, notice.text),
                h('span', { className: 'dsn-grow' }),
                h(
                  'button',
                  { type: 'button', className: 'dsn-banner-btn', onClick: () => setNotice(null) },
                  t('dismiss'),
                ),
              )
            : null,
          h(
            'div',
            {
              className: showBoard ? 'dsn-board' : 'dsn-board dsn-board--empty',
              ref: boardRef,
              // 兜底：卡片上的 dragover/drop 万一没接住，就在看板层按卡片 id 再算一次。
              onDragOver: (event) => {
                if (!dragIdRef.current) return
                const card = event.target && event.target.closest ? event.target.closest('[data-note-id]') : null
                if (!card) return
                event.preventDefault()
                const id = card.getAttribute('data-note-id')
                if (!id || id === dragIdRef.current) return
                const rect = card.getBoundingClientRect()
                onDragOverCard(id, event.clientX > rect.left + rect.width / 2 ? 'after' : 'before')
              },
              onDrop: (event) => {
                // 卡片已经处理过就不再重复排序。
                if (event.defaultPrevented) return
                const card = event.target && event.target.closest ? event.target.closest('[data-note-id]') : null
                if (!card) return
                event.preventDefault()
                const source = event.dataTransfer ? event.dataTransfer.getData('text/plain') : ''
                onDrop(card.getAttribute('data-note-id'), source)
              },
            },
            board,
          ),
          undoEntry
            ? h(
                'div',
                { className: 'dsn-toast', role: 'status' },
                h('span', null, t('deleted')),
                h('button', { type: 'button', className: 'dsn-toast-btn', onClick: undoDelete }, t('undo')),
              )
            : null,
          storageOpen
            ? h(
                'div',
                {
                  className: 'dsn-modal',
                  onPointerDown: (event) => {
                    if (event.target === event.currentTarget) setStorageOpen(false)
                  },
                },
                h(
                  'div',
                  { className: 'dsn-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('storageTitle') },
                  h('div', { className: 'dsn-modal-title' }, t('storageTitle')),
                  h(
                    'div',
                    { className: 'dsn-modal-row' },
                    h('span', null, `${t('storageCurrent')}: `),
                    h(
                      'span',
                      { className: 'dsn-modal-path', title: storageInfo.current },
                      storageInfo.current || '—',
                    ),
                  ),
                  h('input', {
                    className: 'dsn-input',
                    value: storagePath,
                    placeholder: t('storagePlaceholder'),
                    'aria-label': t('storagePlaceholder'),
                    spellCheck: false,
                    onChange: (event) => setStoragePath(event.target.value),
                  }),
                  h('div', { className: 'dsn-modal-hint' }, t('storageHint')),
                  storageMessage
                    ? h(
                        'div',
                        {
                          className: storageMessage.error
                            ? 'dsn-modal-status dsn-modal-status--error'
                            : 'dsn-modal-status',
                          role: 'status',
                        },
                        storageMessage.text,
                      )
                    : null,
                  h(
                    'div',
                    { className: 'dsn-modal-foot' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsn-btn',
                        disabled: storageBusy || storageInfo.isDefault,
                        onClick: () => void applyStorage(null),
                      },
                      t('storageReset'),
                    ),
                    h('span', { className: 'dsn-grow' }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsn-btn',
                        disabled: storageBusy,
                        onClick: () => setStorageOpen(false),
                      },
                      t('storageCancel'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsn-btn dsn-btn--primary',
                        disabled: storageBusy || storagePath.trim() === '',
                        onClick: () => void applyStorage(storagePath.trim()),
                      },
                      storageBusy ? t('storageBusy') : t('storageApply'),
                    ),
                  ),
                ),
              )
            : null,
          trashOpen
            ? h(
                'div',
                {
                  className: 'dsn-modal',
                  onPointerDown: (event) => {
                    if (event.target === event.currentTarget) setTrashOpen(false)
                  },
                },
                h(
                  'div',
                  {
                    className: 'dsn-modal-card dsn-modal-card--wide',
                    role: 'dialog',
                    'aria-modal': 'true',
                    'aria-label': t('trashTitle'),
                  },
                  h(
                    'div',
                    { className: 'dsn-modal-title' },
                    trashCount > 0 ? `${t('trashTitle')} · ${trashCount}` : t('trashTitle'),
                  ),
                  trashEntries.length === 0
                    ? h('div', { className: 'dsn-trash-empty' }, trashBusy ? t('storageBusy') : t('trashEmpty'))
                    : h(
                        'ul',
                        { className: 'dsn-trash-list' },
                        trashEntries.map((entry) =>
                          h(
                            'li',
                            { className: 'dsn-trash-item', key: entry.id },
                            h(
                              'div',
                              { className: 'dsn-trash-text' },
                              h(
                                'div',
                                { className: 'dsn-trash-name', title: titleKey(entry) || entry.id },
                                titleKey(entry) || t('untitled'),
                              ),
                              h('div', { className: 'dsn-trash-meta' }, formatTime(entry.deletedAt)),
                            ),
                            h(
                              'div',
                              { className: 'dsn-trash-actions' },
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsn-btn',
                                  disabled: trashBusy,
                                  onClick: () => void mutateTrash('restore', entry.id),
                                },
                                t('trashRestore'),
                              ),
                              h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsn-btn dsn-btn--danger',
                                  disabled: trashBusy,
                                  onClick: () => void mutateTrash('purge', entry.id),
                                },
                                t('trashPurge'),
                              ),
                            ),
                          ),
                        ),
                      ),
                  trashMessage
                    ? h(
                        'div',
                        {
                          className: trashMessage.error
                            ? 'dsn-modal-status dsn-modal-status--error'
                            : 'dsn-modal-status',
                          role: 'status',
                        },
                        trashMessage.text,
                      )
                    : null,
                  h(
                    'div',
                    { className: 'dsn-modal-foot' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsn-btn dsn-btn--danger',
                        disabled: trashBusy || trashEntries.length === 0,
                        onBlur: () => setTrashConfirmAll(false),
                        onClick: () => {
                          if (!trashConfirmAll) {
                            setTrashConfirmAll(true)
                            return
                          }
                          void mutateTrash('empty')
                        },
                      },
                      trashConfirmAll ? t('trashPurgeAllConfirm') : t('trashPurgeAll'),
                    ),
                    h('span', { className: 'dsn-grow' }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsn-btn',
                        disabled: trashBusy,
                        onClick: () => setTrashOpen(false),
                      },
                      t('trashClose'),
                    ),
                  ),
                ),
              )
            : null,
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
