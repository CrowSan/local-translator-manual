// extension/content.js
(function () {
  let busy = false;

  function countWords(t) {
    return (t || '').trim().split(/\s+/).filter(Boolean).length;
  }

  function getAdapter() {
    return window.NovelBot_Gemini || window.NovelBot_ChatGPT || null;
  }

  function log(level, message, meta = {}) {
    const line = `[novelbot:content:${location.host}:${level}] ${message}`;
    if (level === 'error') console.error(line, meta);
    else console.log(line, meta);

    try {
      chrome.runtime.sendMessage({
        type: 'LOG',
        source: 'content:' + location.host,
        level,
        message,
        meta
      }, () => void chrome.runtime.lastError);
    } catch (e) { /* ignore */ }
  }

  function showOverlay(text) {
    let el = document.getElementById('novelbot-overlay');

    if (!el) {
      el = document.createElement('div');
      el.id = 'novelbot-overlay';
      el.style.cssText =
        'position:fixed;top:12px;right:12px;z-index:2147483647;' +
        'background:#0b0f1a;color:#7ee8fa;padding:10px 16px;border-radius:10px;' +
        'font:600 13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);' +
        'border:1px solid rgba(126,232,250,.35);transition:opacity .3s;direction:ltr;';
      document.body.appendChild(el);
    }

    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0.4'; }, 4000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === 'PING') {
      sendResponse({ pong: true });
      return false;
    }

    if (msg.type === 'EXECUTE') {
      const job = msg.job || {};

      if (busy) {
        showOverlay('⚠ NovelBot is busy');
        sendResponse({ received: false, error: 'busy' });
        return false;
      }

      const adapter = getAdapter();
      if (!adapter) {
        log('error', 'adapter missing', { host: location.host, jobId: job.id });
        showOverlay('❌ adapter missing');
        sendResponse({ received: false, error: 'adapter missing' });
        return false;
      }

      busy = true;
      sendResponse({ received: true });

      (async () => {
        try {
          log('info', 'execute start', {
            id: job.id,
            type: job.type,
            book: job.book,
            chapter: job.chapter,
            inputChars: (job.input || '').length
          });

          showOverlay(`🤖 NovelBot: ${job.type} — starting…`);

          const output = await adapter.run(job);
          const words = countWords(output);

          log('info', 'execute done', {
            id: job.id,
            type: job.type,
            inputChars: (job.input || '').length,
            insertedChars: job._insertedChars || null,
            phases: job._phases || 1,
            words,
            chars: (output || '').length
          });

          showOverlay(`✅ ${job.type} done (${words} words)`);

          chrome.runtime.sendMessage({
            type: 'RESULT',
            payload: {
              id: job.id,
              success: true,
              output,
              book: job.book,
              chapter: job.chapter,
              step: job.step,
              type: job.type,
              stats: { words, chars: (output || '').length }
            }
          }, () => void chrome.runtime.lastError);

        } catch (err) {
          log('error', err.message, {
            id: job.id,
            type: job.type,
            book: job.book,
            chapter: job.chapter
          });

          showOverlay('❌ ' + err.message);

          chrome.runtime.sendMessage({
            type: 'RESULT',
            payload: {
              id: job.id,
              success: false,
              error: err.message,
              book: job.book,
              chapter: job.chapter,
              step: job.step,
              type: job.type
            }
          }, () => void chrome.runtime.lastError);
        } finally {
          busy = false;
        }
      })();

      return false;
    }

    return false;
  });

  log('info', 'content script loaded', {
    host: location.host,
    hasAdapter: !!getAdapter()
  });
})();