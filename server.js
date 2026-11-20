'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 128 * 1024,
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOM_SIZE = 6;
const MAX_MESSAGES = 80;
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));


app.get('/api/config', (_req, res) => {
  const iceServers = [{
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun3.l.google.com:19302'
    ]
  }];

  const turnUrls = String(process.env.TURN_URLS || process.env.TURN_URL || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (turnUrls.length) {
    let username = String(process.env.TURN_USERNAME || '').trim();
    let credential = String(process.env.TURN_CREDENTIAL || '').trim();

    // Optional coturn TURN REST API: issue short-lived credentials without exposing the shared secret.
    if (process.env.TURN_SHARED_SECRET) {
      username = `${Math.floor(Date.now() / 1000) + 3600}:${username || 'kotomaster'}`;
      credential = crypto.createHmac('sha1', process.env.TURN_SHARED_SECRET)
        .update(username)
        .digest('base64');
    }

    if (username && credential) {
      iceServers.push({ urls: turnUrls, username, credential });
    }
  }

  res.setHeader('Cache-Control', 'no-store, private');
  res.json({
    iceServers,
    iceTransportPolicy: process.env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all',
    maxRoomSize: MAX_ROOM_SIZE
  });
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

function toPublicMember(member) {
  return {
    id: member.id,
    name: member.name,
    inCall: member.inCall,
    audio: member.audio,
    video: member.video,
    sharing: member.sharing
  };
}

function getPublicMembers(room) {
  return Array.from(room.members.values()).map(toPublicMember);
}

function cleanClientId(value, fallback) {
  const clientId = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{12,80}$/.test(clientId) ? clientId : fallback;
}

function joinRoom(socket, payload, ack, createNew = false) {
  const callback = typeof ack === 'function' ? ack : () => {};
  const name = cleanName(payload && payload.name);
  const roomId = createNew ? makeRoomId() : cleanRoomId(payload && payload.roomId);
  const clientId = cleanClientId(payload && payload.clientId, `socket-${socket.id}`);

  if (!roomId) return callback({ ok: false, error: 'Введите код комнаты из 6 символов.' });
  if (socket.data.roomId) return callback({ ok: false, error: 'Сначала выйдите из текущей комнаты.' });

  let room = rooms.get(roomId);
  if (!room && !createNew) return callback({ ok: false, error: 'Комната не найдена. Проверьте код.' });
  if (!room) {
    room = { id: roomId, members: new Map(), messages: [], createdAt: Date.now() };
    rooms.set(roomId, room);
  }

  // A mobile network can reconnect before the server notices the old transport is dead.
  // Replace the previous socket for this browser tab instead of adding a duplicate member.
  const previousSessions = Array.from(room.members.values()).filter((member) =>
    member.clientId === clientId && member.id !== socket.id
  );
  previousSessions.forEach((previousSession) => {
    room.members.delete(previousSession.id);
    const previousSocket = io.sockets.sockets.get(previousSession.id);
    if (previousSocket) {
      previousSocket.emit('room:session-replaced');
      previousSocket.data.roomId = null;
      previousSocket.data.name = null;
      previousSocket.leave(roomId);
      previousSocket.disconnect(true);
    }
    io.to(roomId).emit('room:peer-left', {
      id: previousSession.id,
      reason: 'reconnected'
    });
  });

  if (room.members.size >= MAX_ROOM_SIZE) {
    return callback({ ok: false, error: `В комнате уже максимум ${MAX_ROOM_SIZE} участников.` });
  }

  const member = {
    id: socket.id,
    clientId,
    name,
    inCall: false,
    audio: false,
    video: false,
    sharing: false
  };
  const previousMembers = getPublicMembers(room);
  room.members.set(socket.id, member);
  socket.data.roomId = roomId;
  socket.data.name = name;
  socket.data.clientId = clientId;
  socket.join(roomId);

  socket.to(roomId).emit('room:peer-joined', toPublicMember(member));
  callback({
    ok: true,
    roomId,
    self: toPublicMember(member),
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
    const rawSignal = payload && payload.signal;

    if (!room || !targetId || targetId === socket.id || !room.members.has(targetId) || !rawSignal) return;

    // Bound signalling traffic and accept only SDP descriptions or ICE candidates.
    const now = Date.now();
    const windowState = socket.data.rtcSignalWindow;
    if (!windowState || now - windowState.startedAt >= 10000) {
      socket.data.rtcSignalWindow = { startedAt: now, count: 0 };
    }
    socket.data.rtcSignalWindow.count += 1;
    if (socket.data.rtcSignalWindow.count > 160) return;

    let signal;
    if ((rawSignal.type === 'offer' || rawSignal.type === 'answer') &&
        typeof rawSignal.sdp === 'string' && rawSignal.sdp.length <= 24000) {
      signal = { type: rawSignal.type, sdp: rawSignal.sdp };
    } else if (rawSignal.candidate &&
        typeof rawSignal.candidate.candidate === 'string' &&
        rawSignal.candidate.candidate.length <= 4096) {
      const candidate = rawSignal.candidate;
      signal = {
        candidate: {
          candidate: candidate.candidate,
          sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid.slice(0, 128) : null,
          sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null,
          usernameFragment: typeof candidate.usernameFragment === 'string' ? candidate.usernameFragment.slice(0, 128) : null
        }
      };
    } else {
      return;
    }

    io.to(targetId).emit('rtc:signal', {
      from: socket.id,
      name: socket.data.name,
      signal
    });
  });

  socket.on('disconnect', () => leaveRoom(socket, 'disconnected'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`KOTOMASTER is running on port ${PORT}`);
});
