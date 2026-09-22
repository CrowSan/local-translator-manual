// extension/background.js
const SERVER = 'http://localhost:3000';
const POLL_INTERVAL_MINUTES = 0.15;

const AI_TAB_URLS = {
  gemini: 'https://gemini.google.com/app',
  chatgpt: 'https://chatgpt.com/'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

let state = {
  running: false,
  preferred: 'gemini',
  tabId: null,
  lastReloadAt: 0,
  lastChatKey: null,
  stats: { processed: 0, failed: 0, startedAt: null }
};

let busy = false;
let currentExecution = null;

(async () => {
  const saved = await chrome.storage.local.get('novelbot_state');
  if (saved.novelbot_state) state = { ...state, ...saved.novelbot_state };
})();

async function saveState() {
  await chrome.storage.local.set({ novelbot_state: state });
}

async function log(level, message, meta = {}) {
  const line = `[novelbot:bg:${level}] ${message}`;
  if (level === 'error') console.error(line, meta);
  else console.log(line, meta);

  try {
    await fetch(SERVER + '/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'background', level, message, meta })
    });
  } catch (e) { /* server offline */ }
}

function sendMessageToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, resp => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

chrome.alarms.create('poll', { periodInMinutes: POLL_INTERVAL_MINUTES });

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'poll' && state.running && !busy) {
    await pollAndExecute();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'LOG') {
    forwardLog(msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'RESULT') {
    (async () => {
      const payload = msg.payload || {};

      if (currentExecution && currentExecution.jobId === payload.id) {
        clearTimeout(currentExecution.timeout);
        currentExecution = null;
      }

      busy = false;

      const out = await handleResult(payload);

      await log(
        payload.success ? 'info' : 'error',
        'job result received',
        {
          id: payload.id,
          type: payload.type,
          book: payload.book,
          chapter: payload.chapter,
          success: payload.success,
          error: payload.error
        }
      );

      sendResponse(out);
    })();
    return true;
  }

  if (msg.type === 'GET_STATE') {
    sendResponse({ ...state, busy, currentJob: currentExecution ? currentExecution.jobId : null });
    return false;
  }

  if (msg.type === 'SET_PREF') {
    state.preferred = msg.preferred;
    saveState();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'START') {
    startBot().then(() => sendResponse(state));
    return true;
  }

  if (msg.type === 'STOP') {
    stopBot().then(() => sendResponse(state));
    return true;
  }

  return false;
});

async function forwardLog(msg) {
  try {
    await fetch(SERVER + '/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: msg.source || 'extension',
        level: msg.level || 'info',
        message: msg.message || '',
        meta: msg.meta || {}
      })
    });
  } catch (e) { /* ignore */ }
  return { ok: true };
}

async function startBot() {
  state.running = true;
  state.stats.startedAt = Date.now();
  await saveState();
  await log('info', 'bot started', { preferred: state.preferred });
  await pollAndExecute();
}

async function stopBot() {
  state.running = false;
  await saveState();
  await log('info', 'bot stopped');
}

