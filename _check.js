
/* ============================================================
   P2P 房间 - 聊天 · 德州扑克 · 文件传输
   使用 WebRTC DataChannel 实现点对点直连
   使用手动 SDP 复制粘贴作为信令方式 (无需服务器)
   ============================================================ */

// ==================== 全局状态 ====================
const state = {
  myName: localStorage.getItem('p2p_name') || '玩家' + Math.floor(Math.random() * 1000),
  peerName: '',
  connected: false,
  connection: null,       // RTCPeerConnection
  dataChannel: null,      // RTCDataChannel (主通道)
  fileChannel: null,      // RTCDataChannel (文件通道)
  iceCandidates: [],      // 收集的 ICE candidate
  role: null,             // 'host' or 'guest'
  // 文件传输状态
  fileTransfers: {},      // fileId -> transfer state
  // 扑克状态
  poker: null,
};

// ==================== 工具函数 ====================
function $(id) { return document.getElementById(id); }

function toast(msg, type = 'info', duration = 3000) {
  const container = $('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('hiding');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

function copyText(elId) {
  const el = $(elId);
  el.select();
  try {
    document.execCommand('copy');
    toast('✓ 已复制到剪贴板', 'success', 2000);
  } catch (e) {
    toast('复制失败, 请手动复制', 'warning');
  }
}

function setStatus(text, stateKey) {
  $('statusText').textContent = text;
  const dot = $('statusDot');
  dot.className = 'status-dot';
  if (stateKey === 'online') dot.classList.add('online');
  else if (stateKey === 'connecting') dot.classList.add('connecting');
  else if (stateKey === 'error') dot.classList.add('error');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '-';
  if (seconds < 60) return Math.round(seconds) + 's';
  return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
}

function getInitials(name) {
  if (!name) return '?';
  return name.charAt(0).toUpperCase();
}

function updatePeerList() {
  const list = $('peerList');
  if (!state.connected) {
    list.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted); font-size:12px;">连接后显示在线用户</div>';
    return;
  }
  list.innerHTML = `
    <div class="peer-item">
      <div class="peer-avatar" style="background: var(--gradient-primary);">${getInitials(state.myName)}</div>
      <div class="peer-info">
        <div class="peer-name">${state.myName} (你)</div>
        <div class="peer-status">已连接</div>
      </div>
    </div>
    <div class="peer-item">
      <div class="peer-avatar" style="background: linear-gradient(135deg, #ec4899, #8b5cf6);">${getInitials(state.peerName || '对手')}</div>
      <div class="peer-info">
        <div class="peer-name">${state.peerName || '对手'}</div>
        <div class="peer-status">已连接 · P2P</div>
      </div>
    </div>
  `;
}

// ==================== 昵称管理 ====================
function initName() {
  $('myName').value = state.myName;
  $('nameInput').value = state.myName;
  $('myAvatar').textContent = getInitials(state.myName);
  $('meAvatar').textContent = getInitials(state.myName);
  $('meName').textContent = state.myName;
}

function saveName() {
  const name = $('nameInput').value.trim();
  if (!name) { toast('昵称不能为空', 'warning'); return; }
  state.myName = name;
  localStorage.setItem('p2p_name', name);
  $('myName').value = name;
  $('myAvatar').textContent = getInitials(name);
  $('meAvatar').textContent = getInitials(name);
  $('meName').textContent = name;
  updatePeerList();
  // 同步通知对方
  if (state.connected && state.dataChannel) {
    sendJSON({ type: 'name', name: name });
  }
  toast('✓ 昵称已保存', 'success', 2000);
}

$('myName').addEventListener('change', function() {
  const name = this.value.trim();
  if (name) {
    state.myName = name;
    localStorage.setItem('p2p_name', name);
    $('nameInput').value = name;
    $('myAvatar').textContent = getInitials(name);
    $('meAvatar').textContent = getInitials(name);
    $('meName').textContent = name;
    updatePeerList();
    if (state.connected) sendJSON({ type: 'name', name: name });
  } else {
    this.value = state.myName;
  }
});

// ==================== 标签切换 ====================
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const panelId = tab.dataset.panel;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    $('panel-' + panelId).classList.add('active');
  });
});

// ==================== Toast 连接状态 ====================
function showConnectionStatus(msg, type) {
  const el = $('connectionStatus');
  el.innerHTML = `<div class="status-message ${type}">${msg}</div>`;
}

// ==================== WebRTC 连接核心 ====================
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

