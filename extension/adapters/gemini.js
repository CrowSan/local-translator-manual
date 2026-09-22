// extension/adapters/gemini.js
window.NovelBot_Gemini = (function () {

  const SEL = {
    editor: [
      'div.ql-editor[contenteditable="true"]',
      'div[aria-label="Enter a prompt for Gemini"]',
      'div[contenteditable="true"][role="textbox"]'
    ],
    sendBtn: [
      'div[data-test-id="send-button-container"] button',
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]'
    ],
    stopBtn: [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="توقف" i]',
      'button[data-test-id="stop-button"]'
    ],
    lastMessage: [
      'div.markdown-main-panel',
      '.model-response-text',
      'message-content'
    ]
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function pick(selList) {
    for (const s of selList) {
      let els = [];
      try { els = document.querySelectorAll(s); } catch (e) { continue; }
      for (const el of els) {
        if (el && el.offsetParent !== null) return el;
      }
    }
    return null;
  }

  async function waitFor(selList, timeout = 20000, interval = 300) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = pick(selList);
      if (el) return el;
      await sleep(interval);
    }
    throw new Error('selector not found: ' + selList[0]);
  }

  function fireInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Rich-text editors split pasted lines into block elements, so raw
  // textContent comparisons are newline-fragile. Compare whitespace-free.
  const norm = s => (s || '').replace(/\s+/g, '');

  function clearEditor(editor) {
    editor.focus();
    // Constrain the selection to the editor itself: a global selectAll would
    // also grab chat history (e.g. the phase-1 ack) and delete it.
    try {
      const r = document.createRange();
      r.selectNodeContents(editor);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.execCommand('delete', false, null);
    } catch (e) { /* fall through to wipe */ }
    if (editor.textContent.trim()) editor.innerHTML = '';
    // Place caret at start
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // document.execCommand('insertText') silently drops characters on long
  // payloads (a 96%-complete paste still passes a naive length check while
  // missing 200+ head words). Insert in small chunks and verify content.
  async function insertChunked(editor, text) {
    const CHUNK = 500;
    clearEditor(editor);
    editor.focus();

    for (let i = 0; i < text.length; i += CHUNK) {
      const part = text.slice(i, i + CHUNK);
      let ok = false;
      try { ok = document.execCommand('insertText', false, part); } catch (e) { ok = false; }
      if (!ok) {
        // Fallback: append a text node at the caret, then move caret after it
        const sel = window.getSelection();
        const node = document.createTextNode(part);
        if (sel && sel.rangeCount) {
          const r = sel.getRangeAt(0);
          r.deleteContents();
          r.insertNode(node);
          r.setStartAfter(node);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        } else {
          editor.appendChild(node);
        }
      }
      fireInput(editor);
      await sleep(25);
    }
    fireInput(editor);
    await sleep(400);
  }

  // Full verification: total non-whitespace length AND head AND tail.
  // Returns { ok, got, headOk, tailOk } for diagnostics.
  function verifyBox(editor, text) {
    const want = norm(text);
    const got = norm(editor.textContent);
    const probe = Math.min(120, Math.floor(want.length / 3));
    const headOk = got.startsWith(want.slice(0, probe));
    const tailOk = got.endsWith(want.slice(-probe));
    return { ok: got.length >= want.length * 0.93 && headOk && tailOk, got: got.length, want: want.length, headOk, tailOk };
  }

  async function insertViaClipboard(editor, text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      return null; // clipboard blocked, caller tries next fallback
    }
    clearEditor(editor);
    editor.focus();
    await sleep(100);
    try { document.execCommand('paste'); } catch (e) { /* ignore */ }
    await sleep(600);
    fireInput(editor);
    return verifyBox(editor, text);
  }

  async function setInputText(editor, text) {
    const attempts = [];
    // Strategy 1: chunked execCommand('insertText'), up to 3 tries
    for (let a = 1; a <= 3; a++) {
      await insertChunked(editor, text);
      const v = verifyBox(editor, text);
      attempts.push('chunked#' + a + ':' + v.got + '/' + v.want + (v.headOk ? '' : ':NOHEAD') + (v.tailOk ? '' : ':NOTAIL'));
      if (v.ok) return v.got;
      await sleep(400);
    }

    // Strategy 2: clipboard paste
    const pv = await insertViaClipboard(editor, text);
    if (pv) {
      attempts.push('clipboard:' + pv.got + '/' + pv.want);
      if (pv.ok) return pv.got;
    }

    // Strategy 3: direct assignment (last resort, may not enable Send)
    editor.focus();
    editor.textContent = text;
    fireInput(editor);
    await sleep(300);
    const dv = verifyBox(editor, text);
    attempts.push('direct:' + dv.got + '/' + dv.want);
    if (dv.ok) return dv.got;

    throw new Error(
      'Paste verification failed, box content does not match prompt [' + attempts.join(' | ') +
      ']. Reload the Gemini tab once, then re-queue.'
    );
  }

  async function clickSend() {
    const btn = await waitFor(SEL.sendBtn, 10000);
    // Send is disabled until the editor is non-empty; wait briefly
    for (let i = 0; i < 20; i++) {
      if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') break;
      await sleep(250);
    }
    btn.click();
  }

  // All visible response bubbles, de-duplicated (one element can match
  // several selectors). The LAST one is the current answer.
  function allMessages() {
    const out = [];
    for (const s of SEL.lastMessage) {
      let els = [];
      try { els = document.querySelectorAll(s); } catch (e) { continue; }
      els.forEach(el => { if (el && el.offsetParent !== null) out.push(el); });
    }
    return [...new Set(out)];
  }

  // ignore: a previous answer in the same chat (e.g. the phase-1 ack) that
  // must NOT be mistaken for the new response.
  async function waitResponse(maxMs = 240000, opts = {}) {
    const ignore = opts.ignore || null;
    const minLen = opts.minLen || 50;
    const start = Date.now();
    let prev = null;
    let stableFor = 0;

    while (Date.now() - start < maxMs) {
      const stop = pick(SEL.stopBtn);
      const msgs = allMessages();
      const last = msgs[msgs.length - 1];
      const txt = last ? (last.innerText || '').trim() : '';

      if (!txt || txt === ignore) stableFor = 0;
      else if (txt === prev) stableFor += 500;
      else stableFor = 0;
      prev = txt;

      // If stop button is gone and text hasn't changed for 3 seconds, it's done
      if (!stop && txt && txt !== ignore && stableFor >= 3000 && txt.length >= minLen) {
        return txt;
      }
      await sleep(500);
    }
    throw new Error('response timeout after ' + (maxMs / 1000) + 's');
  }

  async function sendOne(editor, text) {
    const inserted = await setInputText(editor, text);
    await sleep(800);
    await clickSend();
    return inserted;
  }

  return {
    async run(job) {
      const prompt = job.prompt;
      const payload = job.payload;
      const single = job.input;
      if ((!prompt || !payload) && (!single || !single.trim())) {
        throw new Error('Server sent empty input text! Check Node terminal logs.');
      }

      const editor = await waitFor(SEL.editor, 25000);
      let insertedTotal = 0;

      if (prompt && payload) {
        // Phase 1: instructions only — wait for the ack ("ready…")
        insertedTotal += await sendOne(editor, prompt);
        const ack = await waitResponse(240000, { minLen: 5 });
        // Phase 2: glossary + chapter text — this answer is the real output
        insertedTotal += await sendOne(editor, payload);
        const output = await waitResponse(240000, { ignore: ack });
        if (!output) throw new Error('empty response from Gemini');
        job._insertedChars = insertedTotal;
        job._phases = 2;
        return output;
      }

      // Legacy single-shot (old server / missing split)
      insertedTotal += await sendOne(editor, single);
      const output = await waitResponse();
      if (!output) throw new Error('empty response from Gemini');
      job._insertedChars = insertedTotal;
      return output;
    }
  };
})();
