'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOM_SIZE = 6;
const MAX_MESSAGES = 80;
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));


app.get('/api/livekit/status', (_req, res) => {
  const configured = Boolean(
    process.env.LIVEKIT_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  );
  res.json({ configured });
});

app.post('/api/livekit/token', async (req, res) => {
  const livekitUrl = String(process.env.LIVEKIT_URL || '').trim().replace(/\\/$/, '');
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!livekitUrl || !apiKey || !apiSecret) {
    return res.status(503).json({
      error: 'Тест LiveKit ещё не настроен. Добавь LIVEKIT_URL, LIVEKIT_API_KEY и LIVEKIT_API_SECRET в Render Environment.'
    });
  }
  if (!/^wss:\/\/[^/]+$/i.test(livekitUrl)) {
    return res.status(503).json({ error: 'LIVEKIT_URL должен начинаться с wss:// и содержать только адрес проекта.' });
  }

  const roomCode = String(req.body && req.body.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const displayName = String(req.body && req.body.name || 'Котик')
    .replace(/[\\u0000-\\u001f\\u007f]/g, '')
    .trim()
    .slice(0, 24) || 'Котик';

  if (roomCode.length !== 6) {
    return res.status(400).json({ error: 'Код тестовой комнаты должен состоять из 6 символов.' });
  }

  try {
    const identity = crypto.randomUUID();
    const roomName = `kotomaster-test-${roomCode}`;
    const accessToken = new AccessToken(apiKey, apiSecret, {
      identity,
      name: displayName,
      ttl: '1h'
    });
    accessToken.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    const token = await accessToken.toJwt();
    return res.json({ url: livekitUrl, token, roomName, identity, name: displayName });
  } catch (error) {
    console.error('LiveKit token error:', error);
    return res.status(500).json({ error: 'Не удалось создать токен тестовой видеокомнаты.' });
  }
});

app.get('/api/config', (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((value) => value.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  res.json({ iceServers, maxRoomSize: MAX_ROOM_SIZE });
});

function cleanName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return name || 'Котик';
}

function cleanRoomId(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function cleanMessage(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, 1200);
}

function makeRoomId() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getPublicMembers(room) {
  return Array.from(room.members.values()).map((member) => ({
    id: member.id,
    name: member.name,
    inCall: member.inCall,
    audio: member.audio,
    video: member.video,
    sharing: member.sharing
  }));
}

function joinRoom(socket, payload, ack, createNew = false) {
  const callback = typeof ack === 'function' ? ack : () => {};
  const name = cleanName(payload && payload.name);
  const roomId = createNew ? makeRoomId() : cleanRoomId(payload && payload.roomId);

  if (!roomId) return callback({ ok: false, error: 'Введите код комнаты из 6 символов.' });
  if (socket.data.roomId) return callback({ ok: false, error: 'Сначала выйдите из текущей комнаты.' });

  let room = rooms.get(roomId);
  if (!room && !createNew) return callback({ ok: false, error: 'Комната не найдена. Проверьте код.' });
  if (!room) {
    room = { id: roomId, members: new Map(), messages: [], createdAt: Date.now() };
    rooms.set(roomId, room);
  }
  if (room.members.size >= MAX_ROOM_SIZE) return callback({ ok: false, error: `В комнате уже максимум ${MAX_ROOM_SIZE} участников.` });

  const member = { id: socket.id, name, inCall: false, audio: false, video: false, sharing: false };
  const previousMembers = getPublicMembers(room);
  room.members.set(socket.id, member);
  socket.data.roomId = roomId;
  socket.data.name = name;
  socket.join(roomId);

  socket.to(roomId).emit('room:peer-joined', { ...member });
  callback({
    ok: true,
    roomId,
    self: { ...member },
    participants: previousMembers,
    messages: room.messages.slice(-MAX_MESSAGES),
    maxRoomSize: MAX_ROOM_SIZE
  });
}

function leaveRoom(socket, reason = 'left') {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (room) {
    const member = room.members.get(socket.id);
    if (member && member.inCall) {
      socket.to(roomId).emit('media:peer-state', {
        ...member, inCall: false, audio: false, video: false, sharing: false
      });
    }
    room.members.delete(socket.id);
    socket.to(roomId).emit('room:peer-left', { id: socket.id, reason });
    if (room.members.size === 0) rooms.delete(roomId);
  }
  socket.leave(roomId);
  socket.data.roomId = null;
  socket.data.name = null;
}

io.on('connection', (socket) => {
  socket.on('room:create', (payload, ack) => joinRoom(socket, payload, ack, true));
  socket.on('room:join', (payload, ack) => joinRoom(socket, payload, ack, false));
  socket.on('room:leave', () => leaveRoom(socket));

  socket.on('chat:send', (payload, ack) => {
    const callback = typeof ack === 'function' ? ack : () => {};
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const text = cleanMessage(payload && payload.text);
    if (!room || !text) return callback({ ok: false });

    const message = {
      id: crypto.randomUUID(),
      from: socket.id,
      name: socket.data.name,
      text,
      time: Date.now()
    };
    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
    io.to(roomId).emit('chat:message', message);
    callback({ ok: true, id: message.id });
  });

  socket.on('media:state', (payload) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const member = room && room.members.get(socket.id);
    if (!member) return;
    member.inCall = Boolean(payload && payload.inCall);
    member.audio = member.inCall && Boolean(payload && payload.audio);
    member.video = member.inCall && Boolean(payload && payload.video);
    member.sharing = member.inCall && Boolean(payload && payload.sharing);
    socket.to(roomId).emit('media:peer-state', { ...member });
  });

  socket.on('rtc:signal', (payload) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const targetId = String(payload && payload.to || '');
    if (!room || !room.members.has(targetId) || !payload || !payload.signal) return;
    io.to(targetId).emit('rtc:signal', {
      from: socket.id,
      name: socket.data.name,
      signal: payload.signal
    });
  });

  socket.on('disconnect', () => leaveRoom(socket, 'disconnected'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`KOTOMASTER is running on port ${PORT}`);
});
