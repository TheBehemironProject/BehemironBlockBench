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

  // ---- 状态 ----
  var finishEditTimer = null;
  var restoringProjects = false; // 避免恢复时回写
  var pendingHistory = null; // 收到 host:set-history 时若 Vue 未就绪暂存,稍后填入

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

  // ---- 2. 语言应用(需 reload)----
  function applyHostLanguage(code) {
    // 中文 → 'zh',其他一律 'en'
    var bbCode = code && code.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
    log('applyHostLanguage incoming:', code, '→ bbCode:', bbCode);
    try {
      var raw = window.localStorage.getItem('settings');
      var settings = raw ? JSON.parse(raw) : {};
      if (!settings.language) settings.language = {};
      log('current settings.language.value:', settings.language.value, ' want:', bbCode);
      if (settings.language.value === bbCode) {
        log('language already at target,skipping reload');
        return;
      }
      settings.language.value = bbCode;
      window.localStorage.setItem('settings', JSON.stringify(settings));
      log('language set in localStorage, triggering reload to:', bbCode);
      window.location.reload();
    } catch (e) {
      log('applyHostLanguage failed', e);
    }
  }

  // ---- 3. 项目序列化 / 加载 ----
  function compileCurrentProject() {
    try {
      if (!window.Project || !window.Codecs || !window.Codecs.project) return null;
      var json = window.Codecs.project.compile({ raw: true });
      var content = typeof json === 'string' ? json : JSON.stringify(json);
      return {
        uuid: window.Project.uuid || '',
        name: window.Project.name || '',
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
        } catch (e) {
          log('restore project failed,uuid=', p.uuid, e);
        }
      }
    } finally {
      // 给 BB 一拍消化 select_project 事件,再放开回写
      setTimeout(function () { restoringProjects = false; }, 500);
    }
  }

  function openSingleProject(project) {
    if (!project || !project.contentJson) return;
    if (!window.Codecs || !window.Codecs.project) return;
    try {
      var model = JSON.parse(project.contentJson);
      window.Codecs.project.load(model, { path: '' });
    } catch (e) {
      log('openSingleProject failed', e);
    }
  }

  // ---- 接管保存(Ctrl+S 与 Save 按钮共享此入口) ----
  // 暴露为全局,让 BB 源(bbmodel.js save_project click)能直接调用。
  function behemironSave() {
    var dto = compileCurrentProject();
    if (!dto || !dto.uuid) {
      log('behemironSave: no project');
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
  function metaToRecentItem(meta) {
    // BB Vue 模板用:project.path(:key & title) / .name / .icon /
    // .day(用于 getDate) / .favorite / .uuid(我们附加,用于回点 open)
    // path 走 'behemiron:<uuid>' 合成,避免空 :key 警告。
    var fmt = (window.Formats && window.Formats[meta.formatId]) || null;
    var icon = (fmt && fmt.icon) || 'fa-cubes';
    var ts = meta.lastSavedAt || meta.lastOpenedAt || 0;
    var day = ts ? Math.floor(ts / 86400000) : 0;
    return {
      path: 'behemiron:' + meta.uuid,
      uuid: meta.uuid,
      name: meta.name || '(untitled)',
      icon: icon,
      day: day,
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
    });

    bb.addListener('select_project', function (data) {
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
        case 'host:language':
          applyHostLanguage(data.payload && data.payload.code);
          break;
        case 'host:projects-restore':
          restoreProjects(data.payload && data.payload.projects);
          break;
        case 'host:project-open':
          openSingleProject(data.payload && data.payload.project);
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
    attachMessageListener();
    whenBlockbenchReady(function () {
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
