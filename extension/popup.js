const SERVER = 'http://localhost:3000';

const $ = id => document.getElementById(id);

async function getState() {
  return new Promise(res => chrome.runtime.sendMessage({ type: 'GET_STATE' }, res));
}

async function refresh() {
  const state = await getState();
  $('dot').classList.toggle('on', state.running);
  $('status').textContent = state.running ? '🟢 فعال' : '⚪ متوقف';
  $('btn').textContent = state.running ? '⏹ توقف' : '▶ شروع';
  $('btn').className = state.running ? 'st' : 'go';
  $('pref').value = state.preferred;
  $('ok').textContent = state.stats.processed || 0;
  $('fail').textContent = state.stats.failed || 0;

  try {
    const r = await fetch(SERVER + '/api/robot/status');
    const d = await r.json();
    $('queue').textContent = d.queueSize + (d.active ? ' (' + d.active + ' فعال)' : '');
  } catch (e) {
    $('queue').textContent = '❌';
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

refresh();
setInterval(refresh, 2500);