function createPeerConnection() {
  try {
    state.connection = new RTCPeerConnection(RTC_CONFIG);
  } catch (e) {
    console.error('创建 RTCPeerConnection 失败:', e);
    toast('❌ 你的浏览器不支持 WebRTC', 'error', 5000);
    return false;
  }

  state.connection.onicecandidate = (e) => {
    if (e.candidate) {
      state.iceCandidates.push(e.candidate);
    } else {
      // ICE 收集完成, 更新 SDP (包含所有 candidates)
      if (state.role === 'host' && state.connection.localDescription) {
        const json = JSON.stringify(state.connection.localDescription);
        $('offerText').value = json;
      } else if (state.role === 'guest' && state.connection.localDescription) {
        const json = JSON.stringify(state.connection.localDescription);
        $('answerText').value = json;
      }
    }
  };

  state.connection.onconnectionstatechange = () => {
    const s = state.connection.connectionState;
    console.log('连接状态:', s);
    if (s === 'connected') {
      onConnected();
    } else if (s === 'disconnected' || s === 'failed') {
      onDisconnected();
    } else if (s === 'connecting') {
      setStatus('连接中...', 'connecting');
    }
  };

  state.connection.ondatachannel = (e) => {
    const channel = e.channel;
    console.log('收到 data channel:', channel.label);
    if (channel.label === 'chat') {
      setupChatChannel(channel);
    } else if (channel.label === 'file') {
      setupFileChannel(channel);
    } else if (channel.label === 'poker') {
      setupPokerChannel(channel);
    }
  };

  // 创建 data channel (只在 host 端创建, 但实际上两端都可以创建)
  // 为简单起见, 两端都创建 (label 相同会自动匹配)
  return true;
}

async function createOffer() {
  resetConnection(true);
  state.role = 'host';

  if (!createPeerConnection()) return;

  // 创建 data channel
  state.dataChannel = state.connection.createDataChannel('chat');
  setupChatChannel(state.dataChannel);
  state.fileChannel = state.connection.createDataChannel('file', { ordered: true });
  setupFileChannel(state.fileChannel);
  state.pokerChannel = state.connection.createDataChannel('poker');
  setupPokerChannel(state.pokerChannel);

  setStatus('正在生成邀请码...', 'connecting');
  $('step1').classList.add('active');

  try {
    const offer = await state.connection.createOffer();
    await state.connection.setLocalDescription(offer);
    $('offerOutput').style.display = 'block';
    $('offerText').value = JSON.stringify(offer);
    showConnectionStatus('✓ 邀请码已生成, 请复制并发送给对方', 'success');
    toast('✓ 邀请码已生成', 'success', 3000);
  } catch (e) {
    console.error(e);
    showConnectionStatus('❌ 生成邀请码失败: ' + e.message, 'error');
  }
}

async function acceptOffer() {
  resetConnection(true);
  state.role = 'guest';

  if (!createPeerConnection()) return;

  // guest 端会通过 ondatachannel 接收通道
  setStatus('正在接受邀请...', 'connecting');
  $('step2').classList.add('active');

  const offerText = $('offerInput').value.trim();
  if (!offerText) { toast('请先粘贴对方的邀请码', 'warning'); return; }

  try {
    const offer = JSON.parse(offerText);
    await state.connection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await state.connection.createAnswer();
    await state.connection.setLocalDescription(answer);
    $('answerOutput').style.display = 'block';
    $('answerText').value = JSON.stringify(answer);
    showConnectionStatus('✓ 回复码已生成, 请复制并发送回对方', 'success');
    toast('✓ 回复码已生成', 'success', 3000);
  } catch (e) {
    console.error(e);
    showConnectionStatus('❌ 处理邀请失败: ' + e.message, 'error');
  }
}

async function submitAnswer() {
  const answerText = $('answerInput').value.trim();
  if (!answerText) { toast('请先粘贴对方的回复码', 'warning'); return; }
  try {
    const answer = JSON.parse(answerText);
    await state.connection.setRemoteDescription(new RTCSessionDescription(answer));
    showConnectionStatus('✓ 回复码已确认, 正在建立 P2P 连接...', 'info');
    setStatus('连接中...', 'connecting');
    toast('正在建立连接...', 'info', 5000);
  } catch (e) {
    console.error(e);
    showConnectionStatus('❌ 确认失败: ' + e.message, 'error');
  }
}

function onConnected() {
  state.connected = true;
  setStatus('已连接', 'online');
  $('step1').classList.remove('active');
  $('step2').classList.remove('active');
  $('step3').classList.add('done');
  $('disconnectBtn').style.display = 'inline-flex';
  $('chatInputBar').style.display = 'flex';
  $('fileDisconnected').style.display = 'none';
  showConnectionStatus('🎉 P2P 连接已成功建立! 可以开始聊天、传文件和玩游戏了', 'success');
  toast('🎉 P2P 连接成功!', 'success', 4000);
  // 通知对方我的昵称
  if (state.dataChannel && state.dataChannel.readyState === 'open') {
    sendJSON({ type: 'name', name: state.myName });
  }
  updatePeerList();
}

