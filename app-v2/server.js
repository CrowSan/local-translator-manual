process.env.NO_PROXY = 'localhost,127.0.0.1';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { chromium } = require('playwright');
const crypto = require('crypto');

// ==========================================
// -- CONFIGURATION --
// ==========================================
const PORT = 3000;
const BASE_INPUT_DIR = path.join(__dirname, 'input');
const BASE_OUTPUT_DIR = path.join(__dirname, 'output');
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const CHROME_PATH = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`;

const MAX_CHUNK_RETRIES = 2;

const PROFILES = [
  { id: 'p1', name: 'farhadking', userDataDir: 'C:\\chrome-dev-profile', port: 9225 },
  { id: 'p2', name: 'farhad.oo', userDataDir: 'C:\\chrome-dev-profile-1', port: 9227 },
  { id: 'p3', name: 'farzincook', userDataDir: 'C:\\chrome-dev-profile-2', port: 9223 },
  { id: 'p4', name: 'alirezatav', userDataDir: 'C:\\chrome-dev-profile-3', port: 9224 },
  { id: 'p5', name: 'farhad.oo2', userDataDir: 'C:\\chrome-dev-profile-4', port: 9226 }
];

const BOT_MODELS = {
  gemini: [{ id: 'flash-light', name: 'Flash-Lite' }, { id: 'light', name: 'Flash' }, { id: 'pro', name: 'Pro' }],
  deepseek: [{ id: 'instant', name: 'Instant' }, { id: 'expert', name: 'Expert' }, { id: 'vision', name: 'Vision' }],
  qwen: [{ id: 'fast', name: 'Fast' }, { id: 'thinking', name: 'Thinking' }, { id: 'auto', name: 'Auto' }]
};

const MODE_CONFIG = {
  translate: { srcBase: () => BASE_INPUT_DIR, outBase: () => path.join(BASE_OUTPUT_DIR, 'translate') },
  edit: { srcBase: () => path.join(BASE_OUTPUT_DIR, 'translate'), outBase: () => path.join(BASE_OUTPUT_DIR, 'edited') },
  proof: { srcBase: () => path.join(BASE_OUTPUT_DIR, 'edited'), outBase: () => path.join(BASE_OUTPUT_DIR, 'proofing') },
  score: { srcBase: () => path.join(BASE_OUTPUT_DIR, 'proofing'), outBase: () => path.join(BASE_OUTPUT_DIR, 'proofing') },
  // Autopilot: full pipeline in one job — input → translate → edited → proofing(JSON).
  // parseRange/check-missing compare raw input vs final proofing output.
  auto: { srcBase: () => BASE_INPUT_DIR, outBase: () => path.join(BASE_OUTPUT_DIR, 'proofing') },
  glossary: { srcBase: () => path.join(BASE_INPUT_DIR, 'glossary'), outBase: () => path.join(BASE_OUTPUT_DIR, 'glossary') }
};

// ==========================================
// -- SERVER SETUP --
// ==========================================
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());
app.use(express.static('public'));

const activeTasks = new Map();

function createLogger(taskId) {
  const broadcast = (level, msg) => {
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ taskId, level, msg }));
    });
  };
  return {
    info: (msg) => broadcast('info', msg),
    success: (msg) => broadcast('success', msg),
    warn: (msg) => broadcast('warn', msg),
    error: (msg) => broadcast('error', msg),
    step: (msg) => broadcast('step', msg),
    trace: (msg) => broadcast('info', msg)
  };
}

// ==========================================
// -- BOT DEFINITIONS --
// ==========================================
const BOT_CONFIGS = {
  deepseek: {
    url: 'https://chat.deepseek.com/',
    responseSelector: '.ds-markdown',
    inputSelector: 'textarea[name="search"]',
    isThinking: async (page, log) => {
      return (await page.locator('.ds-icon--stop, .ds-loading, div.ds-icon-button:has(.ds-icon--stop)').count()) > 0;
    },
    setup: async (page, model, log) => {
      log.trace(`[ds.setup] model=${model}`);
      const modelTypeMap = { instant: 'default', expert: 'expert', vision: 'vision' };
      const btn = page.locator(`[data-model-type="${modelTypeMap[model] || 'default'}"]`);
      if (await btn.count() > 0) { await humanClickLocator(page, btn, log, 'ds.setup'); await page.waitForTimeout(jitter(1500)); }
    },
    sendPrompt: async (page, text, log) => {
      await page.bringToFront().catch(() => { });
      await page.waitForTimeout(jitter(400));
      const ta = page.locator('textarea[name="search"]');
      await ta.waitFor({ state: 'visible', timeout: 30000 });
      // Trusted-input path (v1 extension style). Throws PASTE_TRUNCATED on
      // mismatch so pasteAndGetResult's supervision retries handle it.
      await trustedTextareaFill(page, 'textarea[name="search"]', text, log, 'ds.send');
      log.trace(`[ds.send] trusted fill ok (${text.length} chars)`);
      await page.waitForTimeout(jitter(1500));
      await page.keyboard.press('Enter');
      log.trace(`[ds.send] Enter pressed`);
    }
  },

  gemini: {
    url: 'https://gemini.google.com/app',
    responseSelector: 'message-content .markdown',
    inputSelector: '.ql-editor',

    isThinking: async (page, log) => {
      // Reasoning models spend 60-90s "thinking" before/while answering.
      // Thinking markers are scoped to message-content so the model-picker
      // menu can never false-positive (see the old Qwen bug this avoids).
      return (await page.locator(
        'message-content[aria-busy="true"], ' +
        'message-content mat-progress-bar, ' +
        'message-content mat-spinner, ' +
        'message-content [class*="think" i], ' +
        'message-content [class*="skeleton" i], ' +
        'message-content .generating-indicator, ' +
        'button[aria-label*="Stop generating"], ' +
        'button[aria-label*="stop" i], ' +
        '.generating-indicator, ' +
        '.skeleton-loader'
      ).count()) > 0;
    },

    setup: async (page, model, log) => {
      log.trace(`[gem.setup] starting model setup...`);

      try {
        const dismissBtns = page.locator('button:has-text("Accept"), button:has-text("Got it"), button:has-text("Dismiss"), button[aria-label*="Close"], button:has-text("Accept all")');
        const count = await dismissBtns.count();
        if (count > 0) {
          await humanClickLocator(page, dismissBtns.first(), log, 'gem.setup');
          await page.waitForTimeout(jitter(500));
          log.trace(`[gem.setup] dismissed overlay`);
        }
      } catch (e) { }

      const btn = page.locator(
        '[data-test-id="bard-mode-menu-button"], button[aria-label*="mode"], ' +
        'button[aria-label*="Model"], button:has-text("Flash"), button:has-text("Pro"), button:has-text("Lite")'
      ).first();

      try {
        await btn.waitFor({ state: 'visible', timeout: 15000 });
      } catch (e) {
        log.trace(`[gem.setup] no model btn found`);
        return;
      }

      const btnText = (await btn.innerText().catch(() => '')).toLowerCase();
      log.trace(`[gem.setup] current model btn text: "${btnText}"`);
      const isLite = model === 'flash-light', isPro = model === 'pro', isFlash = !isLite && !isPro;

      if (
        (isLite && btnText.includes('lite')) ||
        (isFlash && btnText.includes('flash') && !btnText.includes('lite')) ||
        (isPro && (btnText.includes('pro') || btnText.includes('advanced')))
      ) {
        log.trace(`[gem.setup] correct model already selected`);
        return;
      }

      await humanClickLocator(page, btn, log, 'gem.setup');
      await page.waitForTimeout(jitter(1500));

      let re = isLite ? /Lite|Flash-Lite/i : isPro ? /Pro|Advanced/i : /Flash/i;
      let opt = page.locator('gem-menu-item, [role="menuitem"], [role="option"], .mat-mdc-menu-item').filter({ hasText: re });
      if (isFlash && !isLite) opt = opt.filter({ hasNotText: /Lite/i });

      try {
        await humanClickLocator(page, opt.first(), log, 'gem.setup');
        await page.waitForTimeout(jitter(2000));
        log.trace(`[gem.setup] model switched successfully`);
      } catch (e) {
        log.trace(`[gem.setup] model switch failed, pressing Escape to clean up`);
        await page.keyboard.press('Escape');
      }
    },

    // Strict Model verification to prevent mid-process drift or rate limit fallbacks
    verifyModel: async (page, model, log) => {
      log.trace(`[gem.verify] checking model... expected: ${model}`);
      const btn = page.locator(
        '[data-test-id="bard-mode-menu-button"], button[aria-label*="mode"], ' +
        'button[aria-label*="Model"], button:has-text("Flash"), button:has-text("Pro"), button:has-text("Lite")'
      ).first();

      try {
        await btn.waitFor({ state: 'visible', timeout: 5000 });
      } catch (e) {
        log.warn(`[gem.verify] model button not found`);
        return;
      }

      const btnText = (await btn.innerText().catch(() => '')).toLowerCase();
      log.trace(`[gem.verify] current button text: "${btnText}"`);

      const isLite = model === 'flash-light';
      const isPro = model === 'pro';
      const isFlash = !isLite && !isPro;

      let isCorrect = false;
      if (isLite && btnText.includes('lite')) isCorrect = true;
      if (isFlash && btnText.includes('flash') && !btnText.includes('lite')) isCorrect = true;
      if (isPro && (btnText.includes('pro') || btnText.includes('advanced'))) isCorrect = true;

      if (!isCorrect) {
        log.warn(`[gem.verify] Model is "${btnText}"! Forcing switch to ${model}...`);
        await humanClickLocator(page, btn, log, 'gem.verify');
        await page.waitForTimeout(jitter(1500));

        let re = isLite ? /Lite|Flash-Lite/i : isPro ? /Pro|Advanced/i : /Flash/i;
        let opt = page.locator('gem-menu-item, [role="menuitem"], [role="option"], .mat-mdc-menu-item').filter({ hasText: re });
        if (isFlash && !isLite) opt = opt.filter({ hasNotText: /Lite/i });

        let switched = false;
        try {
          await humanClickLocator(page, opt.first(), log, 'gem.verify');
          await page.waitForTimeout(jitter(2000));
          switched = true;
        } catch (e) {
          log.warn(`[gem.verify] click failed, pressing Escape`);
          await page.keyboard.press('Escape');
        }

        if (switched) {
          // Verify again after switch
          const newBtnText = (await btn.innerText().catch(() => '')).toLowerCase();
          let newIsCorrect = false;
          if (isLite && newBtnText.includes('lite')) newIsCorrect = true;
          if (isFlash && newBtnText.includes('flash') && !newBtnText.includes('lite')) newIsCorrect = true;
          if (isPro && (newBtnText.includes('pro') || newBtnText.includes('advanced'))) newIsCorrect = true;

          if (!newIsCorrect) {
            log.error(`[gem.verify] Model switch failed. Still on "${newBtnText}". Likely rate limited.`);
            throw new Error('FATAL_MODEL_RATE_LIMIT');
          } else {
            log.success(`[gem.verify] model successfully restored to ${model}`);
          }
        } else {
          log.error(`[gem.verify] Model switch failed. Likely rate limited.`);
          throw new Error('FATAL_MODEL_RATE_LIMIT');
        }
      } else {
        log.trace(`[gem.verify] model is correct`);
      }
    },

    sendPrompt: async (page, text, log) => {
      const t0 = Date.now();
      const el = page.locator('.ql-editor');
      await el.waitFor({ state: 'visible', timeout: 30000 });

      const expectedChars = text.trim().length;
      let actualChars = 0;
      let success = false;
      const MAX_ATTEMPTS = 2;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        log.trace(`[gem.send] Attempt ${attempt}/${MAX_ATTEMPTS} (${expectedChars} expected chars)`);

        await humanClickLocator(page, el, log, 'gem.focus');
        await page.waitForTimeout(jitter(250));

        // --- TRUSTED-INPUT INSERT (ported from extension/adapters/gemini.js) ---
        // Chunked document.execCommand('insertText') executed IN PAGE with
        // input/change events, 500 chars per slice. The old CDP clipboard
        // write + Ctrl+V is a bot signature -> Gemini soft-lock ("I'm AI and
        // can't answer"). Scoped clear keeps chat history intact (v1 fix).
        await page.evaluate(async (txt) => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const fire = (elm) => {
            elm.dispatchEvent(new Event('input', { bubbles: true }));
            elm.dispatchEvent(new Event('change', { bubbles: true }));
          };
          const ed = document.querySelector('.ql-editor');
          if (!ed) return;
          try { ed.focus(); } catch (e) { /* ignore */ }
          try {
            const r = document.createRange();
            r.selectNodeContents(ed);
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(r);
            document.execCommand('delete', false, null);
          } catch (e) { /* fall through to wipe */ }
          if ((ed.textContent || '').trim()) ed.innerHTML = '';
          try { ed.focus(); } catch (e) { /* ignore */ }
          const CHUNK = 500;
          for (let i = 0; i < txt.length; i += CHUNK) {
            const part = txt.slice(i, i + CHUNK);
            let ok = false;
            try { ok = document.execCommand('insertText', false, part); } catch (e) { ok = false; }
            if (!ok) {
              const sel = window.getSelection();
              const node = document.createTextNode(part);
              if (sel && sel.rangeCount) {
                const rg = sel.getRangeAt(0);
                rg.deleteContents();
                rg.insertNode(node);
                rg.setStartAfter(node);
                rg.collapse(true);
                sel.removeAllRanges();
                sel.addRange(rg);
              } else {
                ed.appendChild(node);
              }
            }
            fire(ed);
            // Human burst rhythm: fast 15-55ms cadence + an occasional
            // think-pause every ~8 chunks. Fixed 25ms is a metronome tell.
            await sleep(15 + Math.random() * 40);
            if ((i / CHUNK) % 8 === 7) await sleep(280 + Math.random() * 520);
          }
          fire(ed);
        }, text).catch(() => { });

        await page.waitForTimeout(1500);
        // --------------------------------
        // 1. DYNAMIC WAIT: Wait based on text length to let Quill.js parse
        // Base 3 seconds + 1 second per 4,000 characters
        const dynWait = 3000 + Math.floor(expectedChars / 4000) * 1000;
        log.trace(`[gem.send] Insert done. Waiting ${dynWait}ms for Quill.js to parse...`);
        await page.waitForTimeout(dynWait); 

        actualChars = await page.evaluate(() => {
          const ed = document.querySelector('.ql-editor');
          return ed ? (ed.innerText || '').trim().length : 0;
        }).catch(() => 0);

        // v1 verifyBox(): length alone passes 96%-complete pastes missing
        // 200+ head words — require head + tail match too.
        const probe = await page.evaluate((txt) => {
          const ed = document.querySelector('.ql-editor');
          const norm = (s) => (s || '').replace(/\s+/g, '');
          const want = norm(txt);
          const got = norm(ed ? ed.textContent : '');
          const n = Math.min(120, Math.floor(want.length / 3));
          return {
            ok: got.length >= want.length * 0.93 &&
              got.startsWith(want.slice(0, n)) &&
              got.endsWith(want.slice(-n)),
            got: got.length, want: want.length
          };
        }, text).catch(() => ({ ok: false, got: actualChars, want: expectedChars }));

        if (probe.ok && actualChars >= expectedChars * 0.93) {
          success = true;
          log.trace(`[gem.send] Trusted insert verified: ${actualChars} chars (head+tail ok)`);
          
          // Verified — Send happens exactly ONCE below (sloth humanizer +
          // explicit Send click). Clicking here too double-submits and leaves
          // a stray empty prompt in the chat context.
          break;
        }
      }

if (!success) {
        log.error(`[gem.send] PASTE FAILED after ${MAX_ATTEMPTS} attempts.`);
        throw new Error('PASTE_TRUNCATED');
      }

      // ==========================================
      // --- TEST 2: DYNAMIC "SLOTH" HUMANIZER DELAY ---
      // ==========================================
      const slothWait = jitter(2000 + Math.floor(expectedChars / 5000) * 1000, 0.3);
      log.trace(`[gem.send] Paste visually verified. Waiting ${slothWait}ms for UI framework to sync...`);
      await page.waitForTimeout(slothWait);

      log.trace(`[gem.send] Nudging the editor (Space + Backspace) to trigger organic input events...`);
      await el.focus().catch(() => { });
      await page.keyboard.press('End').catch(() => { }); // Jump to the end of the 18k text
      await page.keyboard.press('Space').catch(() => { });
      await page.waitForTimeout(jitter(500));
      await page.keyboard.press('Backspace').catch(() => { });
      
      log.trace(`[gem.send] Waiting 2 seconds for event debounce...`);
      await page.waitForTimeout(jitter(2000, 0.3));

      log.trace(`[gem.send] Clicking Send with the real mouse path...`);
      // Trusted mouse click (isTrusted=true). The old page.evaluate(b.click())
      // is a JS-synthesized, untrusted click — a detection signal.
      const clicked = await humanClickSendButton(page, log, 'gem.send');

      if (clicked) {
        log.trace(`[gem.send] Clicked Send button: "${clicked}"`);
      } else {
        log.trace(`[gem.send] No Send button found. Pressing Enter...`);
        await page.keyboard.press('Enter').catch(() => { });
      }

      // Wait a moment for the UI to lock and transition to generating state
      await page.waitForTimeout(jitter(2500, 0.3));
      
      const postLen = await page.evaluate(() => {
        const ed = document.querySelector('.ql-editor');
        return ed ? (ed.innerText || '').trim().length : -1;
      }).catch(() => -1);
      
      log.trace(`[gem.send] post-submit editor length: ${postLen} chars`);
      // Hand leaves the mouse: a small scroll + drift to a neutral spot.
      // Zero mouse presence across a whole session is itself a signal.
      await page.mouse.wheel(0, rand(150, 450)).catch(() => { });
      await humanMoveMouse(page, rand(40, 220), rand(480, 660));
      log.trace(`[gem.send] done (${Date.now() - t0}ms)`);
    }
  },

  qwen: {
    url: 'https://chat.qwenlm.ai/',
    responseSelector: '.qwen-markdown, .markdown-body, .message-content',
    inputSelector: '.message-input-texta',
    isThinking: async (page, log) => {
      // FIXED: Removed [class*="thinking"] and [class*="loading"] to prevent matching the model dropdown
      return (await page.locator('.ant-spin, .icon-line-stop, button[aria-label*="stop" i], button:has-text("Stop")').count()) > 0;
    },
    setup: async (page, model, log) => {
      const trigger = page.locator('.qwen-thinking-selector');
      if (await trigger.count() > 0) {
        await humanClickLocator(page, trigger, log, 'qwen.setup'); await page.waitForTimeout(jitter(1000));
        const t = model === 'thinking' ? 'Thinking' : model === 'auto' ? 'Auto' : 'Fast';
        const opt = page.locator(`.ant-select-item-option[title="${t}"]`).first();
        if (await opt.isVisible().catch(() => false)) { await humanClickLocator(page, opt, log, 'qwen.setup'); await page.waitForTimeout(jitter(1000)); }
        else { await page.keyboard.press('Escape'); }
      }
    },
    sendPrompt: async (page, text, log) => {
      await page.bringToFront().catch(() => { });
      await page.waitForTimeout(jitter(400));
      const ta = page.locator('.message-input-textarea').last();
      await ta.waitFor({ state: 'visible', timeout: 30000 });
      // Trusted-input path (v1 extension style). Throws PASTE_TRUNCATED on
      // mismatch so pasteAndGetResult's supervision retries handle it.
      await trustedTextareaFill(page, '.message-input-textarea', text, log, 'qwen.send');
      log.trace(`[qwen.send] trusted fill ok (${text.length} chars)`);
      await page.waitForTimeout(jitter(1500));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(jitter(1000));
      try {
        const sb = page.locator('button[class*="send"], button[aria-label*="end"]').filter({ hasNot: page.locator('[disabled]') }).first();
        if (await sb.isVisible({ timeout: 1000 }).catch(() => false)) await humanClickLocator(page, sb, log, 'qwen.send');
      } catch (e) { }
    }
  }
};

// ==========================================
// -- UTILS --
// ==========================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

const withTimeout = (promise, ms, msg) => {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(msg)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// Helper to detect fatal API errors that should instantly halt the queue
const isFatalError = (str) => {
  const s = (str || '').toLowerCase();
  return s.includes('1095') || s.includes('1096') || s.includes('rate limit') ||
    s.includes('too many requests') || s.includes('try again after') ||
    s.includes('suspended') || s.includes('temporarily restricted');
};

// --- Trusted-input delivery (ported from v1 extension/adapters) ---
// page.locator().fill() sets the value via JS with no trusted key/input
// events — an automation signature that triggers soft-locks ("I'm AI and
// can't answer"). This reproduces the extension path for plain textareas:
// native value setter + input/change events + a Space/Backspace nudge so the
// site's own editor framework observes a human-like sequence, then verifies
// head + tail + length like adapters/gemini.js verifyBox(). Throws
// PASTE_TRUNCATED so the existing supervision ladder (soft retry in same
// chat -> hard reload -> failed-chapters.json) handles it unchanged.
async function trustedTextareaFill(page, selector, text, log, tag) {
  const expected = String(text || '').trim().length;
  const res = await page.evaluate(({ sel, txt }) => {
    const els = document.querySelectorAll(sel);
    const el = els[els.length - 1];
    if (!el) return { ok: false, reason: 'no-el' };
    try { el.focus(); } catch (e) { /* ignore */ }
    try {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(el, txt);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }, { sel: selector, txt: text }).catch(() => ({ ok: false, reason: 'evaluate-failed' }));

  if (!res || !res.ok) {
    throw new Error('PASTE_TRUNCATED');
  }

  // Trusted key events nudge the framework to sync (same as v1 adapters).
  await page.keyboard.press('End').catch(() => { });
  await page.keyboard.press('Space').catch(() => { });
  await page.waitForTimeout(jitter(400));
  await page.keyboard.press('Backspace').catch(() => { });
  await page.waitForTimeout(jitter(1200));

  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const verified = await page.evaluate(({ sel, txt }) => {
    const els = document.querySelectorAll(sel);
    const el = els[els.length - 1];
    const normInner = (s) => String(s || '').replace(/\s+/g, '');
    const want = normInner(txt);
    const got = normInner(el ? (el.value || '') : '');
    const n = Math.min(120, Math.floor(want.length / 3));
    return {
      ok: got.length >= want.length * 0.93 &&
        got.startsWith(want.slice(0, n)) &&
        got.endsWith(want.slice(-n)),
      got: got.length, want: want.length
    };
  }, { sel: selector, txt: text }).catch(() => ({ ok: false, got: 0, want: expected }));

  if (log) log.trace(`[${tag}] trusted fill verify: ${verified.got}/${verified.want} ${verified.ok ? 'ok' : 'MISMATCH'}`);
  if (!verified.ok) throw new Error('PASTE_TRUNCATED');
};

// --- Human-mimicry stealth core ---
// Every fixed sleep, instant click and JS-synthesized event is a bot tell.
// These helpers emit the signals real users produce: jittered timing, real
// mouse travel (trusted isTrusted=true CDP input events instead of
// element.click() from JS), and init-script masking of the well-known
// automation properties. Best-effort only: supervision never depends on them.
const rand = (min, max) => min + Math.random() * (max - min);
const jitter = (base, pct = 0.25) => Math.max(50, Math.round(base * (1 - pct + Math.random() * pct * 2)));

// Per-page last-known cursor position so moves travel like a hand, not jumps.
const __mousePos = new WeakMap();
async function humanMoveMouse(page, x, y) {
  const steps = 6 + Math.floor(Math.random() * 7);
  await page.mouse.move(x, y, { steps }).catch(() => { });
  __mousePos.set(page, { x, y });
}

// Real mouse click with offset jitter and human hold time. Falls back to a
// normal locator click and only then to force-click, so a step is never lost
// just because the human path missed.
async function humanClickLocator(page, locator, log, tag) {
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => { });
    const box = await locator.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) {
      const x = box.x + box.width * (0.35 + Math.random() * 0.3);
      const y = box.y + box.height * (0.35 + Math.random() * 0.3);
      await humanMoveMouse(page, x, y);
      await page.waitForTimeout(rand(60, 220));
      await page.mouse.down().catch(() => { });
      await page.waitForTimeout(rand(40, 130));
      await page.mouse.up().catch(() => { });
      if (log) log.trace(`[${tag}] human mouse click @${Math.round(x)},${Math.round(y)}`);
      return true;
    }
  } catch (e) { /* fall through to locator click */ }
  try { await locator.click({ timeout: 8000 }); return true; }
  catch (e) {
    await locator.click({ force: true, timeout: 8000 }).catch(() => { });
    return true;
  }
}

// Find Gemini's Send button WITHOUT clicking it from JS (untrusted), then
// click it via the real mouse path. Returns the label or null.
async function humanClickSendButton(page, log, tag) {
  const rect = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const b of btns) {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      const title = (b.getAttribute('title') || '').toLowerCase();
      const text = (b.innerText || '').toLowerCase();
      if ((label.includes('send') || title.includes('send') || text.includes('send')) && !b.disabled) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, w: r.width, h: r.height, label: label || title || text || 'send' };
      }
    }
    return null;
  }).catch(() => null);
  if (!rect) return null;
  const x = rect.x + rect.w * (0.3 + Math.random() * 0.4);
  const y = rect.y + rect.h * (0.3 + Math.random() * 0.4);
  await humanMoveMouse(page, x, y);
  await page.waitForTimeout(rand(80, 260));
  await page.mouse.down().catch(() => { });
  await page.waitForTimeout(rand(40, 130));
  await page.mouse.up().catch(() => { });
  if (log) log.trace(`[${tag}] human Send click: "${rect.label}"`);
  return rect.label;
}

// Mask well-known automation properties before page scripts run. Call after
// newPage(), BEFORE goto(). Deliberately minimal — over-spoofing creates
// worse inconsistencies than it fixes. The real user profile already supplies
// locale, timezone, UA, cookies and history.
async function applyStealth(page, log) {
  try {
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
      } catch (e) { /* ignore */ }
      try {
        if (!window.chrome || !window.chrome.runtime) {
          window.chrome = { runtime: {}, loadTimes: function () { }, csi: function () { }, app: {} };
        }
      } catch (e) { /* ignore */ }
      try {
        const perms = window.navigator.permissions;
        if (perms && perms.query) {
          const origQuery = perms.query.bind(perms);
          window.navigator.permissions.query = (params) =>
            params && params.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission })
              : origQuery(params);
        }
      } catch (e) { /* ignore */ }
      try {
        if (navigator.plugins && navigator.plugins.length === 0) {
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3], configurable: true });
        }
      } catch (e) { /* ignore */ }
    }).catch(() => { });
    // Native window viewport: Playwright applies a fixed emulated viewport to
    // every CDP page, so the site renders letterboxed inside the real (often
    // maximized) window — visibly wrong and detectable. Clearing the override
    // lets the page use the actual window size, exactly like a human's
    // browser. The override is per-page, so parallel tabs are unaffected.
    let native = false;
    try {
      const s = await page.context().newCDPSession(page);
      await s.send('Emulation.clearDeviceMetricsOverride').catch(() => { });
      await s.detach().catch(() => { });
      native = true;
    } catch (e) { /* fall through to fallback */ }
    if (!native) {
      await page.setViewportSize({ width: 1366, height: 768 }).catch(() => { });
    }
    if (log) log.trace(`[stealth] applied (${native ? 'native window viewport' : 'fallback viewport'}, webdriver masked)`);
  } catch (e) { /* stealth is best-effort; supervision continues */ }
}

async function loadGlossary(p) {
  try {
    const data = await fs.readFile(p, 'utf-8');
    const map = {};
    data.split('\n').forEach(line => {
      const [en, fa] = line.split('->').map(s => s.trim());
      if (en && fa) map[en] = fa;
    });
    return map;
  } catch { return {}; }
}

const findGlossaryMatches = (text, glossary) => {
  // 1. Sort by length descending (Longest Match First)
  const sortedEntries = Object.entries(glossary).sort((a, b) => b[0].length - a[0].length);

  const matches = [];
  const foundTerms = new Set();

  for (const [en, fa] of sortedEntries) {
    if (!en || foundTerms.has(en.toLowerCase())) continue;

    // 2. Escape regex special chars and use strict word boundaries
    const escapedEn = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedEn}\\b`, 'i');

    if (regex.test(text)) {
      matches.push({ en, fa });
      foundTerms.add(en.toLowerCase());
    }
  }
  return matches;
};

