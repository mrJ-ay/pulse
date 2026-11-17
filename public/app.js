const TOKEN_KEY = 'pulse_oneid_token';
const VERIFIER_KEY = 'pulse_oneid_verifier';
const STATE_KEY = 'pulse_oneid_state';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let cfg = {
  oneidUrl: 'https://oneid-ruddy.vercel.app',
  onebankUrl: 'https://one-bank-lm2p.onrender.com',
  clientId: 'pulse',
};

let oneidToken = localStorage.getItem(TOKEN_KEY) || '';
let meUser = null; // { id, username, nickname }
let activeCategory = '전체';
let currentStream = null;
let isHost = false;
let localMediaStream = null;
let currentSourceType = 'screen';
let thumbInterval = null;
let ttsEnabled = true;
let modTarget = null; // { nickname, oneidId }

// WebRTC peers: host has Map<viewerId, RTCPeerConnection>; viewer has single viewerPc
const hostPeers = new Map();
let viewerPc = null;

// DOM
const brandHome = document.getElementById('brandHome');
const catTabs = document.getElementById('catTabs');
const bankBadge = document.getElementById('bankBadge');
const bankBalanceText = document.getElementById('bankBalanceText');
const goLiveBtn = document.getElementById('goLiveBtn');
const oneidBtn = document.getElementById('oneidBtn');

const lobbyView = document.getElementById('lobbyView');
const streamGrid = document.getElementById('streamGrid');
const refreshLobbyBtn = document.getElementById('refreshLobbyBtn');

const roomView = document.getElementById('roomView');
const videoPlayer = document.getElementById('videoPlayer');
const playerPlaceholder = document.getElementById('playerPlaceholder');
const placeholderText = document.getElementById('placeholderText');
const hudViewers = document.getElementById('hudViewers');
const hudDonated = document.getElementById('hudDonated');
const donationBanner = document.getElementById('donationBanner');
const donationBannerTitle = document.getElementById('donationBannerTitle');
const donationBannerMsg = document.getElementById('donationBannerMsg');

const muteToggleBtn = document.getElementById('muteToggleBtn');
const ttsToggleBtn = document.getElementById('ttsToggleBtn');
const switchSourceBtn = document.getElementById('switchSourceBtn');
const endStreamBtn = document.getElementById('endStreamBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const leaveStreamBtn = document.getElementById('leaveStreamBtn');

const roomCatBadge = document.getElementById('roomCatBadge');
const roomCodeBadge = document.getElementById('roomCodeBadge');
const roomTitleEl = document.getElementById('roomTitleEl');
const roomBjEl = document.getElementById('roomBjEl');
const modQuickActions = document.getElementById('modQuickActions');
const setNoticeBtn = document.getElementById('setNoticeBtn');

const myChatRole = document.getElementById('myChatRole');
const popoutChatBtn = document.getElementById('popoutChatBtn');
const pinnedNotice = document.getElementById('pinnedNotice');
const pinnedNoticeText = document.getElementById('pinnedNoticeText');
const chatList = document.getElementById('chatList');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const isPopout = new URLSearchParams(location.search).get('popout') === '1';
if (isPopout) document.body.classList.add('popout-mode');

const donateDrawer = document.getElementById('donateDrawer');
const toggleDonateBtn = document.getElementById('toggleDonateBtn');
const closeDonateDrawerBtn = document.getElementById('closeDonateDrawerBtn');
const donateAmtInput = document.getElementById('donateAmtInput');
const donateMsgInput = document.getElementById('donateMsgInput');
const donateSendBtn = document.getElementById('donateSendBtn');

const goLiveModal = document.getElementById('goLiveModal');
const closeGoLiveBtn = document.getElementById('closeGoLiveBtn');
const goLiveForm = document.getElementById('goLiveForm');

const modModal = document.getElementById('modModal');
const closeModBtn = document.getElementById('closeModBtn');
const modTargetTitle = document.getElementById('modTargetTitle');
const modManagerBtn = document.getElementById('modManagerBtn');
const modMuteBtn = document.getElementById('modMuteBtn');
const modKickBtn = document.getElementById('modKickBtn');

const socket = window.io();

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatWon(num) {
  return `₩${Number(num || 0).toLocaleString('ko-KR')}`;
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function startOneIdLogin() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64Url(digest);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const redirectUri = `${location.origin}${location.pathname}`;
  const query = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    state,
  });
  location.assign(`${cfg.oneidUrl}/login.html?${query.toString()}`);
}