function onDisconnected() {
  state.connected = false;
  setStatus('已断开', 'error');
  $('chatInputBar').style.display = 'none';
  $('fileDisconnected').style.display = 'block';
  $('disconnectBtn').style.display = 'none';
  toast('连接已断开', 'warning');
  updatePeerList();
}

function disconnect() {
  if (state.connection) {
    try { state.connection.close(); } catch(e){}
  }
  resetConnection(false);
}

function resetConnection(keepName) {
  if (state.connection) { try { state.connection.close(); } catch(e){} }
  state.connection = null;
  state.dataChannel = null;
  state.fileChannel = null;
  state.pokerChannel = null;
  state.connected = false;
  state.role = null;
  state.iceCandidates = [];
  if (!keepName) { /* keep */ }
  setStatus('未连接', '');
  $('offerOutput').style.display = 'none';
  $('answerOutput').style.display = 'none';
  $('offerText').value = '';
  $('answerInput').value = '';
  $('offerInput').value = '';
  $('answerText').value = '';
  $('connectionStatus').innerHTML = '';
  $('step1').classList.remove('active', 'done');
  $('step2').classList.remove('active', 'done');
  $('step3').classList.remove('active', 'done');
  $('chatInputBar').style.display = 'none';
  $('fileDisconnected').style.display = 'block';
  $('disconnectBtn').style.display = 'none';
  updatePeerList();
}

// ==================== JSON 发送工具 ====================
function sendJSON(obj, channel) {
  const ch = channel || state.dataChannel;
  if (!ch || ch.readyState !== 'open') {
    console.warn('通道未就绪, 无法发送', obj);
    return false;
  }
  try {
    ch.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.error('发送失败:', e);
    return false;
  }
}

// ==================== 聊天 ====================
function setupChatChannel(channel) {
  channel.onopen = () => { console.log('chat channel open'); state.dataChannel = channel;
    if (state.connected) sendJSON({ type: 'name', name: state.myName });
  };
  channel.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleChatMessage(msg);
    } catch(err) {
      appendMessage({ text: e.data, own: false, time: new Date(), name: state.peerName || '对方' });
    }
  };
  channel.onclose = () => console.log('chat channel closed');
}

function handleChatMessage(msg) {
  if (msg.type === 'name') {
    state.peerName = msg.name;
    updatePeerList();
    addSystemMessage('对方的昵称已更新为: ' + msg.name);
  } else if (msg.type === 'chat') {
    appendMessage({ text: msg.text, own: false, time: new Date(msg.time), name: msg.name });
  }
}

function sendMessage() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!state.connected || !state.dataChannel || state.dataChannel.readyState !== 'open') {
    toast('尚未建立连接', 'warning');
    return;
  }
  const now = Date.now();
  appendMessage({ text, own: true, time: new Date(now), name: state.myName });
  sendJSON({ type: 'chat', text, time: now, name: state.myName });
  input.value = '';
}