async function readSourceText(dir, file) {
  const extensions = ['.txt', '.md', '.json'];
  const baseName = file.replace(/\.[^.]+$/, '');
  const tryFiles = [file, ...extensions.map(ext => baseName + ext)];

  for (const tryFile of tryFiles) {
    const filePath = path.join(dir, tryFile);
    try {
      await fs.access(filePath);
      if (tryFile.endsWith('.json')) {
        const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        if (data.paragraphs && Array.isArray(data.paragraphs)) return data.paragraphs.join('\n\n');
        return typeof data === 'string' ? data : JSON.stringify(data);
      }
      return await fs.readFile(filePath, 'utf-8');
    } catch (e) { }
  }
  return '';
}

function countTextWords(text) {
  const t = (text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

async function readProofText(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);

    if (data && Array.isArray(data.paragraphs)) {
      return data.paragraphs.join('\n');
    }

    if (Array.isArray(data)) {
      return data.join('\n');
    }

    if (typeof data === 'string') {
      return data;
    }

    return JSON.stringify(data);
  } catch {
    return '';
  }
}

function launchChrome(userDataDir, port, log) {
  return new Promise((resolve) => {
    // Minimal human-like flags (same shape as v1 launchProfile). The old bundle
    // (--disable-background-*, --disable-hang-monitor, 200x200 window,
    // --js-flags) is an automation fingerprint and a soft-lock trigger.
    // Supervision (reconnect, verifyModel, error taxonomy) is untouched.
    const flags = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir="${userDataDir}"`,
      `--no-first-run`,
      `--no-default-browser-check`,
      `--disable-session-crashed-bubble`,
      `--start-maximized`,
    ].join(' ');
    if (log) log.trace(`[chrome] launch port=${port}`);
    exec(`${CHROME_PATH} ${flags}`, () => { });
    setTimeout(() => resolve(), 3000);
  });
}

async function getFolders(dir) {
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    return items.filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
}

async function getFiles(dir) {
  try {
    const items = await fs.readdir(dir);
    return items.filter(f => f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.json')).sort((a, b) => {
      const numA = (a.match(/(\d+)/g) || []).pop();
      const numB = (b.match(/(\d+)/g) || []).pop();
      return (numA && numB) ? numA - numB : a.localeCompare(b, undefined, { numeric: true });
    });
  } catch { return []; }
}

async function parseRange(input, srcDir, outDir) {
  const files = await getFiles(srcDir);
  if (input.trim().toLowerCase() === 'all') return files;
  if (input.trim().toLowerCase() === 'failed') {
    try {
      const data = JSON.parse(await fs.readFile(path.join(outDir, 'failed-chapters.json'), 'utf-8'));
      const failedNames = new Set(data.map(f => f.file));
      return files.filter(f => failedNames.has(f));
    } catch { return []; }
  }

  if (files.includes(input.trim())) return [input.trim()];

  const selectedFiles = new Set();
  const fileMap = files.map(f => ({ file: f, num: parseInt((f.match(/(\d+)/g) || []).pop() || 0) }));
  input.split(',').map(s => s.trim()).filter(Boolean).forEach(p => {
    if (p.includes('-')) {
      const [s, e] = p.split('-').map(Number);
      if (!isNaN(s) && !isNaN(e)) fileMap.filter(i => i.num >= s && i.num <= e).forEach(i => selectedFiles.add(i.file));
    } else {
      const n = Number(p);
      if (!isNaN(n)) fileMap.filter(i => i.num === n).forEach(i => selectedFiles.add(i.file));
    }
  });
  return files.filter(f => selectedFiles.has(f));
}

let writeLock = Promise.resolve();
async function logFailedChapterSafe(outDir, file, reason) {
  writeLock = writeLock.then(async () => {
    const lp = path.join(outDir, 'failed-chapters.json');
    let fData = [];
    try { fData = JSON.parse(await fs.readFile(lp, 'utf-8')); } catch (e) { }
    const i = fData.findIndex(f => f.file === file);
    if (i > -1) fData[i] = { file, reason, timestamp: new Date().toISOString() };
    else fData.push({ file, reason, timestamp: new Date().toISOString() });
    await fs.writeFile(lp, JSON.stringify(fData, null, 2));
  }).catch(() => { });
  await writeLock;
}

// ==========================================
// -- ERROR DETECTION --
// ==========================================
async function detectPageError(page, log) {
  try {
    const sels = 'div[role="alert"], div[role="alertdialog"], .snackbar, [class*="toast"], [class*="error-banner"], [class*="error-message"], mat-snack-bar-container, [class*="snackbar"]';
    const els = page.locator(sels);
    const count = await els.count();
    for (let i = 0; i < count; i++) {
      const txt = (await els.nth(i).innerText().catch(() => '')).toLowerCase();
      if (txt.includes('error') || txt.includes('1095') || txt.includes('1096') || txt.includes('try again') || txt.includes('something went wrong') || txt.includes('rate limit') || txt.includes('too many requests')) {
        if (log) log.trace(`[err] overlay: "${txt.slice(0, 80)}"`);
        return txt.slice(0, 200);
      }
    }
    const bodyText = await page.evaluate(() => {
      const ov = document.querySelectorAll('[role="alert"], [role="alertdialog"], [class*="toast"], [class*="snackbar"], [class*="modal"], [class*="dialog"]');
      return Array.from(ov).map(el => el.innerText).join(' ').toLowerCase();
    });
    if (bodyText.includes('error 1095') || bodyText.includes('error 1096') || bodyText.includes('try again after')) {
      return bodyText.slice(0, 200);
    }
    return null;
  } catch { return null; }
}

// ==========================================
// -- AUTOMATION CORE --
// ==========================================
async function pasteAndGetResult(page, bot, text, isThinkingModel, log, taskId) {
  const respSel = bot.responseSelector;
  let initCount = await page.locator(respSel).count().catch(() => 0);
  let prev = initCount > 0 ? await page.locator(respSel).nth(initCount - 1).innerText().catch(() => '') : '';
  log.trace(`[wait] init: resp=${initCount} prevLen=${prev.length}`);

  await bot.sendPrompt(page, text, log);

  let started = false;
  const maxStart = isThinkingModel ? 60 : 30;

  for (let i = 0; i < maxStart; i++) {
    if (!activeTasks.has(taskId)) throw new Error('TASK_CANCELLED');
    await page.waitForTimeout(4000);

    const count = await page.locator(respSel).count().catch(() => 0);
    const isThinking = bot.isThinking ? await bot.isThinking(page, log).catch(() => false) : false;
    const changed = count === initCount && count > 0
      ? await page.locator(respSel).nth(initCount - 1).innerText().catch(() => '') !== prev
      : false;

    // Rescue nudge ONLY when nothing is happening: never press Enter while
    // the model is reasoning — that double-submits and kills the thought.
    if (!isThinking && (i === 4 || i === 10)) {
      const unsent = await page.evaluate(() => {
        const ed = document.querySelector('.ql-editor') || document.querySelector('textarea');
        return ed ? (ed.innerText || ed.value || '').trim().length : 0;
      }).catch(() => 0);
      if (unsent > 20) {
        log.trace(`[wait] nudge i=${i}: ${unsent} unsent, pressing Enter`);
        await page.keyboard.press('Enter').catch(() => { });
      }
    }

    const pageError = await detectPageError(page, log);
    if (pageError) {
      if (isFatalError(pageError)) throw new Error(`FATAL_API_ERROR: ${pageError}`);
      throw new Error(`API_ERROR: ${pageError}`);
    }

    // (count / isThinking / changed were computed above, before the nudge.)
    if (i % 5 === 0 || count > initCount || isThinking)
      log.trace(`[wait] p1 i=${i}: resp=${count} think=${isThinking} chg=${changed}`);

    if (count > initCount || changed || isThinking) {
      started = true;
      log.trace(`[wait] p1: started at i=${i}`);
      break;
    }
  }

  if (!started) throw new Error('Timeout: Bot did not start generating.');

  // Reasoning models pause long between thought and answer parts: give them
  // 120s of silence (vs 60s) and require 12s of stability (vs 8s) so a slow
  // part-by-part stream is never mistaken for a finished answer. The old
  // limits fired mid-thought → page.reload() killed the answer → endless
  // fail loop that looked like "impatient refreshes".
  let stable = 0, last = '', idle = 0, total = 0;
  const maxIdle = isThinkingModel ? 30 : 15;
  const stableTarget = isThinkingModel ? 3 : 2;
  const maxTotal = isThinkingModel ? 225 : 75;
  const target = page.locator(respSel).last();

  while (stable < stableTarget && total < maxTotal) {
    if (!activeTasks.has(taskId)) throw new Error('TASK_CANCELLED');
    await page.waitForTimeout(4000);
    total++;

    try {
      const pageError = await detectPageError(page, log);
      if (pageError) {
        if (isFatalError(pageError)) throw new Error(`FATAL_API_ERROR: ${pageError}`);
        throw new Error(`API_ERROR: ${pageError}`);
      }

      const count = await page.locator(respSel).count().catch(() => 0);
      const cur = count > 0 ? await target.innerText().catch(() => '') : '';
      const lower = cur.toLowerCase();

      if (isFatalError(lower)) {
        throw new Error('FATAL_API_ERROR: Fatal error in response body.');
      }
      if (lower.includes('something went wrong') || lower.includes('network error')) {
        throw new Error('API_ERROR: Error in response body.');
      }

      // Inside the while loop of pasteAndGetResult:
      const thinking = bot.isThinking ? await bot.isThinking(page, log).catch(() => false) : false;

      // ONLY read innerText if it has STOPPED thinking to prevent interrupting the render thread
      if (thinking) {
        stable = 0; idle = 0;
        if (total % 3 === 0) log.trace(`[wait] p2 i=${total}: Bot is actively streaming/thinking...`);
      } else {
        const cur = count > 0 ? await target.innerText().catch(() => '') : '';
        if (cur !== last && cur.trim().length > 0) {
          stable = 0; last = cur; idle = 0;
        } else if (cur.trim().length > 0) {
          stable++; idle = 0;
        } else {
          idle++;
        }
        if (total % 3 === 0) log.trace(`[wait] p2 i=${total}: len=${cur.trim().length} stable=${stable}`);
      }

      if (total % 3 === 0)
        log.trace(`[wait] p2 i=${total}: len=${cur.trim().length} think=${thinking} stable=${stable} idle=${idle}`);

      if (idle >= maxIdle)
        throw new Error(`Timeout: Bot stuck (${maxIdle * 4}s no content).`);

    } catch (e) {
      if (e.message.includes('API_ERROR') || e.message.includes('FATAL_API_ERROR') || e.message.includes('Timeout:') || e.message.includes('TASK_CANCELLED')) throw e;
    }
  }

  if (!last.trim()) throw new Error('Bot returned empty response.');
  if (total >= maxTotal) throw new Error('Timeout: Hard limit reached.');

  log.trace(`[wait] OK: ${last.length} chars, ${total} intervals`);
  return last.trim();
}

// ==========================================
// -- AUTOPILOT: translate → edit → proof --
// ==========================================
// Runs the three stages back-to-back on the SAME page (shared chat context,
// like v1 chains) by reusing processFile with per-stage configs — so every
// stage keeps the full supervision ladder: trusted input, thinking waits,
// soft/hard retries, fatal taxonomy, failed-chapters ledger.
// Idempotent + resumable: finished stages are detected and skipped, so a
// restarted job never pays twice. Exceptions propagate to runTask's handler
// (requeue on crash, strike-pause on fatal, ledger + next file otherwise).
async function processFileAuto(page, file, cfg, log, taskId) {
  const inputBookDir = path.join(BASE_INPUT_DIR, cfg.bookName);
  const translateDir = path.join(BASE_OUTPUT_DIR, 'translate', cfg.bookName);
  const editedDir = path.join(BASE_OUTPUT_DIR, 'edited', cfg.bookName);
  const proofingDir = path.join(BASE_OUTPUT_DIR, 'proofing', cfg.bookName);
  await fs.mkdir(translateDir, { recursive: true });
  await fs.mkdir(editedDir, { recursive: true });
  await fs.mkdir(proofingDir, { recursive: true });

  const prompts = cfg.prompts || {};
  const stagePrompt = {
    translate: prompts.translate || cfg.prompt || '',
    edit: prompts.edit || cfg.prompt || '',
    proof: prompts.proof || cfg.prompt || ''
  };
  for (const [stage, pr] of Object.entries(stagePrompt)) {
    if (!pr) {
      const msg = `Autopilot ${stage} prompt is empty — check the template file has a ${stage === 'translate' ? 'translation' : stage === 'edit' ? 'editorial' : 'proofing'}_prompt section.`;
      log.error(`[${file}] ${msg}`);
      await logFailedChapterSafe(proofingDir, file, 'AUTO_PROMPT_MISSING:' + stage);
      throw new Error(msg);
    }
  }

  const wordsOf = (txt) => String(txt || '').trim().split(/\s+/).filter(Boolean).length;
  const jsonName = file.replace(/\.[^.]+$/, '.json');

  // Already fully done? Never redo a finished chapter.
  try {
    const doneRaw = await fs.readFile(path.join(proofingDir, jsonName), 'utf-8');
    const doneJson = JSON.parse(doneRaw);
    const doneParas = Array.isArray(doneJson.paragraphs) ? doneJson.paragraphs.join('\n') : '';
    if (wordsOf(doneParas) > 0) {
      log.success(`[${file}] Autopilot: final JSON already exists — skipping.`);
      return;
    }
  } catch (e) { /* not done yet — run the chain */ }

  const hasStageOutput = async (dir) => wordsOf(await readSourceText(dir, file)) > 0;

  // Stage 1: translate (English → Persian, glossary enforced).
  if (await hasStageOutput(translateDir)) {
    log.step(`[${file}] Autopilot 1/3 translate — output exists, skipping.`);
  } else {
    log.step(`[${file}] Autopilot 1/3 translate…`);
    await processFile(page, file, {
      ...cfg, mode: 'translate', srcDir: inputBookDir, outDir: translateDir,
      prompt: stagePrompt.translate, glossary: cfg.glossary || {}, inputDir: null
    }, log, taskId);
    if (!await hasStageOutput(translateDir)) throw new Error(`Autopilot translate produced no output for ${file}.`);
  }

  // Stage 2: edit (polish the translation).
  if (await hasStageOutput(editedDir)) {
    log.step(`[${file}] Autopilot 2/3 edit — output exists, skipping.`);
  } else {
    log.step(`[${file}] Autopilot 2/3 edit…`);
    await processFile(page, file, {
      ...cfg, mode: 'edit', srcDir: translateDir, outDir: editedDir,
      prompt: stagePrompt.edit, inputDir: null
    }, log, taskId);
    if (!await hasStageOutput(editedDir)) throw new Error(`Autopilot edit produced no output for ${file}.`);
  }

  // Stage 3: proof (EN + FA full-chapter → final JSON).
  log.step(`[${file}] Autopilot 3/3 proof…`);
  await processFile(page, file, {
    ...cfg, mode: 'proof', srcDir: editedDir, outDir: proofingDir,
    prompt: stagePrompt.proof, inputDir: inputBookDir
  }, log, taskId);

  log.success(`[${file}] Autopilot done: translated → edited → proofed. 🎉`);
}

async function processFile(page, file, cfg, log, taskId) {
  // Autopilot delegates to the 3-stage chain below (same page = shared chat
  // context, like v1 chains). All supervision lives inside processFile.
  if (cfg.mode === 'auto') return processFileAuto(page, file, cfg, log, taskId);

  log.step(`Processing ${file}... (${cfg.mode}, ${cfg.chunkSize}w chunks, ${cfg.chunkDelay}s delay)`);

  if (cfg.mode === 'score') {
    log.step(`[${file}] Scoring full-chapter mode (no chunking)`);

    const cleanText = (txt) => (txt || '').replace(/^\uFEFF/, '').trim();
    const countWords = (txt) => {
      const t = (txt || '').trim();
      if (!t) return 0;
      return t.split(/\s+/).filter(Boolean).length;
    };

    if (!cfg.inputDir) {
      log.error(`[${file}] Score inputDir missing. Skipping.`);
      return;
    }

    const englishText = cleanText(await readSourceText(cfg.inputDir, file));
    const farsiText = cleanText(await readSourceText(cfg.srcDir, file));

    const enWords = countWords(englishText);
    const faWords = countWords(farsiText);

    log.trace(`[score] ${file}: en=${enWords}w, fa=${faWords}w`);

    if (!englishText || !farsiText || enWords === 0 || faWords === 0) {
      log.error(`[${file}] Score source empty. Skipping.`);
      return;
    }

    const body = `انگلیسی:\n${englishText}\n\n\n\nفارسی:\n${farsiText}`;
    const finalPrompt = (cfg.promptMode === 2 && cfg.prompt)
      ? `${cfg.prompt}\n\n${body}`
      : body;

    if (cfg.promptMode === 1 && cfg.prompt) {
      log.trace(`[score] sending initial prompt...`);
      try {
        await fs.writeFile(path.join(cfg.outDir, `debug_payload_${i}.txt`), finalPrompt, 'utf-8');
        await withTimeout(
          // At the top of processFile, right before pasteAndGetResult:
          pasteAndGetResult(page, cfg.bot, cfg.prompt, cfg.isThinking, log, taskId),
          cfg.isThinking ? 600000 : 300000,
          'HARD_TIMEOUT: Initial prompt > limit (5min, 10min for thinking models).'
        );
        const waitSec = cfg.chunkDelay || 5;
        log.trace(`[score] initial prompt done, waiting ${waitSec}s`);
        await page.waitForTimeout(waitSec * 1000);
      } catch (err) {
        const msg = err.message || String(err);
        if (msg.includes('FATAL_API_ERROR') || msg.includes('FATAL_MODEL_RATE_LIMIT')) {
          log.error(`[${file}] FATAL ERROR: ${msg}. Stopping task.`);
          await logFailedChapterSafe(cfg.outDir, file, msg);
          throw err;
        }
        log.error(`[${file}] Initial score prompt failed: ${msg}`);
        return;
      }
    }

    if (cfg.bot.verifyModel) await cfg.bot.verifyModel(page, cfg.selectedModel, log);

    let scoreResult = '';
    try {
      log.step(`[${file}] Sending full score payload...`);
      scoreResult = await pasteAndGetResult(page, cfg.bot, finalPrompt, cfg.isThinking, log, taskId);
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('FATAL_API_ERROR') || msg.includes('FATAL_MODEL_RATE_LIMIT')) {
        log.error(`[${file}] FATAL ERROR: ${msg}. Stopping task.`);
        await logFailedChapterSafe(cfg.outDir, file, msg);
        throw err;
      }
      log.error(`[${file}] Score failed: ${msg}`);
      return;
    }

    const match = scoreResult.match(/\b(100|\d{1,2})\b/);
    const score = match ? parseInt(match[1], 10) : 'N/A';

    log.success(`[${file}] SCORE = ${score}`);
    log.info(`[${file}] Raw AI response: ${scoreResult.substring(0, 150)}...`);
    return;
  }

  if (cfg.mode === 'proof') {
    log.step(`[${file}] Proof full-chapter mode (no chunking)`);

    const cleanText = (txt) => (txt || '').replace(/^\uFEFF/, '').trim();

    const countWords = (txt) => {
      const t = (txt || '').trim();
      if (!t) return 0;
      return t.split(/\s+/).filter(Boolean).length;
    };

    const makeFingerprints = (txt) => {
      const t = (txt || '').trim();
      if (!t) return { start: '', end: '' };
      const len = Math.min(80, t.length);
      return { start: t.slice(0, len), end: t.slice(-len) };
    };

    if (!cfg.inputDir) {
      log.error(`[${file}] Proof inputDir missing. Logging and skipping.`);
      await logFailedChapterSafe(cfg.outDir, file, 'PROOF_INPUT_DIR_MISSING');
      return;
    }

    const englishText = cleanText(await readSourceText(cfg.inputDir, file));
    const farsiText = cleanText(await readSourceText(cfg.srcDir, file));

    const enWords = countWords(englishText);
    const faWords = countWords(farsiText);

    log.trace(`[proof] ${file}: en=${enWords}w, fa=${faWords}w`);

    if (!englishText || !farsiText || enWords === 0 || faWords === 0) {
      log.error(`[${file}] Proof source empty. Logging and skipping.`);
      await logFailedChapterSafe(cfg.outDir, file, 'PROOF_SOURCE_EMPTY');
      return;
    }

    // Chapter glossary, matched against the ENGLISH source with the SAME
    // matcher the translate step uses (reuse, don't reinvent) — only terms
    // actually present in this chapter, never the whole book. Without this
    // the proofer can't see (or keep) the exact translations chosen earlier.
    let proofGlossary = cfg.glossary || {};
    if (!Object.keys(proofGlossary).length && cfg.inputDir) {
      proofGlossary = await loadGlossary(path.join(cfg.inputDir, 'glossary.txt'));
    }
    const glossMatches = findGlossaryMatches(englishText, proofGlossary);
    let glossBlock = '';
    if (glossMatches.length) {
      glossBlock = '### GLOSSARY FOR THIS CHAPTER (these exact translations were already used - keep them identical in the final text):\n';
      glossMatches.forEach(({ en, fa }) => { glossBlock += `- ${en} -> ${fa}\n`; });
      glossBlock += '\n\n\n';
    }

    const enFp = makeFingerprints(englishText);
    const faFp = makeFingerprints(farsiText);

    const body = `${glossBlock}انگلیسی:\n${englishText}\n\n\n\nفارسی:\n${farsiText}`;
    const finalPrompt = (cfg.promptMode === 2 && cfg.prompt)
      ? `${cfg.prompt}\n\n${body}`
      : body;

    const labelWords = countWords('انگلیسی: فارسی:');
    const promptWords = (cfg.promptMode === 2 && cfg.prompt) ? countWords(cfg.prompt) : 0;
    const glossWords = countWords(glossBlock);
    const expectedWords = enWords + faWords + labelWords + promptWords + glossWords;
    const finalWords = countWords(finalPrompt);

    const fingerprintOk =
      finalPrompt.includes(enFp.start) &&
      finalPrompt.includes(enFp.end) &&
      finalPrompt.includes(faFp.start) &&
      finalPrompt.includes(faFp.end);

    const wordTolerance = Math.max(5, Math.ceil(expectedWords * 0.01));
    const wordOk = Math.abs(finalWords - expectedWords) <= wordTolerance;

    log.trace(`[proof] payload check expected=${expectedWords}w final=${finalWords}w gloss=${glossMatches.length} fingerprints=${fingerprintOk ? 'ok' : 'fail'}`);

    if (!wordOk || !fingerprintOk) {
      const reason = `PROOF_PAYLOAD_MISMATCH expected=${expectedWords} final=${finalWords} fingerprints=${fingerprintOk ? 'ok' : 'fail'}`;
      log.error(`[${file}] Proof payload mismatch. Logging and skipping.`);
      await logFailedChapterSafe(cfg.outDir, file, reason);
      return;
    }

    if (cfg.promptMode === 1 && cfg.prompt) {
      log.trace(`[proof] sending initial prompt...`);
      try {
        await withTimeout(
          pasteAndGetResult(page, cfg.bot, cfg.prompt, cfg.isThinking, log, taskId),
          cfg.isThinking ? 600000 : 300000,
          'HARD_TIMEOUT: Initial prompt > limit (5min, 10min for thinking models).'
        );

        const waitSec = cfg.chunkDelay || 5;
        log.trace(`[proof] initial prompt done, waiting ${waitSec}s`);
        await page.waitForTimeout(waitSec * 1000);
      } catch (err) {
        const msg = err.message || String(err);

        if (msg.includes('FATAL_API_ERROR') || msg.includes('FATAL_MODEL_RATE_LIMIT')) {
          log.error(`[${file}] FATAL ERROR: ${msg}. Stopping task.`);
          await logFailedChapterSafe(cfg.outDir, file, msg);
          throw err;
        }
        if (msg === 'TASK_CANCELLED') throw err;
        if (msg.includes('closed') || msg.includes('Target page, context or browser')) throw err;

        if (msg === 'PASTE_TRUNCATED') {
          log.error(`[${file}] Initial prompt paste truncated. Logging and skipping.`);
          await logFailedChapterSafe(cfg.outDir, file, 'PASTE_TRUNCATED');
          return;
        }

        log.error(`[${file}] Initial proof prompt failed: ${msg}`);
        await logFailedChapterSafe(cfg.outDir, file, `PROOF_INITIAL_FAILED: ${msg}`);
        return;
      }
    }

    if (cfg.bot.verifyModel) await cfg.bot.verifyModel(page, cfg.selectedModel, log);

    let proofResult = '';
    let success = false;
    let retries = MAX_CHUNK_RETRIES;

    while (!success && retries >= 0) {
      try {
        log.step(`[${file}] Sending full proof payload (${finalWords} words)... (try ${MAX_CHUNK_RETRIES - retries + 1})`);
        proofResult = await pasteAndGetResult(page, cfg.bot, finalPrompt, cfg.isThinking, log, taskId);

        const outWords = countTextWords(proofResult);

        if (!proofResult.trim() || outWords === 0) {
          throw new Error('OUTPUT_TOO_SHORT: Proof response empty.');
        }

        // Dynamic limit: Expect at least 35% of the original Farsi word count
        const minExpected = Math.max(10, Math.floor(faWords * 0.35));
        if (faWords > 0 && outWords < minExpected) {
          throw new Error(`OUTPUT_TOO_SHORT: Proof returned ${outWords}w, expected >= ${minExpected}w`);
        }

        success = true;
      } catch (err) {
        const msg = err.message || String(err);

        if (msg.includes('FATAL_API_ERROR') || msg.includes('FATAL_MODEL_RATE_LIMIT')) {
          log.error(`[${file}] FATAL ERROR: ${msg}. Stopping task.`);
          await logFailedChapterSafe(cfg.outDir, file, msg);
          throw err;
        }

        if (msg === 'TASK_CANCELLED') throw err;
        if (msg.includes('closed') || msg.includes('Target page, context or browser')) throw err;

        // --- NEW: Smart Escalation for short text or truncations ---
        if (msg.includes('OUTPUT_TOO_SHORT') || msg === 'PASTE_TRUNCATED') {
          if (retries === 0) {
            if (msg === 'PASTE_TRUNCATED') {
              log.error(`[${file}] Text paste truncated. Logging to failed chapters and skipping.`);
              await logFailedChapterSafe(cfg.outDir, file, 'PASTE_TRUNCATED');
              fileSkipped = true;
              break; 
            } else {
              throw new Error(`Chunk ${i + 1} permanent fail: ${msg}`);
            }
          }
          
          // If we have MAX retries, do a SOFT retry (stay in same chat)
          if (retries === MAX_CHUNK_RETRIES) {
            log.warn(`[${file}] Chunk ${i + 1}: ${msg}. Soft retrying in same chat...`);
            retries--;
            await page.waitForTimeout(3500);
            continue; // Skips the page.reload() logic below!
          }
          
          // If soft retry failed previously, fall through to HARD retry (reload page)
          log.warn(`[${file}] Chunk ${i + 1}: ${msg}. Soft retry failed. Escalating to Hard Reload...`);
        }
        // ----------------------------------------------------------------------
        
        log.warn(`[${file}] Failed: ${msg}`);
        if (retries === 0) throw new Error(`Chunk ${i + 1} permanent fail: ${msg}`);
        retries--;

        // Hard Retry (Network issues, etc.) -> Reloads page
        const wt = msg.includes('API_ERROR') ? 65000 : 5000;

        // Standard hard error fallback
        log.error(`[${file}] Proof failed: ${msg}`);
        await logFailedChapterSafe(cfg.outDir, file, `PROOF_FAILED: ${msg}`);
        return;
      }
    }

    const outWords = countTextWords(proofResult);

    if (!proofResult.trim() || outWords === 0) {
      log.error(`[${file}] Proof response empty. Logging and skipping.`);
      await logFailedChapterSafe(cfg.outDir, file, 'PROOF_RESPONSE_EMPTY');
      return;
    }

    if (faWords > 0 && outWords < Math.floor(faWords * 0.35)) {
      log.warn(`[${file}] Proof response seems short: out=${outWords}w, fa=${faWords}w. Saving anyway.`);
    }

    const paragraphs = proofResult
      .replace(/&nbsp;/g, ' ')
      .replace(/\r\n/g, '\n')
      .split(/\n+/)
      .map(s => s.trim())
      .filter(Boolean);

    const jsonFile = file.replace(/\.[^.]+$/, '.json');

    await fs.writeFile(
      path.join(cfg.outDir, jsonFile),
      JSON.stringify({
        id: `${cfg.bookName}_${(file.match(/\d+/) || ['0'])[0]}`,
        paragraphs
      }, null, 2),
      'utf-8'
    );

    log.trace(`[proof] saved → ${path.join(cfg.outDir, jsonFile)} (${paragraphs.length} paragraphs, ${outWords} words)`);
    log.success(`[${file}] Proof read saved.`);
    return;
  }

  const raw = await readSourceText(cfg.srcDir, file);
  log.trace(`[file] ${raw.length} chars`);

  let chunksArr = [];
  if (cfg.mode === 'glossary') {
    // Split by single newline for glossaries to avoid breaking key-value pairs
    const lines = raw.split('\n');
    let cur = [], cnt = 0;
    for (const line of lines) {
      const wc = line.split(/\s+/).filter(Boolean).length;
      if (cnt + wc > cfg.chunkSize && cur.length > 0) {
        chunksArr.push(cur.join('\n'));
        cur = [];
        cnt = 0;
      }
      cur.push(line);
      cnt += wc;
    }
    if (cur.length > 0) chunksArr.push(cur.join('\n'));
  } else {
    const chunks = raw.split(/\n\s*\n/).reduce((acc, p) => {
      const wc = p.split(/\s+/).length;
      if (acc.cnt + wc > cfg.chunkSize && acc.cur.length) {
        acc.res.push(acc.cur.join('\n\n'));
        acc.cur = [];
        acc.cnt = 0;
      }
      acc.cur.push(p);
      acc.cnt += wc;
      return acc;
    }, { res: [], cur: [], cnt: 0 });
    chunksArr = chunks.res;
    if (chunks.cur.length) chunksArr.push(chunks.cur.join('\n\n'));
  }
  log.trace(`[file] ${chunksArr.length} chunks`);

  // [NEW] Verify model before starting translation/editing chunks
  if (cfg.bot.verifyModel) {
    await cfg.bot.verifyModel(page, cfg.selectedModel, log);
  }

  if (cfg.promptMode === 1) {
    log.trace(`[file] initial prompt...`);
    await withTimeout(
      pasteAndGetResult(page, cfg.bot, cfg.prompt, cfg.isThinking, log, taskId),
      cfg.isThinking ? 600000 : 300000, 'HARD_TIMEOUT: Initial prompt > limit (5min, 10min for thinking models).'
    );
    log.trace(`[file] initial done, wait ${cfg.chunkDelay}s`);
    await page.waitForTimeout(cfg.chunkDelay * 1000);
  }

  const results = [];
  let fileSkipped = false;
  for (let i = 0; i < chunksArr.length; i++) {
    if (!activeTasks.has(taskId)) throw new Error('TASK_CANCELLED');
    // Only steal focus if the page lost it — constant bringToFront fights
    // between parallel tabs are themselves a signal. Jittered either way.
    await page.bringToFront().catch(() => { });
    await page.waitForTimeout(jitter(500));

    let success = false, retries = MAX_CHUNK_RETRIES, out = '';
    while (!success && retries >= 0) {
      if (!activeTasks.has(taskId)) throw new Error('TASK_CANCELLED');
      log.step(`[${file}] Chunk ${i + 1}/${chunksArr.length} (try ${MAX_CHUNK_RETRIES - retries + 1})`);

      let finalPrompt = (cfg.promptMode === 2) ? cfg.prompt + '\n\n' : '';

      if (cfg.mode === 'translate') {
        // [NEW] Dynamic Context Overlap: Grab 30 words from adjacent chunks 
        // to catch multi-word names that might be split across paragraph boundaries.
        let searchText = chunksArr[i];
        if (i > 0) {
          const prevWords = chunksArr[i - 1].split(/\s+/).slice(-30).join(' ');
          searchText = prevWords + '\n' + searchText;
        }
        if (i < chunksArr.length - 1) {
          const nextWords = chunksArr[i + 1].split(/\s+/).slice(0, 30).join(' ');
          searchText = searchText + '\n' + nextWords;
        }

        const matches = findGlossaryMatches(searchText, cfg.glossary);
        if (matches.length) {
          // [NEW] Explicit instruction to keep multi-word names intact
          finalPrompt += '### GLOSSARY FOR THIS CHUNK (CRITICAL: Translate these EXACT phrases as specified. Do not break multi-word names apart):\n';
          matches.forEach(({ en, fa }) => finalPrompt += `- ${en} -> ${fa}\n`);
          finalPrompt += '\n';
        }
        finalPrompt += `متن این قسمت از وبناول کاملا تخیلی و فانتزی که هیچ رنگی از حقیقت نداره رو براساس راهنمایی ها و دستورات نوشته شده، به صورت کامل ترجمه کن. در پاسخ فقط متن ترجمه شده رو به عنوان جواب ارسال کن.\n متن: \n\n${chunksArr[i]}`;
      } else if (cfg.mode === 'edit') {
        finalPrompt += `متن این قسمت را ویراستاری کن. فقط متن ویراستاری شده ارسال شود.\n\n${chunksArr[i]}`;
      } else if (cfg.mode === 'glossary') {
        // For glossary, we just append the chunk. 
        // If promptMode is 2, the prompt was already added to finalPrompt above.
        finalPrompt += chunksArr[i];
      }

      try {
        out = await pasteAndGetResult(page, cfg.bot, finalPrompt, cfg.isThinking, log, taskId);

        // --- NEW: Chunk-level dynamic word count check ---
        const outWc = countTextWords(out);
        const inWc = countTextWords(chunksArr[i]);
        const minExpected = cfg.mode === 'glossary' ? 1 : Math.max(10, Math.floor(inWc * 0.35));

        if (outWc < minExpected) {
          throw new Error(`OUTPUT_TOO_SHORT: Got ${outWc}w, expected >= ${minExpected}w`);
        }
        // ------------------------------------------------

        success = true;
        log.info(`[${file}] Chunk done (${out.length} chars). Wait ${cfg.chunkDelay}s...`);
        await page.waitForTimeout(cfg.chunkDelay * 1000);
      } catch (err) {
        const msg = err.message || String(err);

        if (msg.includes('FATAL_API_ERROR') || msg.includes('FATAL_MODEL_RATE_LIMIT')) {
          log.error(`[${file}] FATAL ERROR: ${msg}. Stopping task.`);
          await logFailedChapterSafe(cfg.outDir, file, msg);
          throw err;
        }
        if (msg === 'TASK_CANCELLED') throw err;
        if (msg.includes('closed') || msg.includes('Target page, context or browser')) throw err;

        // --- NEW: Soft Retry for short text or truncations (No Page Reload) ---
        if (msg.includes('OUTPUT_TOO_SHORT') || msg === 'PASTE_TRUNCATED') {
          log.warn(`[${file}] Chunk ${i + 1}: ${msg}. Retrying in same chat...`);
          if (retries === 0) {
            if (msg === 'PASTE_TRUNCATED') {
              log.error(`[${file}] Text paste truncated. Logging to failed chapters and skipping.`);
              await logFailedChapterSafe(cfg.outDir, file, 'PASTE_TRUNCATED');
              fileSkipped = true;
              break; // Break the while loop
            } else {
              throw new Error(`Chunk ${i + 1} permanent fail: ${msg}`);
            }
          }
          retries--;
          await page.waitForTimeout(3500);
          continue; // Skips the page.reload() logic below!
        }
        // ----------------------------------------------------------------------

        log.warn(`[${file}] Failed: ${msg}`);
        if (retries === 0) throw new Error(`Chunk ${i + 1} permanent fail: ${msg}`);
        retries--;

        // Hard Retry (Network issues, etc.) -> Reloads page
        const wt = msg.includes('API_ERROR') ? 65000 : 5000;
        log.trace(`[file] retry in ${wt / 1000}s...`);
        await page.waitForTimeout(wt);

        log.trace(`[file] reload...`);
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(4000);
          if (cfg.bot.setup) await cfg.bot.setup(page, cfg.selectedModel, log);
          await page.waitForTimeout(2000);
        } catch (re) { log.warn(`[${file}] reload fail: ${re.message}`); }
      }
    }
    if (fileSkipped) break;
    results.push(out);
  }

  if (fileSkipped) {
    log.warn(`[${file}] Skipped file due to paste issues.`);
    return;
  }

  // Join with simple newline for glossaries to preserve list format, otherwise use separators
  const full = results.join(cfg.mode === 'glossary' ? '\n' : '\n\n---\n\n').trim();
  const wc = countTextWords(full);

  if (wc === 0) throw new Error(`Final combined output is empty.`);

  if (cfg.mode === 'translate' || cfg.mode === 'edit' || cfg.mode === 'glossary') {
    const outFile = file.endsWith('.json') ? file.replace('.json', '.txt') : file;
    await fs.writeFile(path.join(cfg.outDir, outFile), full, 'utf-8');
    log.trace(`[file] saved txt → ${path.join(cfg.outDir, outFile)}`);
  }

  log.success(`[${file}] Saved.`);
}

// ==========================================
// -- TASK ENGINE --
// ==========================================
async function runTask(task, log) {
  log.info(`Start: ${task.bookName} (${task.mode}) → ${task.profile.name} [${task.concurrentTabs} tab(s)]`);

  let browser, ctx, isReconnecting = false;
  let fileQueue = [...task.files];
  let isPaused = false;
  let fatalErrorsCount = 0;

  const connectBrowser = async () => {
    if (browser) await browser.close().catch(() => { });
    await launchChrome(task.profile.userDataDir, task.profile.port, log);
    let retries = 5;
    while (retries > 0) {
      try {
        browser = await chromium.connectOverCDP(`http://localhost:${task.profile.port}`);
        ctx = browser.contexts()[0];
        log.trace(`[connect] OK`);
        return;
      } catch (e) {
        retries--;
        log.trace(`[connect] fail (${retries} left): ${e.message}`);
        if (retries === 0) throw e;
        await sleep(3000);
      }
    }
  };

  try { await connectBrowser(); }
  catch (e) { log.error(`Chrome connect fail: ${e.message}`); activeTasks.delete(task.id); return; }

  const startWorker = async (wid) => {
    while (fileQueue.length > 0 && activeTasks.has(task.id)) {
      if (isReconnecting || isPaused) { await sleep(2000); continue; }
      const file = fileQueue.shift();
      if (!file) break;

      let page;
      try {
        log.info(`[W${wid}] ${file}`);
        page = await ctx.newPage();
        // Stealth FIRST (webdriver mask + human viewport), before goto().
        // Supervision (telemetry, timeouts, retries) below is untouched.
        await applyStealth(page, log);
        // --- NEW TELEMETRY LOGS ---
        page.on('console', msg => {
          const type = msg.type();
          if (type === 'error' || type === 'warning') {
            log.trace(`[Browser ${type.toUpperCase()}] ${msg.text().substring(0, 150)}`);
          }
        });

        page.on('response', async (response) => {
          const url = response.url();
          // Watch for the actual generation API calls Gemini makes
          if (url.includes('/generate') || url.includes('/chat') || url.includes('StreamGenerate')) {
            log.trace(`[Network] API Response: ${response.status()} from ${url.split('?')[0].split('/').pop()}`);
            if (response.status() >= 400) {
              log.error(`[Network] HTTP ${response.status()} on generation endpoint!`);
            }
          }
        });
        // --------------------------
        page.setDefaultTimeout(180000);
        await page.goto(task.bot.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
        await page.waitForTimeout(jitter(4000, 0.3));
        await page.bringToFront().catch(() => { });

        if (task.bot.setup) await task.bot.setup(page, task.selectedModel, log);
        if (task.bot.verifyModel) await task.bot.verifyModel(page, task.selectedModel, log);

        await processFile(page, file, task, log, task.id);
      } catch (e) {
        const msg = e.message || '';

        // Halt everything if a fatal API error or model rate limit was thrown
        if (msg.includes('FATAL_API_ERROR') || msg.includes('FATAL_MODEL_RATE_LIMIT')) {
          log.error(`[W${wid}] FATAL ERROR DETECTED (${msg}).`);
          fileQueue.unshift(file); // Put the file back in the queue to try again later
          
          if (!isPaused) {
            isPaused = true;
            fatalErrorsCount++;
            
            if (fatalErrorsCount === 1) {
              log.warn(`[Sys] RATE LIMIT HIT (Strike 1). Closing browser and pausing task for 15 minutes...`);
              if (browser) await browser.close().catch(()=>{});
              await sleep(15 * 60 * 1000); // 15 minutes
              log.success(`[Sys] Resuming task after 15m pause.`);
              await connectBrowser();
              isPaused = false;
            } 
            else if (fatalErrorsCount === 2) {
              log.warn(`[Sys] RATE LIMIT HIT AGAIN (Strike 2). Closing browser and pausing for 30 minutes...`);
              if (browser) await browser.close().catch(()=>{});
              await sleep(30 * 60 * 1000); // 30 minutes
              log.success(`[Sys] Resuming task after 30m pause.`);
              await connectBrowser();
              isPaused = false;
            } 
            else {
              log.error(`[Sys] RATE LIMIT HIT 3 TIMES (Strike 3). Halting all processing.`);
              fileQueue.length = 0;
              activeTasks.delete(task.id);
              break;
            }
          }
          continue; // Go to the next iteration of the while loop (will block at `isPaused`)
        }

        if (msg === 'TASK_CANCELLED') { log.trace(`[W${wid}] cancelled`); break; }
        if (msg.includes('closed') || msg.includes('Target page, context or browser')) {
          log.warn(`[W${wid}] crash, requeue ${file}`);
          fileQueue.unshift(file);
          if (!isReconnecting) {
            isReconnecting = true;
            try { await connectBrowser(); log.success('[Sys] Reconnected'); }
            catch (re) { log.error(`[Sys] Reconnect fail: ${re.message}`); await sleep(5000); }
            finally { isReconnecting = false; }
          }
        } else {
          log.error(`Failed ${file}: ${msg}`);
          await logFailedChapterSafe(task.outDir, file, msg);
        }
      } finally {
        if (page && !isReconnecting) await page.close().catch(() => { });
      }
    }
  };

  try {
    const workers = [];
    for (let i = 0; i < task.concurrentTabs; i++) { workers.push(startWorker(i + 1)); await sleep(rand(2500, 5000)); }
    await Promise.all(workers);
    if (activeTasks.has(task.id)) log.success('All done!');
  } catch (err) { log.error(`Sys: ${err.message}`); }
  finally {
    if (browser) await browser.close().catch(() => { });
    activeTasks.delete(task.id);
  }
}

