// adapters/chatgpt.js
window.NovelBot_ChatGPT = (function () {
  const SEL = {
    editor: [
      '#prompt-textarea',
      'textarea[rows]',
      'div[contenteditable="true"].ProseMirror'
    ],
    sendBtn: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]'
    ],
    lastMessage: [
      'article[data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
      '.markdown:last-child'
    ]
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function pick(list) { for (const s of list) { const e = document.querySelector(s); if (e) return e; } return null; }

  function fireInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const norm = s => (s || '').replace(/\s+/g, '');

  function clearRich(editor) {
    editor.focus();
    try {
      const r = document.createRange();
      r.selectNodeContents(editor);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.execCommand('delete', false, null);
    } catch (e) { /* fall through to wipe */ }
    if (editor.textContent.trim()) editor.innerHTML = '';
  }

  function verifyRich(editor, text) {
    const want = norm(text);
    const got = norm(editor.textContent);
    const probe = Math.min(120, Math.floor(want.length / 3));
    const headOk = got.startsWith(want.slice(0, probe));
    const tailOk = got.endsWith(want.slice(-probe));
    return { ok: got.length >= want.length * 0.93 && headOk && tailOk, got: got.length, want: want.length, headOk, tailOk };
  }

  // Single-shot execCommand('insertText') silently drops characters on long
  // prompts, so insert in small chunks and verify head + tail + length.
  async function setRichText(editor, text) {
    const CHUNK = 500;
    const attempts = [];
    for (let a = 1; a <= 3; a++) {
      clearRich(editor);
      editor.focus();
      for (let i = 0; i < text.length; i += CHUNK) {
        const part = text.slice(i, i + CHUNK);
        let ok = false;
        try { ok = document.execCommand('insertText', false, part); } catch (e) { ok = false; }
        if (!ok) {
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
      const v = verifyRich(editor, text);
      attempts.push('chunked#' + a + ':' + v.got + '/' + v.want + (v.headOk ? '' : ':NOHEAD') + (v.tailOk ? '' : ':NOTAIL'));
      if (v.ok) return v.got;
      await sleep(400);
    }
    throw new Error('Paste verification failed, ChatGPT box content does not match prompt [' + attempts.join(' | ') + ']. Reload the tab once, then re-queue.');
  }

  async function sendOne(editor, text) {
    if (editor.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(editor, text);
      fireInput(editor);
      const got = (editor.value || '').length;
      if (got < text.length * 0.93) {
        throw new Error('Could not paste prompt into ChatGPT box (expected ' + text.length + ' chars, box has ' + got + ').');
      }
    } else {
      await setRichText(editor, text);
    }
    await sleep(300);

    const btn = pick(SEL.sendBtn);
    if (btn) btn.click();
    else editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }

  // ignore: a previous answer in the same chat (phase-1 ack) to skip over.
  async function waitResponse(maxMs = 180000, opts = {}) {
    const ignore = opts.ignore || null;
    const minLen = opts.minLen || 50;
    let prev = null, stable = 0;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const msgs = document.querySelectorAll(SEL.lastMessage.join(','));
      const last = msgs[msgs.length - 1];
      const txt = last ? (last.innerText || '').trim() : '';
      if (!txt || txt === ignore) stable = 0;
      else if (txt === prev) stable += 500;
      else stable = 0;
      prev = txt;
      if (txt && txt !== ignore && stable >= 2500 && txt.length >= minLen) return txt;
      await sleep(500);
    }
    throw new Error('chatgpt response timeout');
  }

  return {
    async run(job) {
      const prompt = job.prompt;
      const payload = job.payload;
      const single = job.input;
      if ((!prompt || !payload) && (!single || !single.trim())) {
        throw new Error('Server sent empty input text! Check Node terminal logs.');
      }
      const editor = await (async () => {
        for (let i = 0; i < 60; i++) { const e = pick(SEL.editor); if (e) return e; await sleep(250); }
        throw new Error('editor not found');
      })();

      if (prompt && payload) {
        // Phase 1: instructions only, then phase 2: glossary + text
        await sendOne(editor, prompt);
        const ack = await waitResponse(180000, { minLen: 5 });
        await sendOne(editor, payload);
        const output = await waitResponse(180000, { ignore: ack });
        if (!output) throw new Error('empty response from ChatGPT');
        job._insertedChars = (prompt.length + payload.length);
        job._phases = 2;
        return output;
      }

      await sendOne(editor, single);
      const output = await waitResponse();
      if (!output) throw new Error('empty response from ChatGPT');
      return output;
    }
  };
})();