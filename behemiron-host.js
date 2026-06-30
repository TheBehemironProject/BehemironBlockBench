/**
 * behemiron-host.js
 *
 * BlockBench fork 与 Behemiron Workerbench 主项目的桥接脚本。
 * 仅在嵌入态生效（iframe 或带 ?host=behemiron 查询的弹出窗口）。
 *
 * 职责：
 *   1. 注入 CSS：隐藏 Download App 按钮、Discord/Bluesky/PSA/new_version banner
 *   2. 覆盖 document.title 为 "BlockBench - Behemiron"
 *   3. 拦截 addStartScreenSection：屏蔽黑名单 section id
 *   4. 双向桥接（postMessage）：
 *      - 接收 host:theme / host:language / host:projects-restore / host:project-open / host:flush-current
 *      - 发送 bb:ready / bb:project-saved / bb:project-switched / bb:project-closed / bb:flush-response
 *   5. Hook Blockbench 事件：finish_edit（防抖 1s）/ select_project / close_project / load_project
 *
 * 实现铁律：
 *   - 不直接编辑 BB 其他文件，所有改动通过 monkey patch / 事件订阅
 *   - 防御性编程：BB 全局可能未就绪，每次访问都判空
 *   - 单向数据流：host 命令优先级高于 BB 内部状态（如主题/语言来自 Behemiron）
 */
