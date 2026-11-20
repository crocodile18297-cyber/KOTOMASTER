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
let appConfig = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], iceTransportPolicy: 'all', maxRoomSize: 6 };
let rtcConfigPromise = null;
let peerConnectionPromises = new Map();
let remoteAudioElements = new Map();
const senderParameterQueues = new WeakMap();
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
    socket = window.io({ autoConnect: false, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 700, reconnectionDelayMax: 9000, randomizationFactor: 0.35, timeout: 12000 });
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
    if (isInCall) {
      createPeerConnection(member.id).catch((error) => showToast(error.message));
    }
  });

  socket.on('rtc:signal', async ({ from, signal }) => {
    if (!from || !signal || !isInCall) return;
    try {
      const pc = await createPeerConnection(from);
      if (pc.signalingState === 'closed') return;

      if (signal.type === 'offer' || signal.type === 'answer') {
        const readyForOffer = !pc._makingOffer &&
          (pc.signalingState === 'stable' || pc._isSettingRemoteAnswerPending);
        const offerCollision = signal.type === 'offer' && !readyForOffer;
        pc._ignoreOffer = !pc._polite && offerCollision;

        // An impolite peer ignores a colliding offer; the polite peer rolls back and accepts it.
        if (pc._ignoreOffer) return;
        if (offerCollision && pc._polite) {
          await pc.setLocalDescription({ type: 'rollback' });
        }

        pc._isSettingRemoteAnswerPending = signal.type === 'answer';
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        pc._isSettingRemoteAnswerPending = false;
        await flushPendingIce(from, pc);

        if (signal.type === 'offer') {
          await pc.setLocalDescription();
          if (socket && socket.connected) {
            socket.emit('rtc:signal', { to: from, signal: pc.localDescription });
          }
        }
      } else if (signal.candidate) {
        if (pc._ignoreOffer) return;
        const candidate = new RTCIceCandidate(signal.candidate);
        if (pc.remoteDescription) {
          await pc.addIceCandidate(candidate);
        } else {
          const queued = pendingIce.get(from) || [];
          if (queued.length < 80) queued.push(candidate);
          pendingIce.set(from, queued);
        }
      }
    } catch (error) {
      console.error('WebRTC signal error:', error);
      showToast('Не удалось согласовать видеосвязь. Повторяем подключение…');
      const pc = peerConnections.get(from);
      if (pc && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
        scheduleIceRestart(from, pc);
      }
    }
  });

  socket.on('disconnect', () => {
    if (roomId) showToast('Соединение с сервером потеряно. Переподключаемся…');
    if (isInCall) {
      for (const peerId of Array.from(peerConnections.keys())) {
        closePeer(peerId);
        removeVideoTile(peerId);
      }
      updateCallStage();
    }
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
        if (isInCall && localStream) {
          const localTile = videoGrid.querySelector('.video-tile.local, .video-tile.sharing');
          if (localTile) {
            localTile.dataset.peerId = socket.id;
            const label = localTile.querySelector('.tile-label span');
            if (label) label.textContent = `${myName} · ты`;
            localTile.classList.toggle('local', !isSharing);
            localTile.classList.toggle('sharing', isSharing);
            updateTileState(socket.id, { audio: isMicOn, video: isCameraOn || isSharing, sharing: isSharing });
          }
        }
        if (isInCall) {
          const self = {
            id: socket.id, name: myName, inCall: true,
            audio: isMicOn, video: isCameraOn, sharing: isSharing
          };
          participants.set(socket.id, self);
          publishMediaState();
          for (const member of participants.values()) {
            if (member.id !== socket.id && member.inCall) {
              createPeerConnection(member.id).catch((error) => showToast(error.message));
            }
          }
          updateCallStage();
        }
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
  video.addEventListener('click', () => {
    if (local) return;
    video.play().catch(() => {});
    const audioElements = remoteAudioElements.get(id) || [];
    audioElements.forEach((audio) => audio.play().catch(() => {}));
  });
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

function getSpeechAudioConstraints() {
  const supported = navigator.mediaDevices.getSupportedConstraints
    ? navigator.mediaDevices.getSupportedConstraints()
    : {};
  const constraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
  if (supported.channelCount) constraints.channelCount = { ideal: 1 };
  if (supported.sampleRate) constraints.sampleRate = { ideal: 48000 };
  return constraints;
}

function markSpeechTrack(track) {
  if (!track) return;
  try { track.contentHint = 'speech'; } catch (_error) {}
}

async function startCall() {
  if (isInCall) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Для видеозвонка открой KOTOMASTER через HTTPS или localhost.');
    return;
  }

  const button = $('#startCallBtn');
  button.disabled = true;
  button.textContent = 'Подключаемся…';
  let audioError = null;
  let videoError = null;

  try {
    const profile = VIDEO_PROFILES[$('#videoResolutionSelect').value] || VIDEO_PROFILES.auto;
    let audioStream = null;
    let videoStream = null;

    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: getSpeechAudioConstraints(),
        video: false
      });
    } catch (error) {
      audioError = error;
      console.warn('Microphone unavailable; trying video-only:', error);
    }

    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: profile.width },
          height: { ideal: profile.height },
          frameRate: { ideal: profile.frameRate, max: profile.frameRate }
        }
      });
    } catch (error) {
      videoError = error;
      console.warn('Camera unavailable; trying audio-only:', error);
    }

    const tracks = [
      ...(audioStream ? audioStream.getAudioTracks() : []),
      ...(videoStream ? videoStream.getVideoTracks() : [])
    ];

    if (!tracks.length) {
      const error = audioError || videoError || new Error('Не удалось получить доступ ни к микрофону, ни к камере.');
      throw error;
    }

    localStream = new MediaStream(tracks);
    localStream.getAudioTracks().forEach(markSpeechTrack);
    localStream.getVideoTracks().forEach((track) => { try { track.contentHint = 'motion'; } catch (_error) {} });
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
      if (member.id !== socket.id && member.inCall) {
        createPeerConnection(member.id).catch((error) => showToast(error.message));
      }
    }

    if (!isMicOn) showToast('Микрофон недоступен. Звонок начат без звука с твоей стороны.');
    else if (!isCameraOn) showToast('Камера недоступна. Звонок начат только со звуком.');
    else showToast('Ты подключился к видеозвонку.');
  } catch (error) {
    console.error('getUserMedia error:', error);
    let message = 'Не удалось получить доступ к камере или микрофону.';
    if (error && error.name === 'NotAllowedError') message = 'Разреши доступ хотя бы к микрофону или камере в настройках браузера.';
    else if (error && error.name === 'NotFoundError') message = 'На устройстве не найдена камера или микрофон.';
    else if (error && error.name === 'NotReadableError') message = 'Камера или микрофон заняты другим приложением.';
    else if (error && error.name === 'OverconstrainedError') message = 'Устройство не поддерживает запрошенное качество. Выбери 480p или 360p.';
    showToast(message);
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>▶</span> Войти в видеозвонок';
  }
}