async function handleOneIdCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return;
  const state = params.get('state');
  const expected = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  history.replaceState(null, '', location.pathname);
  if (!verifier || !state || state !== expected) return;

  const res = await fetch(`${cfg.oneidUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: cfg.clientId,
      redirect_uri: `${location.origin}${location.pathname}`,
      code,
      code_verifier: verifier,
    }),
  });
  const data = await res.json();
  if (res.ok && data.access_token) {
    oneidToken = data.access_token;
    localStorage.setItem(TOKEN_KEY, oneidToken);
  }
}

async function refreshAuthAndBank() {
  if (!oneidToken) {
    meUser = null;
    oneidBtn.textContent = 'ONEID 로그인';
    bankBadge.hidden = true;
    socket.emit('auth:identify', {});
    return;
  }

  try {
    const r = await fetch(`${cfg.oneidUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${oneidToken}` },
    });
    if (!r.ok) throw new Error('expired');
    const u = await r.json();
    meUser = { id: String(u.id), username: u.username, nickname: u.nickname || u.username };
    oneidBtn.textContent = `${meUser.nickname} (로그아웃)`;
    socket.emit('auth:identify', { token: oneidToken });

    try {
      const br = await fetch('/api/bank/me', {
        headers: { Authorization: `Bearer ${oneidToken}` },
      });
      const bd = await br.json();
      if (br.ok && bd.account) {
        bankBadge.hidden = false;
        bankBalanceText.textContent = formatWon(bd.account.balance);
      } else {
        bankBadge.hidden = false;
        bankBalanceText.textContent = '계좌 없음';
      }
    } catch {
      bankBadge.hidden = true;
    }
  } catch {
    oneidToken = '';
    meUser = null;
    localStorage.removeItem(TOKEN_KEY);
    oneidBtn.textContent = 'ONEID 로그인';
    bankBadge.hidden = true;
    socket.emit('auth:identify', {});
  }
}

oneidBtn.addEventListener('click', () => {
  if (meUser) {
    if (!confirm('로그아웃하시겠습니까?')) return;
    oneidToken = '';
    localStorage.removeItem(TOKEN_KEY);
    refreshAuthAndBank();
  } else {
    startOneIdLogin().catch((err) => alert(err.message));
  }
});

// Lobby
async function loadStreams() {
  try {
    const res = await fetch('/api/streams');
    const data = await res.json();
    const list = (data.streams || []).filter(
      (s) => activeCategory === '전체' || s.category === activeCategory
    );
    renderStreams(list);
  } catch {
    streamGrid.innerHTML = '<div class="empty-lobby">방송 목록을 불러오지 못했습니다.</div>';
  }
}

function renderStreams(list) {
  if (!list.length) {
    streamGrid.innerHTML = '<div class="empty-lobby">현재 방송 중인 채널이 없습니다. 우측 상단 <strong>방송하기</strong>를 눌러 첫 방송을 켜보세요!</div>';
    return;
  }
  streamGrid.innerHTML = list
    .map(
      (s) => `
      <article class="stream-card" data-stream-id="${escapeHtml(s.id)}">
        <div class="stream-thumb">
          ${s.thumbnail ? `<img src="${escapeHtml(s.thumbnail)}" alt="방송 화면" />` : '<span class="thumb-fallback">LIVE STREAM</span>'}
          <span class="thumb-live">LIVE</span>
          <span class="thumb-viewers">👁 ${s.viewerCount}명</span>
        </div>
        <div class="stream-card-body">
          <div class="stream-card-meta">
            <span>${escapeHtml(s.category)}</span>
            <span>💸 ${formatWon(s.totalDonated)}</span>
          </div>
          <h3>${escapeHtml(s.title)}</h3>
          <div class="stream-card-bj">BJ ${escapeHtml(s.bjName)}</div>
        </div>
      </article>
    `
    )
    .join('');

  streamGrid.querySelectorAll('[data-stream-id]').forEach((card) => {
    card.addEventListener('click', () => joinStream(card.dataset.streamId));
  });
}

catTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cat]');
  if (!btn) return;
  activeCategory = btn.dataset.cat;
  catTabs.querySelectorAll('.cat-btn').forEach((b) => b.classList.toggle('active', b === btn));
  loadStreams();
});

refreshLobbyBtn.addEventListener('click', loadStreams);
brandHome.addEventListener('click', (e) => {
  e.preventDefault();
  if (currentStream) leaveCurrentStream();
});

// Media Capture & WebRTC
async function captureSource(type) {
  if (type === 'camera') {
    return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: true,
  });
  // Optional mic mix if user wants mic too? Keep clean display audio first.
  return display;
}

function cleanupMedia() {
  if (thumbInterval) {
    clearInterval(thumbInterval);
    thumbInterval = null;
  }
  if (localMediaStream) {
    localMediaStream.getTracks().forEach((t) => t.stop());
    localMediaStream = null;
  }
  for (const pc of hostPeers.values()) {
    try { pc.close(); } catch {}
  }
  hostPeers.clear();
  if (viewerPc) {
    try { viewerPc.close(); } catch {}
    viewerPc = null;
  }
  videoPlayer.srcObject = null;
}

function startThumbnailLoop(streamId) {
  if (thumbInterval) clearInterval(thumbInterval);
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  const sendThumb = () => {
    if (!isHost || !currentStream || videoPlayer.readyState < 2) return;
    try {
      ctx.drawImage(videoPlayer, 0, 0, 320, 180);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.55);
      socket.emit('stream:thumbnail', { streamId, dataUrl });
    } catch {}
  };
  setTimeout(sendThumb, 1200);
  thumbInterval = setInterval(sendThumb, 8000);
}

goLiveBtn.addEventListener('click', () => {
  if (!meUser || !oneidToken) {
    alert('방송을 시작하려면 먼저 ONEID 로그인을 해주세요.');
    startOneIdLogin().catch(console.error);
    return;
  }
  goLiveModal.hidden = false;
});

closeGoLiveBtn.addEventListener('click', () => { goLiveModal.hidden = true; });

goLiveForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('streamTitleInput').value.trim();
  const category = document.getElementById('streamCatSelect').value;
  const source = document.getElementById('streamSourceSelect').value;
  if (!title) return;

  try {
    const media = await captureSource(source);
    currentSourceType = source;
    localMediaStream = media;
    goLiveModal.hidden = true;

    // Auto end if user stops screen sharing via browser bar
    media.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (isHost && currentStream) {
        socket.emit('stream:end');
        exitToLobby();
      }
    });

    socket.emit('stream:start', { title, category, token: oneidToken }, (res) => {
      if (!res?.ok) {
        cleanupMedia();
        alert(res?.error || '방송 시작 실패');
        return;
      }
      isHost = true;
      enterRoomUI(res.stream);
      videoPlayer.muted = true;
      videoPlayer.srcObject = localMediaStream;
      playerPlaceholder.hidden = true;
      startThumbnailLoop(res.stream.id);
    });
  } catch (err) {
    alert(`송출 소스를 가져오지 못했습니다: ${err.message}`);
  }
});

switchSourceBtn.addEventListener('click', async () => {
  if (!isHost || !localMediaStream) return;
  const nextType = currentSourceType === 'screen' ? 'camera' : 'screen';
  try {
    const nextMedia = await captureSource(nextType);
    const nextVideoTrack = nextMedia.getVideoTracks()[0];
    const nextAudioTrack = nextMedia.getAudioTracks()[0] || null;

    for (const pc of hostPeers.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === 'video' && nextVideoTrack) {
          await sender.replaceTrack(nextVideoTrack);
        }
        if (sender.track?.kind === 'audio' && nextAudioTrack) {
          await sender.replaceTrack(nextAudioTrack);
        }
      }
    }

    localMediaStream.getTracks().forEach((t) => t.stop());
    localMediaStream = nextMedia;
    currentSourceType = nextType;
    videoPlayer.srcObject = localMediaStream;
    nextVideoTrack?.addEventListener('ended', () => {
      if (isHost && currentStream) {
        socket.emit('stream:end');
        exitToLobby();
      }
    });
  } catch (err) {
    alert(`소스 전환 실패: ${err.message}`);
  }
});

function enterRoomUI(stream) {
  currentStream = stream;
  lobbyView.hidden = true;
  roomView.hidden = false;
  chatList.innerHTML = '';
  updateStreamStateUI(stream);
  history.replaceState(null, '', `?stream=${encodeURIComponent(stream.id)}`);
}

function exitToLobby() {
  cleanupMedia();
  currentStream = null;
  isHost = false;
  roomView.hidden = true;
  lobbyView.hidden = false;
  history.replaceState(null, '', location.pathname);
  loadStreams();
}

function leaveCurrentStream() {
  if (isHost) {
    if (!confirm('방송을 종료하고 로비로 나가시겠습니까?')) return;
    socket.emit('stream:end');
  } else {
    socket.emit('stream:leave');
  }
  exitToLobby();
}

function updateStreamStateUI(stream) {
  currentStream = stream;
  hudViewers.textContent = `👁 ${stream.viewerCount}명`;
  hudDonated.textContent = `💸 ${formatWon(stream.totalDonated)}`;
  roomCatBadge.textContent = stream.category;
  roomCodeBadge.textContent = `#${stream.id}`;
  roomTitleEl.textContent = stream.title;
  roomBjEl.textContent = stream.bjName;

  if (stream.notice) {
    pinnedNotice.hidden = false;
    pinnedNoticeText.textContent = stream.notice;
  } else {
    pinnedNotice.hidden = true;
  }

  const amManager = Boolean(meUser && stream.managers?.includes(meUser.nickname));
  switchSourceBtn.hidden = !isHost;
  endStreamBtn.hidden = !isHost;
  if (popoutChatBtn) popoutChatBtn.hidden = !isHost;
  modQuickActions.hidden = !(isHost || amManager);

  if (isHost) {
    myChatRole.textContent = 'BJ';
  } else if (amManager) {
    myChatRole.textContent = '매니저';
  } else {
    myChatRole.textContent = meUser ? meUser.nickname : '게스트';
  }
}

function joinStream(streamId, chatOnly = isPopout) {
  socket.emit('stream:join', { streamId, chatOnly }, (res) => {
    if (!res?.ok) {
      alert(res?.error || '방송 입장 실패');
      if (!isPopout) loadStreams();
      return;
    }
    isHost = Boolean(res.isHost);
    enterRoomUI(res.stream);
    if (!chatOnly && !isHost) {
      videoPlayer.muted = false;
      playerPlaceholder.hidden = false;
      placeholderText.textContent = 'BJ의 방송 신호를 연결하는 중...';
    }
  });
}

popoutChatBtn?.addEventListener('click', () => {
  if (!currentStream) return;
  const url = `${location.origin}${location.pathname}?stream=${encodeURIComponent(currentStream.id)}&popout=1`;
  window.open(url, `pulse_chat_${currentStream.id}`, 'width=400,height=680,resizable=yes,scrollbars=yes');
});

// Host WebRTC
socket.on('webrtc:viewer_joined', async ({ viewerId }) => {
  if (!isHost || !localMediaStream) return;
  const pc = new RTCPeerConnection(ICE_CONFIG);
  hostPeers.set(viewerId, pc);

  localMediaStream.getTracks().forEach((track) => pc.addTrack(track, localMediaStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc:ice', { targetId: viewerId, candidate: e.candidate });
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc:offer', { targetId: viewerId, sdp: offer });
});

socket.on('webrtc:viewer_left', ({ viewerId }) => {
  const pc = hostPeers.get(viewerId);
  if (pc) {
    try { pc.close(); } catch {}
    hostPeers.delete(viewerId);
  }
});

// Viewer WebRTC
socket.on('webrtc:offer', async ({ fromId, sdp }) => {
  if (isHost) return;
  if (viewerPc) {
    try { viewerPc.close(); } catch {}
  }
  viewerPc = new RTCPeerConnection(ICE_CONFIG);

  viewerPc.ontrack = (e) => {
    videoPlayer.srcObject = e.streams[0];
    playerPlaceholder.hidden = true;
    videoPlayer.play().catch(() => {
      videoPlayer.muted = true;
      muteToggleBtn.textContent = '🔇 음소거됨 (클릭)';
      videoPlayer.play().catch(() => {});
    });
  };

  viewerPc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc:ice', { targetId: fromId, candidate: e.candidate });
    }
  };

  await viewerPc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await viewerPc.createAnswer();
  await viewerPc.setLocalDescription(answer);
  socket.emit('webrtc:answer', { targetId: fromId, sdp: answer });
});

socket.on('webrtc:answer', async ({ fromId, sdp }) => {
  const pc = hostPeers.get(fromId);
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
});

socket.on('webrtc:ice', async ({ fromId, candidate }) => {
  const pc = isHost ? hostPeers.get(fromId) : viewerPc;
  if (pc && candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {}
  }
});

// Stream Events
socket.on('streams:updated', () => {
  if (!currentStream) loadStreams();
});

socket.on('stream:state', (stream) => {
  if (currentStream && stream.id === currentStream.id) {
    updateStreamStateUI(stream);
  }
});

socket.on('stream:ended', ({ reason }) => {
  alert(reason || '방송이 종료되었습니다.');
  exitToLobby();
});

socket.on('stream:kicked', ({ reason }) => {
  alert(reason || '방송에서 강퇴되었습니다.');
  exitToLobby();
});

// Controls
muteToggleBtn.addEventListener('click', () => {
  videoPlayer.muted = !videoPlayer.muted;
  muteToggleBtn.textContent = videoPlayer.muted ? '🔇 음소거됨' : '🔊 소리 켜짐';
});

ttsToggleBtn.addEventListener('click', () => {
  ttsEnabled = !ttsEnabled;
  ttsToggleBtn.classList.toggle('active', ttsEnabled);
  ttsToggleBtn.textContent = ttsEnabled ? '🗣️ TTS 켜짐' : '🔇 TTS 꺼짐';
  if (!ttsEnabled && window.speechSynthesis) window.speechSynthesis.cancel();
});

fullscreenBtn.addEventListener('click', () => {
  const wrap = videoPlayer.parentElement;
  if (!document.fullscreenElement) {
    wrap.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.().catch(() => {});
  }
});

endStreamBtn.addEventListener('click', leaveCurrentStream);
leaveStreamBtn.addEventListener('click', leaveCurrentStream);

// Chat & Moderation
function appendChatRow(html) {
  const div = document.createElement('div');
  div.className = 'chat-item';
  div.innerHTML = html;
  chatList.appendChild(div);
  chatList.scrollTop = chatList.scrollHeight;
}

const NICK_COLORS = ['#00ffa3', '#38bdf8', '#f472b6', '#fbbf24', '#a78bfa', '#fb7185'];
function pickNickColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NICK_COLORS[h % NICK_COLORS.length];
}

