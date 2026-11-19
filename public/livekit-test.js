'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);
  const query = new URLSearchParams(location.search);
  const roomInput = $('#testRoom');
  const nameInput = $('#testName');
  roomInput.value = (query.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  nameInput.value = (query.get('name') || '').slice(0, 24);

  let room = null;
  let cameraOn = false;
  let micOn = false;
  let screenOn = false;
  const tileByTrack = new Map();

  function setStatus(message) { $('#testStatus').textContent = message; }
  function showError(message) { $('#testError').hidden = !message; $('#testError').textContent = message || ''; }
  function updateButtons() {
    $('#micBtn').disabled = !room;
    $('#cameraBtn').disabled = !room;
    $('#screenBtn').disabled = !room;
    $('#leaveBtn').disabled = !room;
    $('#micBtn').classList.toggle('active', micOn);
    $('#cameraBtn').classList.toggle('active', cameraOn);
    $('#screenBtn').classList.toggle('active', screenOn);
    $('#micBtn').querySelector('span').textContent = micOn ? 'Выключить микрофон' : 'Микрофон';
    $('#cameraBtn').querySelector('span').textContent = cameraOn ? 'Выключить камеру' : 'Камера';
    $('#screenBtn').querySelector('span').textContent = screenOn ? 'Остановить экран' : 'Экран';
  }

  function participantTileKey(participant, publication) {
    return publication.trackSid || `${participant.identity}-${publication.source}`;
  }

  function ensureTile(key, participant, isScreen) {
    let entry = tileByTrack.get(key);
    if (entry) return entry;
    const tile = document.createElement('div');
    tile.className = `media-tile${isScreen ? ' screen' : ''}`;
    const label = document.createElement('div');
    label.className = 'media-label';
    label.textContent = participant.name || participant.identity;
    tile.append(label);
    $('#participantGrid').querySelector('.empty-state')?.remove();
    $('#participantGrid').append(tile);
    entry = { tile, label };
    tileByTrack.set(key, entry);
    return entry;
  }

  function attachTrack(track, publication, participant, isLocal = false) {
    const isVideo = track.kind === LivekitClient.Track.Kind.Video;
    if (!isVideo) {
      if (!isLocal) {
        const audio = track.attach();
        audio.autoplay = true;
        audio.playsInline = true;
        audio.className = 'media-audio';
        $('#audioTracks').append(audio);
        audio.play().catch(() => setStatus('Нажми на страницу, чтобы разрешить звук.'));
      }
      return;
    }
    const isScreen = publication.source === LivekitClient.Track.Source.ScreenShare;
    const key = participantTileKey(participant, publication);
    const entry = ensureTile(key, participant, isScreen);
    const video = track.attach();
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;
    entry.tile.append(video);
  }

  function detachTrack(track) {
    track.detach().forEach((element) => element.remove());
    for (const [key, entry] of tileByTrack.entries()) {
      if (!entry.tile.querySelector('video')) {
        entry.tile.remove();
        tileByTrack.delete(key);
      }
    }
    if (!$('#participantGrid').children.length) {
      $('#participantGrid').innerHTML = '<div class="empty-state"><span>ฅ</span><strong>Здесь пока никого нет</strong><small>Ожидаем видеопотоков</small></div>';
    }
  }

  async function connect() {
    if (room) return;
    showError('');
    const roomCode = roomInput.value.trim().toUpperCase();
    const displayName = nameInput.value.trim() || 'Котик';
    if (roomCode.length !== 6) return showError('Код комнаты должен состоять из 6 символов.');
    if (!window.LivekitClient) return showError('LiveKit SDK не загрузился. Обнови страницу или проверь подключение к CDN.');

    $('#connectBtn').disabled = true;
    setStatus('Получаем доступ к тестовой комнате…');
    try {
      const response = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomCode, name: displayName })
      });
      const credentials = await response.json();
      if (!response.ok) throw new Error(credentials.error || 'Не удалось получить токен.');

      const { Room, RoomEvent, VideoPresets } = window.LivekitClient;
      room = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: { resolution: VideoPresets.h720.resolution }
      });

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => attachTrack(track, publication, participant, false));
      room.on(RoomEvent.TrackUnsubscribed, (track) => detachTrack(track));
      room.on(RoomEvent.LocalTrackPublished, (publication, participant) => {
        if (publication.track) attachTrack(publication.track, publication, participant, true);
      });
      room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
        if (publication.track) detachTrack(publication.track);
      });
      room.on(RoomEvent.ParticipantConnected, () => setStatus(`Подключено участников: ${room.remoteParticipants.size + 1}`));
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        setStatus(`${participant.name || 'Участник'} отключился`);
      });
      room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant && participant.isLocal) setStatus(`LiveKit · качество соединения: ${String(quality)}`);
      });
      room.on(RoomEvent.Disconnected, () => {
        setStatus('Соединение завершено.');
        room = null;
        cameraOn = false; micOn = false; screenOn = false;
        updateButtons();
      });

      room.prepareConnection(credentials.url, credentials.token);
      await room.connect(credentials.url, credentials.token);
      $('#roomLabel').textContent = `Комната ${roomCode}`;
      setStatus('Подключено к LiveKit. Включи микрофон и камеру.');
      updateButtons();
    } catch (error) {
      room = null;
      showError(error.message || 'Не удалось подключиться к LiveKit.');
      setStatus('Нет соединения');
    } finally {
      $('#connectBtn').disabled = Boolean(room);
    }
  }

  async function toggleMic() {
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!micOn);
      micOn = !micOn;
      updateButtons();
    } catch (error) { showError(`Микрофон: ${error.message}`); }
  }

  async function toggleCamera() {
    if (!room) return;
    try {
      const profiles = { '360': LivekitClient.VideoPresets.h360, '480': LivekitClient.VideoPresets.h480, '720': LivekitClient.VideoPresets.h720, '1080': LivekitClient.VideoPresets.h1080 };
      const profile = profiles[$('#qualitySelect').value] || LivekitClient.VideoPresets.h720;
      await room.localParticipant.setCameraEnabled(!cameraOn, { resolution: profile.resolution });
      cameraOn = !cameraOn;
      updateButtons();
    } catch (error) { showError(`Камера: ${error.message}`); }
  }

  async function toggleScreen() {
    if (!room) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showError('Этот браузер не поддерживает демонстрацию экрана с веб-страницы. На телефоне можно смотреть трансляцию, но начать захват экрана может быть невозможно.');
      return;
    }
    try {
      if (screenOn) {
        await room.localParticipant.setScreenShareEnabled(false);
      } else {
        const { ScreenSharePresets } = LivekitClient;
        const profile = $('#qualitySelect').value === '360' ? ScreenSharePresets.h360fps15 : $('#qualitySelect').value === '1080' ? ScreenSharePresets.h1080fps15 : ScreenSharePresets.h720fps15;
        await room.localParticipant.setScreenShareEnabled(true, {
          resolution: profile.resolution,
          contentHint: 'detail',
          audio: false
        });
      }
      screenOn = !screenOn;
      updateButtons();
    } catch (error) {
      screenOn = false;
      updateButtons();
      showError(`Демонстрация экрана: ${error.message || 'не поддерживается этим браузером'}`);
    }
  }

  async function leave() {
    if (!room) return;
    const activeRoom = room;
    room = null;
    try { await activeRoom.disconnect(); } catch (_error) {}
    $('#participantGrid').replaceChildren();
    $('#participantGrid').innerHTML = '<div class="empty-state"><span>ฅ</span><strong>Ты вышел из тестовой комнаты</strong><small>Можешь подключиться снова</small></div>';
    $('#audioTracks').replaceChildren();
    tileByTrack.clear();
    cameraOn = false; micOn = false; screenOn = false;
    $('#connectBtn').disabled = false;
    $('#roomLabel').textContent = 'Ожидание подключения';
    setStatus('Отключено');
    updateButtons();
  }

  $('#connectBtn').addEventListener('click', connect);
  $('#micBtn').addEventListener('click', toggleMic);
  $('#cameraBtn').addEventListener('click', toggleCamera);
  $('#screenBtn').addEventListener('click', toggleScreen);
  $('#leaveBtn').addEventListener('click', leave);
  $('#qualitySelect').addEventListener('change', () => {
    if (cameraOn) {
      const previous = cameraOn;
      cameraOn = false;
      toggleCamera().then(() => {
        if (previous) setStatus('Настройки разрешения обновлены. При необходимости снова включи камеру.');
      });
    }
  });

  const statusCheck = async () => {
    try {
      const response = await fetch('/api/livekit/status', { cache: 'no-store' });
      const result = await response.json();
      if (result.configured) setStatus('LiveKit настроен. Можно подключаться.');
      else setStatus('Нужны ключи LiveKit в Render Environment.');
    } catch (_error) {
      setStatus('Не удалось проверить настройки LiveKit.');
    }
  };
  statusCheck();
  updateButtons();
})();