function currentOutgoingVideoSettings() {
  const profile = VIDEO_PROFILES[$('#videoResolutionSelect').value] || VIDEO_PROFILES.auto;
  const sharing = Boolean(isSharing && screenStream && screenStream.getVideoTracks().length);
  return {
    bitrate: sharing ? profile.shareBitrate : profile.bitrate,
    frameRate: sharing ? profile.shareFrameRate : profile.frameRate,
    keepTextSharp: sharing
  };
}

function scheduleIceRestart(peerId, pc) {
  if (!pc || pc.signalingState === 'closed' || !isInCall) return;
  if (pc._iceRestartTimer) return;

  const delay = pc.iceConnectionState === 'failed' ? 0 : 4500;
  pc._iceRestartTimer = setTimeout(() => {
    pc._iceRestartTimer = null;
    if (!isInCall || pc.signalingState === 'closed') return;
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;

    if ((pc._iceRestartAttempts || 0) >= 2) {
      const member = participants.get(peerId);
      showToast(`Связь с ${member && member.name ? member.name : 'участником'} не восстановилась. Возможно, этой сети нужен TURN-сервер.`);
      return;
    }

    pc._iceRestartAttempts = (pc._iceRestartAttempts || 0) + 1;
    try {
      pc.restartIce();
      showToast('Восстанавливаем сетевое соединение…');
    } catch (error) {
      console.warn('ICE restart failed:', error);
    }
  }, delay);
}