$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function appendMessage({ text, own, time, name }) {
  const empty = $('chatEmpty');
  if (empty) empty.remove();
  const messages = $('chatMessages');
  const div = document.createElement('div');
  div.className = 'message' + (own ? ' own' : '');
  const hh = time.getHours().toString().padStart(2, '0');
  const mm = time.getMinutes().toString().padStart(2, '0');
  const safeText = escapeHtml(text);
  div.innerHTML = `
    <div class="message-header">
      <span>${escapeHtml(name)} · ${hh}:${mm}</span>
    </div>
    <div class="message-bubble">${safeText}</div>
  `;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function addSystemMessage(text) {
  const empty = $('chatEmpty');
  if (empty) empty.remove();
  const messages = $('chatMessages');
  const div = document.createElement('div');
  div.className = 'message system';
  div.innerHTML = `<div class="message-bubble">${escapeHtml(text)}</div>`;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== 文件传输 ====================
const FILE_CHUNK_SIZE = 64 * 1024; // 64KB per chunk

function setupFileChannel(channel) {
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => { console.log('file channel open'); state.fileChannel = channel; };
  channel.onmessage = (e) => handleFileMessage(e.data);
  channel.onclose = () => console.log('file channel closed');
}

function handleFileMessage(data) {
  if (typeof data === 'string') {
    try {
      const msg = JSON.parse(data);
      handleFileControl(msg);
    } catch(e) { console.error(e); }
  } else {
    handleFileChunk(data);
  }
}

function handleFileControl(msg) {
  if (msg.type === 'file-start') {
    state.fileTransfers[msg.fileId] = {
      name: msg.name,
      size: msg.size,
      mimeType: msg.mimeType,
      received: 0,
      chunks: [],
      startTime: Date.now(),
    };
    renderFileItem(msg.fileId, 'receiving');
    toast('📥 开始接收文件: ' + msg.name, 'info', 2000);
  } else if (msg.type === 'file-done') {
    const t = state.fileTransfers[msg.fileId];
    if (t) {
      const blob = new Blob(t.chunks, { type: t.mimeType });
      t.url = URL.createObjectURL(blob);
      t.done = true;
      updateFileItem(msg.fileId, 'done', { url: t.url });
      toast('✓ 文件接收完成: ' + t.name, 'success');
    }
  }
}

function handleFileChunk(arrayBuffer) {
  // 简单的基于顺序的接收: 找到第一个尚未完成的 transfer
  const ids = Object.keys(state.fileTransfers).filter(id => !state.fileTransfers[id].done && state.fileTransfers[id].received < state.fileTransfers[id].size);
  if (ids.length === 0) return;
  const fileId = ids[0];
  const t = state.fileTransfers[fileId];
  t.chunks.push(arrayBuffer);
  t.received += arrayBuffer.byteLength;
  updateFileItem(fileId, 'receiving', { received: t.received, startTime: t.startTime, total: t.size });
}

function sendFile(file) {
  if (!state.connected || !state.fileChannel || state.fileChannel.readyState !== 'open') {
    toast('尚未建立连接, 无法发送文件', 'warning');
    return;
  }
  const fileId = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  state.fileTransfers[fileId] = {
    name: file.name, size: file.size, mimeType: file.type,
    received: 0, chunks: [], startTime: Date.now(), sending: true,
  };
  renderFileItem(fileId, 'sending');

  // 发送开始消息
  state.fileChannel.send(JSON.stringify({
    type: 'file-start', fileId, name: file.name, size: file.size, mimeType: file.type,
  }));

  // 分片发送
  const reader = new FileReader();
  let offset = 0;
  reader.onload = (e) => {
    state.fileChannel.send(e.target.result);
    updateFileItem(fileId, 'sending', { received: offset, total: file.size, startTime: state.fileTransfers[fileId].startTime });
    offset += e.target.result.byteLength;
    if (offset < file.size) {
      readSlice(offset);
    } else {
      setTimeout(() => {
        state.fileChannel.send(JSON.stringify({ type: 'file-done', fileId }));
        updateFileItem(fileId, 'done');
        toast('✓ 文件发送完成: ' + file.name, 'success');
      }, 100);
    }
  };
  reader.onerror = () => toast('文件读取失败', 'error');
  function readSlice(o) {
    const slice = file.slice(o, o + FILE_CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  }
  readSlice(0);
}

// 文件 UI
function renderFileItem(fileId, mode, extra) {
  let item = document.getElementById('file-' + fileId);
  if (!item) {
    const t = state.fileTransfers[fileId];
    const list = $('fileList');
    // 清除 "暂无记录"
    if (list.children.length === 1 && list.children[0].textContent.includes('暂无')) {
      list.innerHTML = '';
    }
    item = document.createElement('div');
    item.className = 'file-item';
    item.id = 'file-' + fileId;
    item.innerHTML = `
      <div class="file-icon">${mode === 'sending' ? '📤' : '📥'}</div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(t.name)}</div>
        <div class="file-meta">
          <span class="file-size">${formatSize(t.size)}</span>
          <span class="file-mode">${mode === 'sending' ? '发送中' : '接收中'}</span>
          <span class="file-progress">0%</span>
          <span class="file-speed" style="color:var(--success); font-weight:600;">-</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
      </div>
      <div class="file-actions">
        <button class="btn btn-sm btn-secondary file-download-btn" style="display:none;">下载</button>
      </div>
    `;
    list.appendChild(item);
  }
  if (extra && extra.url) {
    const btn = item.querySelector('.file-download-btn');
    const t = state.fileTransfers[fileId];
    btn.style.display = 'inline-flex';
    btn.onclick = () => {
      const a = document.createElement('a');
      a.href = extra.url;
      a.download = t.name;
      a.click();
    };
    item.querySelector('.file-mode').textContent = '完成';
  }
}

function updateFileItem(fileId, mode, info) {
  const item = document.getElementById('file-' + fileId);
  if (!item) return;
  const t = state.fileTransfers[fileId];
  if (!t) return;
  if (info && info.received !== undefined && info.total !== undefined) {
    const pct = (info.received / info.total * 100).toFixed(1);
    item.querySelector('.progress-fill').style.width = pct + '%';
    item.querySelector('.file-progress').textContent = pct + '%';
    if (info.startTime) {
      const elapsed = (Date.now() - info.startTime) / 1000;
      if (elapsed > 0.3) {
        const speed = info.received / elapsed;
        item.querySelector('.file-speed').textContent = formatSize(speed) + '/s';
      }
    }
  }
  if (mode === 'done') {
    item.querySelector('.file-mode').textContent = t.sending ? '发送完成' : '接收完成';
    item.querySelector('.progress-fill').style.width = '100%';
    item.querySelector('.file-progress').textContent = '100%';
    if (!t.sending) {
      const btn = item.querySelector('.file-download-btn');
      if (btn) btn.style.display = 'inline-flex';
    }
  }
}

// 文件选择和拖拽
$('dropZone').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  for (const file of e.target.files) sendFile(file);
  e.target.value = '';
});

const dz = $('dropZone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => {
  e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => {
  e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover');
}));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const file of e.dataTransfer.files) sendFile(file);
});

