'use strict';

const $ = (selector) => document.querySelector(selector);

const joinScreen = $('#joinScreen');
const appScreen = $('#appScreen');
const joinError = $('#joinError');
const joinForm = $('#joinForm');
const joinRoomForm = $('#joinRoomForm');
const nameInput = $('#nameInput');
const roomInput = $('#roomInput');
const toastNode = $('#toast');
const inviteModal = $('#inviteModal');
const chatPanel = $('#chatPanel');
const callPanel = $('#callPanel');
const messagesList = $('#messagesList');
const chatScroll = $('#chatScroll');
const videoGrid = $('#videoGrid');
const callEmptyState = $('#callEmptyState');
const callDescription = $('#callDescription');

let socket = null;
let roomId = '';
let myName = '';
let participants = new Map();
let seenMessages = new Set();
let peerConnections = new Map();
let pendingIce = new Map();
let localStream = null;
let screenStream = null;
let isInCall = false;
let isMicOn = false;
let isCameraOn = false;
let isSharing = false;
let appConfig = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], maxRoomSize: 6 };
let toastTimer = null;
let viewerStream = null;

function showToast(message) {
  toastNode.textContent = message;
  toastNode.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove('show'), 2800);
}

function showJoinError(message = '') {
  joinError.textContent = message;
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.textContent = label || 'Подключаемся…';
  } else {
    button.disabled = false;
    if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
  }
}

async function connectSocket() {
  if (socket && socket.connected) return;
  if (!window.io) throw new Error('Не загрузился модуль связи. Обнови страницу.');
  if (!socket) {
    socket = window.io({ autoConnect: false, reconnection: true, reconnectionAttempts: 8, timeout: 9000 });
    bindSocketEvents();
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Сервер не отвечает. Проверь подключение и попробуй ещё раз.')), 10000);
    const onConnect = () => { clearTimeout(timeout); cleanup(); resolve(); };
    const onError = (error) => { clearTimeout(timeout); cleanup(); reject(new Error('Не удалось подключиться к серверу.')); };
    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
    socket.connect();
  });
}

function emitWithAck(event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) return reject(new Error('Нет соединения с сервером.'));
    socket.timeout(9000).emit(event, payload, (error, response) => {
      if (error) return reject(new Error('Сервер не ответил. Попробуй ещё раз.'));
      resolve(response || { ok: false, error: 'Пустой ответ сервера.' });
    });
  });
}

function bindSocketEvents() {
  socket.on('chat:message', (message) => appendMessage(message));

  socket.on('room:peer-joined', (member) => {
    participants.set(member.id, member);
    renderParticipants();
    showToast(`${member.name} присоединился к комнате`);
    updateCallDescription();
  });

  socket.on('room:peer-left', ({ id }) => {
    const member = participants.get(id);
    closePeer(id);
    removeVideoTile(id);
    participants.delete(id);
    updateCallStage();
    renderParticipants();
    updateCallDescription();
    if (member) showToast(`${member.name} вышел из комнаты`);
  });

  socket.on('media:peer-state', (member) => {
    participants.set(member.id, member);
    updateTileState(member.id, member);
    renderParticipants();
    updateCallDescription();
    if (!member.inCall) {
      closePeer(member.id);
      removeVideoTile(member.id);
      updateCallStage();
      return;
    }
    if (isInCall && socket.id.localeCompare(member.id) < 0) {
      createPeerConnection(member.id, true).catch((error) => showToast(error.message));
    }
  });

  socket.on('rtc:signal', async ({ from, name, signal }) => {
    if (!from || !signal || !isInCall) return;
    try {
      const pc = await createPeerConnection(from, false);
      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        await flushPendingIce(from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc:signal', { to: from, signal: pc.localDescription });
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        await flushPendingIce(from, pc);
      } else if (signal.candidate) {
        const candidate = new RTCIceCandidate(signal.candidate);
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else {
          const queued = pendingIce.get(from) || [];
          queued.push(candidate);
          pendingIce.set(from, queued);
        }
      }
    } catch (error) {
      console.error('WebRTC signal error:', error);
      showToast('Не удалось установить связь с участником.');
    }
  });

  socket.on('disconnect', () => {
    if (roomId) showToast('Соединение с сервером потеряно. Переподключаемся…');
    if (isInCall) stopCall();
  });
  socket.on('connect', async () => {
    if (!roomId || participants.has(socket.id)) return;
    const reconnectRoom = roomId;
    try {
      const response = await emitWithAck('room:join', { name: myName, roomId: reconnectRoom });
      if (roomId !== reconnectRoom) {
        if (response.ok) socket.emit('room:leave');
        return;
      }
      if (response.ok) {
        enterWorkspace(response);
        showToast('Связь восстановлена. Ты снова в комнате.');
      } else {
        showToast(response.error || 'Комната больше недоступна.');
      }
    } catch (error) {
      showToast('Не удалось вернуться в комнату. Проверь соединение.');
    }
  });
}

