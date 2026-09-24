// server.js (complete and fixed)
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

let mammoth = null;
try { mammoth = require('mammoth'); } catch (e) { /* optional dependency */ }

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ===================== config ===================== */
const BOOKS_DIR   = path.join(__dirname, 'books');
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const PROMPT_FILE = path.join(PROMPTS_DIR, 'formal.txt');
const STATE_FILE  = '_state.json';
const EXTS        = ['.txt', '.md', '.docx'];

const CHROME_PROFILES = [
    { name: 'farhadking', dir: 'C:\\chrome-dev-profile',   port: 9225 },
    { name: 'farhad.oo',  dir: 'C:\\chrome-dev-profile-1', port: 9227 },
    { name: 'farzincook', dir: 'C:\\chrome-dev-profile-2', port: 9223 }
];

fs.ensureDirSync(BOOKS_DIR);
fs.ensureDirSync(PROMPTS_DIR);

/* ===================== helpers ===================== */
const isChapterFile = f => EXTS.includes(path.extname(f).toLowerCase())
    && path.basename(f).toLowerCase() !== 'glossary.txt';
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const countWords = t => (t || '').trim().split(/\s+/).filter(Boolean).length;
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function readAnyText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.docx') {
        if (!mammoth) throw new Error('mammoth برای خواندن docx نصب نیست');
        const r = await mammoth.extractRawText({ path: filePath });
        return r.value || '';
    }
    return await fs.readFile(filePath, 'utf8');
}

const bookDir  = book => path.join(BOOKS_DIR, book);
const safeName = name => String(name || '').replace(/[\\/]/g, '').replace(/\.\./g, '');
// Worker (chrome profile) identity for parallel dispatch. Assigned jobs stick
// to their owner; unassigned jobs can be taken by anyone.
const normWorker = w => {
    const s = String(w || '').trim().slice(0, 64);
    if (!s) return null;
    if (!/^[A-Za-z0-9_.\-@\u0600-\u06FF ]+$/.test(s)) return null;
    return s;
};

async function readState(bDir) {
    const p = path.join(bDir, 'translated', STATE_FILE);
    try { if (await fs.pathExists(p)) return await fs.readJson(p); } catch (e) { /* ignore */ }
    return {};
}

async function writeState(bDir, state) {
    // Fail-safe slimming: move any legacy full texts into draft files first.
    // If migration of an entry fails, the entry is kept as-is (never lose text).
    for (const [name, entry] of Object.entries(state || {})) {
        if (entry && (entry.inputTranslation || entry.editedText || entry.finalText || entry.saveText)) {
            try { state[name] = await migrateEntryToDrafts(bDir, name, entry); }
            catch (e) { /* keep original entry */ }
        }
    }
    const dir = path.join(bDir, 'translated');
    await fs.ensureDir(dir);
    await fs.writeJson(path.join(dir, STATE_FILE), state, { spaces: 2 });
}

/* ---- slim state: stage texts live in per-chapter draft files, _state.json
   keeps only metadata: step, stage (none|translate|edit|proof|done), word
   counts, tr flags. ---- */
const DRAFT_KINDS = ['translation', 'edited', 'final', 'save'];
const draftPath = (bDir, name, kind) =>
    path.join(bDir, 'translated', '_drafts', name + '.' + kind + '.txt');

async function readDraft(bDir, name, kind) {
    try {
        const p = draftPath(bDir, name, kind);
        if (await fs.pathExists(p)) return await fs.readFile(p, 'utf8');
    } catch (e) { /* ignore */ }
    return '';
}

async function writeDraft(bDir, name, kind, text) {
    if (!String(text || '').trim()) return false; // never wipe a draft with empty text
    await fs.ensureDir(path.dirname(draftPath(bDir, name, kind)));
    await fs.writeFile(draftPath(bDir, name, kind), String(text), 'utf8');
    return true;
}

async function removeDrafts(bDir, name) {
    for (const kind of DRAFT_KINDS) {
        try { await fs.remove(draftPath(bDir, name, kind)); } catch (e) { /* ignore */ }
    }
}

/* Full stage texts: drafts first, legacy state fields second. */
async function stageTexts(bDir, name, cur) {
    cur = cur || {};
    const final = (await readDraft(bDir, name, 'final')) || cur.finalText || '';
    const save = (await readDraft(bDir, name, 'save')) || cur.saveText || final;
    return {
        inputTranslation: (await readDraft(bDir, name, 'translation')) || cur.inputTranslation || '',
        editedText: (await readDraft(bDir, name, 'edited')) || cur.editedText || '',
        finalText: final,
        saveText: save
    };
}

/* Word counts per stage: stored counts first, then legacy texts, then drafts. */
async function stageWordCounts(bDir, name, cur) {
    cur = cur || {};
    let tw = Number(cur.transWords) || 0;
    let ew = Number(cur.editedWords) || 0;
    let fw = Number(cur.finalWords) || 0;
    if (!tw) tw = countWords(cur.inputTranslation || '');
    if (!ew) ew = countWords(cur.editedText || '');
    if (!fw) fw = countWords(cur.finalText || cur.saveText || '');
    if (!tw) tw = countWords(await readDraft(bDir, name, 'translation'));
    if (!ew) ew = countWords(await readDraft(bDir, name, 'edited'));
    if (!fw) fw = countWords((await readDraft(bDir, name, 'final')) || (await readDraft(bDir, name, 'save')));
    return { tw, ew, fw };
}

const STAGE_RANK = { none: 0, translate: 1, edit: 2, proof: 3, done: 4 };
function stageForStep(step, done) {
    if (done) return 'done';
    if (step >= 3) return 'proof';
    if (step >= 2) return 'edit';
    if (step >= 1) return 'translate';
    return 'none';
}

/* One-time migration of a legacy entry (full texts inside _state.json):
   flush texts to drafts (verified), then return a slim metadata entry. */
async function migrateEntryToDrafts(bDir, name, entry) {
    const pairs = [
        ['translation', entry.inputTranslation],
        ['edited', entry.editedText],
        ['final', entry.finalText],
        ['save', entry.saveText]
    ];
    for (const [kind, text] of pairs) {
        if (String(text || '').trim() && !(await readDraft(bDir, name, kind)).trim()) {
            await writeDraft(bDir, name, kind, text);
        }
    }
    // Verify: every non-empty legacy text must now be readable back.
    for (const [kind, text] of pairs) {
        if (String(text || '').trim()) {
            const back = await readDraft(bDir, name, kind);
            if (back.trim().length !== String(text).trim().length) throw new Error('draft verify failed:' + kind);
        }
    }
    const slim = { ...entry };
    delete slim.inputTranslation; delete slim.editedText;
    delete slim.finalText; delete slim.saveText;
    slim.transWords = countWords(entry.inputTranslation || '');
    slim.editedWords = countWords(entry.editedText || '');
    slim.finalWords = countWords(entry.finalText || entry.saveText || '');
    if (!slim.stage) slim.stage = stageForStep(slim.step || 0, slim.done);
    return slim;
}

async function listChapterFiles(bDir) {
    const all = await fs.readdir(bDir);
    const out = [];
    for (const f of all) {
        if (!isChapterFile(f)) continue;
        const st = await fs.stat(path.join(bDir, f));
        if (st.isFile()) out.push(f);
    }
    return out.sort(naturalSort);
}

function normKey(name) {
    const digits = (String(name).match(/\d+/g) || []).join('');
    if (digits) return 'n' + digits;
    return 's' + String(name).toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g, '');
}

/* find a ready-made translation inside books/<book>/tr for a chapter */
async function findTr(bDir, chapterName) {
    const trDir = path.join(bDir, 'tr');
    if (!await fs.pathExists(trDir)) return null;
    const all = await fs.readdir(trDir);
    const files = [];
    for (const f of all) {
        if (!isChapterFile(f)) continue;
        const st = await fs.stat(path.join(trDir, f));
        if (st.isFile()) files.push(f);
    }
    if (!files.length) return null;

    const exact = files.find(f => path.parse(f).name === chapterName);
    if (exact) return path.join(trDir, exact);

    const byName = files.find(f => path.parse(f).name.toLowerCase() === String(chapterName).toLowerCase());
    if (byName) return path.join(trDir, byName);

    const key = normKey(chapterName);
    const byNum = files.find(f => normKey(path.parse(f).name) === key);
    if (byNum) return path.join(trDir, byNum);

    return null;
}