// ==================== 德州扑克 ====================
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const STARTING_CHIPS = 1000;

function setupPokerChannel(channel) {
  channel.onopen = () => { console.log('poker channel open'); state.pokerChannel = channel; };
  channel.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handlePokerMessage(msg);
    } catch(err) { console.error(err); }
  };
  channel.onclose = () => console.log('poker channel closed');
}

function handlePokerMessage(msg) {
  if (msg.type === 'game-start') {
    receiveGameStart(msg);
  } else if (msg.type === 'action') {
    receiveAction(msg);
  } else if (msg.type === 'game-end') {
    receiveGameEnd(msg);
  }
}

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function renderCard(card, hidden) {
  if (hidden) return `<div class="card-poker hidden-card"></div>`;
  const rankLabel = RANK_LABELS[card.rank] || card.rank;
  const isRed = card.suit === '♥' || card.suit === '♦';
  return `<div class="card-poker ${isRed ? 'red' : 'black'}">
    <div class="card-rank">${rankLabel}</div>
    <div class="card-suit">${card.suit}</div>
  </div>`;
}

function startPokerGame() {
  if (!state.connected || !state.pokerChannel || state.pokerChannel.readyState !== 'open') {
    toast('请先建立连接', 'warning'); return;
  }
  // 主机端: 发牌
  const deck = createDeck();
  const myCards = [deck.pop(), deck.pop()];
  const oppCards = [deck.pop(), deck.pop()];
  const community = [deck.pop(), deck.pop(), deck.pop()]; // flop

  state.poker = {
    deck, community, myCards, oppCards,
    myChips: STARTING_CHIPS, oppChips: STARTING_CHIPS,
    pot: SMALL_BLIND + BIG_BLIND,
    myBet: SMALL_BLIND, oppBet: BIG_BLIND,
    phase: 'preflop', // preflop, flop, turn, river, showdown
    currentTurn: 'host', // host is SB in first round - simplified: we alternate
    myRole: state.role === 'host' ? 'host' : 'guest',
    currentBet: BIG_BLIND,
    roundNum: 1,
    minRaise: BIG_BLIND,
    myFolded: false, oppFolded: false,
    waitingForOpp: false,
  };
  state.poker.myChips -= SMALL_BLIND;
  state.poker.oppChips -= BIG_BLIND;

  renderPoker();
  // 通知对方: 发送他的手牌、盲注信息、公共牌
  sendJSON({
    type: 'game-start',
    oppCards: oppCards,
    community: community,
    yourChips: STARTING_CHIPS - BIG_BLIND,
    myChips: STARTING_CHIPS - SMALL_BLIND,
    pot: SMALL_BLIND + BIG_BLIND,
    yourBet: BIG_BLIND,
    myBet: SMALL_BLIND,
    currentBet: BIG_BLIND,
    phase: 'preflop',
    yourTurn: false, // host 先行动, 对方等待
    roundNum: 1,
  }, state.pokerChannel);

  // host 先行动
  enablePokerActions();
  $('pokerStatus').textContent = '你的回合 (跟注 ' + (BIG_BLIND - SMALL_BLIND) + ')';
  $('pokerStatus').className = 'poker-status turn';
}

function receiveGameStart(msg) {
  state.poker = {
    myCards: msg.oppCards,
    oppCards: [], // 对手的牌对方知道, 我们不知道
    community: msg.community,
    myChips: msg.yourChips,
    oppChips: msg.myChips,
    pot: msg.pot,
    myBet: msg.yourBet,
    oppBet: msg.myBet,
    currentBet: msg.currentBet,
    phase: msg.phase,
    currentTurn: msg.yourTurn ? 'me' : 'opp',
    myRole: 'guest',
    roundNum: msg.roundNum,
    myFolded: false, oppFolded: false,
    waitingForOpp: !msg.yourTurn,
  };
  $('oppAvatar').textContent = getInitials(state.peerName || '对方');
  $('oppName').textContent = state.peerName || '对方';
  renderPoker();
  if (msg.yourTurn) {
    enablePokerActions();
    $('pokerStatus').textContent = '你的回合';
    $('pokerStatus').className = 'poker-status turn';
  } else {
    $('pokerStatus').textContent = '等待对手行动...';
    $('pokerStatus').className = 'poker-status';
  }
}