(function () {
  'use strict';

  // ---- 环境检测 ----
  var isHosted =
    window !== window.top ||
    new URLSearchParams(window.location.search).get('host') === 'behemiron';
  if (!isHosted) return;

  // ---- 配置 ----
  var HOST_TITLE = 'BlockBench - Behemiron';
  var BLOCKED_SECTIONS = ['discord_link', 'bluesky_link', 'psa', 'new_version'];
  var FINISH_EDIT_DEBOUNCE_MS = 1000;

  // ---- 状态 ----
  var bridgeReady = false;
  var finishEditTimer = null;
  var flushRequestPending = null; // { requestId, resolve }
  var restoringProjects = false; // 避免恢复时回写

  // ---- 工具 ----
  function log() {
    // eslint-disable-next-line no-console
    if (typeof console !== 'undefined') {
      console.debug.apply(console, ['[behemiron-host]'].concat([].slice.call(arguments)));
    }
  }

  function sendToHost(type, payload) {
    try {
      window.parent.postMessage({ source: 'behemiron-bb', type: type, payload: payload }, '*');
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

  // ---- 1. CSS 注入（早期生效）----
  function injectHostCSS() {
    var css =
      '#web_download_button { display: none !important; }\n' +
      '/* 起始页 banner / 社交入口（按 id 与 data-section-id 双重选中） */\n' +
      '#start_screen > #discord_link,\n' +
      '#start_screen > #bluesky_link,\n' +
      '#start_screen > #psa,\n' +
      '#start_screen > #new_version,\n' +
      '#start_screen [data-section-id="discord_link"],\n' +
      '#start_screen [data-section-id="bluesky_link"],\n' +
      '#start_screen [data-section-id="psa"],\n' +
      '#start_screen [data-section-id="new_version"] { display: none !important; }\n';
    var style = document.createElement('style');
    style.id = 'behemiron-host-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- 2. 标题覆盖 ----
  function pinTitle() {
    try {
      document.title = HOST_TITLE;
      // 防止 BB 后续动态改回，监听 title 元素变化
      var titleEl = document.querySelector('head > title');
      if (titleEl && typeof MutationObserver === 'function') {
        var mo = new MutationObserver(function () {
          if (document.title !== HOST_TITLE) document.title = HOST_TITLE;
        });
        mo.observe(titleEl, { childList: true, characterData: true, subtree: true });
      }
    } catch (e) {
      log('pinTitle failed', e);
    }
  }

  // ---- 3. addStartScreenSection 拦截 ----
  function patchAddStartScreenSection() {
    // 这个全局函数在 boot 后才存在。轮询挂钩。
    var attempts = 0;
    var t = setInterval(function () {
      attempts++;
      if (typeof window.addStartScreenSection === 'function') {
        clearInterval(t);
        var orig = window.addStartScreenSection;
        window.addStartScreenSection = function (id, data) {
          if (BLOCKED_SECTIONS.indexOf(id) !== -1) {
            log('blocked section:', id);
            return null;
          }
          return orig.call(this, id, data);
        };
        log('addStartScreenSection patched');
      } else if (attempts > 200) {
        // 10s 还没出现就放弃
        clearInterval(t);
        log('addStartScreenSection never appeared');
      }
    }, 50);
  }

  // ---- 4. 主题应用 ----
  function applyHostTheme(mode) {
    if (mode !== 'light' && mode !== 'dark') return;
    try {
      var themes =
        (window.CustomTheme && window.CustomTheme.themes) ||
        (window.Blockbench && window.Blockbench.themes) ||
        [];
      var target = null;
      for (var i = 0; i < themes.length; i++) {
        if (themes[i] && themes[i].id === mode) {
          target = themes[i];
          break;
        }
      }
      if (target && window.CustomTheme && typeof window.CustomTheme.loadTheme === 'function') {
        window.CustomTheme.loadTheme(target);
        log('theme applied:', mode);
      } else {
        log('theme not found in BB:', mode);
      }
    } catch (e) {
      log('applyHostTheme failed', e);
    }
  }

  // ---- 5. 语言应用（需 reload）----
  function applyHostLanguage(code) {
    // 中文 → 'zh',其他一律 'en'
    var bbCode = code && code.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
    try {
      var raw = window.localStorage.getItem('settings');
      var settings = raw ? JSON.parse(raw) : {};
      if (!settings.language) settings.language = {};
      if (settings.language.value === bbCode) return; // 已是目标
      settings.language.value = bbCode;
      window.localStorage.setItem('settings', JSON.stringify(settings));
      log('language set,reloading to:', bbCode);
      window.location.reload();
    } catch (e) {
      log('applyHostLanguage failed', e);
    }
  }

  // ---- 6. 项目序列化 / 加载 ----
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

  function compileSpecificProject(proj) {
    if (!proj || !window.Codecs || !window.Codecs.project) return null;
    // BB 的 Codecs.project.compile 默认序列化"当前激活"的 Project,
    // 切换标签的真正持久化由 host:flush-current 在 select_project 之前完成即可。
    if (window.Project === proj) {
      return compileCurrentProject();
    }
    return null;
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

  // ---- 7. 事件转发 ----
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
      // 切换前的项目其实已经由 finish_edit 持续兜底,这里额外发一次事件让 host 端可同步 UI
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
      // 新工程加载后做一次完整持久化(用户从文件菜单导入的场景)
      var dto = compileCurrentProject();
      if (dto) sendToHost('bb:project-saved', { project: dto });
    });

    bb.addListener('new_project', function () {
      if (restoringProjects) return;
      // 新建工程立即占位一行,以便 host 端列表能反映
      var dto = compileCurrentProject();
      if (dto) sendToHost('bb:project-saved', { project: dto });
    });

    log('Blockbench listeners attached');
  }

  // ---- 8. 接收 host 消息 ----
  function attachMessageListener() {
    window.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.source !== 'behemiron-host') return;

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
        default:
          // 未知 type,忽略
          break;
      }
    });
  }

  // ---- 9. 监控 BB setup_successful,发送 ready ----
  function waitForBlockbenchSetup() {
    var attempts = 0;
    var t = setInterval(function () {
      attempts++;
      if (window.Blockbench && window.Blockbench.setup_successful) {
        clearInterval(t);
        attachBlockbenchListeners();
        bridgeReady = true;
        sendToHost('bb:ready', {
          version: (window.Blockbench && window.Blockbench.version) || '',
        });
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
    injectHostCSS();
    pinTitle();
    patchAddStartScreenSection();
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