function startPeerQualityMonitor(peerId, pc) {
  if (pc._qualityTimer) clearInterval(pc._qualityTimer);
  pc._qualityBusy = false;
  pc._lastAdaptiveBitrate = 0;
  pc._lastScaleDown = 1;

  pc._qualityTimer = setInterval(async () => {
    if (pc._qualityBusy || pc.signalingState === 'closed' || !isInCall) return;
    pc._qualityBusy = true;
    try {
      const stats = await pc.getStats();
      let selectedPairId = null;
      let selectedPair = null;
      let videoPacketLoss = 0;
      let audioPacketLoss = 0;
      let audioJitterMs = NaN;
      let encoderLimit = 'none';

      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId;
        }

        if (report.type === 'remote-inbound-rtp') {
          const loss = Math.max(0, Number(report.fractionLost) || 0);
          if (report.kind === 'audio' || report.mediaType === 'audio') {
            audioPacketLoss = Math.max(audioPacketLoss, loss);
          } else if (report.kind === 'video' || report.mediaType === 'video') {
            videoPacketLoss = Math.max(videoPacketLoss, loss);
          }
        }

        if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio') &&
            Number.isFinite(report.jitter)) {
          audioJitterMs = Math.max(Number.isFinite(audioJitterMs) ? audioJitterMs : 0, report.jitter * 1000);
        }

        if (report.type === 'outbound-rtp' && (report.kind === 'video' || report.mediaType === 'video') &&
            report.qualityLimitationReason) {
          if (report.qualityLimitationReason === 'cpu' || report.qualityLimitationReason === 'bandwidth') {
            encoderLimit = report.qualityLimitationReason;
          }
        }
      });

      stats.forEach((report) => {
        if (report.type !== 'candidate-pair' || report.state !== 'succeeded') return;
        if ((selectedPairId && report.id === selectedPairId) || (!selectedPairId && (report.selected || report.nominated))) {
          selectedPair = report;
        }
      });

      const rttMs = selectedPair && Number.isFinite(selectedPair.currentRoundTripTime)
        ? Math.round(selectedPair.currentRoundTripTime * 1000)
        : NaN;

      let path = '';
      if (selectedPair && typeof stats.get === 'function') {
        const localCandidate = stats.get(selectedPair.localCandidateId);
        path = localCandidate && localCandidate.candidateType === 'relay' ? 'TURN' : 'P2P';
      }

      const sender = findVideoSender(pc);
      const current = currentOutgoingVideoSettings();
      let desiredBitrate = current.bitrate;

      if (selectedPair && Number.isFinite(selectedPair.availableOutgoingBitrate) && selectedPair.availableOutgoingBitrate > 0) {
        desiredBitrate = Math.min(desiredBitrate, selectedPair.availableOutgoingBitrate * 0.74);
      }
      if (videoPacketLoss > 0.18) desiredBitrate *= 0.55;
      else if (videoPacketLoss > 0.10) desiredBitrate *= 0.72;
      else if (videoPacketLoss > 0.06) desiredBitrate *= 0.86;
      if (encoderLimit === 'cpu') desiredBitrate *= 0.82;

      desiredBitrate = Math.max(160000, Math.round(desiredBitrate));

      const previousBitrate = pc._lastAdaptiveBitrate || 0;
      // React quickly to congestion, but recover quality slowly to avoid bitrate oscillation.
      const targetBitrate = previousBitrate
        ? Math.round(desiredBitrate < previousBitrate
          ? previousBitrate * 0.55 + desiredBitrate * 0.45
          : previousBitrate * 0.82 + desiredBitrate * 0.18)
        : desiredBitrate;

      const ratio = targetBitrate / Math.max(current.bitrate, 1);
      const scale = current.keepTextSharp
        ? 1
        : (encoderLimit === 'cpu' ? 1.25 : ratio < 0.30 ? 1.75 : ratio < 0.48 ? 1.4 : ratio < 0.68 ? 1.15 : 1);
      const targetFrameRate = !current.keepTextSharp && encoderLimit === 'cpu'
        ? Math.max(12, Math.round(current.frameRate * 0.82))
        : current.frameRate;

      if (sender) {
        const previousScale = pc._lastScaleDown || 1;
        const bitrateChanged = !previousBitrate || Math.abs(targetBitrate - previousBitrate) > Math.max(60000, previousBitrate * 0.10);
        const scaleChanged = scale !== previousScale;
        if (bitrateChanged || scaleChanged || pc._lastAdaptiveFrameRate !== targetFrameRate) {
          await tuneVideoSender(sender, targetBitrate, targetFrameRate, current.keepTextSharp, scale);
          pc._lastAdaptiveBitrate = targetBitrate;
          pc._lastScaleDown = scale;
          pc._lastAdaptiveFrameRate = targetFrameRate;
        }
      }

      let level = 'good';
      if (
        audioPacketLoss > 0.12 ||
        (Number.isFinite(audioJitterMs) && audioJitterMs > 80) ||
        videoPacketLoss > 0.18 ||
        (Number.isFinite(rttMs) && rttMs > 550) ||
        (encoderLimit === 'cpu' && ratio < 0.42)
      ) {
        level = 'poor';
      } else if (
        audioPacketLoss > 0.05 ||
        (Number.isFinite(audioJitterMs) && audioJitterMs > 35) ||
        videoPacketLoss > 0.07 ||
        (Number.isFinite(rttMs) && rttMs > 280) ||
        ratio < 0.72 ||
        encoderLimit !== 'none'
      ) {
        level = 'medium';
      }

      updateRtcQualityIndicator(
        level, path, rttMs, videoPacketLoss,
        (participants.get(peerId) || {}).name,
        audioJitterMs, audioPacketLoss
      );
    } catch (error) {
      console.warn('WebRTC quality monitor skipped:', error);
    } finally {
      pc._qualityBusy = false;
    }
  }, 3000);
}

