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



const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_PUBLISHABLE_KEY = String(process.env.SUPABASE_PUBLISHABLE_KEY || '');
const AUTH_REQUIRED = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);

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
    .split(',').map((value) => value.trim()).filter(Boolean);
  if (turnUrls.length) {
    let username = String(process.env.TURN_USERNAME || '').trim();
    let credential = String(process.env.TURN_CREDENTIAL || '').trim();
    if (process.env.TURN_SHARED_SECRET) {
      username = `${Math.floor(Date.now() / 1000) + 3600}:${username || 'kotomaster'}`;
      credential = crypto.createHmac('sha1', process.env.TURN_SHARED_SECRET).update(username).digest('base64');
    }
    if (username && credential) iceServers.push({ urls: turnUrls, username, credential });
  }
  res.setHeader('Cache-Control', 'no-store, private');
  res.json({
    iceServers,
    iceTransportPolicy: process.env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all',
    maxRoomSize: MAX_ROOM_SIZE,
    supabaseUrl: SUPABASE_URL || null,
    supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY || null,
    authRequired: AUTH_REQUIRED
  });
});

async function verifyAccessToken(token) {
  if (!AUTH_REQUIRED || !token || typeof token !== 'string' || token.length > 8192) return null;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) return null;
    const user = await response.json();
    return user && user.id && user.email ? user : null;
  } catch (_error) {
    return null;
  }
}

io.use(async (socket, next) => {
  if (!AUTH_REQUIRED) return next(new Error('Авторизация временно недоступна.'));
  const token = socket.handshake.auth && socket.handshake.auth.accessToken;
  const user = await verifyAccessToken(token);
  if (!user) return next(new Error('Сессия недействительна. Войди в аккаунт заново.'));
  socket.data.userId = user.id;
  socket.data.email = user.email;
  socket.data.authUser = user;
  socket.data.accessToken = token;
  next();
});