function enablePokerActions() {
  $('pokerStartBtn').style.display = 'none';
  $('pokerActionBtns').style.display = 'flex';
  $('pokerWaitMsg').style.display = 'none';
}

function disablePokerActions() {
  $('pokerActionBtns').style.display = 'none';
  $('pokerWaitMsg').style.display = 'flex';
}

function pokerAction(action) {
  if (!state.poker) return;
  const p = state.poker;
  const toCall = Math.max(0, p.currentBet - p.myBet);

  if (action === 'fold') {
    p.myFolded = true;
    sendJSON({ type: 'action', action: 'fold' }, state.pokerChannel);
    endHandByFold(false); // 自己弃牌 = 对手赢
    return;
  }

  if (action === 'check') {
    if (toCall > 0) { toast('不能过牌, 需要跟注', 'warning'); return; }
    sendJSON({ type: 'action', action: 'check' }, state.pokerChannel);
    progressToNextPhase();
    return;
  }

  if (action === 'call') {
    if (toCall === 0) { toast('无需跟注', 'warning'); return; }
    if (toCall > p.myChips) { toast('筹码不足', 'warning'); return; }
    p.myChips -= toCall;
    p.myBet += toCall;
    p.pot += toCall;
    sendJSON({ type: 'action', action: 'call', amount: toCall }, state.pokerChannel);
    progressToNextPhase();
    return;
  }

  if (action === 'raise') {
    const raiseAmt = parseInt($('betAmount').value, 10);
    if (!raiseAmt || raiseAmt <= 0) { toast('请输入加注金额', 'warning'); return; }
    const totalBet = toCall + raiseAmt;
    if (totalBet > p.myChips) { toast('筹码不足', 'warning'); return; }
    p.myChips -= totalBet;
    p.myBet += totalBet;
    p.pot += totalBet;
    p.currentBet = p.myBet;
    sendJSON({ type: 'action', action: 'raise', amount: totalBet, bet: raiseAmt }, state.pokerChannel);
    // 对手需要应对这个加注
    renderPoker();
    disablePokerActions();
    $('pokerStatus').textContent = '你加注 ' + raiseAmt + ', 等待对手回应';
    $('pokerStatus').className = 'poker-status';
    return;
  }

  if (action === 'allin') {
    const allIn = p.myChips;
    p.myChips = 0;
    p.myBet += allIn;
    p.pot += allIn;
    if (p.myBet > p.currentBet) p.currentBet = p.myBet;
    sendJSON({ type: 'action', action: 'allin', amount: allIn }, state.pokerChannel);
    renderPoker();
    disablePokerActions();
    $('pokerStatus').textContent = '你 ALL-IN ' + allIn + '!';
    $('pokerStatus').className = 'poker-status';
    return;
  }
}

function receiveAction(msg) {
  if (!state.poker) return;
  const p = state.poker;

  if (msg.action === 'fold') {
    p.oppFolded = true;
    endHandByFold(true);
    return;
  }

  if (msg.action === 'check') {
    toast('对手过牌', 'info', 1500);
    progressToNextPhase();
    return;
  }

  if (msg.action === 'call') {
    const amt = msg.amount || 0;
    p.oppChips -= amt;
    p.oppBet += amt;
    p.pot += amt;
    toast('对手跟注 ' + amt, 'info', 1500);
    progressToNextPhase();
    return;
  }

  if (msg.action === 'raise') {
    const total = msg.amount || 0;
    p.oppChips -= total;
    p.oppBet += total;
    p.pot += total;
    p.currentBet = p.oppBet;
    toast('对手加注!', 'warning', 2000);
    renderPoker();
    enablePokerActions();
    $('pokerStatus').textContent = '对手加注, 需要你回应';
    $('pokerStatus').className = 'poker-status turn';
    return;
  }

  if (msg.action === 'allin') {
    const allIn = msg.amount || 0;
    p.oppChips = 0;
    p.oppBet += allIn;
    p.pot += allIn;
    if (p.oppBet > p.currentBet) p.currentBet = p.oppBet;
    toast('对手 ALL-IN ' + allIn + '!', 'warning', 2500);
    renderPoker();
    enablePokerActions();
    return;
  }
}