async function createPeerConnection(peerId) {
  if (!isInCall || !localStream) throw new Error('Сначала войди в звонок.');
  if (peerConnections.has(peerId)) return peerConnections.get(peerId);
  if (peerConnectionPromises.has(peerId)) return peerConnectionPromises.get(peerId);

  const creation = (async () => {
    if (rtcConfigPromise) {
      try { await rtcConfigPromise; } catch (_error) {}
    }
    if (!isInCall || !localStream) throw new Error('Звонок уже завершён.');
    if (peerConnections.has(peerId)) return peerConnections.get(peerId);

    const member = participants.get(peerId) || { name: 'Участник' };
    const pc = new RTCPeerConnection({
      iceServers: appConfig.iceServers || [],
      iceTransportPolicy: appConfig.iceTransportPolicy || 'all',
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
    pc._polite = Boolean(socket && socket.id.localeCompare(peerId) > 0);
    pc._makingOffer = false;
    pc._ignoreOffer = false;
    pc._isSettingRemoteAnswerPending = false;
    pc._iceRestartAttempts = 0;
    peerConnections.set(peerId, pc);

    pc.onnegotiationneeded = async () => {
      if (pc._makingOffer || pc.signalingState !== 'stable' || !socket || !socket.connected) return;
      pc._makingOffer = true;
      try {
        // Perfect Negotiation: both peers may offer; polite/impolite roles resolve collisions.
        await pc.setLocalDescription();
        if (socket && socket.connected) {
          socket.emit('rtc:signal', { to: peerId, signal: pc.localDescription });
        }
      } catch (error) {
        console.error('WebRTC negotiation error:', error);
        showToast(`Не удалось согласовать соединение с ${member.name || 'участником'}.`);
      } finally {
        pc._makingOffer = false;
      }
    };

    localStream.getAudioTracks().forEach((track) => {
      markSpeechTrack(track);
      const audioSender = pc.addTrack(track, localStream);
      tuneAudioSender(audioSender);
      preferOpusAudioCodec(pc, audioSender);
    });
    const outgoingVideoTrack = isSharing && screenStream
      ? screenStream.getVideoTracks()[0]
      : localStream.getVideoTracks()[0];
    if (outgoingVideoTrack) {
      pc.addTrack(outgoingVideoTrack, isSharing && screenStream ? screenStream : localStream);
      const settings = currentOutgoingVideoSettings();
      const sender = pc.getSenders().find((item) => item.track === outgoingVideoTrack);
      if (sender) tuneVideoSender(sender, settings.bitrate, settings.frameRate, settings.keepTextSharp);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && socket && socket.connected) {
        socket.emit('rtc:signal', { to: peerId, signal: { candidate: event.candidate } });
      }
    };

    pc.ontrack = (event) => {
      const currentMember = participants.get(peerId) || member;

      if (event.track.kind === 'audio') {
        let audioElements = remoteAudioElements.get(peerId);
        if (!audioElements) {
          audioElements = [];
          remoteAudioElements.set(peerId, audioElements);
        }
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.className = 'remote-audio-only';
        audio.dataset.peerId = peerId;
        audio.srcObject = new MediaStream([event.track]);
        document.body.append(audio);
        audioElements.push(audio);
        audio.play().catch(() => showToast('Нажми в любом месте видеокомнаты, чтобы включить звук участников.'));
        event.track.onended = () => {
          audio.pause();
          audio.srcObject = null;
          audio.remove();
          const current = remoteAudioElements.get(peerId) || [];
          remoteAudioElements.set(peerId, current.filter((item) => item !== audio));
        };
        return;
      }

      const tile = makeVideoTile(peerId, currentMember.name || 'Участник');
      const video = tile.querySelector('video');
      let remoteStream = event.streams && event.streams[0];
      if (!remoteStream) remoteStream = new MediaStream([event.track]);
      video.srcObject = remoteStream;
      video.muted = true;
      video.playsInline = true;
      event.track.onunmute = () => video.play().catch(() => {});
      video.play().catch(() => {});
      tile.classList.toggle('has-video', event.track.readyState === 'live' && event.track.enabled);
      tile.classList.toggle('sharing', Boolean(currentMember.sharing));
      updateTileState(peerId, currentMember);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        if (pc._iceRestartTimer) clearTimeout(pc._iceRestartTimer);
        pc._iceRestartTimer = null;
        pc._iceRestartAttempts = 0;
      } else if (pc.connectionState === 'failed') {
        scheduleIceRestart(peerId, pc);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        if (pc._iceRestartTimer) clearTimeout(pc._iceRestartTimer);
        pc._iceRestartTimer = null;
        pc._iceRestartAttempts = 0;
      } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        scheduleIceRestart(peerId, pc);
      }
    };

    startPeerQualityMonitor(peerId, pc);
    return pc;
  })();

  peerConnectionPromises.set(peerId, creation);
  try {
    return await creation;
  } finally {
    peerConnectionPromises.delete(peerId);
  }
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
    pc.onnegotiationneeded = null;
    if (pc._iceRestartTimer) clearTimeout(pc._iceRestartTimer);
    if (pc._qualityTimer) clearInterval(pc._qualityTimer);
    pc.getReceivers().forEach((receiver) => { if (receiver.track) receiver.track.stop(); });
    const audioElements = remoteAudioElements.get(peerId) || [];
    audioElements.forEach((audio) => { audio.pause(); audio.srcObject = null; audio.remove(); });
    remoteAudioElements.delete(peerId);
    pc.close();
    peerConnections.delete(peerId);
  }
  pendingIce.delete(peerId);
  peerConnectionPromises.delete(peerId);
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