/* Pre-made translations in books/<book>/tr are RAW translations: they never
   went through edit/proof. When such a file exists for a chapter that has no
   inputTranslation in state yet, import it so the pipeline starts at EDIT
   instead of TRANSLATE. Returns true when something was imported. */
async function importTrIntoState(bDir, chapterName, state) {
    const cur = (state || {})[chapterName] || {};
    const w = await stageWordCounts(bDir, chapterName, cur);
    if (w.tw > 0) return false;
    const trPath = await findTr(bDir, chapterName);
    if (!trPath) return false;
    let text = '';
    try { text = await readAnyText(trPath); } catch (e) { return false; }
    if (!text.trim()) return false;
    await writeDraft(bDir, chapterName, 'translation', text);
    state[chapterName] = {
        ...cur,
        step: Math.max(cur.step || 0, 1),
        stage: 'translate',
        transWords: countWords(text),
        outWords: countWords(text),
        trImported: true,
        trFile: path.basename(trPath),
        updatedAt: new Date().toISOString()
    };
    return true;
}

async function readGlossary(bDir) {
    const p = path.join(bDir, 'glossary.txt');
    if (!await fs.pathExists(p)) return [];
    const txt = await fs.readFile(p, 'utf8');
    return txt.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.includes('->'))
        .map(l => {
            const parts = l.split('->');
            return { en: parts[0].trim(), fa: parts.slice(1).join('->').trim() };
        })
        .filter(x => x.en && x.fa);
}

function matchGlossary(glossary, text) {
    const hay = text || '';
    return glossary.filter(g => {
        try { return new RegExp('\\b' + escapeRegExp(g.en) + '\\b', 'i').test(hay); }
        catch (e) { return false; }
    });
}

