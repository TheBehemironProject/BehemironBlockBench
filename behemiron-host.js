/**
 * behemiron-host.js
 *
 * BlockBench fork 与 Behemiron Workerbench 主项目的桥接脚本。
 * 仅在嵌入态生效(iframe 或带 ?host=behemiron 查询的弹出窗口)。
 *
 * 职责(仅"动态" / "运行时"的桥接,**静态 UI 改动已下放到源码**):
 *   1. 双向桥接(postMessage):
 *      - 接收 host:theme / host:language / host:projects-restore /
 *        host:project-open / host:flush-current
 *      - 发送 bb:ready / bb:project-saved / bb:project-switched /
 *        bb:project-closed / bb:flush-response
 *   2. Hook Blockbench 事件:finish_edit(防抖 1s) / select_project /
 *      close_project / load_project / new_project
 *
 * **下面这些原本在本脚本里的非侵入式逻辑已迁移到源码**(不再 monkey-patch):
 *   - index.html: title 直接写 "BlockBench - Behemiron",删除 #web_download_button
 *   - js/web.js: 删除 #web_download_button.show() + display-mode 监听
 *   - js/interface/interface.js: setProjectTitle 默认 title + 后缀改为 Behemiron
 *   - js/interface/start_screen.js: 删除 discord_link / bluesky_link /
 *     new_version / psa 4 个 addStartScreenSection 调用 + news.json XHR
 *
 * 这样所有 UI 静态改动都在源码里"确定性"生效,不依赖 setInterval 轮询或
 * MutationObserver 反应式;本脚本只承担真正动态的桥接职责。
 */