function findVideoSender(pc) {
  if (!pc) return null;
  const active = pc.getSenders().find((sender) => sender.track && sender.track.kind === 'video');
  if (active) return active;
  const transceiver = pc.getTransceivers().find((item) =>
    item.receiver && item.receiver.track && item.receiver.track.kind === 'video'
  );
  return transceiver ? transceiver.sender : null;
}

async function addLocalTrackToPeers(track, kind) {
  for (const pc of peerConnections.values()) {
    if (pc.signalingState === 'closed') continue;

    const sender = kind === 'video'
      ? findVideoSender(pc)
      : pc.getSenders().find((item) => item.track && item.track.kind === 'audio');
    try {
      if (sender) {
        // While sharing the screen, keep the screen track published until sharing ends.
        if (kind === 'video' && isSharing) continue;
        await sender.replaceTrack(track);
        if (kind === 'audio') await tuneAudioSender(sender);
        else {
          const settings = currentOutgoingVideoSettings();
          await tuneVideoSender(sender, settings.bitrate, settings.frameRate, settings.keepTextSharp);
        }
      } else {
        const addedSender = pc.addTrack(track, localStream);
        if (kind === 'audio') {
          await tuneAudioSender(addedSender);
          preferOpusAudioCodec(pc, addedSender);
        } else {
          const settings = currentOutgoingVideoSettings();
          await tuneVideoSender(addedSender, settings.bitrate, settings.frameRate, settings.keepTextSharp);
        }
      }
    } catch (error) {
      console.warn(`Could not add local ${kind} track:`, error);
      showToast(kind === 'audio'
        ? 'Не удалось подключить микрофон к текущему звонку.'
        : 'Не удалось подключить камеру к текущему звонку.');
    }
  }
}

