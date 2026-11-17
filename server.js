import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const ONEID_URL = (process.env.ONEID_URL || 'https://oneid-ruddy.vercel.app').replace(/\/$/, '');
const ONEBANK_URL = (process.env.ONEBANK_URL || 'https://one-bank-lm2p.onrender.com').replace(/\/$/, '');
const ONEID_CLIENT_ID = process.env.ONEID_CLIENT_ID || 'pulse';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Active live streams: streamId -> stream object
const streams = new Map();

function makeId(len = 8) {
  return crypto.randomBytes(len).toString('hex').slice(0, len).toUpperCase();
}

async function verifyOneIdToken(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${ONEID_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const u = await res.json();
    return {
      id: String(u.id),
      username: u.username,
      nickname: u.nickname || u.username,
      isAdmin: Boolean(u.is_admin),
    };
  } catch {
    return null;
  }
}

async function fetchOneBankAccount(token) {
  const res = await fetch(`${ONEBANK_URL}/api/account/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.detail || 'ONE BANK 계좌를 불러올 수 없습니다.');
  }
  return data.account || data;
}

function serializeStream(s) {
  return {
    id: s.id,
    title: s.title,
    category: s.category,
    bjName: s.bjName,
    bjOneId: s.bjOneId,
    bjAccountNumber: s.bjAccountNumber || null,
    viewerCount: s.viewers.size,
    totalDonated: s.totalDonated,
    notice: s.notice,
    thumbnail: s.thumbnail,
    managers: [...s.managers],
    muted: [...s.muted],
    startedAt: s.startedAt,
  };
}

// REST Endpoints
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'pulse', streams: streams.size });
});

app.get('/api/config', (_req, res) => {
  res.json({ oneidUrl: ONEID_URL, onebankUrl: ONEBANK_URL, clientId: ONEID_CLIENT_ID });
});

app.get('/api/streams', (_req, res) => {
  const list = [...streams.values()]
    .map(serializeStream)
    .sort((a, b) => b.viewerCount - a.viewerCount || b.startedAt - a.startedAt);
  res.json({ streams: list });
});

app.get('/api/bank/me', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'ONEID 로그인이 필요합니다.' });
  try {
    const account = await fetchOneBankAccount(token);
    res.json({ ok: true, account });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/streams/:id/donate', async (req, res) => {
  const stream = streams.get(String(req.params.id || '').toUpperCase());
  if (!stream) return res.status(404).json({ error: '현재 방송 중인 방을 찾을 수 없습니다.' });

  const auth = req.headers.authorization || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: '후원하려면 ONEID 로그인이 필요합니다.' });

  const sender = await verifyOneIdToken(token);
  if (!sender) return res.status(401).json({ error: 'ONEID 로그인이 만료되었습니다.' });

  const amount = Math.floor(Number(req.body?.amount));
  const message = String(req.body?.message || '').trim().slice(0, 120);
  if (!Number.isFinite(amount) || amount < 100) {
    return res.status(400).json({ error: '최소 후원 금액은 100원입니다.' });
  }

  const targetIdentifier = stream.bjAccountNumber || stream.bjName;
  try {
    const resp = await fetch(`${ONEBANK_URL}/api/account/transfer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        toIdentifier: targetIdentifier,
        amount,
        senderMemo: `PULSE 후원 → ${stream.bjName}`,
        recipientMemo: `PULSE 후원 ← ${sender.nickname}`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !result.ok) {
      return res.status(400).json({ error: result.error || 'ONE BANK 송금에 실패했습니다.' });
    }

    stream.totalDonated += amount;
    const donation = {
      id: makeId(8),
      senderName: sender.nickname,
      amount,
      message,
      totalDonated: stream.totalDonated,
      createdAt: Date.now(),
    };

    io.to(`stream:${stream.id}`).emit('stream:donation', donation);
    io.emit('streams:updated');

    let newBalance = null;
    try {
      const acc = await fetchOneBankAccount(token);
      newBalance = acc.balance;
    } catch {}

    res.json({ ok: true, donation, balance: newBalance });
  } catch (err) {
    res.status(502).json({ error: err.message || 'ONE BANK 서버와 통신하지 못했습니다.' });
  }
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 2e6,
});