async function createRoom(name) {
  const response = await emitWithAck('room:create', { name });
  if (!response.ok) throw new Error(response.error || 'Не удалось создать комнату.');
  enterWorkspace(response);
}

async function joinRoom(name, code) {
  const response = await emitWithAck('room:join', { name, roomId: code });
  if (!response.ok) throw new Error(response.error || 'Не удалось войти в комнату.');
  enterWorkspace(response);
}

function enterWorkspace(data) {
  roomId = data.roomId;
  myName = data.self.name;
  participants.clear();
  seenMessages.clear();
  participants.set(data.self.id, data.self);
  (data.participants || []).forEach((member) => participants.set(member.id, member));

  $('#sidebarRoomCode').textContent = roomId;
  $('#welcomeRoomCode').textContent = roomId;
  $('#callRoomCode').textContent = roomId;
  $('#myName').textContent = myName;
  $('#myAvatar').textContent = firstLetter(myName);
  $('#callNavBadge').hidden = true;
  messagesList.replaceChildren();
  $('.chat-welcome').hidden = false;
  (data.messages || []).forEach((message) => appendMessage(message, false));
  renderParticipants();
  updateCallDescription();

  joinScreen.hidden = true;
  appScreen.hidden = false;
  switchPanel('chat');
  $('#messageInput').focus();
}

function firstLetter(value) {
  return String(value || 'К').trim().charAt(0).toLocaleUpperCase('ru-RU') || 'К';
}

function renderParticipants() {
  const list = $('#memberList');
  list.replaceChildren();
  const entries = Array.from(participants.values());
  $('#memberCount').textContent = `${entries.length}/${appConfig.maxRoomSize || 6}`;
  $('#topbarSubtitle').textContent = `Твоя комната · ${entries.length} ${pluralize(entries.length, 'участник', 'участника', 'участников')}`;

  entries.forEach((member) => {
    const row = document.createElement('div');
    row.className = 'member-row';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    if (member.id === (socket && socket.id)) avatar.classList.add('avatar-me');
    avatar.textContent = firstLetter(member.name);
    const name = document.createElement('div');
    name.className = 'member-name';
    name.textContent = member.name + (member.id === (socket && socket.id) ? ' (ты)' : '');
    const state = document.createElement('span');
    state.className = `member-state${member.inCall ? ' in-call' : ''}`;
    state.textContent = member.inCall ? '● LIVE' : '●';
    row.append(avatar, name, state);
    list.append(row);
  });
}