// ==========================================
// -- API --
// ==========================================
app.get('/api/config', async (req, res) => {
  await fs.mkdir(BASE_INPUT_DIR, { recursive: true });
  await fs.mkdir(BASE_OUTPUT_DIR, { recursive: true });
  await fs.mkdir(PROMPTS_DIR, { recursive: true });
  await fs.mkdir(path.join(BASE_OUTPUT_DIR, 'translate'), { recursive: true });
  await fs.mkdir(path.join(BASE_OUTPUT_DIR, 'edited'), { recursive: true });
  await fs.mkdir(path.join(BASE_OUTPUT_DIR, 'proofing'), { recursive: true });
  await fs.mkdir(path.join(BASE_INPUT_DIR, 'glossary'), { recursive: true });
  await fs.mkdir(path.join(BASE_OUTPUT_DIR, 'glossary'), { recursive: true });

  let prompts = (await fs.readdir(PROMPTS_DIR)).filter(f => f.endsWith('.txt'));
  if (!prompts.length) {
    await fs.writeFile(path.join(PROMPTS_DIR, 'default.txt'),
      `translation_prompt:\nTranslate this.\n\neditorial_prompt:\nEdit this.\n\nproofing_prompt:\nProofread this.\n\nscoring_prompt:\nScore this translation from 0 to 100. Only return the number.`
    );
    prompts = ['default.txt'];
  }

  const gfPath = path.join(PROMPTS_DIR, 'glossary-filter.txt');
  try {
    await fs.access(gfPath);
  } catch {
    await fs.writeFile(gfPath, `Filter and trim this glossary to keep only the most essential terms.\n`);
    if (!prompts.includes('glossary-filter.txt')) prompts.push('glossary-filter.txt');
  }

  res.json({
    profiles: PROFILES,
    bots: Object.keys(BOT_MODELS),
    models: BOT_MODELS,
    prompts,
    inputBooks: await getFolders(BASE_INPUT_DIR),
    translateBooks: await getFolders(path.join(BASE_OUTPUT_DIR, 'translate')),
    editedBooks: await getFolders(path.join(BASE_OUTPUT_DIR, 'edited')),
    proofedBooks: await getFolders(path.join(BASE_OUTPUT_DIR, 'proofing')),
    glossaryFiles: await getFiles(path.join(BASE_INPUT_DIR, 'glossary')).catch(() => [])
  });
});