function isModerator(stream, socket) {
  if (!stream || !socket.data.user) return false;
  if (socket.id === stream.bjSocketId) return true;
  if (socket.data.user.oneidId && socket.data.user.oneidId === stream.bjOneId) return true;
  return stream.managers.has(socket.data.user.nickname);
}

io.on('connection', (socket) => {
  socket.data.user = {
    oneidId: null,
    nickname: `시청자_${socket.id.slice(0, 4)}`,
    isGuest: true,
  };
  socket.data.streamId = null;
  socket.data.hostingStreamId = null;

  socket.on('auth:identify', async ({ token, guestName } = {}, cb) => {
    if (token) {
      const u = await verifyOneIdToken(token);
      if (u) {
        socket.data.user = { oneidId: u.id, nickname: u.nickname, isGuest: false };
        cb?.({ ok: true, user: socket.data.user });
        return;
      }
    }
    const clean = String(guestName || '').trim().slice(0, 18);
    if (clean) socket.data.user.nickname = clean;
    socket.data.user.isGuest = true;
    socket.data.user.oneidId = null;
    cb?.({ ok: true, user: socket.data.user });
  });

  socket.on('stream:start', async ({ title, category, token } = {}, cb) => {
    const u = await verifyOneIdToken(token);
    if (!u) {
      cb?.({ ok: false, error: '방송을 시작하려면 ONEID 로그인이 필요합니다.' });
      return;
    }

    let bjAccountNumber = null;
    try {
      const acc = await fetchOneBankAccount(token);
      bjAccountNumber = acc.accountNumber || null;
    } catch {
      bjAccountNumber = null;
    }

    // End previous stream if this socket was hosting
    if (socket.data.hostingStreamId) {
      const old = streams.get(socket.data.hostingStreamId);
      if (old) {
        io.to(`stream:${old.id}`).emit('stream:ended', { reason: 'BJ가 새 방송을 시작했습니다.' });
        streams.delete(old.id);
      }
    }

    const id = makeId(6);
    const stream = {
      id,
      title: String(title || `${u.nickname}의 라이브 방송`).trim().slice(0, 60),
      category: String(category || '토크').trim().slice(0, 16),
      bjSocketId: socket.id,
      bjOneId: u.id,
      bjName: u.nickname,
      bjAccountNumber,
      viewers: new Set(),
      managers: new Set(),
      muted: new Set(),
      kickedOneIds: new Set(),
      kickedNames: new Set(),
      notice: '',
      totalDonated: 0,
      thumbnail: null,
      startedAt: Date.now(),
    };

    streams.set(id, stream);
    socket.data.user = { oneidId: u.id, nickname: u.nickname, isGuest: false };
    socket.data.hostingStreamId = id;
    socket.data.streamId = id;
    socket.join(`stream:${id}`);

    cb?.({ ok: true, stream: serializeStream(stream) });
    io.emit('streams:updated');
  });

  socket.on('stream:thumbnail', ({ streamId, dataUrl } = {}) => {
    const s = streams.get(String(streamId || '').toUpperCase());
    if (!s || s.bjSocketId !== socket.id) return;
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') && dataUrl.length < 350000) {
      s.thumbnail = dataUrl;
    }
  });

  socket.on('stream:end', () => {
    const id = socket.data.hostingStreamId;
    if (!id) return;
    const s = streams.get(id);
    if (s && s.bjSocketId === socket.id) {
      io.to(`stream:${id}`).emit('stream:ended', { reason: 'BJ가 방송을 종료했습니다.' });
      streams.delete(id);
      socket.data.hostingStreamId = null;
      io.emit('streams:updated');
    }
  });

  socket.on('stream:join', ({ streamId, chatOnly } = {}, cb) => {
    const id = String(streamId || '').toUpperCase();
    const s = streams.get(id);
    if (!s) {
      cb?.({ ok: false, error: '종료되었거나 존재하지 않는 방송입니다.' });
      return;
    }
    const u = socket.data.user;
    if ((u.oneidId && s.kickedOneIds.has(u.oneidId)) || s.kickedNames.has(u.nickname)) {
      cb?.({ ok: false, error: '이 방송에서 강퇴되어 입장할 수 없습니다.' });
      return;
    }

    if (socket.data.streamId && socket.data.streamId !== id) {
      const prev = streams.get(socket.data.streamId);
      if (prev) {
        prev.viewers.delete(socket.id);
        socket.leave(`stream:${prev.id}`);
        io.to(`stream:${prev.id}`).emit('stream:state', serializeStream(prev));
      }
    }

    socket.data.streamId = id;
    socket.data.chatOnly = Boolean(chatOnly);
    socket.join(`stream:${id}`);
    if (!chatOnly && socket.id !== s.bjSocketId) {
      s.viewers.add(socket.id);
      io.to(s.bjSocketId).emit('webrtc:viewer_joined', { viewerId: socket.id });
    }

    const isHostUser = socket.id === s.bjSocketId || Boolean(u.oneidId && u.oneidId === s.bjOneId);
    const state = serializeStream(s);
    cb?.({ ok: true, stream: state, isHost: isHostUser });
    if (!chatOnly) {
      io.to(`stream:${id}`).emit('stream:state', state);
      io.emit('streams:updated');
    }
  });

  socket.on('stream:leave', () => {
    const id = socket.data.streamId;
    if (!id) return;
    const s = streams.get(id);
    if (s) {
      s.viewers.delete(socket.id);
      socket.leave(`stream:${id}`);
      if (s.bjSocketId !== socket.id) {
        io.to(s.bjSocketId).emit('webrtc:viewer_left', { viewerId: socket.id });
      }
      io.to(`stream:${id}`).emit('stream:state', serializeStream(s));
      io.emit('streams:updated');
    }
    socket.data.streamId = null;
  });

  // WebRTC Signaling
  socket.on('webrtc:offer', ({ targetId, sdp } = {}) => {
    if (targetId && sdp) io.to(targetId).emit('webrtc:offer', { fromId: socket.id, sdp });
  });

  socket.on('webrtc:answer', ({ targetId, sdp } = {}) => {
    if (targetId && sdp) io.to(targetId).emit('webrtc:answer', { fromId: socket.id, sdp });
  });

  socket.on('webrtc:ice', ({ targetId, candidate } = {}) => {
    if (targetId && candidate) io.to(targetId).emit('webrtc:ice', { fromId: socket.id, candidate });
  });

  // Chat
  socket.on('chat:send', ({ text } = {}, cb) => {
    const id = socket.data.streamId;
    const s = streams.get(id);
    if (!s) return cb?.({ ok: false, error: '방송에 입장해 있지 않습니다.' });

    const u = socket.data.user;
    if (s.muted.has(u.nickname)) {
      return cb?.({ ok: false, error: '채팅 금지 상태입니다.' });
    }

    const clean = String(text || '').trim().slice(0, 300);
    if (!clean) return;

    const isBj = socket.id === s.bjSocketId || (u.oneidId && u.oneidId === s.bjOneId);
    const isManager = !isBj && s.managers.has(u.nickname);

    io.to(`stream:${id}`).emit('chat:message', {
      id: makeId(8),
      senderId: socket.id,
      oneidId: u.oneidId,
      nickname: u.nickname,
      role: isBj ? 'bj' : isManager ? 'manager' : 'viewer',
      text: clean,
      createdAt: Date.now(),
    });
    cb?.({ ok: true });
  });

  // Moderation: Notice / Manager / Mute / Kick
  socket.on('mod:notice', ({ text } = {}, cb) => {
    const s = streams.get(socket.data.streamId);
    if (!s || !isModerator(s, socket)) return cb?.({ ok: false, error: '권한이 없습니다.' });
    s.notice = String(text || '').trim().slice(0, 140);
    io.to(`stream:${s.id}`).emit('stream:state', serializeStream(s));
    io.to(`stream:${s.id}`).emit('chat:system', {
      text: s.notice ? `📌 공지 등록: ${s.notice}` : '📌 공지가 해제되었습니다.',
    });
    cb?.({ ok: true });
  });

  socket.on('mod:manager', ({ nickname } = {}, cb) => {
    const s = streams.get(socket.data.streamId);
    if (!s || socket.id !== s.bjSocketId) return cb?.({ ok: false, error: 'BJ만 매니저를 임명할 수 있습니다.' });
    const target = String(nickname || '').trim();
    if (!target || target === s.bjName) return;

    if (s.managers.has(target)) {
      s.managers.delete(target);
      io.to(`stream:${s.id}`).emit('chat:system', { text: `${target} 님의 매니저 권한이 해제되었습니다.` });
    } else {
      s.managers.add(target);
      io.to(`stream:${s.id}`).emit('chat:system', { text: `🛡️ ${target} 님이 매니저로 임명되었습니다.` });
    }
    io.to(`stream:${s.id}`).emit('stream:state', serializeStream(s));
    cb?.({ ok: true });
  });

  socket.on('mod:mute', ({ nickname } = {}, cb) => {
    const s = streams.get(socket.data.streamId);
    if (!s || !isModerator(s, socket)) return cb?.({ ok: false, error: '권한이 없습니다.' });
    const target = String(nickname || '').trim();
    if (!target || target === s.bjName) return;

    if (s.muted.has(target)) {
      s.muted.delete(target);
      io.to(`stream:${s.id}`).emit('chat:system', { text: `${target} 님의 채팅 금지가 해제되었습니다.` });
    } else {
      s.muted.add(target);
      io.to(`stream:${s.id}`).emit('chat:system', { text: `🔇 ${target} 님이 채팅 금지(채금) 처리되었습니다.` });
    }
    io.to(`stream:${s.id}`).emit('stream:state', serializeStream(s));
    cb?.({ ok: true });
  });

  socket.on('mod:kick', ({ nickname, oneidId } = {}, cb) => {
    const s = streams.get(socket.data.streamId);
    if (!s || !isModerator(s, socket)) return cb?.({ ok: false, error: '권한이 없습니다.' });
    const target = String(nickname || '').trim();
    if (!target || target === s.bjName) return;

    s.kickedNames.add(target);
    if (oneidId) s.kickedOneIds.add(String(oneidId));

    for (const sock of io.sockets.sockets.values()) {
      if (sock.data.streamId === s.id && sock.data.user?.nickname === target && sock.id !== s.bjSocketId) {
        s.viewers.delete(sock.id);
        sock.emit('stream:kicked', { reason: '방장 또는 매니저에 의해 강퇴되었습니다.' });
        sock.leave(`stream:${s.id}`);
        sock.data.streamId = null;
      }
    }
    io.to(`stream:${s.id}`).emit('chat:system', { text: `⛔ ${target} 님이 방송에서 강퇴되었습니다.` });
    io.to(`stream:${s.id}`).emit('stream:state', serializeStream(s));
    io.emit('streams:updated');
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    if (socket.data.hostingStreamId) {
      const s = streams.get(socket.data.hostingStreamId);
      if (s && s.bjSocketId === socket.id) {
        io.to(`stream:${s.id}`).emit('stream:ended', { reason: 'BJ 연결이 끊어져 방송이 종료되었습니다.' });
        streams.delete(s.id);
        io.emit('streams:updated');
      }
    } else if (socket.data.streamId) {
      const s = streams.get(socket.data.streamId);
      if (s) {
        s.viewers.delete(socket.id);
        io.to(s.bjSocketId).emit('webrtc:viewer_left', { viewerId: socket.id });
        io.to(`stream:${s.id}`).emit('stream:state', serializeStream(s));
        io.emit('streams:updated');
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`PULSE live streaming server listening on http://localhost:${PORT}`);
});