async function supabaseApi(socket, endpoint, options = {}) {
  if (!AUTH_REQUIRED || !socket.data.accessToken) {
    throw new Error('Сессия Supabase отсутствует. Войди в аккаунт заново.');
  }
  const response = await fetch(`${SUPABASE_URL}${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${socket.data.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(9000)
  });
  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch (_error) { body = raw; }
  if (!response.ok) {
    const message = body && (body.message || body.error_description || body.hint)
      ? (body.message || body.error_description || body.hint)
      : `Supabase вернул ошибку ${response.status}`;
    throw new Error(String(message).slice(0, 240));
  }
  return body;
}

async function supabaseRpc(socket, functionName, payload) {
  return supabaseApi(socket, `/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

async function loadConversationMessages(socket, conversationId) {
  const params = new URLSearchParams({
    select: 'id,sender_id,body,reply_to,edited_at,deleted_at,created_at',
    conversation_id: `eq.${conversationId}`,
    order: 'created_at.desc',
    limit: String(MAX_MESSAGES)
  });
  const rows = await supabaseApi(socket, `/rest/v1/messages?${params.toString()}`);
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const ids = [...new Set(rows.map((row) => row.sender_id).filter(Boolean))];
  const profiles = await supabaseApi(socket,
    `/rest/v1/profiles?select=id,display_name&id=in.(${ids.join(',')})`);
  const names = new Map((Array.isArray(profiles) ? profiles : [])
    .map((profile) => [profile.id, profile.display_name || 'Котик']));
  return rows.reverse().map((row) => ({
    id: row.id,
    from: row.sender_id,
    senderId: row.sender_id,
    name: names.get(row.sender_id) || 'Котик',
    text: row.deleted_at ? '' : row.body,
    time: Date.parse(row.created_at) || Date.now(),
    editedAt: row.edited_at ? Date.parse(row.edited_at) : null,
    deleted: Boolean(row.deleted_at),
    reactions: {},
    readBy: [],
    replyTo: null
  }));
}

async function persistRoomMessage(socket, conversationId, text, replyTo) {
  const body = [{
    conversation_id: conversationId,
    sender_id: socket.data.userId,
    body: text,
    reply_to: replyTo || null
  }];
  const rows = await supabaseApi(socket, '/rest/v1/messages?select=id,sender_id,body,reply_to,edited_at,deleted_at,created_at', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!Array.isArray(rows) || !rows[0]) throw new Error('Сообщение не сохранилось в базе.');
  return rows[0];
}

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

async function joinRoom(socket, payload, ack, createNew = false) {
  const callback = typeof ack === 'function' ? ack : () => {};
  const name = cleanName(payload && payload.name);
  let roomId = createNew ? '' : cleanRoomId(payload && payload.roomId);
  const clientId = cleanClientId(payload && payload.clientId, `socket-${socket.id}`);

  if (!socket.data.userId) return callback({ ok: false, error: 'Сначала войди в аккаунт.' });
  if (!createNew && !roomId) return callback({ ok: false, error: 'Введите код комнаты из 6 символов.' });
  if (socket.data.roomId) return callback({ ok: false, error: 'Сначала выйдите из текущей комнаты.' });

  // Reject an obviously full in-memory room before creating a persistent membership row.
  let room = roomId ? rooms.get(roomId) : null;
  const isReplacingSameTab = room && Array.from(room.members.values())
    .some((member) => member.clientId === clientId);
  if (room && room.members.size >= MAX_ROOM_SIZE && !isReplacingSameTab) {
    return callback({ ok: false, error: `В комнате уже максимум ${MAX_ROOM_SIZE} участников.` });
  }

  let conversationId = null;
  try {
    if (createNew) {
      let linked = false;
      for (let attempt = 0; attempt < 8 && !linked; attempt += 1) {
        const candidate = makeRoomId();
        try {
          conversationId = await supabaseRpc(socket, 'create_room_conversation', { p_room_code: candidate });
          roomId = candidate;
          linked = true;
        } catch (error) {
          if (!/already exists/i.test(error.message)) throw error;
        }
      }
      if (!linked) throw new Error('Не удалось подобрать свободный код комнаты. Попробуй ещё раз.');
    } else {
      conversationId = await supabaseRpc(socket, 'join_room_conversation', { p_room_code: roomId });
    }
  } catch (error) {
    return callback({ ok: false, error: `Не удалось открыть постоянную переписку: ${error.message}` });
  }

  room = rooms.get(roomId);
  if (!room) {
    room = { id: roomId, conversationId, members: new Map(), messages: [], pinnedMessageId: null, createdAt: Date.now() };
    rooms.set(roomId, room);
  } else if (room.conversationId && room.conversationId !== conversationId) {
    return callback({ ok: false, error: 'Код комнаты связан с другой перепиской. Перезагрузи страницу.' });
  }
  room.conversationId = conversationId;

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
      previousSocket.data.conversationId = null;
      previousSocket.leave(roomId);
      previousSocket.disconnect(true);
    }
    io.to(roomId).emit('room:peer-left', { id: previousSession.id, reason: 'reconnected' });
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
  socket.data.conversationId = conversationId;
  socket.join(roomId);

  socket.to(roomId).emit('room:peer-joined', toPublicMember(member));
  let persistentMessages = [];
  try {
    persistentMessages = await loadConversationMessages(socket, conversationId);
    room.messages = persistentMessages;
  } catch (error) {
    room.members.delete(socket.id);
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.conversationId = null;
    return callback({ ok: false, error: `Не удалось загрузить историю чата: ${error.message}` });
  }

  callback({
    ok: true,
    roomId,
    conversationId,
    self: toPublicMember(member),
    participants: previousMembers,
    messages: persistentMessages.slice(-MAX_MESSAGES),
    pinnedMessage: room.messages.find((item) => item.id === room.pinnedMessageId) || null,
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
  socket.on('room:create', (payload, ack) => {
    joinRoom(socket, payload, ack, true).catch((error) => {
      if (typeof ack === 'function') ack({ ok: false, error: error.message || 'Не удалось создать комнату.' });
    });
  });
  socket.on('room:join', (payload, ack) => {
    joinRoom(socket, payload, ack, false).catch((error) => {
      if (typeof ack === 'function') ack({ ok: false, error: error.message || 'Не удалось войти в комнату.' });
    });
  });
  socket.on('room:sync', async (payload, ack) => {
    const callback = typeof ack === 'function' ? ack : () => {};
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const member = room && room.members.get(socket.id);
    if (!room || !member) {
      return callback({ ok: false, error: 'Комната больше недоступна. Войди в неё заново.' });
    }
    try {
      room.messages = await loadConversationMessages(socket, room.conversationId);
    } catch (error) {
      return callback({ ok: false, error: `Не удалось обновить историю: ${error.message}` });
    }
    callback({
      ok: true,
      roomId,
      conversationId: room.conversationId,
      self: toPublicMember(member),
      participants: getPublicMembers(room).filter((item) => item.id !== socket.id),
      messages: room.messages.slice(-MAX_MESSAGES),
      pinnedMessage: room.messages.find((item) => item.id === room.pinnedMessageId) || null,
      maxRoomSize: MAX_ROOM_SIZE
    });
  });

  socket.on('profile:update', (payload) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const member = room && room.members.get(socket.id);
    if (!member) return;
    const name = cleanName(payload && payload.name);
    member.name = name;
    socket.data.name = name;
    io.to(roomId).emit('room:peer-renamed', toPublicMember(member));
  });

  socket.on('room:leave', () => leaveRoom(socket));

  socket.on('chat:send', async (payload, ack) => {
    const callback = typeof ack === 'function' ? ack : () => {};
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const text = cleanMessage(payload && payload.text);
    if (!room || !text || !socket.data.conversationId) return callback({ ok: false });

    const replyId = payload && typeof payload.replyTo === 'string' && /^[0-9a-f-]{36}$/i.test(payload.replyTo)
      ? payload.replyTo : null;
    let replyTarget = replyId ? room.messages.find((item) => item.id === replyId && !item.deleted) : null;
    try {
      const row = await persistRoomMessage(socket, socket.data.conversationId, text, replyTarget && replyTarget.id);
      const message = {
        id: row.id,
        from: socket.id,
        senderId: socket.data.userId,
        name: socket.data.name,
        text: row.body,
        time: Date.parse(row.created_at) || Date.now(),
        editedAt: null,
        deleted: false,
        reactions: {},
        readBy: [],
        replyTo: replyTarget ? {
          id: replyTarget.id,
          from: replyTarget.from,
          name: replyTarget.name,
          text: replyTarget.text.slice(0, 180)
        } : null
      };
      room.messages.push(message);
      if (room.messages.length > MAX_MESSAGES) {
        const removed = room.messages.splice(0, room.messages.length - MAX_MESSAGES);
        if (removed.some((item) => item.id === room.pinnedMessageId)) room.pinnedMessageId = null;
      }
      io.to(roomId).emit('chat:message', message);
      callback({ ok: true, id: message.id });
    } catch (error) {
      console.error('Persist room message failed:', error);
      callback({ ok: false, error: `Сообщение не сохранено: ${error.message}` });
    }
  });

  socket.on('chat:typing', (payload) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || !room.members.has(socket.id)) return;
    const now = Date.now();
    const last = Number(socket.data.lastTypingAt || 0);
    if (now - last < 250) return;
    socket.data.lastTypingAt = now;
    socket.to(roomId).emit('chat:typing', {
      id: socket.id,
      name: socket.data.name,
      typing: Boolean(payload && payload.typing)
    });
  });

  socket.on('chat:edit', async (payload, ack) => {
    const callback = typeof ack === 'function' ? ack : () => {};
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const messageId = String(payload && payload.messageId || '');
    const text = cleanMessage(payload && payload.text);
    const message = room && room.messages.find((item) => item.id === messageId);
    if (!message || message.senderId !== socket.data.userId || message.deleted || !text) {
      return callback({ ok: false, error: 'Это сообщение нельзя изменить.' });
    }
    try {
      const rows = await supabaseApi(socket, `/rest/v1/messages?id=eq.${encodeURIComponent(messageId)}&sender_id=eq.${socket.data.userId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ body: text, edited_at: new Date().toISOString() })
      });
      if (!Array.isArray(rows) || !rows[0]) return callback({ ok: false, error: 'Изменение не сохранено.' });
      message.text = rows[0].body;
      message.editedAt = Date.parse(rows[0].edited_at) || Date.now();
      io.to(roomId).emit('chat:edited', message);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: `Не удалось изменить сообщение: ${error.message}` });
    }
  });

  socket.on('chat:delete', async (payload, ack) => {
    const callback = typeof ack === 'function' ? ack : () => {};
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const messageId = String(payload && payload.messageId || '');
    const message = room && room.messages.find((item) => item.id === messageId);
    if (!message || message.senderId !== socket.data.userId || message.deleted) {
      return callback({ ok: false, error: 'Это сообщение нельзя удалить.' });
    }
    try {
      const rows = await supabaseApi(socket, `/rest/v1/messages?id=eq.${encodeURIComponent(messageId)}&sender_id=eq.${socket.data.userId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ body: '', deleted_at: new Date().toISOString() })
      });
      if (!Array.isArray(rows) || !rows[0]) return callback({ ok: false, error: 'Удаление не сохранено.' });
      message.deleted = true;
      message.text = '';
      message.deletedAt = Date.now();
      message.reactions = {};
      if (room.pinnedMessageId === message.id) {
        room.pinnedMessageId = null;
        io.to(roomId).emit('chat:pinned', null);
      }
      io.to(roomId).emit('chat:deleted', { messageId });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: `Не удалось удалить сообщение: ${error.message}` });
    }
  });

  socket.on('chat:react', async (payload, ack) => {
    const callback = typeof ack === 'function' ? ack : () => {};
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const messageId = String(payload && payload.messageId || '');
    const emoji = String(payload && payload.emoji || '');
    const allowed = new Set(['❤️', '👍', '😂', '🔥', '🐱', '🎉']);
    const message = room && room.messages.find((item) => item.id === messageId && !item.deleted);
    if (!message || !allowed.has(emoji)) return callback({ ok: false });
    try {
      const params = new URLSearchParams({
        select: 'message_id,user_id,emoji',
        message_id: `eq.${messageId}`,
        user_id: `eq.${socket.data.userId}`,
        emoji: `eq.${emoji}`
      });
      const existing = await supabaseApi(socket, `/rest/v1/message_reactions?${params}`);
      if (Array.isArray(existing) && existing.length) {
        await supabaseApi(socket, `/rest/v1/message_reactions?message_id=eq.${messageId}&user_id=eq.${socket.data.userId}&emoji=eq.${encodeURIComponent(emoji)}`, { method: 'DELETE' });
      } else {
        await supabaseApi(socket, '/rest/v1/message_reactions', {
          method: 'POST',
          body: JSON.stringify([{ message_id: messageId, user_id: socket.data.userId, emoji }])
        });
      }
      const all = await supabaseApi(socket, `/rest/v1/message_reactions?select=user_id,emoji&message_id=eq.${messageId}`);
      message.reactions = {};
      (Array.isArray(all) ? all : []).forEach((item) => {
        if (!message.reactions[item.emoji]) message.reactions[item.emoji] = [];
        message.reactions[item.emoji].push(item.user_id);
      });
      io.to(roomId).emit('chat:reaction', { messageId, reactions: message.reactions });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: `Реакция не сохранена: ${error.message}` });
    }
  });

  socket.on('chat:pin', (payload, ack) => {
    const callback = typeof ack === 'function' ? ack : () => {};
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || !room.members.has(socket.id)) return callback({ ok: false });
    const messageId = String(payload && payload.messageId || '');
    const message = messageId
      ? room.messages.find((item) => item.id === messageId && !item.deleted)
      : null;
    if (messageId && !message) return callback({ ok: false, error: 'Сообщение не найдено.' });
    room.pinnedMessageId = message ? message.id : null;
    io.to(roomId).emit('chat:pinned', message);
    callback({ ok: true });
  });

  socket.on('chat:read', async (payload) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || !Array.isArray(payload && payload.messageIds) || !socket.data.conversationId) return;
    try {
      await supabaseApi(socket, `/rest/v1/conversation_members?conversation_id=eq.${socket.data.conversationId}&user_id=eq.${socket.data.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_read_at: new Date().toISOString() })
      });
      const ids = new Set(payload.messageIds.filter((id) => typeof id === 'string').slice(0, 50));
      room.messages.forEach((message) => {
        if (!ids.has(message.id) || message.senderId === socket.data.userId || message.deleted) return;
        socket.to(roomId).emit('chat:read-receipt', {
          messageId: message.id,
          readerId: socket.id,
          readerUserId: socket.data.userId,
          readerName: socket.data.name
        });
      });
    } catch (error) {
      console.warn('Could not mark room messages as read:', error.message);
    }
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