/* shrink a text payload: drop blanks, markdown noise and extra spaces */
function compact(text) {
    return String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/`{1,3}/g, '')            // strip code fences / backticks
        .replace(/\*\*/g, '')
        .replace(/__{2,}/g, '')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^\s*[-*•]\s+/gm, '')
        .split('\n')
        .map(l => l.replace(/[ \t]{2,}/g, ' ').replace(/\u00a0/g, ' ').trim())
        .filter(l => l.length > 0)
        .join('\n');
}

/* ===================== prompts ===================== */
const DEFAULT_PROMPTS = {
    translation: [
        'تو یک مترجمٔ حرفه‌ای وب‌ناول‌های فانتزی هستی. متن انگلیسی زیر را کامل و بدون خلاصه‌سازی به فارسی روان، طبیعی و ادبی ترجمه کن.',
        '- نام‌های خاص و اصطلاحات را دقیقاً بر اساس واژه‌نامه (اگر داده شد) ترجمه کن و نام‌های چندکلمه‌ای را از هم جدا نکن.',
        '- لحن روایی و کشش داستان را حفظ کن.',
        '- تعداد پاراگراف‌ها را دقیقاً مثل متن اصلی نگه دار.',
        '- هیچ توضیح اضافه‌ای ننویس؛ در پاسخ فقط متن ترجمه‌شده را بفرست.'
    ].join('\n'),
    editorial: [
        'تو یک ویراستار حرفه‌ای متن فارسی هستی. ترجمهٔ زیر را ویرایش کن:',
        '- جمله‌ها را روان و خوش‌آهنگ کن، بدون تغییر معنا و بدون حذف محتوا.',
        '- ترجمه‌های تحت‌اللفظی و بوی ترجمه را از بین ببر.',
        '- لحن روایی را یکدست کن و نام‌های خاص را در کل متن یکسان نگه دار.',
        '- در پاسخ فقط متن ویرایش‌شده را بفرست.'
    ].join('\n'),
    proofing: [
        'تو بازبین نهایی ترجمهٔ وب‌ناول هستی. متن فارسی (FA) را با متن انگلیسی (EN) مقایسه کن:',
        '- جاافتادگی، حذف یا اضافه‌شدن پاراگراف را اصلاح کن.',
        '- اشتباهات معنایی، دستوری و نشانه‌گذاری را برطرف کن.',
        '- پیوستگی، خوانایی و لحن نهایی را تضمین کن.',
        '- در پاسخ فقط متن نهایی و کامل فارسی را بفرست.'
    ].join('\n')
};

function loadPrompts() {
    const out = { ...DEFAULT_PROMPTS };
    try {
        if (fs.existsSync(PROMPT_FILE)) {
            const c = fs.readFileSync(PROMPT_FILE, 'utf8');
            const t = c.match(/translation_prompt:\s*([\s\S]*?)(?=editorial_prompt:|proofing_prompt:|$)/i);
            const e = c.match(/editorial_prompt:\s*([\s\S]*?)(?=proofing_prompt:|translation_prompt:|$)/i);
            const p = c.match(/proofing_prompt:\s*([\s\S]*?)(?=translation_prompt:|editorial_prompt:|$)/i);
            if (t && t[1].trim()) out.translation = t[1].trim();
            if (e && e[1].trim()) out.editorial = e[1].trim();
            if (p && p[1].trim()) out.proofing = p[1].trim();
        }
    } catch (err) { console.error('prompt load error:', err.message); }
    return out;
}

app.get('/api/prompts', (req, res) => res.json(loadPrompts()));

/* ===================== chrome profiles ===================== */
function findChrome() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    const local = process.env.LOCALAPPDATA || '';
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        local ? path.join(local, 'Google\\Chrome\\Application\\chrome.exe') : null,
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ].filter(Boolean);
    for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ } }
    try {
        const { chromium } = require('playwright');
        const p = chromium.executablePath();
        if (p && fs.existsSync(p)) return p;
    } catch (e) { /* playwright optional */ }
    return null;
}

function portOnline(port) {
    return new Promise(resolve => {
        const s = net.connect({ port, host: '127.0.0.1' });
        const done = v => { try { s.destroy(); } catch (e) { /* ignore */ } resolve(v); };
        s.setTimeout(700);
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
        s.once('timeout', () => done(false));
    });
}

function launchProfile(p, exe) {
    const args = [
        '--user-data-dir=' + p.dir,
        '--remote-debugging-port=' + p.port,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--start-maximized',
        '--new-window'
    ];
    try { fs.ensureDirSync(p.dir); } catch (e) { /* ignore */ }
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.on('error', err => console.error('chrome launch error (' + p.name + '):', err.message));
    child.unref();
    return true;
}

app.get('/api/chrome/status', async (req, res) => {
    try {
        const exe = findChrome();
        const profiles = await Promise.all(CHROME_PROFILES.map(async p => ({
            name: p.name, dir: p.dir, port: p.port, online: await portOnline(p.port)
        })));
        res.json({ profiles, chromePath: exe || '' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chrome/launch', async (req, res) => {
    try {
        const exe = findChrome();
        if (!exe) return res.status(500).json({ error: 'مرورگر کروم/اج پیدا نشد. متغیر محیطی CHROME_PATH را تنظیم کن.' });
        const only = req.body && req.body.name;
        const wanted = only ? CHROME_PROFILES.filter(p => p.name === only) : CHROME_PROFILES;
        if (!wanted.length) return res.status(404).json({ error: 'پروفایل پیدا نشد' });
        wanted.forEach(p => { try { launchProfile(p, exe); } catch (e) { console.error(e.message); } });
        res.json({ success: true, message: wanted.length + ' پروفایل در حال باز شدن…', launched: wanted.map(p => p.name) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ===================== books ===================== */
app.get('/api/books', async (req, res) => {
    try {
        await fs.ensureDir(BOOKS_DIR);
        const items = (await fs.readdir(BOOKS_DIR)).sort(naturalSort);
        const books = [];
        for (const item of items) {
            const bDir = path.join(BOOKS_DIR, item);
            let st;
            try { st = await fs.stat(bDir); } catch (e) { continue; }
            if (!st.isDirectory()) continue;

            const chapters = await listChapterFiles(bDir);
            const trOut = path.join(bDir, 'translated');
            let doneCount = 0;
            if (await fs.pathExists(trOut)) {
                for (const c of chapters) {
                    if (await fs.pathExists(path.join(trOut, path.parse(c).name + '.json'))) doneCount++;
                }
            }
            const trSrc = path.join(bDir, 'tr');
            let trCount = 0;
            if (await fs.pathExists(trSrc)) {
                trCount = (await fs.readdir(trSrc)).filter(isChapterFile).length;
            }
            // trPending = chapters with a ready tr file that are NOT finished yet
            // and have no translation input yet -> they can start at EDIT.
            // (state-only check: counts/legacy fields; no draft reads here.)
            let trPending = 0;
            try {
                const st0 = await readState(bDir);
                for (const c of chapters) {
                    const nm = path.parse(c).name;
                    const isDone = await fs.pathExists(path.join(trOut, nm + '.json'));
                    if (isDone) continue;
                    const cur = st0[nm] || {};
                    const hasInput = (Number(cur.transWords) > 0) || !!((cur.inputTranslation || '').trim());
                    if (hasInput) continue;
                    if (await findTr(bDir, nm)) trPending++;
                }
            } catch (e) { /* ignore */ }
            const chapterCount = chapters.length;
            books.push({
                name: item,
                chapterCount,
                doneCount,
                trCount,
                trPending,
                hasGlossary: await fs.pathExists(path.join(bDir, 'glossary.txt')),
                percent: chapterCount ? Math.round(doneCount / chapterCount * 100) : 0,
                status: !chapterCount || doneCount <= 0 ? 'not-started'
                    : (doneCount >= chapterCount ? 'completed' : 'in-progress')
            });
        }
        res.json({ books });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/books/:book', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const bDir = bookDir(book);
        if (!await fs.pathExists(bDir)) return res.status(404).json({ error: 'کتاب پیدا نشد' });

        const files = await listChapterFiles(bDir);
        const state = await readState(bDir);
        const glossary = await readGlossary(bDir);

        const chapters = [];
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const name = path.parse(f).name;
            const done = await fs.pathExists(path.join(bDir, 'translated', name + '.json'));
            const tr = await findTr(bDir, name);
            const stt = state[name] || {};
            const hasInput = (Number(stt.transWords) > 0) || !!((stt.inputTranslation || '').trim());
            chapters.push({
                index: i,
                file: f,
                name,
                done,
                step: done ? 4 : (stt.step || 0),
                stage: done ? 'done' : (stt.stage || stageForStep(stt.step || 0, false)),
                outWords: Number(stt.outWords) || 0,
                hasTr: !!tr,
                trFile: tr ? path.basename(tr) : null,
                // tr can be used as step-1 input: chapter is able to start at EDIT
                trImportable: !done && !!tr && !hasInput,
                trImported: !!stt.trImported,
                // effective start stage for UI / robot hints
                startFrom: done ? 'done' : (hasInput || tr) ? 'edit' : 'translate'
            });
        }

        res.json({
            book,
            chapters,
            hasGlossary: glossary.length > 0,
            glossaryCount: glossary.length
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/books/:book/reset', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const trDir = path.join(bookDir(book), 'translated');
        if (await fs.pathExists(trDir)) {
            const files = await fs.readdir(trDir);
            for (const f of files) {
                if (f.toLowerCase().endsWith('.json')) await fs.remove(path.join(trDir, f));
            }
            await fs.remove(path.join(trDir, '_drafts'));
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Bulk-import ready-made tr translations as step-1 input.
   Chapters with tr files skip TRANSLATE and start at EDIT. */
app.post('/api/books/:book/import-tr', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const bDir = bookDir(book);
        if (!await fs.pathExists(bDir)) return res.status(404).json({ error: 'کتاب پیدا نشد' });
        const files = await listChapterFiles(bDir);
        const state = await readState(bDir);
        let imported = 0, skipped = 0;
        const only = req.body && Array.isArray(req.body.files) ? new Set(req.body.files.map(f => path.basename(f))) : null;
        for (const f of files) {
            if (only && !only.has(f)) continue;
            const name = path.parse(f).name;
            const done = await fs.pathExists(path.join(bDir, 'translated', name + '.json'));
            if (done) { skipped++; continue; }
            if (await importTrIntoState(bDir, name, state)) imported++;
            else skipped++;
        }
        await writeState(bDir, state);
        pushLog('server', 'info', 'tr bulk import', { book, imported, skipped });
        res.json({ success: true, imported, skipped });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Use the tr file of ONE chapter as its translation input (start at EDIT). */
app.post('/api/books/:book/chapter/:file/use-tr', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const file = path.basename(req.params.file);
        const bDir = bookDir(book);
        const name = path.parse(file).name;
        if (!await fs.pathExists(path.join(bDir, file))) return res.status(404).json({ error: 'فصل پیدا نشد' });
        const trPath = await findTr(bDir, name);
        if (!trPath) return res.status(404).json({ error: 'ترجمهٔ آماده‌ای در پوشهٔ tr پیدا نشد' });
        const text = await readAnyText(trPath);
        if (!text.trim()) return res.status(422).json({ error: 'فایل tr خالی است' });
        await writeDraft(bDir, name, 'translation', text);
        const state = await readState(bDir);
        state[name] = {
            ...(state[name] || {}),
            step: Math.max((state[name] || {}).step || 0, 1),
            stage: 'translate',
            transWords: countWords(text),
            outWords: countWords(text),
            trImported: true,
            trFile: path.basename(trPath),
            updatedAt: new Date().toISOString()
        };
        await writeState(bDir, state);
        pushLog('server', 'info', 'tr imported for chapter (starts at edit)', { book, chapter: name });
        res.json({ success: true, step: state[name].step, words: countWords(text) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* everything the workbench needs for one chapter */
app.get('/api/books/:book/chapter/:file/data', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const file = path.basename(req.params.file);
        const bDir = bookDir(book);
        const filePath = path.join(bDir, file);
        if (!await fs.pathExists(filePath)) return res.status(404).json({ error: 'فصل پیدا نشد' });

        const name = path.parse(file).name;
        const rawText = await readAnyText(filePath);
        const state = await readState(bDir);
        const stt = state[name] || {};
        const done = await fs.pathExists(path.join(bDir, 'translated', name + '.json'));
        const trPath = await findTr(bDir, name);
        const glossary = await readGlossary(bDir);

        const draftTexts = await stageTexts(bDir, name, stt);
        const words = await stageWordCounts(bDir, name, stt);
        res.json({
            book, file, name,
            rawText,
            rawWords: countWords(rawText),
            glossaryCount: matchGlossary(glossary, rawText).length,
            done,
            step: done ? 4 : (stt.step || 0),
            stage: done ? 'done' : (stt.stage || stageForStep(stt.step || 0, false)),
            words: {
                raw: countWords(rawText),
                input: words.tw,
                output: stt.outWords || words.fw || words.ew || words.tw || 0,
                trans: words.tw,
                edited: words.ew,
                final: words.fw
            },
            texts: {
                inputTranslation: draftTexts.inputTranslation,
                editedText: draftTexts.editedText,
                finalText: draftTexts.finalText,
                saveText: draftTexts.saveText
            },
            tr: trPath
                ? { exists: true, file: path.basename(trPath), text: await readAnyText(trPath) }
                : { exists: false, file: null, text: '' }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* raw chapter text */
app.get('/api/books/:book/chapter/:file/raw', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const file = path.basename(req.params.file);
        const p = path.join(bookDir(book), file);
        if (!await fs.pathExists(p)) return res.status(404).json({ error: 'فصل پیدا نشد' });
        const text = await readAnyText(p);
        res.json({ text, words: countWords(text) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* raw text + matched glossary (translation payload) */
app.get('/api/books/:book/chapter/:file/with-glossary', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const file = path.basename(req.params.file);
        const bDir = bookDir(book);
        const raw = await readAnyText(path.join(bDir, file));
        const matched = matchGlossary(await readGlossary(bDir), raw);

        let out = '';
        if (matched.length) {
            out += '### GLOSSARY FOR THIS CHAPTER (translate these EXACTLY, never split multi-word names):\n';
            matched.forEach(g => { out += '- ' + g.en + ' -> ' + g.fa + '\n'; });
            out += '\n';
        }
        out += raw;
        res.json({ formattedText: out, glossaryCount: matched.length, words: countWords(raw) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ready-made translation from books/<book>/tr */
app.get('/api/books/:book/chapter/:file/tr', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const file = path.basename(req.params.file);
        const name = path.parse(file).name;
        const trPath = await findTr(bookDir(book), name);
        if (!trPath) return res.status(404).json({ error: 'ترجمهٔ آماده‌ای در پوشهٔ tr پیدا نشد' });
        const text = await readAnyText(trPath);
        res.json({ file: path.basename(trPath), text, words: countWords(text) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* short combined EN + FA payload for the proofing step */
app.post('/api/compact', (req, res) => {
    try {
        const body = req.body || {};
        const en = compact(body.english || '');
        const faText = compact(body.persian || body.farsi || '');
        const text = 'EN:\n' + en + '\n\nFA:\n' + faText;
        res.json({
            text,
            chars: text.length,
            words: countWords(text),
            savedChars: String(body.english || '').length + String(body.persian || '').length - text.length
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* save step progress (auto-save): texts go to draft files, state keeps counts */
app.post('/api/books/:book/chapter/:file/progress', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const file = path.basename(req.params.file);
        const bDir = bookDir(book);
        const name = path.parse(file).name;
        const body = req.body || {};
        const texts = body.texts || {};
        const step = Number(body.step) || 0;

        const pairs = [
            ['translation', 'inputTranslation'],
            ['edited', 'editedText'],
            ['final', 'finalText'],
            ['save', 'saveText']
        ];
        const staged = {};
        for (const [kind, key] of pairs) {
            const v = texts[key];
            if (v !== undefined && String(v).trim()) {
                await writeDraft(bDir, name, kind, v);
                staged[kind] = countWords(v);
            }
        }

        const state = await readState(bDir);
        const cur = state[name] || {};
        const prev = await stageWordCounts(bDir, name, cur);
        let rawWords = Number(cur.rawWords) || 0;
        if (!rawWords) {
            try { rawWords = countWords(await readAnyText(path.join(bDir, file))); } catch (e) { rawWords = 0; }
        }
        const stepStage = stageForStep(step, false);
        const rank = s => STAGE_RANK[s] || 0;
        const stage = rank(stepStage) >= rank(cur.stage || 'none') ? stepStage : (cur.stage || 'none');
        // outWords = highest-stage text we have (final > edited > translation)
        const outWords = staged.save || staged.final || staged.edited || staged.translation
            || cur.outWords || prev.fw || prev.ew || prev.tw || 0;
        state[name] = {
            ...cur,
            step: Math.max(cur.step || 0, step),
            stage,
            rawWords,
            transWords: staged.translation || prev.tw,
            editedWords: staged.edited || prev.ew,
            finalWords: staged.final || staged.save || prev.fw,
            outWords,
            updatedAt: new Date().toISOString()
        };
        await writeState(bDir, state);
        res.json({ success: true, step: state[name].step, stage });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* final save -> JSON into books/<book>/translated */
app.post('/api/books/:book/chapter/:file/save', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const file = path.basename(req.params.file);
        const bDir = bookDir(book);
        const name = path.parse(file).name;
        const body = req.body || {};
        const text = String(body.text || '');
        const force = !!body.force;

        if (!text.trim()) return res.status(400).json({ error: 'متن خالی است' });

        const raw = await readAnyText(path.join(bDir, file));
        const rawWords = countWords(raw);
        const words = countWords(text);
        const percent = rawWords ? Math.round(words / rawWords * 100) : 100;

        if (!force && rawWords > 0 && words < rawWords * 0.8) {
            return res.status(409).json({
                warning: '⚠️ متن چسبانده‌شده (' + words + ' واژه) کمتر از ۸۰٪ متن اصلی (' + rawWords + ' واژه) است. احتمالاً پاراگراف جا افتاده.',
                words, rawWords, percent
            });
        }

        const paragraphs = text.split(/\r?\n/).map(p => p.replace(/\u00a0/g, ' ').trim()).filter(Boolean);
        const outDir = path.join(bDir, 'translated');
        await fs.ensureDir(outDir);
        const outPath = path.join(outDir, name + '.json');

        const json = {
            id: book + '_' + name,
            paragraphs
        };
        await fs.writeFile(outPath, JSON.stringify(json, null, 2), 'utf8');

        const state = await readState(bDir);
        const curSv = state[name] || {};
        await writeDraft(bDir, name, 'final', text);
        await writeDraft(bDir, name, 'save', text);
        state[name] = {
            ...curSv,
            step: 4,
            done: true,
            stage: 'done',
            rawWords,
            transWords: Number(curSv.transWords) || 0,
            editedWords: Number(curSv.editedWords) || 0,
            finalWords: words,
            outWords: words,
            updatedAt: new Date().toISOString()
        };
        await writeState(bDir, state);

        res.json({
            success: true,
            path: path.relative(__dirname, outPath).split(path.sep).join('/'),
            paragraphs: paragraphs.length,
            words, rawWords, percent
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* saved final translation of a chapter */
app.get('/api/books/:book/chapter/:file/translation', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const file = path.basename(req.params.file);
        const name = path.parse(file).name;
        const p = path.join(bookDir(book), 'translated', name + '.json');
        if (!await fs.pathExists(p)) return res.status(404).json({ error: 'ترجمهٔ ذخیره‌شده‌ای برای این فصل نیست' });
        const j = await fs.readJson(p);
        res.json({ translatedText: (j.paragraphs || []).join('\n'), json: j });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* global stats for the HUD */
app.get('/api/stats', async (req, res) => {
    try {
        await fs.ensureDir(BOOKS_DIR);
        const items = await fs.readdir(BOOKS_DIR);
        let books = 0, chapters = 0, done = 0, trReady = 0;
        for (const item of items) {
            const bDir = path.join(BOOKS_DIR, item);
            let st; try { st = await fs.stat(bDir); } catch (e) { continue; }
            if (!st.isDirectory()) continue;
            books++;
            const files = await listChapterFiles(bDir);
            chapters += files.length;
            for (const f of files) {
                if (await fs.pathExists(path.join(bDir, 'translated', path.parse(f).name + '.json'))) done++;
            }
            const trSrc = path.join(bDir, 'tr');
            if (await fs.pathExists(trSrc)) trReady += (await fs.readdir(trSrc)).filter(isChapterFile).length;
        }
        res.json({ books, chapters, done, trReady });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
/* ===================== ROBOT QUEUE ===================== */
const robotQueue = [];     // pending jobs
const robotActive = {};    // jobId -> in progress
const robotDropped = new Map(); // jobId -> ts: late results to ignore (cancelled via clear)

function robotJobId() { return 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

/* ===================== LOGGING ===================== */
const nodeFs = require('fs');
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'novelbot.log');
fs.ensureDirSync(LOG_DIR);

let logBuffer = [];

function pushLog(source, level, message, meta = {}) {
    const entry = {
        ts: new Date().toISOString(),
        source,
        level,
        message: String(message || '').slice(0, 5000),
        meta: meta || {}
    };

    logBuffer.push(entry);
    if (logBuffer.length > 3000) logBuffer = logBuffer.slice(-2000);

    try {
        nodeFs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', () => {});
    } catch (e) { /* ignore file log error */ }

    console.log(`[novelbot:${source}:${level}]`, message, meta || '');
}

app.post('/api/log', (req, res) => {
    const { source = 'extension', level = 'info', message = '', meta = {} } = req.body || {};
    pushLog(String(source).slice(0, 80), String(level).slice(0, 20), message, meta);
    res.json({ ok: true });
});

app.get('/api/logs', (req, res) => {
    cleanupStaleRobot();

    const limit = Math.min(Number(req.query.limit) || 250, 1000);
    const source = req.query.source || 'all';
    const search = String(req.query.search || '').toLowerCase();

    let logs = logBuffer.slice(-limit).reverse();

    if (source && source !== 'all') {
        logs = logs.filter(l => l.source === source || l.source.startsWith(source + ':'));
    }

    if (search) {
        logs = logs.filter(l =>
            l.message.toLowerCase().includes(search) ||
            JSON.stringify(l.meta || {}).toLowerCase().includes(search)
        );
    }

    res.json({ logs });
});

app.post('/api/logs/clear', (req, res) => {
    logBuffer = [];
    try { nodeFs.writeFileSync(LOG_FILE, '', 'utf8'); } catch (e) { /* ignore */ }
    pushLog('server', 'info', 'logs cleared');
    res.json({ success: true });
});

/* ===================== ROBOT QUEUE v2 ===================== */
function robotJobId() {
    return 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function typeToStep(type) {
    return ({ translate: 1, edit: 2, proof: 3, save: 4 })[type] || 0;
}

/* A stage text only counts if it is plausibly a full chapter, not a stub or
   a short AI refusal. Prevents the robot from starting at edit/proof/save on
   stale or garbage text left in _state.json. */
const ROBOT_MIN_ABS_WORDS = 15;
const ROBOT_MIN_REL = 0.4;    // stage text must be >= 40% of raw words to count
const ROBOT_ACCEPT_REL = 0.5; // AI output must be >= 50% of source words to accept

/* Short "acknowledgement / refusal" replies ("ready, send the text", "I can't", …)
   are never translations — reject them even when length checks would pass
   (e.g. tiny chapters where a 19-word ack matches a 22-word source). */
const REFUSAL_PATTERNS = [
    /آماده[‌ ]?ام/i,
    /متن\s*(فصل|را)?\s*(را\s*)?(ارسال|بفرست|بفرستید|ارسال کن|ارسال کنید)/i,
    /ارسال کن(ید)? تا/i,
    /i can ?not|i cannot|as an ai|unable to (translate|comply|help)/i,
    /i['’]m (not able|unable)/i,
    /ready(\s+to)?(,|\.|\s).*send/i,
    /send (me |the )?(text|chapter|content)/i,
    /متا?سفم|نمی ?توانم|نمیتونم|قادر نیستم|معذورم/i
];

function looksLikeRefusal(text) {
    const t = String(text || '');
    if (countWords(t) >= 150) return false; // long outputs are real work, not acks
    return REFUSAL_PATTERNS.some(re => re.test(t));
}

function stageWordFloor(rawWords) {
    return Math.max(ROBOT_MIN_ABS_WORDS, Math.floor((rawWords || 0) * ROBOT_MIN_REL));
}
function acceptWordFloor(sourceWords) {
    return Math.max(ROBOT_MIN_ABS_WORDS, Math.floor((sourceWords || 0) * ROBOT_ACCEPT_REL));
}

function cleanAiOutput(text) {
    let t = String(text || '').trim();
    const lines = t.split(/\r?\n/);

    // remove fenced code block if AI wrapped output
    if (lines.length >= 2 && lines[0].trim().startsWith('```') && lines[lines.length - 1].trim().startsWith('```')) {
        lines.shift();
        lines.pop();
        t = lines.join('\n');
    }

    return t.trim();
}

function cleanupStaleRobot() {
    const now = Date.now();
    for (const [id, job] of Object.entries(robotActive)) {
        const age = now - (job.claimedAt || 0);
        if (age > 10 * 60 * 1000) {
            delete robotActive[id];
            pushLog('server', 'warn', 'stale robot job removed', { id, type: job.type, book: job.book, chapter: job.chapter, ageMs: age });
        }
    }
    // Drop-tokens for cancelled jobs expire after 30 min (their extensions
    // report back at most once, right after cancellation).
    for (const [id, ts] of robotDropped) {
        if (now - ts > 30 * 60 * 1000) robotDropped.delete(id);
    }
}

async function saveChapterFinal({ book, chapter, text, force = false, source = 'manual' }) {
    book = safeName(book);
    const file = path.basename(chapter);
    const bDir = bookDir(book);
    const name = path.parse(file).name;

    if (!String(text || '').trim()) throw new Error('empty text');

    const raw = await readAnyText(path.join(bDir, file));
    const rawWords = countWords(raw);
    const words = countWords(text);
    const percent = rawWords ? Math.round((words / rawWords) * 100) : 100;

    if (!force && rawWords > 0 && words < rawWords * 0.8) {
        const err = new Error(`length too short: ${words}/${rawWords} (${percent}%)`);
        err.status = 409;
        throw err;
    }

    if (rawWords > 0 && percent < 80) {
        pushLog('server', 'warn', 'saving chapter below 80% length', { book, chapter, words, rawWords, percent, source });
    }

    const paragraphs = String(text)
        .split(/\r?\n/)
        .map(p => p.replace(/\u00a0/g, ' ').trim())
        .filter(Boolean);

    const outDir = path.join(bDir, 'translated');
    await fs.ensureDir(outDir);
    const outPath = path.join(outDir, name + '.json');

    const json = {
        id: book + '_' + name,
        paragraphs
    };

    await fs.writeFile(outPath, JSON.stringify(json, null, 2), 'utf8');

    const state = await readState(bDir);
    const curF = state[name] || {};
    await writeDraft(bDir, name, 'final', text);
    await writeDraft(bDir, name, 'save', text);
    state[name] = {
        ...curF,
        step: 4,
        done: true,
        stage: 'done',
        rawWords,
        finalWords: words,
        outWords: words,
        updatedAt: new Date().toISOString()
    };
    await writeState(bDir, state);

    pushLog('server', 'info', 'chapter saved as FINISHED', {
        book, chapter: name, paragraphs: paragraphs.length, words, rawWords, percent, source
    });

    return {
        path: path.relative(__dirname, outPath).split(path.sep).join('/'),
        paragraphs: paragraphs.length,
        words,
        rawWords,
        percent
    };
}

async function buildRobotInput(job) {
    console.log('\n🔵🔵🔵 BUILDING ROBOT INPUT 🔵🔵🔵');
    console.log('Job:', job.id, job.type, job.book, job.chapter);
    
    const bDir = bookDir(job.book);
    const filePath = path.join(bDir, job.chapter);
    console.log('File path:', filePath);
    
    const name = path.parse(job.chapter).name;
    const state = await readState(bDir);
    const cur = state[name] || {};
    const prompts = loadPrompts();

    let prompt = '';
    let payload = '';
    let context = {};

    if (job.type === 'translate') {
        let raw = '';
        try {
            raw = await readAnyText(filePath);
        } catch (e) {
            console.error('❌ Error reading file:', e);
            throw new Error('Cannot read chapter file: ' + e.message);
        }

        console.log('🔵 Raw text length:', raw.length);
        if (!raw || !raw.trim()) {
            throw new Error('Chapter file is completely empty! Path: ' + filePath);
        }

        const glossary = matchGlossary(await readGlossary(bDir), raw);

        if (glossary.length) {
            payload += '### GLOSSARY FOR THIS CHAPTER (translate these EXACTLY, never split multi-word names):\n';
            glossary.forEach(g => { payload += '- ' + g.en + ' -> ' + g.fa + '\n'; });
            payload += '\n';
        }
        payload += 'متن:\n\n' + raw;

        prompt = prompts.translation || 'Translate the following text to Persian.';

        context = { rawWords: countWords(raw), glossaryCount: glossary.length };
    }
    else if (job.type === 'edit') {
        // Pre-made tr files count as the translation input (raw, needs editing).
        // Stage texts live in draft files (slim _state.json keeps only counts).
        let src = (await readDraft(bDir, name, 'translation')) || cur.inputTranslation || '';
        let fromTr = false;
        if (!src.trim()) {
            const trPath = await findTr(bDir, name);
            if (trPath) {
                try { src = await readAnyText(trPath); fromTr = true; } catch (e) { src = ''; }
            }
        }
        if (!src.trim()) throw new Error('No translated text available for edit step.');
        // Persist the tr fallback so the workbench / chain sees step 1 done.
        if (fromTr) {
            try {
                await writeDraft(bDir, name, 'translation', src);
                const st = await readState(bDir);
                st[name] = {
                    ...(st[name] || {}),
                    step: Math.max((st[name] || {}).step || 0, 1),
                    stage: 'translate',
                    transWords: countWords(src),
                    outWords: countWords(src),
                    trImported: true,
                    updatedAt: new Date().toISOString()
                };
                await writeState(bDir, st);
            } catch (e) { /* ignore */ }
        }
        prompt = prompts.editorial || 'Edit this:';
        payload = 'ترجمهٔ نیازمند ویرایش:\n' + src;
        context = { sourceWords: countWords(src), fromTr };
    }
    else if (job.type === 'proof') {
        const raw = await readAnyText(filePath);
        let faText = (await readDraft(bDir, name, 'edited'))
            || (await readDraft(bDir, name, 'translation'))
            || cur.editedText || cur.inputTranslation || '';
        if (!faText.trim()) {
            const trPath = await findTr(bDir, name);
            if (trPath) { try { faText = await readAnyText(trPath); } catch (e) { faText = ''; } }
        }
        if (!faText.trim()) throw new Error('No edited text available for proof step.');
        prompt = prompts.proofing || 'Proof this:';
        payload = 'EN:\n' + compact(raw) + '\n\nFA:\n' + compact(faText);
        context = { rawWords: countWords(raw), faWords: countWords(faText) };
    }
    else {
        throw new Error('unknown robot job type: ' + job.type);
    }

    // Legacy single-shot field (old extensions + logs). New adapters send
    // `prompt` first, wait for the ack, then send `payload`.
    const input = prompt + '\n\n' + payload;

    console.log('🔵 Final input length:', input.length, '(prompt:', prompt.length, 'payload:', payload.length + ')');
    console.log('🔵🔵🔵 DONE BUILDING 🔵🔵🔵\n');

    if (!payload.trim()) {
        throw new Error('Generated input is empty!');
    }

    pushLog('server', 'info', 'robot input built', {
        id: job.id, book: job.book, chapter: job.chapter, type: job.type,
        inputChars: input.length,
        promptChars: prompt.length,
        payloadChars: payload.length,
        glossaryCount: context.glossaryCount || 0,
        head: payload.slice(0, 300)
    });

    return { input, prompt, payload, context };
}

/* single claim handler — builds prompt input at claim time */
async function queueRobotJob({ book, chapter, type = null, autoChain = true, source = 'ui', owner = null }) {
    book = safeName(book);
    chapter = path.basename(chapter);
    owner = normWorker(owner);

    const bDir = bookDir(book);
    const filePath = path.join(bDir, chapter);

    if (!await fs.pathExists(filePath)) {
        throw new Error('chapter file not found: ' + chapter);
    }

    const name = path.parse(chapter).name;
    const done = await fs.pathExists(path.join(bDir, 'translated', name + '.json'));
    if (done) {
        return { skipped: true, reason: 'already done' };
    }

    const state = await readState(bDir);
    let cur = state[name] || {};

    // Ready-made tr translations are RAW (unedited) translations: if the
    // chapter has a tr file but no translation yet, import it now so the
    // pipeline starts at EDIT instead of TRANSLATE.
    let trUsed = false;
    if ((await stageWordCounts(bDir, name, cur)).tw <= 0) {
        try {
            if (await importTrIntoState(bDir, name, state)) {
                await writeState(bDir, state);
                cur = state[name] || {};
                trUsed = true;
                pushLog('server', 'info', 'tr used as translation input — starting at edit', { book, chapter });
            }
        } catch (e) { /* ignore import errors */ }
    }

    // Content-based step detection: pick the earliest step whose required
    // text is missing or implausibly short — never trust the step number alone.
    let rawWords = 0;
    try { rawWords = countWords(await readAnyText(filePath)); } catch (e) { rawWords = 0; }
    const floor = stageWordFloor(rawWords);
    const sw = await stageWordCounts(bDir, name, cur);
    const hasT = sw.tw >= floor;
    const hasE = sw.ew >= floor;
    const hasF = sw.fw >= floor;

    if (!type) {
        if (!hasT) type = 'translate';
        else if (!hasE) type = 'edit';
        else if (!hasF) type = 'proof';
        else type = 'save';
    } else {
        // A tr-backed chapter never goes back to TRANSLATE: it starts at EDIT.
        const trBacked = hasT || trUsed || !!(await findTr(bDir, name));
        if (type === 'translate' && trBacked) type = 'edit';
        // Downgrade an explicit type if its required input is missing/weak.
        if (type === 'edit' && !hasT) type = trBacked ? 'edit' : 'translate';
        else if (type === 'proof') type = !hasT ? (trBacked ? 'edit' : 'translate') : (!hasE ? 'edit' : 'proof');
        else if (type === 'save' && !hasF) type = !hasT ? (trBacked ? 'edit' : 'translate') : (!hasE ? 'edit' : 'proof');
    }

    if (type !== 'save') {
        pushLog('server', 'info', 'robot step picked by content', {
            book, chapter, type, rawWords, needWords: floor,
            hasTranslate: hasT, hasEdit: hasE, hasFinal: hasF, trUsed
        });
    }

    // If chapter already has final text but is not saved, save immediately.
    // Never force: a short final text stays unfinished for manual review.
    if (type === 'save') {
        const t = await stageTexts(bDir, name, cur);
        const text = t.saveText || t.finalText || t.editedText || t.inputTranslation || '';
        if (!text.trim()) return { skipped: true, reason: 'no final text to save' };

        try {
            const saved = await saveChapterFinal({
                book,
                chapter,
                text,
                force: false,
                source: source + ':auto-save'
            });
            return { saved: true, ...saved };
        } catch (err) {
            return { skipped: true, reason: 'final text too short — needs review' };
        }
    }

    const already =
        robotQueue.some(j => j.book === book && j.chapter === chapter) ||
        Object.values(robotActive).some(j => j.book === book && j.chapter === chapter);

    if (already) {
        return { skipped: true, reason: 'already queued or running' };
    }

    const job = {
        id: robotJobId(),
        book,
        chapter,
        type,
        autoChain: !!autoChain,
        queuedAt: Date.now(),
        source,
        owner
    };

    robotQueue.push(job);
    pushLog('server', 'info', 'robot job queued', {
        id: job.id, book, chapter, type, autoChain: job.autoChain, source, owner: owner || 'any'
    });

    return { queued: true, jobId: job.id, type };
}

app.get('/api/robot/jobs', (req, res) => {
    cleanupStaleRobot();

    const limit = Math.min(Number(req.query.limit) || 1, 10);
    const worker = normWorker(req.query.worker);
    // Affinity: a named worker sees its OWN jobs first, then unassigned ones.
    // Anonymous (no worker) workers only see unassigned jobs, so assigned
    // ranges can't be stolen by the wrong profile.
    let pool = robotQueue;
    if (worker) {
        const mine = robotQueue.filter(j => j.owner === worker);
        const free = robotQueue.filter(j => !j.owner);
        pool = [...mine, ...free];
    } else {
        pool = robotQueue.filter(j => !j.owner);
    }
    // Chain-first: a chapter's follow-up step (edit after translate, proof
    // after edit) jumps ahead of fresh chapters, so each chapter runs its
    // full path (tr→edit→proof, or raw→translate→edit→proof) before the
    // worker moves on — instead of doing all first-steps first.
    pool = [...pool.filter(j => j.source === 'chain'), ...pool.filter(j => j.source !== 'chain')];
    const jobs = pool.slice(0, limit).map(j => ({
        id: j.id,
        type: j.type,
        book: j.book,
        chapter: j.chapter,
        autoChain: j.autoChain,
        queuedAt: j.queuedAt,
        owner: j.owner || null
    }));

    res.json({ jobs, queueSize: robotQueue.length, worker: worker || null });
});

app.post('/api/robot/claim', async (req, res) => {
    try {
        cleanupStaleRobot();

        const { id, worker: rawWorker } = req.body || {};
        const worker = normWorker(rawWorker);
        const idx = robotQueue.findIndex(j => j.id === id);

        if (idx < 0) return res.status(404).json({ error: 'job not found' });
        if (robotActive[id]) return res.status(409).json({ error: 'already claimed' });

        // Ownership check BEFORE removing from the queue: a job assigned to
        // profile A must be claimed by A (wrong-profile claims are rejected
        // and the job stays queued for its owner).
        const queued = robotQueue[idx];
        if (queued.owner && queued.owner !== worker) {
            pushLog('server', 'warn', 'claim rejected (wrong worker)', {
                id, owner: queued.owner, worker: worker || '(anonymous)'
            });
            return res.status(409).json({ error: 'job assigned to worker "' + queued.owner + '"', owner: queued.owner });
        }

        const job = robotQueue.splice(idx, 1)[0];

        try {
            const built = await buildRobotInput(job);
            
            // STRICT VALIDATION: Prevent 0-character inputs
            if (!built || !built.input || !built.input.trim()) {
                throw new Error('buildRobotInput returned empty string');
            }
            
            job.input = built.input;
            job.prompt = built.prompt;
            job.payload = built.payload;
            job.context = built.context || {};
        } catch (err) {
            pushLog('server', 'error', 'failed building robot input; job dropped', {
                id: job.id, book: job.book, chapter: job.chapter, type: job.type, error: err.message
            });
            return res.status(422).json({ error: err.message });
        }

        job.claimedAt = Date.now();
        job.worker = worker || null;
        robotActive[id] = job;

        pushLog('server', 'info', 'robot job claimed', {
            id, book: job.book, chapter: job.chapter, type: job.type,
            inputChars: (job.input || '').length,
            owner: job.owner || 'any', worker: worker || '(anonymous)'
        });

        res.json({ success: true, job });
    } catch (err) {
        pushLog('server', 'error', 'claim error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/robot/result', async (req, res) => {
    try {
        cleanupStaleRobot();

        const body = req.body || {};
        const id = body.id;
        const success = !!body.success;
        const output = cleanAiOutput(body.output || '');
        const error = body.error || '';

        // Results of jobs cancelled via "clear" are dropped silently: no
        // state write and no auto-chain, so a cleared queue stays cleared.
        if (robotDropped.has(id)) {
            robotDropped.delete(id);
            if (robotActive[id]) delete robotActive[id];
            pushLog('server', 'warn', 'robot result dropped (job was cancelled)', { id, success });
            return res.json({ success: false, dropped: true });
        }

        const job = robotActive[id];
        if (job) delete robotActive[id];

        if (!job) {
            pushLog('server', 'warn', 'robot result for unknown/expired job', { id, success, error });
            return res.json({ success: false, error: 'unknown job' });
        }

        if (!success) {
            pushLog('server', 'error', 'robot job failed', {
                id, book: job.book, chapter: job.chapter, type: job.type, error
            });
            return res.json({ success: false });
        }

        if (!output.trim()) {
            pushLog('server', 'error', 'robot job returned empty output', {
                id, book: job.book, chapter: job.chapter, type: job.type
            });
            return res.json({ success: false, error: 'empty output' });
        }

        const bDir = bookDir(job.book);
        const name = path.parse(job.chapter).name;
        const state = await readState(bDir);
        const cur = state[name] || {};
        const outWords = countWords(output);

        // Reject garbage (AI refusals, one-liners) before it poisons state
        // or chains into the next step.
        let srcWords = 0, rawW = 0;
        try {
            const rawCheck = await readAnyText(path.join(bDir, job.chapter));
            rawW = countWords(rawCheck);
            const sw0 = await stageWordCounts(bDir, name, cur);
            if (job.type === 'translate') srcWords = rawW;
            else if (job.type === 'edit') srcWords = sw0.tw;
            else if (job.type === 'proof') srcWords = Math.max(rawW, sw0.ew || sw0.tw);
        } catch (e) { srcWords = 0; }

        const need = acceptWordFloor(srcWords);
        if (looksLikeRefusal(output)) {
            pushLog('server', 'error', 'robot output is an ack/refusal, not a translation — rejected', {
                id, book: job.book, chapter: job.chapter, type: job.type,
                outWords, head: output.slice(0, 200)
            });
            return res.json({ success: false, error: 'AI acknowledged instead of translating (two-phase will retry with split prompt)' });
        }
        if (srcWords > 0 && outWords < need) {
            pushLog('server', 'error', 'robot output too short — rejected, chain stopped', {
                id, book: job.book, chapter: job.chapter, type: job.type,
                outWords, srcWords, needWords: need,
                head: output.slice(0, 200)
            });
            return res.json({ success: false, error: 'output too short: ' + outWords + ' words vs ~' + srcWords + ' source words (' + job.type + ')' });
        }

        // Slim state: full text goes to the draft file, _state.json keeps
        // step + stage + word counts only.
        if (job.type === 'translate') await writeDraft(bDir, name, 'translation', output);
        if (job.type === 'edit') await writeDraft(bDir, name, 'edited', output);
        if (job.type === 'proof') {
            await writeDraft(bDir, name, 'final', output);
            await writeDraft(bDir, name, 'save', output);
        }

        const step = typeToStep(job.type);
        const stage = job.type; // translate | edit | proof
        const prev = await stageWordCounts(bDir, name, cur);

        state[name] = {
            ...cur,
            step: Math.max(cur.step || 0, step),
            stage,
            rawWords: rawW || cur.rawWords || 0,
            transWords: job.type === 'translate' ? outWords : (prev.tw || cur.transWords || 0),
            editedWords: job.type === 'edit' ? outWords : (prev.ew || cur.editedWords || 0),
            finalWords: job.type === 'proof' ? outWords : (prev.fw || cur.finalWords || 0),
            outWords,
            updatedAt: new Date().toISOString()
        };

        await writeState(bDir, state);

        pushLog('server', 'info', 'robot job completed', {
            id, book: job.book, chapter: job.chapter, type: job.type,
            words: countWords(output), chars: output.length,
            head: output.slice(0, 200),
            worker: job.worker || body.worker || '(unknown)'
        });

        if (job.autoChain) {
            // Follow-up steps inherit the owner so the whole chapter stays on
            // the same profile (chat-context locality).
            if (job.type === 'translate') {
                await queueRobotJob({
                    book: job.book,
                    chapter: job.chapter,
                    type: 'edit',
                    autoChain: true,
                    source: 'chain',
                    owner: job.owner || null
                });
            } else if (job.type === 'edit') {
                await queueRobotJob({
                    book: job.book,
                    chapter: job.chapter,
                    type: 'proof',
                    autoChain: true,
                    source: 'chain',
                    owner: job.owner || null
                });
            } else if (job.type === 'proof') {
                try {
                    await saveChapterFinal({
                        book: job.book,
                        chapter: job.chapter,
                        text: output,
                        force: false,
                        source: 'robot-proof'
                    });
                } catch (err) {
                    // Short output stays in state at step 3 for manual review —
                    // never auto-FINISH a chapter below the length bar.
                    pushLog('server', 'error', 'robot auto-save skipped (chapter left unfinished for review)', {
                        id, book: job.book, chapter: job.chapter, error: err.message
                    });
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        pushLog('server', 'error', 'robot result error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/robot/queue', async (req, res) => {
    try {
        console.log('🔵 ROBOT QUEUE RECEIVED:', req.body); // <--- DEBUG LOG
        
        const body = req.body || {};
        const book = body.book;
        const chapter = body.chapter;
        const type = body.type || null;
        const autoChain = body.autoChain !== undefined ? body.autoChain : true;
        const owner = normWorker(body.owner || body.worker);

        if (!book || !chapter) {
            console.error('🔴 MISSING DATA:', { book, chapter, fullBody: body });
            return res.status(400).json({ 
                error: 'book and chapter are required', 
                debug: { receivedBook: book, receivedChapter: chapter }
            });
        }

        const result = await queueRobotJob({
            book,
            chapter,
            type,
            autoChain,
            source: 'ui',
            owner
        });

        res.json({ success: true, ...result });
    } catch (err) {
        pushLog('server', 'error', 'queue error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

function robotPerWorker() {
    const names = new Set(CHROME_PROFILES.map(p => p.name));
    robotQueue.forEach(j => { if (j.owner) names.add(j.owner); });
    Object.values(robotActive).forEach(j => {
        if (j.owner) names.add(j.owner);
        if (j.worker) names.add(j.worker);
    });
    return Array.from(names).map(name => {
        const cur = Object.values(robotActive)
            .filter(j => j.owner === name || j.worker === name)
            .map(j => ({ id: j.id, type: j.type, book: j.book, chapter: j.chapter }));
        return {
            name,
            queued: robotQueue.filter(j => j.owner === name).length,
            active: cur.length,
            current: cur[0] || null
        };
    });
}

app.get('/api/robot/status', (req, res) => {
    cleanupStaleRobot();

    res.json({
        queueSize: robotQueue.length,
        unassigned: robotQueue.filter(j => !j.owner).length,
        pending: robotQueue.map(j => ({
            id: j.id,
            type: j.type,
            book: j.book,
            chapter: j.chapter,
            queuedAt: j.queuedAt,
            owner: j.owner || null
        })),
        active: Object.values(robotActive).map(j => ({
            id: j.id,
            type: j.type,
            book: j.book,
            chapter: j.chapter,
            claimedAt: j.claimedAt,
            owner: j.owner || null,
            worker: j.worker || null
        })),
        perWorker: robotPerWorker()
    });
});

/* worker (profile) overview: online state + queue depth + current job */
app.get('/api/robot/workers', async (req, res) => {
    try {
        cleanupStaleRobot();
        const per = robotPerWorker();
        const byName = Object.fromEntries(per.map(p => [p.name, p]));
        const workers = await Promise.all(CHROME_PROFILES.map(async p => ({
            name: p.name,
            dir: p.dir,
            port: p.port,
            online: await portOnline(p.port),
            queued: (byName[p.name] || {}).queued || 0,
            active: (byName[p.name] || {}).active || 0,
            current: (byName[p.name] || {}).current || null
        })));
        const extra = per.filter(p => !CHROME_PROFILES.some(c => c.name === p.name))
            .map(p => ({ ...p, dir: '', port: null, online: null }));
        res.json({ workers: [...workers, ...extra] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Parallel dispatch: assign chapter ranges to profiles in one call.
   Body: { assignments: [{ book, from, to, worker|owner, autoChain?, type? }] }
   from/to are 1-based chapter positions as shown in the map UI (inclusive). */
app.post('/api/robot/dispatch', async (req, res) => {
    try {
        const body = req.body || {};
        const list = Array.isArray(body.assignments) ? body.assignments
            : (body.book ? [body] : []);
        if (!list.length) return res.status(400).json({ error: 'assignments are required' });

        const summary = [];
        for (const a of list) {
            const book = safeName(a.book);
            const owner = normWorker(a.worker || a.owner);
            const autoChain = a.autoChain !== undefined ? !!a.autoChain : true;
            const type = a.type || null;
            let from = Math.max(1, Number(a.from) || 1);
            let to = Math.max(1, Number(a.to) || from);
            if (to < from) [from, to] = [to, from];

            const bDir = bookDir(book);
            if (!await fs.pathExists(bDir)) {
                summary.push({ book, owner, error: 'book not found' });
                continue;
            }
            const files = await listChapterFiles(bDir);
            const slice = files.slice(from - 1, to);
            // Pipeline preview: chapters with a ready tr (or existing
            // translation input) start at EDIT, the rest at TRANSLATE.
            // Either way autoChain walks each chapter to proof + save.
            const st0 = await readState(bDir);
            let viaEdit = 0, viaTranslate = 0;
            for (const file of slice) {
                const nm = path.parse(file).name;
                if (await fs.pathExists(path.join(bDir, 'translated', nm + '.json'))) continue;
                const cur0 = st0[nm] || {};
                const w = await stageWordCounts(bDir, nm, cur0);
                if (w.tw > 0 || await findTr(bDir, nm)) viaEdit++;
                else viaTranslate++;
            }
            const pipeline = viaTranslate > 0 ? ['translate', 'edit', 'proof'] : ['edit', 'proof'];
            let queued = 0, saved = 0, skipped = 0, failed = 0;
            for (const file of slice) {
                try {
                    const r = await queueRobotJob({ book, chapter: file, type, autoChain, source: 'dispatch', owner });
                    if (r.queued) queued++; else if (r.saved) saved++; else skipped++;
                } catch (e) { failed++; }
            }
            pushLog('server', 'info', 'dispatch range queued', {
                book, from, to, chapters: slice.length, owner: owner || 'any',
                pipeline: pipeline.join('->'), viaEdit, viaTranslate, queued, saved, skipped, failed
            });
            summary.push({ book, from, to, chapters: slice.length, owner, pipeline, viaEdit, viaTranslate, queued, saved, skipped, failed });
        }
        res.json({ success: true, summary });
    } catch (err) {
        pushLog('server', 'error', 'dispatch error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/* Release assigned jobs back to the shared pool (all, or one worker's). */
app.post('/api/robot/release', (req, res) => {
    cleanupStaleRobot();
    const worker = normWorker((req.body || {}).worker || (req.body || {}).owner);
    let released = 0;
    for (const j of robotQueue) {
        if (!j.owner) continue;
        if (worker && j.owner !== worker) continue;
        j.owner = null;
        released++;
    }
    pushLog('server', 'warn', 'robot jobs released to shared pool', { worker: worker || 'all', released });
    res.json({ success: true, released });
});

app.post('/api/robot/clear', (req, res) => {
    cleanupStaleRobot();
    const body = req.body || {};
    const worker = normWorker(body.worker || body.owner);
    // cancelActive (default true): also stop in-flight jobs so their late
    // results are dropped instead of chaining new jobs back into the queue.
    const cancelActive = body.cancelActive === undefined ? true : !!body.cancelActive;
    const match = j => !worker || j.owner === worker || j.worker === worker;

    let removed = 0;
    for (let i = robotQueue.length - 1; i >= 0; i--) {
        if (match(robotQueue[i])) { robotQueue.splice(i, 1); removed++; }
    }
    let cancelled = 0;
    if (cancelActive) {
        for (const [id, job] of Object.entries(robotActive)) {
            if (match(job)) {
                delete robotActive[id];
                robotDropped.set(id, Date.now());
                cancelled++;
            }
        }
    }
    const activeLeft = Object.keys(robotActive).length;
    pushLog('server', 'warn', 'robot queue cleared', { worker: worker || 'all', removed, cancelled, activeLeft });
    res.json({ success: true, removed, cancelled, worker: worker || null });
});

/* redo one chapter: delete its translated JSON + state entry (source file untouched) */
app.post('/api/books/:book/chapter/:file/reset', async (req, res) => {
    try {
        const book = safeName(req.params.book);
        const file = path.basename(req.params.file);
        const bDir = bookDir(book);
        const name = path.parse(file).name;
        await fs.remove(path.join(bDir, 'translated', name + '.json'));
        await removeDrafts(bDir, name);
        const state = await readState(bDir);
        delete state[name];
        await writeState(bDir, state);
        pushLog('server', 'warn', 'chapter progress reset', { book, chapter: name });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* 404 guard for unknown api routes */
app.use('/api', (req, res) => res.status(404).json({ error: 'مسیر پیدا نشد: ' + req.originalUrl }));

/* error handler */
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🚀 NovelQuest running on http://localhost:' + PORT);
    console.log('📚 books dir: ' + BOOKS_DIR);
    const exe = findChrome();
    console.log('🌐 chrome: ' + (exe || 'NOT FOUND (set CHROME_PATH env)'));
});