function progressToNextPhase() {
  const p = state.poker;
  p.currentBet = 0;
  p.myBet = 0;
  p.oppBet = 0;

  if (p.phase === 'preflop') {
    p.phase = 'flop';
  } else if (p.phase === 'flop') {
    // 发 turn 牌
    if (p.deck && p.deck.length > 0) p.community.push(p.deck.pop());
    p.phase = 'turn';
  } else if (p.phase === 'turn') {
    if (p.deck && p.deck.length > 0) p.community.push(p.deck.pop());
    p.phase = 'river';
  } else if (p.phase === 'river') {
    showdown();
    return;
  }

  // 如果我是 host, 我先行动 (简化)
  const isMyTurn = (p.myRole === 'host');
  renderPoker();
  if (isMyTurn) {
    enablePokerActions();
    $('pokerStatus').textContent = '你的回合 (' + p.phase.toUpperCase() + ')';
    $('pokerStatus').className = 'poker-status turn';
  } else {
    disablePokerActions();
    $('pokerStatus').textContent = p.phase.toUpperCase() + ' - 等待对手行动';
    $('pokerStatus').className = 'poker-status';
  }

  // 通知对手新阶段的公共牌 (如果新增了牌)
  if (p.deck) {
    sendJSON({
      type: 'action',
      action: 'next-phase',
      phase: p.phase,
      community: p.community,
      yourTurn: !isMyTurn,
    }, state.pokerChannel);
  }
}

function endHandByFold(oppFolded) {
  const p = state.poker;
  if (oppFolded) {
    p.myChips += p.pot;
    $('pokerStatus').textContent = '对手弃牌, 你赢得底池 ' + p.pot + ' 筹码!';
  } else {
    p.oppChips += p.pot;
    $('pokerStatus').textContent = '你弃牌, 对手赢得底池 ' + p.pot + ' 筹码';
  }
  $('pokerStatus').className = 'poker-status win';
  disablePokerActions();
  $('pokerStartBtn').style.display = 'flex';
  $('pokerStartBtn').innerHTML = '<button class="btn btn-success" onclick="startPokerGame()">🎮 下一局</button>';
  renderPoker();
  sendJSON({ type: 'game-end', oppFolded: oppFolded, pot: p.pot, myChips: p.myChips, yourChips: p.oppChips }, state.pokerChannel);
}

function receiveGameEnd(msg) {
  const p = state.poker;
  if (!p) return;
  p.myChips = msg.yourChips;
  p.oppChips = msg.myChips;
  if (msg.oppFolded === true) {
    $('pokerStatus').textContent = '你弃牌, 对手赢得底池';
  } else if (msg.oppFolded === false) {
    $('pokerStatus').textContent = '对手弃牌, 你赢得底池!';
  } else if (msg.showdown) {
    $('pokerStatus').textContent = '对手: ' + msg.winnerText;
    if (msg.oppCards) p.oppCards = msg.oppCards;
  }
  $('pokerStatus').className = 'poker-status win';
  disablePokerActions();
  $('pokerStartBtn').style.display = 'flex';
  renderPoker();
}

function showdown() {
  const p = state.poker;
  // host 端计算胜负
  const myHand = evaluateBestHand([...p.myCards, ...p.community]);
  const oppHand = evaluateBestHand([...p.oppCards, ...p.community]);
  let winnerText;
  if (myHand.rank > oppHand.rank || (myHand.rank === oppHand.rank && myHand.tiebreak > oppHand.tiebreak)) {
    p.myChips += p.pot;
    winnerText = '你赢得底池 ' + p.pot + ' 筹码! (' + myHand.name + ')';
  } else if (oppHand.rank > myHand.rank || (myHand.rank === oppHand.rank && oppHand.tiebreak > myHand.tiebreak)) {
    p.oppChips += p.pot;
    winnerText = '对手赢得底池 (' + oppHand.name + ')';
  } else {
    p.myChips += p.pot / 2;
    p.oppChips += p.pot / 2;
    winnerText = '平分底池!';
  }
  $('pokerStatus').textContent = winnerText;
  $('pokerStatus').className = 'poker-status win';
  disablePokerActions();
  $('pokerStartBtn').style.display = 'flex';
  $('pokerStartBtn').innerHTML = '<button class="btn btn-success" onclick="startPokerGame()">🎮 下一局</button>';
  renderPoker(true);
  sendJSON({
    type: 'game-end',
    showdown: true,
    oppCards: p.oppCards,
    winnerText: winnerText,
    myChips: p.oppChips,
    yourChips: p.myChips,
  }, state.pokerChannel);
}

function renderPoker(showdown) {
  const p = state.poker;
  if (!p) return;
  $('meChips').textContent = p.myChips;
  $('oppChips').textContent = p.oppChips;
  $('potAmount').textContent = p.pot;
  $('meBet').textContent = '下注: ' + p.myBet;
  $('oppBet').textContent = '下注: ' + p.oppBet;
  $('roundNum').textContent = p.roundNum;

  // 自己的手牌
  $('meCards').innerHTML = p.myCards.map(c => renderCard(c)).join('');

  // 对手的手牌 (showdown 时展示)
  if (showdown && p.oppCards && p.oppCards.length) {
    $('oppCards').innerHTML = p.oppCards.map(c => renderCard(c)).join('');
  } else if (p.oppCards && p.oppCards.length && p.myRole === 'host' && showdown) {
    $('oppCards').innerHTML = p.oppCards.map(c => renderCard(c)).join('');
  } else {
    $('oppCards').innerHTML = [1,2].map(() => `<div class="card-poker hidden-card"></div>`).join('');
  }

  // 公共牌
  if (p.community) {
    $('communityCards').innerHTML = p.community.map(c => renderCard(c)).join('');
  }

  // 牌型展示
  const bestHand = evaluateBestHand([...p.myCards, ...(p.community || [])]);
  $('handRank').textContent = bestHand.name;
}