socket.on('chat:message', (msg) => {
  const roleBadge =
    msg.role === 'bj'
      ? '<span class="badge-role bj">BJ</span>'
      : msg.role === 'manager'
      ? '<span class="badge-role manager">매니저</span>'
      : '';
  const timeStr = new Date(msg.createdAt || Date.now()).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const nickColor =
    msg.role === 'bj' ? '#00ffa3' : msg.role === 'manager' ? '#00d4ff' : pickNickColor(msg.nickname || '');
  appendChatRow(
    `<span class="chat-time">${timeStr}</span>${roleBadge}<span class="chat-nick ${escapeHtml(msg.role)}" style="color:${nickColor}" data-nick="${escapeHtml(msg.nickname)}" data-oneid="${escapeHtml(msg.oneidId || '')}">${escapeHtml(msg.nickname)}</span><span class="chat-text">${escapeHtml(msg.text)}</span>`
  );
});

socket.on('chat:system', ({ text }) => {
  appendChatRow(`<div class="chat-system">${escapeHtml(text)}</div>`);
});

chatList.addEventListener('click', (e) => {
  const nickEl = e.target.closest('.chat-nick');
  if (!nickEl || !currentStream) return;
  const amManager = Boolean(meUser && currentStream.managers?.includes(meUser.nickname));
  if (!(isHost || amManager)) return;

  const targetNick = nickEl.dataset.nick;
  if (!targetNick || targetNick === currentStream.bjName) return;

  modTarget = { nickname: targetNick, oneidId: nickEl.dataset.oneid || '' };
  modTargetTitle.textContent = `${targetNick} 관리`;
  modManagerBtn.hidden = !isHost;
  modModal.hidden = false;
});

