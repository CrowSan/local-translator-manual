const SERVER = 'http://localhost:3000';

const $ = id => document.getElementById(id);

async function getState() {
  return new Promise(res => chrome.runtime.sendMessage({ type: 'GET_STATE' }, res));
}

function ensureWorkerOption(workerId) {
  const sel = $('worker');
  if (!workerId) { sel.value = ''; return; }
  let opt = Array.from(sel.options).find(o => o.value === workerId);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = workerId;
    opt.textContent = workerId;
    sel.appendChild(opt);
  }
  sel.value = workerId;
}

async function refresh() {
  const state = await getState();
  $('dot').classList.toggle('on', state.running);
  $('status').textContent = state.running ? '🟢 فعال' : '⚪ متوقف';
  $('btn').textContent = state.running ? '⏹ توقف' : '▶ شروع';
  $('btn').className = state.running ? 'st' : 'go';
  $('pref').value = state.preferred;
  ensureWorkerOption(state.workerId || '');
  $('ok').textContent = state.stats.processed || 0;
  $('fail').textContent = state.stats.failed || 0;

  try {
    const r = await fetch(SERVER + '/api/robot/status');
    const d = await r.json();
    const activeCount = Array.isArray(d.active) ? d.active.length : d.active;
    $('queue').textContent = d.queueSize + (activeCount ? ' (' + activeCount + ' فعال)' : '');
    const me = (d.perWorker || []).find(w => w.name === (state.workerId || ''));
    $('mine').textContent = state.workerId
      ? (me ? (me.queued + ' در صف • ' + (me.current ? (me.current.book + ' / ' + me.current.chapter) : 'بیکار')) : '۰ در صف')
      : 'نام تنظیم نشده!';
  } catch (e) {
    $('queue').textContent = '❌';
    $('mine').textContent = '❌';
  }
}

$('btn').onclick = async () => {
  const state = await getState();
  const type = state.running ? 'STOP' : 'START';
  chrome.runtime.sendMessage({ type }, refresh);
};

$('pref').onchange = e => {
  chrome.runtime.sendMessage({ type: 'SET_PREF', preferred: e.target.value });
};

$('worker').onchange = e => {
  chrome.runtime.sendMessage({ type: 'SET_WORKER', workerId: e.target.value }, refresh);
};

refresh();
setInterval(refresh, 2500);