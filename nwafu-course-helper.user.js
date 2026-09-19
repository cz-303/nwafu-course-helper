// ==UserScript==
// @name         NWAFU 研究生选课助手
// @namespace    local.nwafu.course-helper
// @version      2.0.0
// @description  监测指定课程容量，支持整页刷新、登录失效暂停与单次选课尝试。
// @match        https://newxsxk.nwafu.edu.cn/*
// @run-at       document-idle
// @noframes
// @grant        none
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const DEFAULT_CODES = ['6091014', '7263001', '7264010', '7264016'];
  const KEY = 'nwafu-course-helper:v2';
  const COURSE_PATH = '/yjsxkapp/sys/xsxkapp/course.html';
  const MAX_RUN_MS = 2 * 60 * 60 * 1000;
  const LOAD_TIMEOUT_MS = 20000;
  const isCoursePage = location.pathname === COURSE_PATH;
  // 整页刷新之间保留同一标签页的配置；不保存账号、密码、Cookie。
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
  } catch {
    saved = null;
  }
  let running = false;
  let busy = false;
  let pollTimer;
  let refreshTimer;
  let runUntil = 0;
  let config;
  const panel = document.createElement('section');
  panel.id = 'nwafu-course-helper';
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:white;color:#222;padding:16px;border:1px solid #aac6ef;border-radius:10px;box-shadow:0 4px 20px #0003;font:14px/1.6 sans-serif;width:300px;max-width:85vw';
  panel.innerHTML = `
    <strong>NWAFU 选课助手 v2</strong>
    <label style="display:block">课程号（按优先级，用空格分隔）
      <input data-codes style="box-sizing:border-box;width:100%" aria-label="课程号">
    </label>
    <label style="display:block">刷新间隔（秒，至少 60）
      <input data-interval type="number" min="60" value="60" style="width:70px">
    </label>
    <label style="display:block"><input data-click type="checkbox" checked>有余量时自动点击“选课”</label>
    <div style="margin:8px 0"><button data-start>开始监测</button> <button data-stop disabled>停止</button></div>
    <div data-status role="status" aria-live="polite"></div>
    <small>尝试一门后暂停，请核对结果再继续。</small>`;
  document.body.append(panel);
  const codesInput = panel.querySelector('[data-codes]');
  const intervalInput = panel.querySelector('[data-interval]');
  const clickInput = panel.querySelector('[data-click]');
  const startButton = panel.querySelector('[data-start]');
  const stopButton = panel.querySelector('[data-stop]');
  const statusNode = panel.querySelector('[data-status]');
  codesInput.value = Array.isArray(saved?.codes) ? saved.codes.join(' ') : DEFAULT_CODES.join(' ');
  intervalInput.value = Number.isFinite(saved?.seconds) ? Math.max(60, saved.seconds) : 60;
  clickInput.checked = saved?.autoClick !== false;

  function status(message) {
    statusNode.textContent = message;
  }

  function controls(active) {
    startButton.disabled = active || !isCoursePage;
    stopButton.disabled = !active;
    codesInput.disabled = intervalInput.disabled = clickInput.disabled = active;
  }

  function stop(message) {
    running = false;
    clearInterval(pollTimer);
    clearTimeout(refreshTimer);
    try { sessionStorage.removeItem(KEY); } catch { /* 状态提示仍然可用 */ }
    controls(false);
    status(message);
  }

  function loginLost() {
    // 排除助手自身的提示，避免文本匹配反过来触发自己。
    const clone = document.body.cloneNode(true);
    clone.querySelector('#nwafu-course-helper')?.remove();
    return /未登录不能选课|请重新登录|登录已失效|登录超时|会话已过期/.test(clone.textContent || '')
      || [...document.querySelectorAll('input[type="password"]')].some(visible);
  }

  function visible(el) {
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function tableRows() {
    const found = [];
    for (const table of document.querySelectorAll('table')) {
      if (!visible(table)) continue;
      const header = [...table.rows].find(row => [...row.cells].some(cell => cell.textContent.trim() === '容量'));
      if (!header) continue;
      const headers = [...header.cells].map(cell => cell.textContent.trim());
      const courseIndex = headers.indexOf('课程');
      const capacityIndex = headers.indexOf('容量');
      const operationIndex = headers.indexOf('操作');
      if (courseIndex < 0 || operationIndex < 0) continue;
      for (const row of table.rows) {
        if (row === header || !visible(row)) continue;
        const cells = [...row.cells];
        const match = cells[courseIndex]?.textContent.trim().match(/^(\d{6,}[A-Z]?)(?=[\s\-－—]|$)/i);
        if (!match) continue;
        found.push({
          code: match[1].toUpperCase(),
          capacity: cells[capacityIndex]?.textContent.trim() || '',
          operation: cells[operationIndex],
          row,
        });
      }
    }
    return found;
  }

  function hasSeat(text) {
    const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
    // 按“已选人数 / 总容量”解释。未知格式不会触发选课。
    return !!match && Number(match[2]) > 0 && Number(match[1]) < Number(match[2]);
  }

  function inspect() {
    if (!running || busy) return false;
    if (loginLost()) {
      stop('登录失效，已停止刷新。请返回首页输入验证码登录，然后重新开始。');
      document.title = '【需要登录】选课助手';
      return false;
    }
    if (Date.now() >= runUntil) {
      stop('本轮已达到 2 小时，已暂停。确认登录状态后可重新开始。');
      return false;
    }
    const rows = tableRows();
    if (!rows.length) return false;
    const missing = config.codes.filter(code => !rows.some(row => row.code === code));
    for (const code of config.codes) {
      const matches = rows.filter(row => row.code === code);
      if (matches.length > 1) {
        stop(`${code} 匹配到多个教学班，请先用页面筛选条件限定教学班。`);
        return false;
      }
      const item = matches[0];
      if (!item || !hasSeat(item.capacity)) continue;
      busy = true;
      // 在点击前撤销自动恢复，防止跳转、异常或刷新造成重复提交。
      stop(`发现 ${code} 有余量（${item.capacity}）。监测已暂停。`);
      document.title = `【有余量】${code}`;
      item.row.style.outline = '3px solid #159957';
      if (!config.autoClick) return true;
      const buttons = [...(item.operation?.querySelectorAll('button,a,input[type="button"],input[type="submit"]') || [])]
        .filter(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
          && (el.textContent || el.value || '').trim() === '选课');
      if (buttons.length !== 1) {
        status(`${code} 有余量，但选课按钮无法唯一识别，请手动操作。`);
        return true;
      }
      status(`已尝试点击 ${code} 的“选课”。请处理确认弹窗，并到“已选课程”核对结果。`);
      buttons[0].click();
      return true;
    }
    const unknown = rows.filter(row => config.codes.includes(row.code)
      && row.capacity !== '已满' && !/^\d+\s*\/\s*\d+$/.test(row.capacity));
    if (unknown.length) {
      stop(`容量格式无法识别：${unknown.map(row => row.code).join('、')}，请人工检查。`);
      return false;
    }
    status(missing.length
      ? `当前页未找到：${missing.join('、')}。只监测本页，其余课程需调整筛选或页码。`
      : `目标课暂无余量。每 ${config.seconds} 秒刷新；检查时间 ${new Date().toLocaleTimeString()}。`);
    return true;
  }

  function start(resume = false) {
    if (running || !isCoursePage) return;
    const codes = [...new Set(codesInput.value.toUpperCase().split(/[\s,，;；]+/).filter(Boolean))];
    const seconds = Number(intervalInput.value);
    if (!codes.length || codes.some(code => !/^\d{6,}[A-Z]?$/.test(code))) {
      status('请填写有效课程号，以空格或逗号分隔。');
      return;
    }
    if (!Number.isFinite(seconds) || seconds < 60 || seconds > 3600) {
      status('刷新间隔应在 60 到 3600 秒之间。');
      return;
    }
    runUntil = resume ? saved.until : Date.now() + MAX_RUN_MS;
    config = { codes, seconds, autoClick: clickInput.checked, until: runUntil, active: true };
    try { sessionStorage.setItem(KEY, JSON.stringify(config)); } catch {
      status('浏览器禁止会话存储，无法可靠恢复监测，请检查网站存储设置。');
      return;
    }
    busy = false;
    running = true;
    controls(true);
    status('正在等待课程表加载…');
    const started = Date.now();
    let loaded = false;
    const tick = () => {
      try {
        loaded = inspect() || loaded;
        if (!running) return;
        if (!loaded && Date.now() - started >= LOAD_TIMEOUT_MS) {
          stop('20 秒内未识别到课程表，已暂停。请检查页面、登录状态及筛选条件。');
        }
      } catch {
        stop('读取页面时发生异常，已暂停。请检查页面后再试。');
      }
    };
    pollTimer = setInterval(tick, 1000); // 仅读取 DOM，不发送网络请求。
    refreshTimer = setTimeout(() => {
      tick();
      if (running && loaded && !busy) location.reload();
    }, seconds * 1000);
    tick();
  }

  startButton.addEventListener('click', () => start());
  stopButton.addEventListener('click', () => stop('已停止。'));
  // 迁移时取消旧版本保存的自动恢复状态；还需在扩展中禁用旧脚本。
  try { sessionStorage.removeItem('nwafu-course-monitor-running'); } catch { /* 忽略 */ }
  controls(false);
  if (!isCoursePage || loginLost()) {
    stop('请手动登录并打开课程列表页，再开始监测。');
  } else if (saved?.active && Number.isFinite(saved.until) && saved.until > Date.now()) {
    start(true);
  } else {
    stop('就绪。确认目标教学班和容量含义后，点击“开始监测”。');
  }
})();