async function toggleMic() {
  if (!isInCall || !localStream) return;

  let tracks = localStream.getAudioTracks();
  if (!tracks.length) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: getSpeechAudioConstraints(),
        video: false
      });
      tracks = stream.getAudioTracks();
      tracks.forEach((track) => {
        track.enabled = true;
        markSpeechTrack(track);
        localStream.addTrack(track);
      });
      if (tracks[0]) await addLocalTrackToPeers(tracks[0], 'audio');
    } catch (error) {
      console.warn('Could not enable microphone:', error);
      showToast(error && error.name === 'NotAllowedError'
        ? 'Разреши микрофон в настройках браузера.'
        : 'Не удалось включить микрофон.');
      return;
    }
    isMicOn = tracks.length > 0;
  } else {
    isMicOn = !isMicOn;
    tracks.forEach((track) => { track.enabled = isMicOn; });
  }

  updateTileState(socket.id, { audio: isMicOn, video: isCameraOn });
  updateCallButtons();
  publishMediaState();
}

async function toggleCamera() {
  if (!isInCall || !localStream) return;

  let tracks = localStream.getVideoTracks();
  if (!tracks.length) {
    try {
      const profile = VIDEO_PROFILES[$('#videoResolutionSelect').value] || VIDEO_PROFILES.auto;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: profile.width },
          height: { ideal: profile.height },
          frameRate: { ideal: profile.frameRate, max: profile.frameRate }
        }
      });
      tracks = stream.getVideoTracks();
      tracks.forEach((track) => {
        try { track.contentHint = 'motion'; } catch (_error) {}
        track.enabled = true;
        localStream.addTrack(track);
      });
      if (tracks[0]) {
        await addLocalTrackToPeers(tracks[0], 'video');
        const senderSettings = currentOutgoingVideoSettings();
        for (const pc of peerConnections.values()) {
          const sender = findVideoSender(pc);
          if (sender && sender.track === tracks[0]) {
            await tuneVideoSender(sender, senderSettings.bitrate, senderSettings.frameRate, senderSettings.keepTextSharp);
          }
        }
      }
    } catch (error) {
      console.warn('Could not enable camera:', error);
      let message = 'Не удалось включить камеру.';
      if (error && error.name === 'NotAllowedError') message = 'Разреши камеру в настройках браузера.';
      else if (error && error.name === 'NotReadableError') message = 'Камера занята другим приложением.';
      else if (error && error.name === 'OverconstrainedError') message = 'Устройство не поддерживает выбранное разрешение. Выбери 480p или 360p.';
      showToast(message);
      return;
    }
    isCameraOn = tracks.length > 0;
  } else {
    isCameraOn = !isCameraOn;
    tracks.forEach((track) => { track.enabled = isCameraOn; });
  }

  const localTile = makeVideoTile(socket.id, myName, true);
  const localVideo = localTile.querySelector('video');
  if (localVideo.srcObject !== localStream) localVideo.srcObject = localStream;
  updateTileState(socket.id, { audio: isMicOn, video: isCameraOn });
  updateCallButtons();
  publishMediaState();
}

function unlockRemoteAudioPlayback() {
  let attempted = 0;
  for (const audioElements of remoteAudioElements.values()) {
    for (const audio of audioElements) {
      if (audio.paused) {
        attempted += 1;
        audio.play().catch(() => {});
      }
    }
  }
  if (attempted) showToast('Пробуем включить звук участников.');
}

function preferOpusAudioCodec(pc, sender) {
  try {
    if (!pc || !sender || typeof RTCRtpSender.getCapabilities !== 'function') return;
    const capabilities = RTCRtpSender.getCapabilities('audio');
    if (!capabilities || !Array.isArray(capabilities.codecs)) return;
    const transceiver = pc.getTransceivers().find((item) => item.sender === sender);
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;

    const opus = capabilities.codecs.filter((codec) =>
      String(codec.mimeType || '').toLowerCase() === 'audio/opus'
    );
    if (!opus.length) return;
    const otherCodecs = capabilities.codecs.filter((codec) =>
      String(codec.mimeType || '').toLowerCase() !== 'audio/opus'
    );
    transceiver.setCodecPreferences([...opus, ...otherCodecs]);
  } catch (error) {
    // Codec preference is optional; browser defaults remain available.
    console.warn('Could not prefer Opus codec:', error);
  }
}