function pluralize(number, one, few, many) {
  const mod10 = number % 10;
  const mod100 = number % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function appendMessage(message, shouldScroll = true) {
  if (!message || !message.id || seenMessages.has(message.id)) return;
  seenMessages.add(message.id);
  const mine = socket && message.from === socket.id;
  const row = document.createElement('div');
  row.className = `message-row${mine ? ' mine' : ''}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = firstLetter(message.name);

  const content = document.createElement('div');
  content.className = 'message-content';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const name = document.createElement('strong');
  name.textContent = mine ? 'Ты' : (message.name || 'Котик');
  const time = document.createElement('time');
  const date = new Date(message.time || Date.now());
  time.textContent = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  meta.append(name, time);

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = message.text || '';
  content.append(meta, bubble);
  row.append(avatar, content);
  messagesList.append(row);
  $('.chat-welcome').hidden = true;
  if (shouldScroll) requestAnimationFrame(() => { chatScroll.scrollTop = chatScroll.scrollHeight; });
}

function switchPanel(panel) {
  const isCall = panel === 'call';
  chatPanel.hidden = isCall;
  callPanel.hidden = !isCall;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.panel === panel));
  $('#topbarTitle').textContent = isCall ? 'Видеокомната' : 'Общий чат';
  updateCallStage();
}

function updateCallDescription() {
  const inCallCount = Array.from(participants.values()).filter((member) => member.inCall).length;
  if (isInCall) {
    callDescription.textContent = inCallCount <= 1 ? 'Ты в звонке. Друзья могут присоединиться в любой момент.' : `Сейчас в звонке: ${inCallCount} ${pluralize(inCallCount, 'участник', 'участника', 'участников')}.`;
  } else if (inCallCount > 0) {
    callDescription.textContent = `${inCallCount} ${pluralize(inCallCount, 'участник уже в звонке', 'участника уже в звонке', 'участников уже в звонке')}. Нажми кнопку, чтобы присоединиться.`;
  } else {
    callDescription.textContent = 'Подключись, чтобы увидеть друзей и начать разговор.';
  }
  $('#callNavBadge').hidden = inCallCount === 0;
}

function updateCallStage() {
  const remoteInCall = Array.from(participants.values()).some((member) => member.id !== (socket && socket.id) && member.inCall);
  callEmptyState.hidden = isInCall || remoteInCall;
  if (!isInCall && remoteInCall) {
    callEmptyState.hidden = false;
    callEmptyState.querySelector('h4').textContent = 'Друзья уже здесь';
    callEmptyState.querySelector('p').textContent = 'Присоединяйся к видеозвонку, чтобы общаться вместе.';
  } else {
    callEmptyState.querySelector('h4').textContent = 'Здесь пока тихо';
    callEmptyState.querySelector('p').textContent = 'Включи камеру и микрофон, чтобы войти в звонок.';
  }
  $('#startCallBtn').hidden = isInCall;
}

function makeVideoTile(id, name, local = false) {
  let tile = videoGrid.querySelector(`[data-peer-id="${CSS.escape(id)}"]`);
  if (tile) {
    const label = tile.querySelector('.tile-label span');
    if (label) label.textContent = local ? `${name} · ты` : name;
    return tile;
  }
  tile = document.createElement('div');
  tile.className = `video-tile${local ? ' local' : ''}`;
  tile.dataset.peerId = id;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = local;
  video.volume = 1;
  const avatar = document.createElement('div');
  avatar.className = 'tile-avatar';
  avatar.textContent = firstLetter(name);
  const label = document.createElement('div');
  label.className = 'tile-label';
  const labelName = document.createElement('span');
  labelName.textContent = local ? `${name} · ты` : name;
  const mic = document.createElement('b');
  mic.className = 'tile-mic';
  mic.textContent = '●';
  label.append(labelName, mic);

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'tile-expand';
  expand.title = 'Увеличить видео';
  expand.setAttribute('aria-label', 'Увеличить видео');
  expand.textContent = '⛶';
  expand.addEventListener('click', (event) => {
    event.stopPropagation();
    openVideoViewer(tile);
  });
  video.addEventListener('dblclick', () => openVideoViewer(tile));

  tile.append(video, avatar, label, expand);
  videoGrid.append(tile);
  return tile;
}

function updateTileState(id, member) {
  const tile = videoGrid.querySelector(`[data-peer-id="${CSS.escape(id)}"]`);
  if (!tile) return;
  const mic = tile.querySelector('.tile-mic');
  if (mic) {
    mic.classList.toggle('on', Boolean(member.audio));
    mic.title = member.audio ? 'Микрофон включён' : 'Микрофон выключен';
  }
  tile.classList.toggle('has-video', Boolean(member.video) || (id === (socket && socket.id) && isSharing));
  tile.classList.toggle('sharing', Boolean(member.sharing) || (id === (socket && socket.id) && isSharing));
}

async function startCall() {
  if (isInCall) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Для видеозвонка открой KOTOMASTER через HTTPS или localhost.');
    return;
  }
  const button = $('#startCallBtn');
  button.disabled = true;
  button.textContent = 'Подключаем камеру…';
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: (() => { const p = VIDEO_PROFILES[$('#videoResolutionSelect').value] || VIDEO_PROFILES.auto; return { width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.frameRate, max: p.frameRate } }; })()
    });
    isInCall = true;
    isMicOn = localStream.getAudioTracks().length > 0;
    isCameraOn = localStream.getVideoTracks().length > 0;
    isSharing = false;
    const localTile = makeVideoTile(socket.id, myName, true);
    const localVideo = localTile.querySelector('video');
    localVideo.srcObject = localStream;
    updateTileState(socket.id, { audio: isMicOn, video: isCameraOn });
    updateCallButtons();
    socket.emit('media:state', { inCall: true, audio: isMicOn, video: isCameraOn, sharing: false });
    participants.set(socket.id, { id: socket.id, name: myName, inCall: true, audio: isMicOn, video: isCameraOn, sharing: false });
    renderParticipants();
    updateCallDescription();
    updateCallStage();

    for (const member of participants.values()) {
      if (member.id !== socket.id && member.inCall && socket.id.localeCompare(member.id) < 0) {
        createPeerConnection(member.id, true).catch((error) => showToast(error.message));
      }
    }
    showToast('Ты подключился к видеозвонку.');
  } catch (error) {
    console.error('getUserMedia error:', error);
    let message = 'Не удалось включить камеру и микрофон.';
    if (error && error.name === 'NotAllowedError') message = 'Разреши доступ к камере и микрофону в браузере.';
    else if (error && error.name === 'NotFoundError') message = 'Камера или микрофон не найдены. Проверь устройства.';
    else if (error && error.name === 'NotReadableError') message = 'Камера занята другим приложением.';
    showToast(message);
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>▶</span> Войти в видеозвонок';
  }
}

async function createPeerConnection(peerId, shouldOffer) {
  if (!isInCall || !localStream) throw new Error('Сначала войди в звонок.');
  let pc = peerConnections.get(peerId);
  if (pc) return pc;

  const member = participants.get(peerId) || { name: 'Участник' };
  pc = new RTCPeerConnection({
    iceServers: appConfig.iceServers || [],
    iceCandidatePoolSize: 4,
    bundlePolicy: 'max-bundle'
  });
  peerConnections.set(peerId, pc);
  localStream.getAudioTracks().forEach((track) => pc.addTrack(track, localStream));
  const outgoingVideoTrack = isSharing && screenStream
    ? screenStream.getVideoTracks()[0]
    : localStream.getVideoTracks()[0];
  if (outgoingVideoTrack) {
    pc.addTrack(outgoingVideoTrack, isSharing && screenStream ? screenStream : localStream);
  }
  pc.onicecandidate = (event) => {
    if (event.candidate && socket && socket.connected) {
      socket.emit('rtc:signal', { to: peerId, signal: { candidate: event.candidate } });
    }
  };
  pc.ontrack = (event) => {
    const currentMember = participants.get(peerId) || member;
    const tile = makeVideoTile(peerId, currentMember.name || 'Участник');
    const video = tile.querySelector('video');
    let remoteStream = event.streams && event.streams[0];
    if (!remoteStream) {
      remoteStream = video.srcObject instanceof MediaStream ? video.srcObject : new MediaStream();
      if (!remoteStream.getTracks().some((track) => track.id === event.track.id)) remoteStream.addTrack(event.track);
    }
    video.srcObject = remoteStream;
    video.muted = false;
    video.volume = 1;
    event.track.onunmute = () => {
      video.play().catch(() => showToast('Нажми на видео участника, чтобы разрешить воспроизведение звука.'));
    };
    video.play().catch(() => showToast('Нажми на видео участника, чтобы включить звук.'));
    tile.classList.toggle('has-video', remoteStream.getVideoTracks().some((track) => track.readyState === 'live' && track.enabled));
    tile.classList.toggle('sharing', Boolean(currentMember.sharing));
    updateTileState(peerId, currentMember);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      showToast(`Не удалось соединиться с ${member.name || 'участником'}. Для некоторых мобильных сетей нужен TURN-сервер.`);
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' && typeof pc.restartIce === 'function') {
      try { pc.restartIce(); } catch (error) { console.warn('ICE restart failed:', error); }
    }
  };

  if (shouldOffer) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('rtc:signal', { to: peerId, signal: pc.localDescription });
  }
  return pc;
}

async function flushPendingIce(peerId, pc) {
  const queued = pendingIce.get(peerId) || [];
  pendingIce.delete(peerId);
  for (const candidate of queued) {
    try { await pc.addIceCandidate(candidate); } catch (error) { console.warn('ICE candidate skipped:', error); }
  }
}

function closePeer(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.getReceivers().forEach((receiver) => { if (receiver.track) receiver.track.stop(); });
    pc.close();
    peerConnections.delete(peerId);
  }
  pendingIce.delete(peerId);
}

function removeVideoTile(peerId) {
  const tile = videoGrid.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
  if (tile) {
    const video = tile.querySelector('video');
    if (video && video.srcObject) video.srcObject = null;
    tile.remove();
  }
}

function updateCallButtons() {
  const mic = $('#micBtn');
  const camera = $('#cameraBtn');
  const share = $('#shareBtn');
  const leave = $('#leaveCallBtn');
  [mic, camera, share, leave].forEach((button) => { button.disabled = !isInCall; });
  mic.classList.toggle('active', isInCall && isMicOn);
  camera.classList.toggle('active', isInCall && isCameraOn);
  share.classList.toggle('active', isInCall && isSharing);
  mic.title = isMicOn ? 'Выключить микрофон' : 'Включить микрофон';
  camera.title = isCameraOn ? 'Выключить камеру' : 'Включить камеру';
  share.title = isSharing ? 'Остановить показ экрана' : 'Показать экран';
  $('#callStatusDot').classList.toggle('live', isInCall);
  $('#callStatusText').textContent = isInCall ? 'Ты в звонке' : 'Ты не в звонке';
}

function publishMediaState() {
  if (!socket || !socket.connected) return;
  socket.emit('media:state', { inCall: isInCall, audio: isMicOn, video: isCameraOn, sharing: isSharing });
  const me = participants.get(socket.id);
  if (me) {
    me.inCall = isInCall;
    me.audio = isMicOn;
    me.video = isCameraOn;
    me.sharing = isSharing;
    participants.set(socket.id, me);
  }
  renderParticipants();
  updateCallDescription();
}

function toggleMic() {
  if (!isInCall || !localStream) return;
  isMicOn = !isMicOn;
  localStream.getAudioTracks().forEach((track) => { track.enabled = isMicOn; });
  updateTileState(socket.id, { audio: isMicOn, video: isCameraOn });
  updateCallButtons();
  publishMediaState();
}

function toggleCamera() {
  if (!isInCall || !localStream) return;
  const tracks = localStream.getVideoTracks();
  if (!tracks.length) return showToast('Камера не обнаружена.');
  isCameraOn = !isCameraOn;
  tracks.forEach((track) => { track.enabled = isCameraOn; });
  updateTileState(socket.id, { audio: isMicOn, video: isCameraOn });
  updateCallButtons();
  publishMediaState();
}

async function tuneVideoSender(sender, bitrate, frameRate, keepTextSharp = false) {
  if (!sender || typeof sender.getParameters !== 'function') return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) return;
    params.encodings[0].maxBitrate = bitrate;
    params.encodings[0].maxFramerate = frameRate;
    if ('degradationPreference' in params || keepTextSharp) {
      params.degradationPreference = keepTextSharp ? 'maintain-resolution' : 'maintain-framerate';
    }
    await sender.setParameters(params);
  } catch (error) {
    // Some mobile browsers expose only part of RTCRtpSendParameters.
    console.warn('Could not tune outgoing video:', error);
  }
}

async function startScreenShare() {
  if (!isInCall) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    showToast('Этот браузер не умеет передавать экран из веб-страницы. Это ограничение браузера телефона, а не KOTOMASTER.');
    return;
  }

  const profile = VIDEO_PROFILES[$('#videoResolutionSelect').value] || VIDEO_PROFILES.auto;
  const frameRate = profile.shareFrameRate || 12;
  try {
    // Share text and UI details at a modest frame rate to reduce upload delay.
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: profile.width },
        height: { ideal: profile.height },
        frameRate: { ideal: frameRate }
      },
      audio: false
    });
    const screenTrack = screenStream.getVideoTracks()[0];
    if (!screenTrack) throw new Error('Браузер не вернул видеопоток экрана.');
    try { screenTrack.contentHint = 'detail'; } catch (_error) {}

    isSharing = true;
    screenTrack.onended = () => stopScreenShare();

    for (const pc of peerConnections.values()) {
      let sender = pc.getSenders().find((item) => item.track && item.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(screenTrack);
      } else {
        sender = pc.addTrack(screenTrack, screenStream);
      }
      await tuneVideoSender(sender, profile.shareBitrate || 850000, frameRate, true);
    }

    const localTile = makeVideoTile(socket.id, myName, true);
    const localVideo = localTile.querySelector('video');
    localVideo.srcObject = new MediaStream([screenTrack, ...localStream.getAudioTracks()]);
    localVideo.muted = true;
    localTile.classList.remove('local');
    localTile.classList.add('has-video', 'sharing');
    updateTileState(socket.id, { audio: isMicOn, video: true, sharing: true });
    updateCallButtons();
    publishMediaState();
    showToast('Демонстрация экрана началась. Нажми ⛶ на видео, чтобы увеличить.');
  } catch (error) {
    console.error('Screen share error:', error);
    if (screenStream) {
      screenStream.getTracks().forEach((track) => track.stop());
      screenStream = null;
    }
    isSharing = false;
    if (error && error.name === 'NotAllowedError') showToast('Доступ к экрану отменён или запрещён браузером.');
    else if (error && error.name === 'NotFoundError') showToast('Браузер не нашёл источник экрана для передачи.');
    else if (error && error.name === 'NotSupportedError') showToast('Передача экрана не поддерживается этим браузером.');
    else showToast(error.message || 'Не удалось показать экран.');
  }
}


async function stopScreenShare() {
  if (!isSharing) return;
  isSharing = false;
  const cameraTrack = localStream && localStream.getVideoTracks()[0];
  const profile = VIDEO_PROFILES[$('#videoResolutionSelect').value] || VIDEO_PROFILES.auto;
  for (const pc of peerConnections.values()) {
    const sender = pc.getSenders().find((item) => item.track && item.track.kind === 'video');
    if (sender) {
      try {
        await sender.replaceTrack(cameraTrack || null);
        await tuneVideoSender(sender, profile.bitrate, profile.frameRate, false);
      } catch (error) { console.warn('Could not restore camera track:', error); }
    }
  }
  if (screenStream) {
    screenStream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    screenStream = null;
  }
  const localTile = videoGrid.querySelector(`[data-peer-id="${CSS.escape(socket.id)}"]`);
  if (localTile) {
    const video = localTile.querySelector('video');
    video.srcObject = localStream;
    localTile.classList.add('local');
    localTile.classList.remove('sharing');
    localTile.classList.toggle('has-video', isCameraOn);
  }
  updateCallButtons();
  publishMediaState();
  showToast('Демонстрация экрана остановлена.');
}

function stopCall() {
  if (!isInCall) {
    for (const peerId of Array.from(peerConnections.keys())) {
      closePeer(peerId);
      removeVideoTile(peerId);
    }
    return;
  }
  if (screenStream) {
    screenStream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    screenStream = null;
  }
  isSharing = false;
  for (const peerId of Array.from(peerConnections.keys())) {
    closePeer(peerId);
    removeVideoTile(peerId);
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  isInCall = false;
  isMicOn = false;
  isCameraOn = false;
  removeVideoTile(socket && socket.id);
  videoGrid.replaceChildren();
  publishMediaState();
  updateCallButtons();
  updateCallStage();
  showToast('Ты вышел из видеозвонка.');
}


function openVideoViewer(tile) {
  const sourceVideo = tile && tile.querySelector('video');
  if (!sourceVideo || !sourceVideo.srcObject) {
    showToast('Видеопоток пока не появился.');
    return;
  }
  const modal = $('#videoViewerModal');
  const viewerVideo = $('#videoViewerVideo');
  const title = $('#videoViewerTitle');
  const label = tile.querySelector('.tile-label span');
  viewerStream = sourceVideo.srcObject;
  viewerVideo.srcObject = viewerStream;
  viewerVideo.muted = true;
  title.textContent = label ? label.textContent : 'Видео участника';
  modal.hidden = false;
  modal.classList.remove('zoomed');
  $('#videoViewerZoom').textContent = 'Увеличить';
  viewerVideo.play().catch(() => {});
}

function closeVideoViewer() {
  const modal = $('#videoViewerModal');
  const viewerVideo = $('#videoViewerVideo');
  viewerVideo.pause();
  viewerVideo.srcObject = null;
  viewerStream = null;
  modal.hidden = true;
  modal.classList.remove('zoomed');
}

const VIDEO_PROFILES = {
  auto: { width: 1280, height: 720, frameRate: 24, bitrate: 1200000 },
  '360': { width: 640, height: 360, frameRate: 24, bitrate: 450000 },
  '480': { width: 854, height: 480, frameRate: 24, bitrate: 750000 },
  '720': { width: 1280, height: 720, frameRate: 30, bitrate: 1500000 },
  '1080': { width: 1920, height: 1080, frameRate: 30, bitrate: 2500000 }
};

const VIDEO_PROFILES = {
  auto: { width: 1280, height: 720, frameRate: 24, bitrate: 1200000, shareFrameRate: 12, shareBitrate: 850000 },
  '360': { width: 640, height: 360, frameRate: 24, bitrate: 450000, shareFrameRate: 10, shareBitrate: 350000 },
  '480': { width: 854, height: 480, frameRate: 24, bitrate: 750000, shareFrameRate: 12, shareBitrate: 550000 },
  '720': { width: 1280, height: 720, frameRate: 30, bitrate: 1500000, shareFrameRate: 15, shareBitrate: 1000000 },
  '1080': { width: 1920, height: 1080, frameRate: 30, bitrate: 2500000, shareFrameRate: 15, shareBitrate: 1600000 }
};

async function changeVideoResolution() {
  const select = $('#videoResolutionSelect');
  const profile = VIDEO_PROFILES[select.value] || VIDEO_PROFILES.auto;
  const sharingTrack = isSharing && screenStream ? screenStream.getVideoTracks()[0] : null;
  const cameraTrack = localStream && localStream.getVideoTracks()[0];
  const track = sharingTrack || cameraTrack;
  if (!track || !isInCall) {
    showToast('Сначала включи камеру или демонстрацию экрана.');
    return;
  }

  const frameRate = sharingTrack ? profile.shareFrameRate : profile.frameRate;
  const bitrate = sharingTrack ? profile.shareBitrate : profile.bitrate;
  try {
    await track.applyConstraints({
      width: { ideal: profile.width },
      height: { ideal: profile.height },
      frameRate: { ideal: frameRate }
    });
    for (const pc of peerConnections.values()) {
      const sender = pc.getSenders().find((item) => item.track && item.track.kind === 'video');
      if (sender) await tuneVideoSender(sender, bitrate, frameRate, Boolean(sharingTrack));
    }
    const mode = select.value === 'auto' ? 'Автоматическое качество' : `Качество до ${select.value}p`;
    showToast(sharingTrack ? `${mode} демонстрации применено.` : `${mode} камеры применено.`);
  } catch (error) {
    console.warn('Resolution change failed:', error);
    showToast('Это разрешение не поддерживается текущим источником. Выбери ниже.');
  }
}


async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      if (!copied) throw new Error('copy failed');
    }
    showToast('Код комнаты скопирован.');
  } catch (_error) {
    showToast(`Код комнаты: ${value}`);
  }
}

function leaveRoom() {
  stopCall();
  if (socket) {
    socket.emit('room:leave');
    socket.disconnect();
    socket = null;
  }
  roomId = '';
  myName = '';
  participants.clear();
  seenMessages.clear();
  messagesList.replaceChildren();
  $('#roomInput').value = '';
  $('#messageInput').value = '';
  showJoinError('');
  appScreen.hidden = true;
  joinScreen.hidden = false;
  inviteModal.hidden = true;
  showToast('Ты вышел из комнаты.');
}

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#createRoomBtn');
  const name = nameInput.value.trim();
  if (!name) return showJoinError('Напиши имя, чтобы создать комнату.');
  showJoinError('');
  setBusy(button, true, 'Создаём комнату…');
  try {
    myName = name;
    await connectSocket();
    await createRoom(name);
  } catch (error) {
    showJoinError(error.message);
    if (socket && !roomId) { socket.disconnect(); socket = null; }
  } finally {
    setBusy(button, false);
  }
});

joinRoomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#joinRoomBtn');
  const name = nameInput.value.trim();
  const code = roomInput.value.trim().toUpperCase();
  if (!name) return showJoinError('Сначала напиши своё имя.');
  if (code.length !== 6) return showJoinError('Код комнаты должен состоять из 6 символов.');
  showJoinError('');
  setBusy(button, true, 'Входим…');
  try {
    myName = name;
    await connectSocket();
    await joinRoom(name, code);
  } catch (error) {
    showJoinError(error.message);
    if (socket && !roomId) { socket.disconnect(); socket = null; }
  } finally {
    setBusy(button, false);
  }
});

roomInput.addEventListener('input', () => { roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });

document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => switchPanel(item.dataset.panel)));

$('#messageForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text || !socket || !socket.connected) return;
  input.value = '';
  try {
    const response = await emitWithAck('chat:send', { text });
    if (!response.ok) showToast('Сообщение не отправлено.');
  } catch (error) {
    showToast(error.message);
  }
});

$('#startCallBtn').addEventListener('click', startCall);
$('#micBtn').addEventListener('click', toggleMic);
$('#cameraBtn').addEventListener('click', toggleCamera);
$('#shareBtn').addEventListener('click', () => isSharing ? stopScreenShare() : startScreenShare());
$('#leaveCallBtn').addEventListener('click', stopCall);
$('#videoViewerClose').addEventListener('click', closeVideoViewer);
$('#videoViewerZoom').addEventListener('click', () => {
  const modal = $('#videoViewerModal');
  const zoomed = modal.classList.toggle('zoomed');
  $('#videoViewerZoom').textContent = zoomed ? 'Уместить' : 'Увеличить';
});
$('#videoViewerModal').addEventListener('click', (event) => {
  if (event.target === $('#videoViewerModal')) closeVideoViewer();
});
$('#videoResolutionSelect').addEventListener('change', changeVideoResolution);
$('#copyRoomBtn').addEventListener('click', () => roomId && copyText(roomId));
$('#welcomeCopyBtn').addEventListener('click', () => roomId && copyText(roomId));
$('#inviteBtn').addEventListener('click', () => { $('#modalRoomCode').textContent = roomId; inviteModal.hidden = false; });
$('#closeInviteBtn').addEventListener('click', () => { inviteModal.hidden = true; });
$('#modalCopyBtn').addEventListener('click', () => roomId && copyText(roomId));
$('#leaveRoomBtn').addEventListener('click', leaveRoom);
inviteModal.addEventListener('click', (event) => { if (event.target === inviteModal) inviteModal.hidden = true; });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { inviteModal.hidden = true; if (!$('#videoViewerModal').hidden) closeVideoViewer(); } });

(async function loadConfig() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (response.ok) appConfig = { ...appConfig, ...await response.json() };
  } catch (error) {
    console.warn('Using default WebRTC ICE configuration:', error);
  }
})();

updateCallButtons();
