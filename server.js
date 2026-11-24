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
app.use('/vendor/simple-rnnoise-wasm', express.static(
  path.join(__dirname, 'node_modules', 'simple-rnnoise-wasm', 'dist'),
  { immutable: true, maxAge: '7d' }
));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));



const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_PUBLISHABLE_KEY = String(process.env.SUPABASE_PUBLISHABLE_KEY || '');
const AUTH_REQUIRED = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
const POSTHOG_PROJECT_TOKEN = String(process.env.POSTHOG_PROJECT_TOKEN || '');
const POSTHOG_API_HOST = String(process.env.POSTHOG_API_HOST || '').replace(/\/+$/, '');

function capturePostHogEvent(distinctId, event, properties = {}, sessionId = null) {
  if (!POSTHOG_PROJECT_TOKEN || !POSTHOG_API_HOST || !distinctId) return;
  const payload = {
    api_key: POSTHOG_PROJECT_TOKEN,
    event,
    properties: {
      ...properties,
      ...(sessionId ? { $session_id: sessionId } : {}),
      distinct_id: distinctId
    }
  };
  fetch(`${POSTHOG_API_HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2500)
  }).then((response) => {
    if (!response.ok && process.env.NODE_ENV !== 'production') {
      console.warn(`PostHog event delivery failed (${response.status}).`);
    }
  }).catch(() => {
    if (process.env.NODE_ENV !== 'production') console.warn('PostHog event delivery failed.');
  });
}

function captureSocketPostHogEvent(socket, event, properties = {}) {
  capturePostHogEvent(
    socket.data.userId,
    event,
    properties,
    socket.data.posthogSessionId
  );
}

app.get('/api/config', (_req, res) => {
  const iceServers = [{
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun3.l.google.com:19302',
      'stun:stun.cloudflare.com:3478'
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
    authRequired: AUTH_REQUIRED,
    posthogProjectToken: POSTHOG_PROJECT_TOKEN || null,
    posthogApiHost: POSTHOG_API_HOST || null
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

const CLOUDFLARE_TURN_KEY_ID = String(process.env.CLOUDFLARE_TURN_KEY_ID || '').trim();
const CLOUDFLARE_TURN_API_TOKEN = String(process.env.CLOUDFLARE_TURN_API_TOKEN || '').trim();
const cloudflareTurnCredentialCache = new Map();
const CLOUDFLARE_TURN_TTL_SECONDS = 43200;

app.post('/api/rtc/ice-servers', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, private');
  if (!CLOUDFLARE_TURN_KEY_ID || !CLOUDFLARE_TURN_API_TOKEN) {
    return res.status(503).json({ error: 'turn_not_configured' });
  }
  const authorization = String(req.headers.authorization || '');
  const accessToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const user = await verifyAccessToken(accessToken);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const now = Date.now();
  const cached = cloudflareTurnCredentialCache.get(user.id);
  if (cached && cached.expiresAt > now + 10 * 60 * 1000) {
    return res.json({ iceServers: cached.iceServers, expiresAt: cached.expiresAt });
  }

  try {
    const endpoint = 'https://rtc.live.cloudflare.com/v1/turn/keys/' +
      encodeURIComponent(CLOUDFLARE_TURN_KEY_ID) + '/credentials/generate-ice-servers';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + CLOUDFLARE_TURN_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ttl: CLOUDFLARE_TURN_TTL_SECONDS }),
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) {
      console.error('Cloudflare TURN credential request failed (' + response.status + ').');
      return res.status(502).json({ error: 'turn_provider_unavailable' });
    }
    const payload = await response.json();
    const iceServers = Array.isArray(payload.iceServers) ? payload.iceServers
      .map((entry) => {
        if (!entry || !Array.isArray(entry.urls)) return null;
        // Port 53 is documented as browser-blocked; omit it to avoid wasted ICE timeouts.
        const urls = entry.urls.filter((url) =>
          typeof url === 'string' &&
          /^(stun|turn|turns):/.test(url) &&
          !/:53(?:\?|$)/.test(url)
        );
        if (!urls.length) return null;
        const clean = { urls };
        if (typeof entry.username === 'string') clean.username = entry.username;
        if (typeof entry.credential === 'string') clean.credential = entry.credential;
        return clean;
      }).filter(Boolean) : [];
    if (!iceServers.some((entry) => entry.urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:')))) {
      console.error('Cloudflare TURN returned no usable relay URLs.');
      return res.status(502).json({ error: 'turn_provider_invalid_response' });
    }
    const expiresAt = now + CLOUDFLARE_TURN_TTL_SECONDS * 1000;
    cloudflareTurnCredentialCache.set(user.id, { iceServers, expiresAt });
    return res.json({ iceServers, expiresAt });
  } catch (_error) {
    console.error('Cloudflare TURN credential request failed.');
    return res.status(502).json({ error: 'turn_provider_unavailable' });
  }
});

async function fetchAuthenticatedProfile(token, userId) {
  try {
    const params = new URLSearchParams({ select: 'display_name,username,avatar_path', id: `eq.${userId}`, limit: '1' });
    const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?${params.toString()}`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    const rows = await response.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
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
  const analyticsSessionId = socket.handshake.auth && socket.handshake.auth.posthogSessionId;
  socket.data.posthogSessionId = typeof analyticsSessionId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(analyticsSessionId)
    ? analyticsSessionId
    : null;
  socket.data.email = user.email;
  socket.data.authUser = user;
  socket.data.accessToken = token;
  const profile = await fetchAuthenticatedProfile(token, user.id);
  socket.data.profileName = cleanName(profile?.display_name || user.user_metadata?.display_name || user.email.split('@')[0]);
  socket.data.profileAvatar = String(profile?.avatar_path || '');
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

  const replyIds = [...new Set(rows.map((row) => row.reply_to).filter(Boolean))];
  let replyRows = [];
  if (replyIds.length) {
    replyRows = await supabaseApi(socket,
      `/rest/v1/messages?select=id,sender_id,body,deleted_at&id=in.(${replyIds.join(',')})`);
  }
  const allSenderIds = [...new Set([
    ...rows.map((row) => row.sender_id),
    ...(Array.isArray(replyRows) ? replyRows.map((row) => row.sender_id) : [])
  ].filter(Boolean))];
  const profiles = await supabaseApi(socket,
    `/rest/v1/profiles?select=id,display_name&id=in.(${allSenderIds.join(',')})`);
  const names = new Map((Array.isArray(profiles) ? profiles : [])
    .map((profile) => [profile.id, profile.display_name || 'Котик']));
  const replyById = new Map((Array.isArray(replyRows) ? replyRows : []).map((row) => [row.id, row]));

  const messageIds = rows.map((row) => row.id);
  const [reactionRows, memberRows] = await Promise.all([
    supabaseApi(socket,
      `/rest/v1/message_reactions?select=message_id,user_id,emoji&message_id=in.(${messageIds.join(',')})`),
    supabaseApi(socket,
      `/rest/v1/conversation_members?select=user_id,last_read_at&conversation_id=eq.${conversationId}`)
  ]);
  const reactionsByMessage = new Map();
  (Array.isArray(reactionRows) ? reactionRows : []).forEach((reaction) => {
    if (!reactionsByMessage.has(reaction.message_id)) reactionsByMessage.set(reaction.message_id, {});
    const reactionMap = reactionsByMessage.get(reaction.message_id);
    if (!reactionMap[reaction.emoji]) reactionMap[reaction.emoji] = [];
    reactionMap[reaction.emoji].push(reaction.user_id);
  });
  const readers = Array.isArray(memberRows) ? memberRows : [];

  return rows.reverse().map((row) => {
    const createdAt = Date.parse(row.created_at) || Date.now();
    const reply = row.reply_to ? replyById.get(row.reply_to) : null;
    const readBy = readers.filter((reader) => reader.user_id !== row.sender_id &&
      reader.last_read_at && Date.parse(reader.last_read_at) >= createdAt).map((reader) => reader.user_id);
    return {
      id: row.id,
      from: row.sender_id === socket.data.userId ? socket.id : row.sender_id,
      senderId: row.sender_id,
      name: names.get(row.sender_id) || 'Котик',
      text: row.deleted_at ? '' : row.body,
      time: createdAt,
      editedAt: row.edited_at ? Date.parse(row.edited_at) : null,
      deleted: Boolean(row.deleted_at),
      reactions: reactionsByMessage.get(row.id) || {},
      readBy,
      replyTo: reply ? {
        id: reply.id,
        from: reply.sender_id,
        name: names.get(reply.sender_id) || 'Котик',
        text: reply.deleted_at ? 'Сообщение удалено' : String(reply.body || '').slice(0,180)
      } : null
    };
  });
}

async function loadConversationPin(socket, conversationId, room) {
  const pins = await supabaseApi(socket,
    `/rest/v1/conversation_pins?select=message_id&conversation_id=eq.${conversationId}`);
  if (!Array.isArray(pins) || !pins[0]) return null;
  const pinId = pins[0].message_id;
  const cached = room.messages.find((message) => message.id === pinId);
  if (cached) return cached;
  const rows = await supabaseApi(socket,
    `/rest/v1/messages?select=id,sender_id,body,edited_at,deleted_at,created_at&id=eq.${pinId}&limit=1`);
  if (!Array.isArray(rows) || !rows[0]) return null;
  const row = rows[0];
  const profiles = await supabaseApi(socket,
    `/rest/v1/profiles?select=id,display_name&id=eq.${row.sender_id}`);
  return {
    id: row.id,
    from: row.sender_id,
    senderId: row.sender_id,
    name: Array.isArray(profiles) && profiles[0] ? profiles[0].display_name : 'Котик',
    text: row.deleted_at ? '' : row.body,
    time: Date.parse(row.created_at) || Date.now(),
    editedAt: row.edited_at ? Date.parse(row.edited_at) : null,
    deleted: Boolean(row.deleted_at),
    reactions: {},
    readBy: [],
    replyTo: null
  };
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
    userId: member.userId,
    name: member.name,
    avatarPath: member.avatarPath || '',
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
  const name = cleanName(socket.data.profileName || (payload && payload.name));
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
    userId: socket.data.userId,
    clientId,
    name,
    avatarPath: socket.data.profileAvatar || '',
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

  let persistentMessages = [];
  let persistentPin = null;
  try {
    persistentMessages = await loadConversationMessages(socket, conversationId);
    room.messages = persistentMessages;
    persistentPin = await loadConversationPin(socket, conversationId, room);
    room.pinnedMessageId = persistentPin ? persistentPin.id : null;
  } catch (error) {
    room.members.delete(socket.id);
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.conversationId = null;
    return callback({ ok: false, error: `Не удалось загрузить историю чата: ${error.message}` });
  }

  socket.to(roomId).emit('room:peer-joined', toPublicMember(member));
  captureSocketPostHogEvent(socket, createNew ? 'room_created' : 'room_joined', {
    chat_type: 'room',
    participant_count: room.members.size
  });
  callback({
    ok: true,
    roomId,
    conversationId,
    self: toPublicMember(member),
    participants: previousMembers,
    messages: persistentMessages.slice(-MAX_MESSAGES),
    pinnedMessage: persistentPin,
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
      captureSocketPostHogEvent(socket, 'call_ended', { reason: reason === 'left' ? 'left_room' : 'disconnected' });
      socket.to(roomId).emit('media:peer-state', {
        ...member, inCall: false, audio: false, video: false, sharing: false
      });
    }
    captureSocketPostHogEvent(socket, 'room_left', {
      reason: String(reason || 'left').slice(0, 24)
    });
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
    let pinnedMessage = null;
    try {
      room.messages = await loadConversationMessages(socket, room.conversationId);
      pinnedMessage = await loadConversationPin(socket, room.conversationId, room);
      room.pinnedMessageId = pinnedMessage ? pinnedMessage.id : null;
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
      pinnedMessage,
      maxRoomSize: MAX_ROOM_SIZE
    });
  });

  socket.on('profile:update', async () => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    const member = room && room.members.get(socket.id);
    if (!member) return;
    const profile = await fetchAuthenticatedProfile(socket.data.accessToken, socket.data.userId);
    if (!profile?.display_name) return;
    const name = cleanName(profile.display_name);
    socket.data.profileName = name;
    socket.data.profileAvatar = String(profile.avatar_path || '');
    member.avatarPath = socket.data.profileAvatar;
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
      captureSocketPostHogEvent(socket, 'message_sent', {
        chat_type: 'room',
        has_reply: Boolean(replyTarget)
      });
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
        await supabaseApi(socket, `/rest/v1/conversation_pins?conversation_id=eq.${socket.data.conversationId}`, { method: 'DELETE' });
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
      captureSocketPostHogEvent(socket, 'message_reaction_toggled', { chat_type: 'room' });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: `Реакция не сохранена: ${error.message}` });
    }
  });

  socket.on('chat:pin', async (payload, ack) => {
    const callback = typeof ack === 'function' ? ack : () => {};
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || !room.members.has(socket.id) || !socket.data.conversationId) return callback({ ok: false });
    const messageId = String(payload && payload.messageId || '');
    const message = messageId
      ? room.messages.find((item) => item.id === messageId && !item.deleted)
      : null;
    if (messageId && !message) return callback({ ok: false, error: 'Сообщение не найдено.' });
    try {
      await supabaseApi(socket, `/rest/v1/conversation_pins?conversation_id=eq.${socket.data.conversationId}`, {
        method: 'DELETE'
      });
      if (message) {
        await supabaseApi(socket, '/rest/v1/conversation_pins', {
          method: 'POST',
          body: JSON.stringify([{
            conversation_id: socket.data.conversationId,
            message_id: message.id,
            pinned_by: socket.data.userId
          }])
        });
      }
      room.pinnedMessageId = message ? message.id : null;
      io.to(roomId).emit('chat:pinned', message);
      captureSocketPostHogEvent(socket, 'message_pin_changed', {
        chat_type: 'room',
        pinned: Boolean(message)
      });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: `Не удалось сохранить закрепление: ${error.message}` });
    }
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
    const previous = {
      inCall: member.inCall,
      audio: member.audio,
      video: member.video,
      sharing: member.sharing
    };
    member.inCall = Boolean(payload && payload.inCall);
    member.audio = member.inCall && Boolean(payload && payload.audio);
    member.video = member.inCall && Boolean(payload && payload.video);
    member.sharing = member.inCall && Boolean(payload && payload.sharing);
    if (!previous.inCall && member.inCall) {
      captureSocketPostHogEvent(socket, 'call_started', { chat_type: 'room' });
    } else if (previous.inCall && !member.inCall) {
      captureSocketPostHogEvent(socket, 'call_ended', { reason: 'normal' });
    }
    if (member.inCall && previous.audio !== member.audio) {
      captureSocketPostHogEvent(socket, 'microphone_state_changed', { enabled: member.audio });
    }
    if (member.inCall && previous.video !== member.video) {
      captureSocketPostHogEvent(socket, 'camera_state_changed', { enabled: member.video });
    }
    if (member.inCall && previous.sharing !== member.sharing) {
      captureSocketPostHogEvent(socket, 'screen_share_state_changed', { enabled: member.sharing });
    }
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