async function withSenderParameterLock(sender, update) {
  const previous = senderParameterQueues.get(sender) || Promise.resolve();
  const next = previous.catch(() => {}).then(update);
  senderParameterQueues.set(sender, next);
  try {
    return await next;
  } finally {
    if (senderParameterQueues.get(sender) === next) senderParameterQueues.delete(sender);
  }
}

async function tuneAudioSender(sender) {
  if (!sender || typeof sender.getParameters !== 'function') return;
  return withSenderParameterLock(sender, async () => {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    const encoding = params.encodings[0];
    encoding.maxBitrate = 64000;
    if ('priority' in encoding || !Object.prototype.hasOwnProperty.call(encoding, 'priority')) {
      encoding.priority = 'high';
    }
    try {
      await sender.setParameters(params);
    } catch (error) {
      // Retry without priority for browsers that do not implement encoding priority.
      try {
        const fallback = sender.getParameters();
        if (!fallback.encodings || !fallback.encodings.length) fallback.encodings = [{}];
        fallback.encodings[0].maxBitrate = 64000;
        await sender.setParameters(fallback);
      } catch (fallbackError) {
        console.warn('Could not tune speech sender:', fallbackError || error);
      }
    }
  });
}

async function tuneVideoSender(sender, bitrate, frameRate, keepTextSharp = false, scaleResolutionDownBy = 1) {
  if (!sender || typeof sender.getParameters !== 'function') return;
  return withSenderParameterLock(sender, async () => {
    const apply = async (includeScale) => {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const encoding = params.encodings[0];
      encoding.maxBitrate = Math.max(120000, Math.round(bitrate));
      encoding.maxFramerate = Math.max(6, Math.round(frameRate));
      encoding.priority = keepTextSharp ? 'medium' : 'low';
      if (includeScale) encoding.scaleResolutionDownBy = Math.max(1, scaleResolutionDownBy);
      params.degradationPreference = keepTextSharp ? 'maintain-resolution' : 'maintain-framerate';
      await sender.setParameters(params);
    };

    try {
      await apply(true);
    } catch (error) {
      // Older mobile browsers may reject scale/degradation hints. Keep bitrate and FPS tuning.
      try {
        await apply(false);
      } catch (fallbackError) {
        console.warn('Could not tune outgoing video:', fallbackError || error);
      }
    }
  });
}

function updateRtcQualityIndicator(level, path, rttMs, videoPacketLoss, peerName, audioJitterMs = NaN, audioPacketLoss = 0) {
  const bars = $('#rtcQualityBars');
  const label = $('#rtcQualityText');
  if (!bars || !label) return;

  bars.classList.remove('quality-good', 'quality-medium', 'quality-poor');
  bars.classList.add(`quality-${level}`);
  label.textContent = path ? `WEBRTC · ${path}` : 'WEBRTC';

  const details = [
    peerName ? `Участник: ${peerName}` : '',
    path ? `Маршрут: ${path}` : '',
    Number.isFinite(rttMs) ? `RTT: ${rttMs} мс` : '',
    `Потери видео: ${Math.round(Math.max(0, videoPacketLoss || 0) * 100)}%`,
    `Потери голоса: ${Math.round(Math.max(0, audioPacketLoss || 0) * 100)}%`,
    Number.isFinite(audioJitterMs) ? `Джиттер голоса: ${Math.round(audioJitterMs)} мс` : '',
    `Качество: ${level === 'good' ? 'хорошее' : level === 'medium' ? 'среднее' : 'слабое'}`
  ].filter(Boolean);
  bars.title = details.join(' · ');
}