closeModBtn.addEventListener('click', () => { modModal.hidden = true; });
modManagerBtn.addEventListener('click', () => {
  if (!modTarget) return;
  socket.emit('mod:manager', { nickname: modTarget.nickname }, (r) => {
    if (r && !r.ok) alert(r.error);
    modModal.hidden = true;
  });
});
modMuteBtn.addEventListener('click', () => {
  if (!modTarget) return;
  socket.emit('mod:mute', { nickname: modTarget.nickname }, (r) => {
    if (r && !r.ok) alert(r.error);
    modModal.hidden = true;
  });
});
modKickBtn.addEventListener('click', () => {
  if (!modTarget) return;
  if (!confirm(`${modTarget.nickname} 님을 방송에서 강퇴할까요?`)) return;
  socket.emit('mod:kick', modTarget, (r) => {
    if (r && !r.ok) alert(r.error);
    modModal.hidden = true;
  });
});

setNoticeBtn.addEventListener('click', () => {
  const next = prompt('채팅창 상단에 고정할 공지사항을 입력하세요 (비우면 해제):', currentStream?.notice || '');
  if (next === null) return;
  socket.emit('mod:notice', { text: next }, (r) => {
    if (r && !r.ok) alert(r.error);
  });
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat:send', { text }, (r) => {
    if (r && !r.ok) alert(r.error);
  });
  chatInput.value = '';
});