// 牌型评估: 返回 {rank(0-9), name, tiebreak}
function evaluateBestHand(cards) {
  // 穷举所有 5 张组合
  const combos = combinations(cards, 5);
  let best = { rank: -1, name: '高牌', tiebreak: 0 };
  for (const combo of combos) {
    const eval0 = evaluateFive(combo);
    if (eval0.rank > best.rank || (eval0.rank === best.rank && eval0.tiebreak > best.tiebreak)) {
      best = eval0;
    }
  }
  return best;
}

function combinations(arr, k) {
  const result = [];
  function helper(start, combo) {
    if (combo.length === k) { result.push([...combo]); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return result;
}

function evaluateFive(cards) {
  const ranks = cards.map(c => c.rank).sort((a,b)=>b-a);
  const suits = cards.map(c => c.suit);
  const uniqRanks = [...new Set(ranks)];
  const uniqSuits = [...new Set(suits)];

  const isFlush = uniqSuits.length === 1;
  const isStraight = (() => {
    const sorted = [...uniqRanks].sort((a,b)=>a-b);
    if (sorted.length !== 5) return false;
    if (sorted[4] - sorted[0] === 4) return true;
    // A-2-3-4-5
    if (sorted[0] === 2 && sorted[1] === 3 && sorted[2] === 4 && sorted[3] === 5 && sorted[4] === 14) return true;
    return false;
  })();
  const straightHigh = (() => {
    const sorted = [...uniqRanks].sort((a,b)=>a-b);
    if (sorted[0] === 2 && sorted[1] === 3 && sorted[2] === 4 && sorted[3] === 5 && sorted[4] === 14) return 5;
    return sorted[4];
  })();

  // 统计点数分布
  const countMap = {};
  for (const r of ranks) countMap[r] = (countMap[r] || 0) + 1;
  const counts = Object.values(countMap).sort((a,b)=>b-a);

  // 同花顺
  if (isStraight && isFlush) return { rank: 8, name: '同花顺', tiebreak: straightHigh };
  // 四条
  if (counts[0] === 4) return { rank: 7, name: '四条', tiebreak: ranks[0] };
  // 葫芦 (三带二)
  if (counts[0] === 3 && counts[1] === 2) return { rank: 6, name: '葫芦', tiebreak: ranks[0] };
  // 同花
  if (isFlush) return { rank: 5, name: '同花', tiebreak: ranks[0] };
  // 顺子
  if (isStraight) return { rank: 4, name: '顺子', tiebreak: straightHigh };
  // 三条
  if (counts[0] === 3) return { rank: 3, name: '三条', tiebreak: ranks[0] };
  // 两对
  if (counts[0] === 2 && counts[1] === 2) return { rank: 2, name: '两对', tiebreak: ranks[0] };
  // 对子
  if (counts[0] === 2) return { rank: 1, name: '对子', tiebreak: ranks[0] };
  // 高牌
  return { rank: 0, name: '高牌', tiebreak: ranks[0] };
}

// 处理 "next-phase" 消息 (在 receiveAction 中)
const origReceiveAction = handlePokerMessage;
// 额外处理 next-phase: 监听收到的 action=next-phase
(function patchActionHandler() {
  const original = handlePokerMessage;
  handlePokerMessage = function(msg) {
    if (msg.type === 'action' && msg.action === 'next-phase') {
      if (!state.poker) return;
      const p = state.poker;
      p.phase = msg.phase;
      p.community = msg.community;
      p.currentBet = 0;
      p.myBet = 0;
      p.oppBet = 0;
      renderPoker();
      if (msg.yourTurn) {
        enablePokerActions();
        $('pokerStatus').textContent = '你的回合 (' + p.phase.toUpperCase() + ')';
        $('pokerStatus').className = 'poker-status turn';
      } else {
        disablePokerActions();
        $('pokerStatus').textContent = p.phase.toUpperCase() + ' - 等待对手行动';
        $('pokerStatus').className = 'poker-status';
      }
      return;
    }
    original(msg);
  };
})();

// ==================== 初始化 ====================
initName();
setStatus('未连接', '');
updatePeerList();