app.post('/api/check-missing', async (req, res) => {
  const { mode, bookName } = req.body;
  if (!bookName) return res.json({ missing: [] });

  const mc = MODE_CONFIG[mode];
  if (!mc) return res.json({ missing: [] });

  const srcDir = path.join(mc.srcBase(), bookName);
  const outDir = path.join(mc.outBase(), bookName);

  try {
    const sf = await getFiles(srcDir);
    const of = await getFiles(outDir).catch(() => []);

    const extractNum = (f) => parseInt((f.match(/(\d+)/g) || []).pop() || 0);
    const sn = sf.map(extractNum).filter(n => n > 0);
    const on = of.map(extractNum).filter(n => n > 0);

    res.json({ missing: sn.filter(n => !on.includes(n)).sort((a, b) => a - b) });
  } catch (e) { res.json({ missing: [], error: e.message }); }
});

app.post('/api/check-proof-insurance', async (req, res) => {
  const { bookName } = req.body;
  if (!bookName) return res.json({ redo: [], checked: 0, skippedNoEnglish: 0 });

  const proofDir = path.join(BASE_OUTPUT_DIR, 'proofing', bookName);
  const inputDir = path.join(BASE_INPUT_DIR, bookName);

  const getChapterNumber = (name) =>
    parseInt((name.match(/(\d+)/g) || []).pop() || '0');

  try {
    const proofFiles = (await getFiles(proofDir))
      .filter(f => f.toLowerCase().endsWith('.json'))
      .filter(f => f.toLowerCase() !== 'failed-chapters.json');

    const inputFiles = await getFiles(inputDir);

    const inputByNum = new Map();
    for (const f of inputFiles) {
      const n = getChapterNumber(f);
      if (n > 0 && !inputByNum.has(n)) {
        inputByNum.set(n, f);
      }
    }

    const redo = [];
    let checked = 0;
    let skippedNoEnglish = 0;

    for (const pf of proofFiles) {
      const n = getChapterNumber(pf);
      if (!n) continue;

      const enFile = inputByNum.get(n);
      if (!enFile) {
        skippedNoEnglish++;
        continue;
      }

      const proofText = await readProofText(path.join(proofDir, pf));
      const enText = await readSourceText(inputDir, enFile);

      const proofWords = countTextWords(proofText);
      const enWords = countTextWords(enText);

      checked++;

      const diff = Math.abs(proofWords - enWords);

      if (proofWords === 0 || enWords === 0 || diff > 700) {
        redo.push(n);
      }
    }

    redo.sort((a, b) => a - b);

    res.json({ redo, checked, skippedNoEnglish });
  } catch (e) {
    res.json({ redo: [], checked: 0, skippedNoEnglish: 0, error: e.message });
  }
});