(function () {
  'use strict';

  // ---- 环境检测 ----
  var isHosted =
    window !== window.top ||
    new URLSearchParams(window.location.search).get('host') === 'behemiron';
  if (!isHosted) return;

  // ---- 配置 ----
  var FINISH_EDIT_DEBOUNCE_MS = 1000;
  // 跨窗口实时同步广播的防抖间隔,独立于上面 SQLite 自动保存的 1000ms —— 同步
  // 要"尽快"但不能每次按键都发,250ms 是 Spike B 阶段的初始值,Phase 0 落地后
  // 建议针对真实项目(较多元素/材质)重新校准。
  var SYNC_DEBOUNCE_MS = 250;
  // 轻量选中态广播的防抖间隔——比整工程同步短得多,因为选中态同步不走
  // replaceProjectContentInPlace 的"清空重灌",开销小很多,可以更频繁地发,
  // 换取接近原生的选中响应速度。
  var SELECTION_DEBOUNCE_MS = 60;

  // ---- 状态 ----
  var finishEditTimer = null;
  var syncBroadcastTimer = null;
  var selectionBroadcastTimer = null;
  var restoringProjects = false; // 避免恢复时回写
  var pendingHistory = null; // 收到 host:set-history 时若 Vue 未就绪暂存,稍后填入
  // 本 BB 实例的唯一标识,每次 iframe/窗口启动重新生成。用于:
  //   1. 标记自己广播出去的同步快照(接收端据此丢弃"回声")
  //   2. 按来源窗口分别追踪已应用的 seq,丢弃乱序/重复的旧包
  var windowInstanceId = (window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID()
    : ('win-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  var syncSeq = 0;
  var lastAppliedSyncSeqByOrigin = {};
  var selectionSeq = 0;
  var lastAppliedSelectionSeqByOrigin = {};

  // ---- 工具 ----
  // 默认 console.info,所有节点都打在 DevTools 默认可见级别;
  // 排查"语言/主题不同步"等问题时直接看 wails webview 的 console。
  function log() {
    // eslint-disable-next-line no-console
    if (typeof console !== 'undefined') {
      console.info.apply(console, ['[behemiron-host]'].concat([].slice.call(arguments)));
    }
  }

  function sendToHost(type, payload) {
    try {
      window.parent.postMessage({ source: 'behemiron-bb', type: type, payload: payload }, '*');
      // 仅记关键事件,避免高频 finish_edit 刷屏
      if (type !== 'bb:project-saved') log('send to host:', type);
    } catch (e) {
      log('postMessage failed', e);
    }
  }

  function whenBlockbenchReady(cb) {
    if (window.Blockbench && window.Blockbench.dispatchEvent) {
      cb();
      return;
    }
    var t = setInterval(function () {
      if (window.Blockbench && window.Blockbench.dispatchEvent) {
        clearInterval(t);
        cb();
      }
    }, 50);
  }

  // ---- 1. 主题应用 ----
  function applyHostTheme(mode) {
    if (mode !== 'light' && mode !== 'dark') return;
    try {
      var themes =
        (window.CustomTheme && window.CustomTheme.themes) ||
        (window.Blockbench && window.Blockbench.themes) ||
        [];
      // BB 内置主题 id: 'default'(dark) / 'default_light'(light) / 'contrast'
      var targetId = mode === 'dark' ? 'default' : 'default_light';
      var target = null;
      for (var i = 0; i < themes.length; i++) {
        if (themes[i] && themes[i].id === targetId) {
          target = themes[i];
          break;
        }
      }
      if (target && window.CustomTheme && typeof window.CustomTheme.loadTheme === 'function') {
        window.CustomTheme.loadTheme(target);
        log('theme applied:', mode, '→', targetId);
      } else {
        log('theme not found in BB:', targetId);
      }
    } catch (e) {
      log('applyHostTheme failed', e);
    }
  }

  // ---- 2. 语言:由 AssetService 注入 + BB 源码直接读取 ----
  // 不再用 postMessage 触发 reload 写 localStorage 的方式 —— 不可靠(BB 在
  // saveLocalStorages 时会用自己当前值覆盖)。统一架构:
  //   1. host:set-bb-language → host 收到 → 调 behemironRequestReload(由 parent
  //      负责把 KV 'settings'.language.value 改好,然后改 iframe.src 或调 reload)
  //   2. 实际语言切换的"权威源"是 SQLite blockbench_kv key='settings',
  //      由 AssetService 在 serve index.html 时注入到 window.__BEHEMIRON_BB_SETTINGS__
  //      → BB setup_settings.js 读到。
  //
  // 收到 host:reload 时简单 location.reload(让 AssetService 重新注入新值)。
  function applyHostReload() {
    log('host requested iframe reload');
    try {
      window.location.reload();
    } catch (e) {
      log('reload failed', e);
    }
  }

  // ---- 2b. BB → host 镜像:settings 写回 SQLite ----
  // BB 源码的 Settings.saveLocalStorages 会调这个,把整个 settings 推给 parent。
  // parent 端写到 SQLite,下次 boot 由 AssetService 注入回来。
  window.behemironPostSettings = function (settingsCopy) {
    sendToHost('bb:settings-changed', { settings: settingsCopy });
  };

  // ---- 3. 项目序列化 / 加载 ----
  // 返回 null 时表示"不应持久化"。两类情况:
  //   - Project / Codecs 未就绪
  //   - 工程未命名(name 空字符串或 'noname')—— 用户没有主动命名,任何
  //     自动保存(finish_edit 防抖)都不应该把它写进 SQLite,避免新建即
  //     编辑就堆出一堆 noname 历史项
  function compileCurrentProject(opts) {
    opts = opts || {};
    try {
      if (!window.Project || !window.Codecs || !window.Codecs.project) return null;
      var name = window.Project.name || '';
      var isNamed = name && name.trim() && name.trim() !== 'noname';
      if (!opts.allowUnnamed && !isNamed) {
        return null;
      }
      // BB bbmodel codec 默认不存 Project.uuid。每次 reload + restore
      // 都会让 ModelProject 生成新 uuid,导致同一个工程被 DB 视为新行
      // 不断累积。这里在 raw 模式 compile 出的对象里注入 behemiron_uuid,
      // restore 时(restoreProjects / openSingleProject)读出来覆盖回
      // Project.uuid,保证主键稳定。
      var json = window.Codecs.project.compile({ raw: true });
      if (json && typeof json === 'object') {
        json.behemiron_uuid = window.Project.uuid;
      }
      var content = typeof json === 'string' ? json : JSON.stringify(json);
      return {
        uuid: window.Project.uuid || '',
        name: name,
        formatId: (window.Project.format && window.Project.format.id) || '',
        contentJson: content,
        thumbnailBase64: '',
        isOpenSession: true,
        sortOrder: 0,
        lastSavedAt: Date.now(),
        lastOpenedAt: Date.now(),
      };
    } catch (e) {
      log('compileCurrentProject failed', e);
      return null;
    }
  }

  // ---- 3a. 跨窗口实时同步:广播当前工程快照 ----
  // 与 compileCurrentProject(用于 SQLite 持久化,raw 全量)刻意不同 ——
  // 不带 bitmaps:true。Spike B 实测证实材质 dataURL 编码是单次调用里最重的
  // 一块开销,高频的实时同步通道不应该背上它;材质变化如需同步,后续应该走
  // 独立的低频通道,而不是让每次同步都重新编码全部材质。
  function sendSyncBroadcast() {
    try {
      if (!window.Project || !window.Codecs || !window.Codecs.project) return;
      var json = window.Codecs.project.compile({ editor_state: true, uuids: true, raw: true });
      if (!json || typeof json !== 'object') return;
      json.behemiron_uuid = window.Project.uuid;
      syncSeq++;
      sendToHost('bb:sync-broadcast-request', {
        projectUuid: window.Project.uuid || '',
        windowInstanceId: windowInstanceId,
        seq: syncSeq,
        snapshotJson: JSON.stringify(json),
      });
    } catch (e) {
      log('sendSyncBroadcast failed', e);
    }
  }

  // 防抖调度 sendSyncBroadcast——finish_edit 触发,250ms 内没有新的编辑才真正
  // 发一次广播。选中态变化不再走这条(见下面 scheduleSelectionBroadcast),
  // 避免"只是换个选中"也要付出整工程重建的代价。
  function scheduleSyncBroadcast() {
    if (syncBroadcastTimer) clearTimeout(syncBroadcastTimer);
    syncBroadcastTimer = setTimeout(function () {
      syncBroadcastTimer = null;
      sendSyncBroadcast();
    }, SYNC_DEBOUNCE_MS);
  }

  // ---- 3a-2. 轻量选中态广播(独立于整工程同步) ----
  function sendSelectionBroadcast() {
    try {
      if (!window.Project) return;
      selectionSeq++;
      var elementUuids = (window.Project.selected_elements || []).map(function (e) { return e.uuid; });
      var groupUuids = (window.Group && window.Group.multi_selected || []).map(function (g) { return g.uuid; });
      sendToHost('bb:selection-broadcast-request', {
        projectUuid: window.Project.uuid || '',
        windowInstanceId: windowInstanceId,
        seq: selectionSeq,
        selectedElementUuids: elementUuids,
        selectedGroupUuids: groupUuids,
      });
    } catch (e) {
      log('sendSelectionBroadcast failed', e);
    }
  }

  function scheduleSelectionBroadcast() {
    if (selectionBroadcastTimer) clearTimeout(selectionBroadcastTimer);
    selectionBroadcastTimer = setTimeout(function () {
      selectionBroadcastTimer = null;
      sendSelectionBroadcast();
    }, SELECTION_DEBOUNCE_MS);
  }

  // 应用来自其它窗口的选中态——只调 applySelectionOnly(不碰 Outliner/Texture/
  // Group/Animation 的增删),不会有 replaceProjectContentInPlace 那种整工程
  // 重建的闪烁/迟钝感。用同样的 restoringProjects 抑制 + seq 防乱序套路。
  function applySelectionSnapshot(payload) {
    if (!payload) return;
    if (payload.windowInstanceId === windowInstanceId) return;
    var lastSeq = lastAppliedSelectionSeqByOrigin[payload.windowInstanceId] || 0;
    if (typeof payload.seq === 'number' && payload.seq <= lastSeq) return;
    if (!window.__behemironProjectSync || typeof window.__behemironProjectSync.applySelectionOnly !== 'function') return;
    restoringProjects = true;
    try {
      var applied = window.__behemironProjectSync.applySelectionOnly(
        payload.selectedElementUuids || [],
        payload.selectedGroupUuids || []
      );
      if (applied && typeof payload.seq === 'number') {
        lastAppliedSelectionSeqByOrigin[payload.windowInstanceId] = payload.seq;
      }
    } catch (e) {
      log('applySelectionSnapshot failed', e);
    } finally {
      // 选中态应用不涉及 Three.js 节点重建,副作用基本是同步的,复位延迟可以
      // 比整工程同步短很多。
      setTimeout(function () { restoringProjects = false; }, 100);
    }
  }

  // ---- 3b. 跨窗口实时同步:应用来自其它窗口的快照 ----
  // 复用 restoringProjects 标志位抑制本地事件监听器在应用期间往外广播/持久化,
  // 避免"应用远端快照 → 触发本地 finish_edit → 又广播出去"的回声环路。
  function applySyncSnapshot(payload) {
    if (!payload || !payload.snapshotJson) return;
    if (payload.windowInstanceId === windowInstanceId) return; // 自己的广播,忽略回声
    var lastSeq = lastAppliedSyncSeqByOrigin[payload.windowInstanceId] || 0;
    if (typeof payload.seq === 'number' && payload.seq <= lastSeq) {
      log('applySyncSnapshot: stale/out-of-order seq ignored', payload.seq, '<=', lastSeq);
      return;
    }
    if (!window.__behemironProjectSync || typeof window.__behemironProjectSync.replaceProjectContentInPlace !== 'function') {
      log('applySyncSnapshot: replaceProjectContentInPlace not available yet');
      return;
    }
    var model;
    try {
      model = JSON.parse(payload.snapshotJson);
    } catch (e) {
      log('applySyncSnapshot: JSON parse failed', e);
      return;
    }
    restoringProjects = true;
    try {
      var applied = window.__behemironProjectSync.replaceProjectContentInPlace(model);
      if (applied && typeof payload.seq === 'number') {
        lastAppliedSyncSeqByOrigin[payload.windowInstanceId] = payload.seq;
      }
      log('applySyncSnapshot: applied =', applied, 'from', payload.windowInstanceId, 'seq', payload.seq);
    } catch (e) {
      log('applySyncSnapshot: apply failed', e);
    } finally {
      // 和 restoreProjects() 用一样的 500ms 延迟复位(不再用更短的 200ms):
      // replaceProjectContentInPlace 触发的 Vue/Three.js 副作用有部分是异步
      // 落地的,过早复位可能让某个异步回调误判成"用户新编辑"而广播回声,
      // 形成 A 广播→B 应用→B 误触发→广播回 A→A 应用→... 的环路。
      setTimeout(function () { restoringProjects = false; }, 500);
    }
  }

  // 给刚加载的 Project 强制恢复稳定 uuid。
  // BB Codecs.project.load 不会从 model 拿 uuid,默认给新工程生成新 uuid。
  // 必须 load 完后立即手动 set,确保后续 save 命中同一个 DB 行(upsert)。
  //
  // **关键**:ModelProject 构造时用当时的 uuid 在全局 ProjectData 字典里
  // 创建条目(model_3d: THREE.Object3D / nodes_3d: {}),而 Project 类的
  // model_3d / nodes_3d getter 是 `ProjectData[this.uuid].model_3d` 这种
  // 写法。一旦我们改了 Project.uuid 而不同步迁移 ProjectData 的 key,
  // unselect()/close() 里 `scene.remove(this.model_3d)` 等就会读到
  // undefined 而抛 "Cannot read properties of undefined (reading 'model_3d')"。
  // 这里把旧 key 改名到新 key,完整保留已绑定的 THREE 节点。
  function rebindProjectUuid(stableUuid) {
    if (!stableUuid) return;
    if (window.Project && window.Project.uuid !== stableUuid) {
      var oldUuid = window.Project.uuid;
      window.Project.uuid = stableUuid;
      try {
        if (window.ProjectData && Object.prototype.hasOwnProperty.call(window.ProjectData, oldUuid)) {
          // 旧 key 已存在新 key 可能也存在(罕见,但容错):优先保留旧的实际数据,
          // 因为新 key 极可能是空壳(构造函数路径以外的字段访问会触发懒创建)。
          window.ProjectData[stableUuid] = window.ProjectData[oldUuid];
          delete window.ProjectData[oldUuid];
        }
      } catch (e) {
        log('rebindProjectUuid: ProjectData migrate failed', e);
      }
    }
  }

  function restoreProjects(projects) {
    if (!projects || !projects.length) return;
    if (!window.Codecs || !window.Codecs.project || typeof window.Codecs.project.load !== 'function') {
      log('Codecs.project.load not ready, retry later');
      setTimeout(function () { restoreProjects(projects); }, 200);
      return;
    }
    restoringProjects = true;
    try {
      for (var i = 0; i < projects.length; i++) {
        var p = projects[i];
        if (!p || !p.contentJson) continue;
        try {
          var model = JSON.parse(p.contentJson);
          window.Codecs.project.load(model, { path: '' });
          // 优先用 contentJson 里注入的 behemiron_uuid,回退到 ProjectMeta.uuid
          rebindProjectUuid(model.behemiron_uuid || p.uuid);
        } catch (e) {
          log('restore project failed,uuid=', p.uuid, e);
        }
      }
    } finally {
      setTimeout(function () { restoringProjects = false; }, 500);
    }
  }

  function openSingleProject(project) {
    if (!project || !project.contentJson) return;
    if (!window.Codecs || !window.Codecs.project) return;
    try {
      var model = JSON.parse(project.contentJson);
      window.Codecs.project.load(model, { path: '' });
      rebindProjectUuid(model.behemiron_uuid || project.uuid);
    } catch (e) {
      log('openSingleProject failed', e);
    }
  }

  // ---- 面板真弹出(Phase 1) ----
  // 暴露为全局,让 panels.ts 的 expand_button 在 host 模式下调用,取代原本
  // 同页面内 moveTo('float') 的"假弹出"。
  window.behemironRequestPanelPopout = function (panelId, width, height) {
    if (!panelId) return;
    sendToHost('bb:request-panel-popout', {
      kind: 'panel',
      panelId: panelId,
      projectUuid: (window.Project && window.Project.uuid) || '',
      // 面板各自的浮动尺寸(position_data.float_size),不同面板类型给不同的
      // 弹出窗口尺寸——之前统一硬编码 720x600,大纲树和调色板这种内容差异很大
      // 的面板挤进同一个尺寸不合理。host 端会做兜底范围收敛,这里原样传。
      width: typeof width === 'number' ? Math.round(width) : 0,
      height: typeof height === 'number' ? Math.round(height) : 0,
    });
  };

  // ---- 预览格真弹出(分屏每一格的"弹出为独立窗口",与面板复用同一条
  // Go/React 通路——OpenPanelPopout 早就支持 kind='preview',这里补上 BB
  // 源码侧的调用入口) ----
  // slotIndex 对应 Preview.split_screen.previews 的下标,弹出窗口读取
  // URL 的 slot 参数后走"预览 solo 模式"(见 applyPreviewSoloMode),只显示
  // 一个全屏的 main_preview,不复刻分屏布局。
  window.behemironRequestPreviewPopout = function (slotIndex, width, height) {
    if (typeof slotIndex !== 'number') return;
    sendToHost('bb:request-panel-popout', {
      kind: 'preview',
      panelId: String(slotIndex),
      projectUuid: (window.Project && window.Project.uuid) || '',
      width: typeof width === 'number' ? Math.round(width) : 0,
      height: typeof height === 'number' ? Math.round(height) : 0,
    });
  };

  // 接收 host 推来的"某面板在独立窗口里的开关状态"变化,转给 panels.ts
  // 暴露的 __behemironPanelPopout 去切换占位层(showPopoutPlaceholder /
  // hidePopoutPlaceholder,纯 DOM/CSS,不碰 Panel.moveTo())。
  function applyPanelPopoutState(payload) {
    if (!payload || !payload.panelId) return;
    if (!window.__behemironPanelPopout || typeof window.__behemironPanelPopout.setPoppedOut !== 'function') return;
    window.__behemironPanelPopout.setPoppedOut(payload.panelId, !!payload.popped);
  }

  // ---- 面板 solo 隔离(面板弹出窗口专用) ----
  // URL 形如 /bb/?host=behemiron&panel=outliner —— 直接从自己的 URL 读,不必
  // 等 host 消息往返。用纯 CSS 隐藏其它面板 + 顶部 chrome,刻意不调用
  // Panel.moveTo(hidden)(会 flush 进跨窗口共享的 localStorage
  // panel_customization,见 Wails v3 WebView2 存储分区共享的结论)。
  var soloPanelId = (function () {
    try {
      return new URLSearchParams(window.location.search).get('panel') || '';
    } catch (e) {
      return '';
    }
  })();

  function applyPanelSoloMode(panelId) {
    if (!panelId) return;
    try {
      // 全局标记:preview.js 的 animate() 渲染循环 + uv.js 的 UVEditor GL 场景
      // 都会查这个值,跳过看不见的渲染工作(纯 CSS display:none 只是隐藏 DOM,
      // 不会让这些"面板级"的持续渲染循环停下来——canvas.isConnected 依然是
      // true,实测不隐藏这些循环会导致弹出窗口整体卡顿,哪怕不编辑也一样)。
      window.__BEHEMIRON_SOLO_PANEL_ID__ = panelId;
      // 弹出窗口是全新独立启动的 BB 实例,跟主窗口没有运行时状态共享——如果
      // 这个面板在本实例里构建出来时仍然是"附着"在别的面板上的标签页(没有
      // 自己独立插入 DOM 的容器),CSS 选择器找不到东西可显示。在这一侧也
      // 主动摘一次(panels.ts 暴露的 prepareSoloPanel,用 moveTo('hidden')
      // 让 BB 自己的布局逻辑彻底不再管这个面板,不依赖主窗口那边是否已经
      // 生效/落盘同步及时)。
      if (window.__behemironPanelPopout && typeof window.__behemironPanelPopout.prepareSoloPanel === 'function') {
        window.__behemironPanelPopout.prepareSoloPanel(panelId);
        log('prepareSoloPanel done, project =', window.Project && window.Project.name);
      } else {
        log('prepareSoloPanel NOT AVAILABLE (window.__behemironPanelPopout missing?)');
      }
      // 之前几版都是靠 CSS 精确挑选"隐藏谁、显示谁"(.panel_container 属性
      // 选择器 + z-index 覆盖),反复实测都不可靠——#page_wrapper 内部的层叠
      // 上下文/Vue 动态重排比预期复杂,z-index 打不赢,弹出窗口里出现过显示
      // 错误面板、甚至整个 #page_wrapper 的情况。
      // 改用物理搬运:relocateSoloPanel 把目标面板的真实 DOM 容器整个搬到
      // document.body 的直接子级,脱离 #page_wrapper 这整棵祖先树,这里只需
      // 要把 #page_wrapper(装了 tab_bar/start_screen/work_screen 里所有面板
      // /main_toolbar 的顶层容器)和 header(标题栏/菜单栏)整个隐藏——目标
      // 面板已经不在这两者管辖范围内了,不需要再逐个排除。
      if (window.__behemironPanelPopout && typeof window.__behemironPanelPopout.relocateSoloPanel === 'function') {
        window.__behemironPanelPopout.relocateSoloPanel(panelId);
      } else {
        log('relocateSoloPanel NOT AVAILABLE (window.__behemironPanelPopout missing?)');
      }
      var style = document.createElement('style');
      style.setAttribute('data-behemiron-solo', 'true');
      style.textContent = 'header, #page_wrapper { display: none !important; }';
      document.head.appendChild(style);
      document.body.classList.add('behemiron-panel-solo');
      log('panel solo mode applied for', panelId);
      // 诊断:多个时间点抽查目标容器的实际尺寸/父节点/可见性,方便排查
      // "一闪而过又消失"这类问题——不确定是否已经彻底修好,先把信号打出来。
      [0, 300, 1000, 3000].forEach(function (delay) {
        setTimeout(function () {
          var el = document.querySelector('.panel_container[panel_id="' + panelId + '"]');
          if (!el) {
            log('diag @' + delay + 'ms: container not found in DOM at all for', panelId);
            return;
          }
          var rect = el.getBoundingClientRect();
          var cs = window.getComputedStyle(el);
          log('diag @' + delay + 'ms:', panelId, {
            parent: el.parentElement && (el.parentElement.id || el.parentElement.className),
            width: rect.width,
            height: rect.height,
            display: cs.display,
            visibility: cs.visibility,
          });
        }, delay);
      });
    } catch (e) {
      log('applyPanelSoloMode failed', e);
    }
  }

  // ---- 预览格 solo 隔离(预览弹出窗口专用) ----
  // URL 形如 /bb/?host=behemiron&slot=1 —— 同样直接从自己的 URL 读。
  // 与 applyPanelSoloMode 的关键区别:**不设置** window.__BEHEMIRON_SOLO_PANEL_ID__
  // ——那个标记是让 preview.js 的 animate() 跳过渲染用的,预览弹出窗口的存在
  // 意义就是要渲染 3D 视图,不能跟着一起被跳过。
  //
  // 弹出窗口是一份全新启动的 BB 实例,没有原窗口的分屏状态,这里不复刻
  // 多格分屏布局,只让 main_preview 全屏显示——相当于把"这一格"单拎出来看,
  // 相机角度从该窗口默认视角开始(不携带原格子的 camera_preset,是本次实现
  // 的已知简化,如果需要还原成同一个视角,后续可以把 preset 编到 URL 里再读)。
  var soloPreviewSlot = (function () {
    try {
      var v = new URLSearchParams(window.location.search).get('slot');
      return v === null ? null : parseInt(v, 10);
    } catch (e) {
      return null;
    }
  })();

  function applyPreviewSoloMode() {
    try {
      // 跟 applyPanelSoloMode 同一套思路(见那边注释详细说明失败史):不用
      // CSS 精确挑选隐藏/显示,而是把 #center(装 #preview 主 3D 视口的结构
      // 元素,不是 .panel_container,直接按 DOM id 取)物理搬到 body 直接
      // 子级,脱离 #page_wrapper,然后把 #page_wrapper 和 header 整个隐藏。
      var center = document.getElementById('center');
      if (center) {
        document.body.appendChild(center);
        center.style.cssText = 'position: fixed; inset: 0; width: 100vw; height: 100vh;';
      }
      var style = document.createElement('style');
      style.setAttribute('data-behemiron-solo', 'true');
      style.textContent = 'header, #page_wrapper { display: none !important; }';
      document.head.appendChild(style);
      document.body.classList.add('behemiron-preview-solo');
      log('preview solo mode applied');
    } catch (e) {
      log('applyPreviewSoloMode failed', e);
    }
  }

  // ---- 接管保存(Ctrl+S 与 Save 按钮共享此入口) ----
  // 暴露为全局,让 BB 源(bbmodel.js save_project click)能直接调用。
  //
  // **未命名工程拒绝保存**:防止 noname 项堆积历史。
  // 让用户先在 BB 的"工程信息"对话框里命名再保存。
  function behemironSave() {
    var dto = compileCurrentProject();
    if (!dto || !dto.uuid) {
      var isUnnamed = window.Project && (!window.Project.name ||
                                          window.Project.name.trim() === '' ||
                                          window.Project.name.trim() === 'noname');
      if (isUnnamed && window.Blockbench && typeof window.Blockbench.showQuickMessage === 'function') {
        window.Blockbench.showQuickMessage(
          window.tl ? window.tl('message.behemiron_name_required') || 'Name the project before saving' : 'Name the project before saving',
          2200
        );
      }
      log('behemironSave: skipped (no project or unnamed)');
      return;
    }
    log('behemironSave: requesting persist for', dto.name || dto.uuid);
    sendToHost('bb:save-request', { project: dto });
  }
  window.behemironSave = behemironSave;

  function setupCtrlSInterceptor() {
    // 在 capture 阶段拦截,防止 webview 触发"保存网页"下载。
    // 注意:BB 自己的 save_project action keybind 是 Ctrl+Alt+S,我们这里把
    // 单纯 Ctrl+S 也接管;两者效果一致。
    window.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey || e.altKey) return; // 让 Ctrl+Shift+S / Ctrl+Alt+S 走 BB 自己
      if (e.key !== 's' && e.key !== 'S') return;
      e.preventDefault();
      e.stopPropagation();
      behemironSave();
    }, true);
    log('Ctrl+S interceptor installed');
  }

  // ---- 历史列表 ----
  // BB start_screen 的 Vue 实例(StartScreen.vue)有个 `recent` 数组,
  // 我们把 host 推过来的 BlockbenchProjectMeta[] 转成 Vue 期待的形态填进去。
  // BB getDate 期望 p.day 是 day-of-year(1-365),
  // 不是 epoch 天数。这里用同样的算法转换 ts → dayOfYear,与 BB util.js 的
  // Date.prototype.dayOfYear 行为一致(从当年 1 月 1 日起算)。
  function tsToDayOfYear(ts) {
    if (!ts) return 0;
    var d = new Date(ts);
    var start = new Date(d.getFullYear(), 0, 0); // 1月0日 = 上年最后一天
    var oneDay = 86400000;
    return Math.floor((d - start) / oneDay);
  }

  function metaToRecentItem(meta) {
    // BB Vue 模板用:project.path(:key & title) / .name / .icon /
    // .day(用于 getDate,day-of-year) / .favorite / .uuid(我们附加,用于回点 open)
    // path 走 'behemiron:<uuid>' 合成,避免空 :key 警告。
    var fmt = (window.Formats && window.Formats[meta.formatId]) || null;
    var icon = (fmt && fmt.icon) || 'fa-cubes';
    var ts = meta.lastSavedAt || meta.lastOpenedAt || 0;
    return {
      path: 'behemiron:' + meta.uuid,
      uuid: meta.uuid,
      name: meta.name || '(untitled)',
      icon: icon,
      day: tsToDayOfYear(ts),
      favorite: false,
      behemironHistoryItem: true,
    };
  }

  function applyHistory(history) {
    var items = (history || []).map(metaToRecentItem);
    if (window.StartScreen && window.StartScreen.vue) {
      window.StartScreen.vue.recent = items;
      window.StartScreen.vue.$forceUpdate();
      log('history applied to start_screen,count=', items.length);
    } else {
      // Vue 还未挂载,暂存待会儿补
      pendingHistory = items;
      log('history pending,Vue not ready,count=', items.length);
    }
  }

  function flushPendingHistoryWhenReady() {
    if (!pendingHistory) return;
    var t = setInterval(function () {
      if (window.StartScreen && window.StartScreen.vue) {
        clearInterval(t);
        window.StartScreen.vue.recent = pendingHistory;
        window.StartScreen.vue.$forceUpdate();
        log('pending history applied,count=', pendingHistory.length);
        pendingHistory = null;
      }
    }, 100);
  }

  // ---- 4. 事件转发 ----
  function attachBlockbenchListeners() {
    if (!window.Blockbench || typeof window.Blockbench.addListener !== 'function') {
      // 不同 BB 版本可能用 addEventListener
      if (typeof window.Blockbench.addEventListener === 'function') {
        window.Blockbench.addListener = window.Blockbench.addEventListener.bind(window.Blockbench);
      } else {
        log('Blockbench listener API missing');
        return;
      }
    }
    var bb = window.Blockbench;

    bb.addListener('finish_edit', function () {
      if (restoringProjects) return;
      if (finishEditTimer) clearTimeout(finishEditTimer);
      finishEditTimer = setTimeout(function () {
        finishEditTimer = null;
        var dto = compileCurrentProject();
        if (dto) sendToHost('bb:project-saved', { project: dto });
      }, FINISH_EDIT_DEBOUNCE_MS);

      // 跨窗口实时同步:独立于上面的 SQLite 自动保存 debounce,间隔更短。
      scheduleSyncBroadcast();
    });

    // 单纯的选中态变化(点大纲树节点/3D 视口点选)不会触发 finish_edit——
    // finish_edit 只在 Undo.finishEdit() 时派发,选择不算"编辑"、不进撤销
    // 历史。之前只挂 finish_edit 导致"弹出的 Outliner 里点选没反应":选中
    // 变化压根没广播出去。update_selection 是 misc.js 的 updateSelection()
    // 末尾统一派发的全局事件,覆盖所有选中来源(大纲树/3D视口/UV编辑器等)。
    bb.addListener('update_selection', function () {
      if (restoringProjects) return;
      scheduleSelectionBroadcast();
    });

    bb.addListener('select_project', function (data) {
      // 补上其它监听器都有的 restoringProjects 守卫:applySyncSnapshot() 在
      // 多工程场景下可能调用 target.select()(目标不是当前激活工程时),这个
      // select() 会派发 select_project——若不守卫,会绕过"应用同步期间不落库"
      // 的约束,无条件触发一次真实 SQLite 写入,违反"同一工程同一时刻只有一个
      // 窗口写库"的设计。
      if (restoringProjects) return;
      var proj = data && data.project ? data.project : window.Project;
      var uuid = proj && proj.uuid ? proj.uuid : '';
      sendToHost('bb:project-switched', { uuid: uuid });
      // 立即把新激活的工程也 upsert(更新 lastOpenedAt)
      var dto = compileCurrentProject();
      if (dto) sendToHost('bb:project-saved', { project: dto });
    });

    bb.addListener('close_project', function (data) {
      if (data && data.on_quit) return; // 整体退出由 host 端兜底
      var proj = data && data.project ? data.project : window.Project;
      var uuid = proj && proj.uuid ? proj.uuid : '';
      if (uuid) sendToHost('bb:project-closed', { uuid: uuid });
    });

    bb.addListener('load_project', function () {
      if (restoringProjects) return;
      var dto = compileCurrentProject();
      if (dto) sendToHost('bb:project-saved', { project: dto });
    });

    bb.addListener('new_project', function () {
      if (restoringProjects) return;
      var dto = compileCurrentProject();
      if (dto) sendToHost('bb:project-saved', { project: dto });
    });

    log('Blockbench listeners attached');
  }

  // ---- 5. 接收 host 消息 ----
  function attachMessageListener() {
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.source !== 'behemiron-host') return;
      log('recv from host:', data.type, data.payload);

      switch (data.type) {
        case 'host:theme':
          applyHostTheme(data.payload && data.payload.mode);
          break;
        case 'host:reload':
          // 用于 Behemiron 改了 settings/embeddedTools 的语言之后,
          // 让 BB iframe 整体 reload,AssetService 会把新 settings 注入回来。
          applyHostReload();
          break;
        case 'host:projects-restore':
          restoreProjects(data.payload && data.payload.projects);
          break;
        case 'host:project-open':
          openSingleProject(data.payload && data.payload.project);
          // 面板/预览弹出窗口专属:工程真正加载完成后才应用 solo 模式——
          // 提前到 bb:ready 时应用会因为工程还没加载、面板内容压根没渲染出
          // 东西而导致弹出窗口一片空白(实测踩过)。整编辑器弹出/主窗口没有
          // soloPanelId/soloPreviewSlot,这两个分支不会命中,不影响它们。
          if (soloPanelId) {
            applyPanelSoloMode(soloPanelId);
            sendToHost('bb:panel-solo-ready', {});
          } else if (soloPreviewSlot !== null) {
            applyPreviewSoloMode();
            sendToHost('bb:panel-solo-ready', {});
          }
          break;
        case 'host:flush-current': {
          var dto = compileCurrentProject();
          sendToHost('bb:flush-response', {
            requestId: (data.payload && data.payload.requestId) || '',
            project: dto,
          });
          break;
        }
        case 'host:set-history':
          applyHistory(data.payload && data.payload.history);
          break;
        case 'host:sync-apply':
          applySyncSnapshot(data.payload);
          break;
        case 'host:selection-apply':
          applySelectionSnapshot(data.payload);
          break;
        case 'host:panel-popout-state':
          applyPanelPopoutState(data.payload);
          break;
        case 'host:save-ack': {
          var ok = data.payload && data.payload.ok;
          var uuid = data.payload && data.payload.uuid;
          if (ok && window.Project && window.Project.uuid === uuid) {
            window.Project.saved = true;
            if (window.Blockbench && typeof window.Blockbench.showQuickMessage === 'function') {
              window.Blockbench.showQuickMessage('Saved to Behemiron', 1500);
            }
          }
          break;
        }
        default:
          break;
      }
    });
  }

  // ---- 6. 监控 BB setup_successful,发送 ready ----
  function waitForBlockbenchSetup() {
    var attempts = 0;
    var t = setInterval(function () {
      attempts++;
      if (window.Blockbench && window.Blockbench.setup_successful) {
        clearInterval(t);
        attachBlockbenchListeners();
        setupCtrlSInterceptor();
        // 注意:不在这里应用 solo 模式。这时候工程还没加载(usePanelPopout.ts
        // 要等 bb:ready 之后才会拉工程数据、发 host:project-open),面板的
        // 内容普遍依赖"当前工程/模式"才会渲染出东西(比如颜色/调色板面板挂着
        // condition:{modes:['paint']})——这时候把一个内容还没渲染出来的空
        // 容器搬去 body,弹出窗口只会是一片空白(实测踩过这个坑)。solo 模式
        // 挪到下面 host:project-open 处理完之后再应用。
        sendToHost('bb:ready', {
          version: (window.Blockbench && window.Blockbench.version) || '',
        });
        // 立即请求历史列表
        sendToHost('bb:request-history', {});
        flushPendingHistoryWhenReady();
        log('BB ready,bridge online');
      } else if (attempts > 600) {
        // 30s 还没 setup,放弃但仍可接收 host 消息(主题/语言)
        clearInterval(t);
        log('BB setup_successful timeout,bridge in degraded mode');
      }
    }, 50);
  }

  // ---- 启动序列 ----
  function boot() {
    // 诊断:启动时立即读 localStorage.settings,确认 BB 即将以什么语言 boot
    try {
      var rawSettings = window.localStorage.getItem('settings');
      var parsedLang = '(no settings key)';
      if (rawSettings) {
        var s = JSON.parse(rawSettings);
        parsedLang = (s && s.language && s.language.value) || '(no language.value)';
      }
      log('boot: localStorage.settings.language.value =', parsedLang,
          ' | navigator.language =', navigator.language);
    } catch (e) {
      log('boot: failed to read settings', e);
    }

    attachMessageListener();
    whenBlockbenchReady(function () {
      // BB 全局就绪后,立即 log 它实际选定的 Language.code
      try {
        log('Blockbench global ready: Language.code =',
            (window.Language && window.Language.code) || '(unset)');
      } catch (e) { /* noop */ }
      waitForBlockbenchSetup();
    });
    log('host script booted');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