async function pollAndExecute() {
  if (!state.running || busy) return;

  busy = true;

  try {
    const r = await fetch(SERVER + '/api/robot/jobs?limit=1');
    if (!r.ok) return;

    const data = await r.json();
    if (!data.jobs || !data.jobs.length) return;

    const meta = data.jobs[0];

    const c = await fetch(SERVER + '/api/robot/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: meta.id })
    });

    const cd = await c.json().catch(() => ({}));
    if (!c.ok || !cd.job) {
      await log('warn', 'claim failed', { id: meta.id, error: cd.error || c.status });
      return;
    }

    const job = cd.job;
    await log('info', `claimed ${job.type}`, {
      id: job.id,
      book: job.book,
      chapter: job.chapter,
      inputChars: (job.input || '').length
    });

    const tab = await ensureAiTab(state.preferred);
    if (!tab) {
      await failJob(job.id, 'no AI tab available');
      return;
    }

    // Fresh chat per chapter: steps of the SAME chapter share one chat
    // (needed context), but a new chapter always starts a new chat so the
    // model never mixes two chapters' text and glossaries.
    const chatKey = (job.book || '') + '|' + (job.chapter || '');
    if (state.lastChatKey !== chatKey) {
      await log('info', 'opening fresh chat for new chapter', {
        id: job.id,
        book: job.book,
        chapter: job.chapter,
        tabId: tab.id
      });

      try {
        await chrome.tabs.update(tab.id, { url: AI_TAB_URLS[state.preferred] });
      } catch (e) {
        await failJob(job.id, 'could not open fresh chat: ' + e.message);
        return;
      }

      await waitForTabLoaded(tab.id, 30000);
      // Re-fetch: navigation may have replaced the tab object
      state.lastChatKey = chatKey;
      state.tabId = tab.id;
      await saveState();
    }

    let ready = await ensureContentReady(tab.id, 20000);

    if (!ready) {
      const canReload = Date.now() - (state.lastReloadAt || 0) > 60000;

      if (canReload) {
        state.lastReloadAt = Date.now();
        await saveState();

        await log('warn', 'content script not ready; reloading AI tab once', {
          tabId: tab.id,
          url: tab.url
        });

        try {
          await chrome.tabs.reload(tab.id);
        } catch (e) {
          await log('error', 'tab reload failed', { error: e.message });
        }

        await waitForTabLoaded(tab.id, 25000);
        ready = await ensureContentReady(tab.id, 20000);
      }
    }

    if (!ready) {
      await failJob(job.id, 'content script not ready; no reload loop');
      return;
    }

    currentExecution = {
      jobId: job.id,
      timeout: setTimeout(() => {
        failJob(job.id, 'execution timeout (10 min)');
      }, 600000)
    };

    await sendMessageToTab(tab.id, { type: 'EXECUTE', job });

    await log('info', 'EXECUTE sent to content script', {
      id: job.id,
      type: job.type,
      tabId: tab.id
    });

  } catch (err) {
    await log('error', 'pollAndExecute failed', { error: err.message });

    if (currentExecution) {
      const id = currentExecution.jobId;
      clearTimeout(currentExecution.timeout);
      currentExecution = null;
      await failJob(id, err.message);
    }
  } finally {
    if (!currentExecution) busy = false;
  }
}

async function failJob(jobId, error) {
  if (currentExecution && currentExecution.jobId === jobId) {
    clearTimeout(currentExecution.timeout);
    currentExecution = null;
  }

  busy = false;

  await log('error', 'job failed', { jobId, error });

  await handleResult({
    id: jobId,
    success: false,
    error
  });
}

async function handleResult(payload) {
  try {
    const r = await fetch(SERVER + '/api/robot/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const d = await r.json().catch(() => ({}));

    if (payload.success) state.stats.processed++;
    else state.stats.failed++;

    await saveState();
    return d;
  } catch (e) {
    return { error: e.message };
  }
}

async function waitForTabLoaded(tabId, timeout = 25000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return true;
    } catch (e) {
      return false;
    }
    await sleep(300);
  }

  return false;
}

async function pingTab(tabId) {
  try {
    const resp = await sendMessageToTab(tabId, { type: 'PING' });
    return !!(resp && resp.pong);
  } catch (e) {
    return false;
  }
}

async function ensureContentReady(tabId, timeout = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await pingTab(tabId)) return true;
    await sleep(700);
  }

  return false;
}

async function ensureAiTab(kind) {
  const prefix = AI_TAB_URLS[kind];
  if (!prefix) return null;

  if (state.tabId) {
    try {
      const t = await chrome.tabs.get(state.tabId);
      if (t.url && t.url.startsWith(prefix)) {
        await waitForTabLoaded(t.id, 8000);
        return t;
      }
    } catch (e) {
      state.tabId = null;
    }
  }

  const tabs = await chrome.tabs.query({ url: prefix + '*' });
  if (tabs.length) {
    state.tabId = tabs[0].id;
    await saveState();
    await waitForTabLoaded(tabs[0].id, 8000);
    return tabs[0];
  }

  const t = await chrome.tabs.create({ url: prefix, active: false });
  state.tabId = t.id;
  await saveState();

  await waitForTabLoaded(t.id, 30000);

  try {
    return await chrome.tabs.get(t.id);
  } catch (e) {
    return t;
  }
}