app.post('/api/start', async (req, res) => {
  const data = req.body;
  const taskId = crypto.randomUUID();
  const profile = PROFILES.find(p => p.id === data.profileId);
  const botCfg = BOT_CONFIGS[data.botName];

  if (Array.from(activeTasks.values()).some(t => t.profile.id === profile.id))
    return res.status(400).json({ error: 'Profile in use.' });

  const mc = MODE_CONFIG[data.mode];
  if (!mc) return res.status(400).json({ error: 'Invalid mode.' });

  // For glossary mode, bookName is the file itself, not a subfolder
  const srcDir = data.mode === 'glossary' ? mc.srcBase() : path.join(mc.srcBase(), data.bookName);
  const outDir = data.mode === 'glossary' ? mc.outBase() : path.join(mc.outBase(), data.bookName);
  await fs.mkdir(outDir, { recursive: true });

  const files = await parseRange(data.chapters, srcDir, outDir);
  if (!files.length) return res.status(400).json({ error: 'No files matched.' });

  let glossary = {};
  if (data.mode === 'translate' || data.mode === 'auto') {
    glossary = await loadGlossary(path.join(srcDir, 'glossary.txt'));
  } else if (data.mode === 'proof') {
    // Standalone proof never had the glossary — load it from the raw input
    // book dir (same file the translate step uses).
    glossary = await loadGlossary(path.join(BASE_INPUT_DIR, data.bookName, 'glossary.txt'));
  }

  const rawPrompt = await fs.readFile(path.join(PROMPTS_DIR, data.promptFile), 'utf-8').catch(() => '');
  const t = rawPrompt.match(/translation_prompt:\s*([\s\S]*?)(?=\n\s*(?:editorial_prompt|proofing_prompt|scoring_prompt):|$)/i);
  const e = rawPrompt.match(/editorial_prompt:\s*([\s\S]*?)(?=\n\s*(?:translation_prompt|proofing_prompt|scoring_prompt):|$)/i);
  const p = rawPrompt.match(/proofing_prompt:\s*([\s\S]*?)(?=\n\s*(?:translation_prompt|editorial_prompt|scoring_prompt):|$)/i);
  const s = rawPrompt.match(/scoring_prompt:\s*([\s\S]*?)(?=\n\s*(?:translation_prompt|editorial_prompt|proofing_prompt):|$)/i);

  let promptText = '';
  if (data.mode === 'glossary') {
    try {
      promptText = (await fs.readFile(path.join(PROMPTS_DIR, 'glossary-filter.txt'), 'utf-8')).trim();
    } catch (err) {
      promptText = '';
    }
  } else if (data.mode === 'translate') promptText = t ? t[1].trim() : '';
  else if (data.mode === 'auto') promptText = t ? t[1].trim() : '';
  else if (data.mode === 'edit') promptText = e ? e[1].trim() : '';
  else if (data.mode === 'proof') promptText = p ? p[1].trim() : '';
  else if (data.mode === 'score') promptText = s ? s[1].trim() : '';

  // Autopilot carries all three stage prompts; processFileAuto picks per stage.
  const stagePrompts = {
    translate: t ? t[1].trim() : '',
    edit: e ? e[1].trim() : '',
    proof: p ? p[1].trim() : ''
  };

  const inputDir = (data.mode === 'proof' || data.mode === 'score' || data.mode === 'auto') ? path.join(BASE_INPUT_DIR, data.bookName) : null;

  const taskDef = {
    id: taskId, mode: data.mode, profile, bookName: data.bookName, srcDir, outDir, files,
    bot: botCfg, botName: data.botName, selectedModel: data.model,
    promptMode: parseInt(data.promptMode), prompt: promptText, prompts: stagePrompts,
    // Reasoning models (Gemini Flash/Pro, Qwen Thinking, DeepSeek Expert) think
    // 60-90s before/within answers — they get the patient wait profile in
    // pasteAndGetResult. Never gate patience on speed alone.
    isThinking: ['thinking', 'expert', 'pro', 'flash-light', 'light'].includes(data.model),
    chunkSize: parseInt(data.chunkSize) || 1000, chunkDelay: parseInt(data.chunkDelay) || 20,
    concurrentTabs: parseInt(data.concurrentTabs) || 1, glossary, inputDir
  };

  activeTasks.set(taskId, taskDef);
  runTask(taskDef, createLogger(taskId));
  res.json({ taskId, message: 'Started', title: `${data.mode === 'auto' ? 'AUTO ✈' : data.mode.toUpperCase()}: ${data.bookName} (${files.length} ch) → ${data.botName}` });
});


app.delete('/api/stop/:taskId', (req, res) => {
  if (activeTasks.has(req.params.taskId)) {
    activeTasks.delete(req.params.taskId);
    createLogger(req.params.taskId).warn('Stop requested — halting at next checkpoint.');
  }
  res.json({ success: true });
});

server.listen(PORT, () => console.log(`\nUI: http://localhost:${PORT}\n`));