async function startScreenShare() {
  if (!isInCall) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    showToast('Этот браузер не умеет передавать экран из веб-страницы. На этом устройстве нужен браузер или приложение с поддержкой захвата экрана.');
    return;
  }

  const profile = VIDEO_PROFILES[$('#videoResolutionSelect').value] || VIDEO_PROFILES.auto;
  const frameRate = profile.shareFrameRate || 15;
  let capturedStream = null;
  const changedSenders = [];

  try {
    capturedStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: profile.width },
        height: { ideal: profile.height },
        frameRate: { ideal: frameRate, max: frameRate },
        cursor: 'always'
      },
      audio: false
    });

    const screenTrack = capturedStream.getVideoTracks()[0];
    if (!screenTrack) throw new Error('Браузер не вернул видеопоток экрана.');
    try { screenTrack.contentHint = 'detail'; } catch (_error) {}
    try {
      await screenTrack.applyConstraints({
        frameRate: { ideal: frameRate, max: frameRate }
      });
    } catch (_error) {
      // Some display-capture sources expose fixed constraints. Keep the browser-selected settings.
    }

    for (const pc of peerConnections.values()) {
      if (pc.signalingState === 'closed') continue;
      let sender = findVideoSender(pc);
      let createdTransceiver = false;

      if (sender) {
        const previousTrack = sender.track;
        await sender.replaceTrack(screenTrack);
        changedSenders.push({ pc, sender, previousTrack, createdTransceiver });
      } else {
        sender = pc.addTrack(screenTrack, capturedStream);
        createdTransceiver = true;
        changedSenders.push({ pc, sender, previousTrack: null, createdTransceiver });
      }
      await tuneVideoSender(sender, profile.shareBitrate || 1200000, frameRate, true);
    }

    screenStream = capturedStream;
    isSharing = true;
    screenTrack.onended = () => stopScreenShare();

    const localTile = makeVideoTile(socket.id, myName, true);
    const localVideo = localTile.querySelector('video');
    localVideo.srcObject = new MediaStream([screenTrack, ...localStream.getAudioTracks()]);
    localVideo.muted = true;
    localTile.classList.remove('local');
    localTile.classList.add('has-video', 'sharing');
    updateTileState(socket.id, { audio: isMicOn, video: true, sharing: true });
    updateCallButtons();
    publishMediaState();

    const actual = screenTrack.getSettings ? screenTrack.getSettings() : {};
    const actualSize = actual.width && actual.height ? `${actual.width}×${actual.height}` : 'автоматическое разрешение';
    showToast(`Демонстрация экрана началась: ${actualSize}, до ${frameRate} FPS.`);
  } catch (error) {
    console.error('Screen share error:', error);

    // Roll back any tracks already replaced so a partial failure cannot leave peers without camera video.
    for (const entry of changedSenders.reverse()) {
      try {
        if (entry.createdTransceiver) {
          entry.pc.removeTrack(entry.sender);
        } else {
          await entry.sender.replaceTrack(entry.previousTrack || null);
        }
      } catch (rollbackError) {
        console.warn('Screen-share rollback failed:', rollbackError);
      }
    }

    if (capturedStream) {
      capturedStream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    }
    screenStream = null;
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
    const sender = findVideoSender(pc);
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
  auto: { width: 1280, height: 720, frameRate: 24, bitrate: 1200000, shareFrameRate: 15, shareBitrate: 1200000 },
  '360': { width: 640, height: 360, frameRate: 24, bitrate: 450000, shareFrameRate: 10, shareBitrate: 420000 },
  '480': { width: 854, height: 480, frameRate: 24, bitrate: 750000, shareFrameRate: 12, shareBitrate: 750000 },
  '720': { width: 1280, height: 720, frameRate: 30, bitrate: 1500000, shareFrameRate: 15, shareBitrate: 1400000 },
  '1080': { width: 1920, height: 1080, frameRate: 30, bitrate: 2500000, shareFrameRate: 15, shareBitrate: 2200000 }
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
callPanel.addEventListener('click', unlockRemoteAudioPlayback);
$('#copyRoomBtn').addEventListener('click', () => roomId && copyText(roomId));
$('#welcomeCopyBtn').addEventListener('click', () => roomId && copyText(roomId));
$('#inviteBtn').addEventListener('click', () => { $('#modalRoomCode').textContent = roomId; inviteModal.hidden = false; });
$('#closeInviteBtn').addEventListener('click', () => { inviteModal.hidden = true; });
$('#modalCopyBtn').addEventListener('click', () => roomId && copyText(roomId));
$('#leaveRoomBtn').addEventListener('click', leaveRoom);
inviteModal.addEventListener('click', (event) => { if (event.target === inviteModal) inviteModal.hidden = true; });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { inviteModal.hidden = true; if (!$('#videoViewerModal').hidden) closeVideoViewer(); } });

rtcConfigPromise = (async function loadConfig() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (response.ok) appConfig = { ...appConfig, ...await response.json() };
    else console.warn('Using default WebRTC ICE configuration:', response.status);
  } catch (error) {
    console.warn('Using default WebRTC ICE configuration:', error);
  }
})();

updateCallButtons();