toggleDonateBtn?.addEventListener('click', () => {
  const willOpen = donateDrawer.hidden;
  donateDrawer.hidden = !willOpen;
  toggleDonateBtn.classList.toggle('active', willOpen);
});

closeDonateDrawerBtn?.addEventListener('click', () => {
  donateDrawer.hidden = true;
  toggleDonateBtn?.classList.remove('active');
});

// Donations & TTS
document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    donateAmtInput.value = btn.dataset.amt;
  });
});

donateSendBtn.addEventListener('click', async () => {
  if (!currentStream) return;
  if (!meUser || !oneidToken) {
    alert('후원하려면 먼저 ONEID 로그인을 해주세요.');
    startOneIdLogin().catch(console.error);
    return;
  }
  const amount = Math.floor(Number(donateAmtInput.value));
  const message = donateMsgInput.value.trim();
  if (!Number.isFinite(amount) || amount < 100) {
    alert('최소 후원 금액은 100원입니다.');
    return;
  }

  donateSendBtn.disabled = true;
  try {
    const res = await fetch(`/api/streams/${encodeURIComponent(currentStream.id)}/donate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oneidToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount, message }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '후원 실패');
    donateMsgInput.value = '';
    donateDrawer.hidden = true;
    toggleDonateBtn?.classList.remove('active');
    if (typeof data.balance === 'number') {
      bankBalanceText.textContent = formatWon(data.balance);
    }
  } catch (err) {
    alert(err.message);
  } finally {
    donateSendBtn.disabled = false;
  }
});

let bannerTimer = null;
function speakDonationTTS(senderName, amount, message) {
  if (!ttsEnabled || !('speechSynthesis' in window)) return;
  try {
    const text = message
      ? `${senderName}님이 ${amount.toLocaleString('ko-KR')}원 후원하셨습니다. ${message}`
      : `${senderName}님이 ${amount.toLocaleString('ko-KR')}원 후원하셨습니다.`;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'ko-KR';
    utter.rate = 1.05;
    window.speechSynthesis.speak(utter);
  } catch {}
}

socket.on('stream:donation', (d) => {
  if (!currentStream) return;
  currentStream.totalDonated = d.totalDonated;
  hudDonated.textContent = `💸 ${formatWon(d.totalDonated)}`;

  donationBannerTitle.textContent = `${d.senderName}님이 ${formatWon(d.amount)} 후원!`;
  donationBannerMsg.textContent = d.message || '';
  donationBanner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { donationBanner.hidden = true; }, 5000);

  appendChatRow(
    `<div class="chat-donation">🎉 <strong>${escapeHtml(d.senderName)}</strong>님이 <strong>${formatWon(d.amount)}</strong> 후원!${d.message ? `<div>${escapeHtml(d.message)}</div>` : ''}</div>`
  );

  speakDonationTTS(d.senderName, d.amount, d.message);
});

// Init
(async function init() {
  try {
    const cr = await fetch('/api/config');
    if (cr.ok) cfg = await cr.json();
  } catch {}
  await handleOneIdCallback();
  await refreshAuthAndBank();
  await loadStreams();

  const initStreamId = new URLSearchParams(location.search).get('stream');
  if (initStreamId) joinStream(initStreamId);
})();
