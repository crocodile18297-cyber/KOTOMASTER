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

const ROOM_SESSION_KEY = 'kotomaster-last-room-session';
const tabClientId = (() => {
  // sessionStorage is shared by reloads in this tab, but isolated from other tabs.
  const key = 'kotomaster-tab-client-id';
  try {
    let value = sessionStorage.getItem(key);
    if (!value) {
      value = window.crypto && typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `km-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(key, value);
    }
    return value;
  } catch (_error) {
    return window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `km-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
})();

let socket = null;
let roomId = '';
let roomConversationId = null;
let activePanel = 'chat';
let myName = '';
let participants = new Map();
let seenMessages = new Set();
let peerConnections = new Map();
let pendingIce = new Map();
let localStream = null;
let previewAudioStream = null;
let selectedAudioDeviceId = '';
let screenStream = null;
let isInCall = false;
let isMicOn = false;
let isCameraOn = false;
let isSharing = false;
let isRoomSyncing = false;
let wasMicInterrupted = false;
let wasCameraInterrupted = false;
let videoQualityBoostEnabled = (() => { try { return localStorage.getItem('kotomaster-video-quality-boost') === '1'; } catch (_error) { return false; } })();
let resumeCallAfterRestore = false;
let appConfig = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }
  ],
  iceTransportPolicy: 'all',
  maxRoomSize: 6
};
let rtcConfigPromise = null;
let peerConnectionPromises = new Map();
let remoteAudioElements = new Map();
const senderParameterQueues = new WeakMap();
let micMeterContext = null;
let micMeterSource = null;
let micMeterAnalyser = null;
let micMeterTimer = null;
let isSwitchingAudioInput = false;
let toastTimer = null;
let viewerStream = null;
let messageRecords = new Map();
let replyTarget = null;
let typingStopTimer = null;
let lastTypingEmitAt = 0;
let typingMembers = new Map();
let pinnedMessage = null;
let notificationsEnabled = (() => { try { return localStorage.getItem('kotomaster-notifications') === '1'; } catch (_error) { return false; } })();
let messageSearchQuery = '';
let activeCallStartedAt = 0;


const KOTO_PREFS_KEY='kotomaster-preferences-v1';
const KOTO_MUTED_PEERS_KEY='kotomaster-muted-peers-v1';
function readKotoPrefs(){
  try{return {...{accent:'#a47965',theme:'light',scale:'normal',sounds:true,animations:true},...JSON.parse(localStorage.getItem(KOTO_PREFS_KEY)||'{}')};}
  catch(_error){return {accent:'#a47965',theme:'light',scale:'normal',sounds:true,animations:true};}
}
let kotoPrefs=readKotoPrefs();
function playKotoNotificationSound(){
  if(!kotoPrefs.sounds || document.hidden) return;
  try{
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    if(!AudioContextClass)return;
    const context=new AudioContextClass();
    if(context.state==='suspended')context.resume().catch(()=>{});
    const oscillator=context.createOscillator();
    const gain=context.createGain();
    oscillator.type='sine';
    oscillator.frequency.setValueAtTime(660,context.currentTime);
    oscillator.frequency.setValueAtTime(880,context.currentTime+0.08);
    gain.gain.setValueAtTime(0.0001,context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08,context.currentTime+0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001,context.currentTime+0.22);
    oscillator.connect(gain);gain.connect(context.destination);
    oscillator.start();oscillator.stop(context.currentTime+0.24);
    oscillator.onended=()=>context.close().catch(()=>{});
  }catch(_error){}
}
function applyKotoPrefs(){
  const root=document.documentElement;
  root.style.setProperty('--accent',kotoPrefs.accent);
  const resolvedTheme=kotoPrefs.theme==='system'?(window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light'):kotoPrefs.theme;
  root.dataset.kotoTheme=resolvedTheme;
  root.dataset.kotoScale=kotoPrefs.scale;
  root.dataset.kotoAnimations=kotoPrefs.animations?'on':'off';
  const sound=$('#settingSounds'),animations=$('#settingAnimations');
  if(sound)sound.checked=!!kotoPrefs.sounds;
  if(animations)animations.checked=!!kotoPrefs.animations;
  document.querySelectorAll('[data-accent]').forEach(b=>b.classList.toggle('is-selected',b.dataset.accent===kotoPrefs.accent));
  document.querySelectorAll('[data-theme-choice]').forEach(b=>b.classList.toggle('is-selected',b.dataset.themeChoice===kotoPrefs.theme));
  document.querySelectorAll('[data-scale-choice]').forEach(b=>b.classList.toggle('is-selected',b.dataset.scaleChoice===kotoPrefs.scale));
  try{localStorage.setItem(KOTO_PREFS_KEY,JSON.stringify(kotoPrefs));}catch(_error){}
}
function readMutedPeers(){try{return new Set(JSON.parse(localStorage.getItem(KOTO_MUTED_PEERS_KEY)||'[]'));}catch(_error){return new Set();}}
const locallyMutedPeers=readMutedPeers();
function persistMutedPeers(){try{localStorage.setItem(KOTO_MUTED_PEERS_KEY,JSON.stringify([...locallyMutedPeers]));}catch(_error){}}
function applyPeerMute(peerId){
  const stableId=(participants.get(peerId)||{}).userId || peerId;
  const muted=locallyMutedPeers.has(stableId);
  (remoteAudioElements.get(peerId)||[]).forEach(audio=>{audio.muted=muted;});
  const tile=videoGrid?.querySelector('[data-peer-id="'+CSS.escape(peerId)+'"]');
  if(tile)tile.classList.toggle('peer-locally-muted',muted);
}
function togglePeerLocalMute(peerId){
  const stableId=(participants.get(peerId)||{}).userId || peerId;
  if(locallyMutedPeers.has(stableId))locallyMutedPeers.delete(stableId);else locallyMutedPeers.add(stableId);
  persistMutedPeers();applyPeerMute(peerId);renderParticipants();
}
function openSettings(){applyKotoPrefs();$('#settingsModal').hidden=false;}
function closeSettings(){$('#settingsModal').hidden=true;}

let supabaseClient = null;
let authSession = null;
let authMode = 'signin';
let authReady = false;
let authProfile = null;
let passwordRecoveryPending = false;
let posthogInitialized = false;
let posthogIdentity = null;

function initializeProductAnalytics(config, currentSession) {
  if (!config?.posthogProjectToken || !config?.posthogApiHost ||
      !window.posthog || typeof window.posthog.init !== 'function') return;
  try {
    window.posthog.init(config.posthogProjectToken, {
      api_host: config.posthogApiHost,
      defaults: '2026-08-30',
      autocapture: false,
      disable_session_recording: true,
      capture_performance: false,
      logs: { captureConsoleLogs: false },
      capture_pageview: true
    });
    posthogInitialized = true;
    updateProductAnalyticsIdentity(currentSession?.user?.id || null);
  } catch (error) {
    console.warn('PostHog initialization failed:', error?.name || 'Error');
  }
}

function updateProductAnalyticsIdentity(userId) {
  if (!posthogInitialized || !window.posthog) return;
  const nextId = typeof userId === 'string' && userId.length <= 80 ? userId : null;
  if (nextId && nextId !== posthogIdentity) {
    window.posthog.identify(nextId);
    posthogIdentity = nextId;
  } else if (!nextId && posthogIdentity) {
    window.posthog.reset();
    posthogIdentity = null;
  }
}

function captureProductEvent(event, properties = {}) {
  if (!posthogInitialized || !window.posthog || typeof window.posthog.capture !== 'function') return;
  try { window.posthog.capture(event, properties); } catch (_error) {}
}

function captureWebRtcDiagnostic(stage, error, peerConnection = null) {
  const rawName = error && typeof error.name === 'string' ? error.name : 'Error';
  const errorName = rawName.replace(/[^A-Za-z0-9_]/g, '').slice(0, 48) || 'Error';
  const properties = {
    feature: 'webrtc',
    stage: String(stage).slice(0, 48),
    error_name: errorName
  };
  if (error && Number.isInteger(error.errorCode)) {
    properties.error_code = error.errorCode;
  }
  if (peerConnection) {
    const connectionState = String(peerConnection.connectionState || '').slice(0, 24);
    const iceState = String(peerConnection.iceConnectionState || '').slice(0, 24);
    const signalingState = String(peerConnection.signalingState || '').slice(0, 24);
    if (connectionState) properties.connection_state = connectionState;
    if (iceState) properties.ice_state = iceState;
    if (signalingState) properties.signaling_state = signalingState;
  }
  captureProductEvent('webrtc_error', properties);
}

function getAnalyticsSessionId() {
  if (!posthogInitialized || !window.posthog || typeof window.posthog.get_session_id !== 'function') return null;
  try { return window.posthog.get_session_id() || null; } catch (_error) { return null; }
}

async function loadAuthenticatedTurnServers(session) {
  const token = session?.access_token;
  if (!token) return false;
  try {
    const response = await fetch('/api/rtc/ice-servers', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      cache: 'no-store'
    });
    if (response.status === 503) return false;
    if (!response.ok) {
      captureWebRtcDiagnostic('turn_credentials', { name: response.status === 401 ? 'Unauthorized' : 'TurnProviderError' });
      return false;
    }
    const config = await response.json();
    if (!Array.isArray(config.iceServers) || !config.iceServers.length) return false;
    const combined = [...(appConfig.iceServers || []), ...config.iceServers];
    const unique = new Map(combined.map((server) => [JSON.stringify(server), server]));
    appConfig = { ...appConfig, iceServers: [...unique.values()], iceTransportPolicy: 'all' };
    captureProductEvent('webrtc_turn_configured', { provider: 'cloudflare' });
    return true;
  } catch (error) {
    captureWebRtcDiagnostic('turn_credentials', error);
    console.warn('Could not load TURN relay configuration:', error?.name || 'Error');
    return false;
  }
}

async function initializeSupabase() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Не удалось загрузить настройки сервиса.');
  const config = await response.json();
  appConfig = { ...appConfig, ...config };
  initializeProductAnalytics(config, authSession);
  if (!config.supabaseUrl || !config.supabasePublishableKey || !window.supabase?.createClient) {
    throw new Error('Авторизация не настроена. Обнови страницу позже.');
  }
  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  authSession = data.session;
  updateProductAnalyticsIdentity(authSession?.user?.id || null);
  if (authSession?.access_token) {
    rtcConfigPromise = Promise.resolve(rtcConfigPromise)
      .then(() => loadAuthenticatedTurnServers(authSession));
    await rtcConfigPromise;
  }
  supabaseClient.auth.onAuthStateChange((event, session) => {
    const previousToken = authSession?.access_token;
    authSession = session;
    updateProductAnalyticsIdentity(session?.user?.id || null);
    if (session?.user && (!previousToken || previousToken !== session.access_token)) {
      const activeSession = session;
      rtcConfigPromise = Promise.resolve(rtcConfigPromise)
        .then(() => loadAuthenticatedTurnServers(activeSession));
      loadRemoteCallHistory().catch((error)=>console.warn('Could not refresh remote call history:',error));
      startCommunityRealtime().catch((error)=>console.warn('Could not start inbox updates:',error));
    } else if (!session) {
      stopCommunityRealtime().catch((error)=>console.warn('Could not stop inbox updates:',error));
    }
    if (event === 'PASSWORD_RECOVERY') {
      passwordRecoveryPending = true;
      authMode = 'recovery';
      $('#authEmail').value = session?.user?.email || '';
      $('#authEmail').readOnly = true;
      $('#authPassword').value = '';
      $('#authPassword').placeholder = 'Новый пароль';
      $('#authModeToggle').hidden = true;
      $('#forgotPasswordBtn').hidden = true;
      $('#authSubmitBtn').querySelector('span:nth-child(2)').textContent = 'Сохранить пароль';
    }
    updateAuthInterface();
    if (session?.access_token && socket) {
      socket.auth = {
        accessToken: session.access_token,
        posthogSessionId: getAnalyticsSessionId()
      };
      if (previousToken && previousToken !== session.access_token && socket.connected) {
        socket.disconnect();
        socket.connect();
      }
    }
    if (!session && socket) {
      if (isInCall) stopCall();
      if (roomId) leaveRoom();
    }
  });
  authReady = true;
  updateAuthInterface();
}

function updateAuthInterface() {
  const signedIn = Boolean(authSession?.user) && !passwordRecoveryPending;
  const authPanel = $('#authPanel');
  const roomAccessPanel = $('#roomAccessPanel');
  if (authPanel) authPanel.hidden = signedIn;
  if (roomAccessPanel) roomAccessPanel.hidden = !signedIn;
  const user = authSession?.user;
  const displayName = authProfile?.display_name || user?.user_metadata?.display_name || user?.email?.split('@')[0] || '';
  if (signedIn && displayName) {
    nameInput.value = String(displayName).slice(0, 24);
    myName = nameInput.value;
  }
  const usernameNode=$('#myUsername');
  if(usernameNode) usernameNode.textContent=authProfile?.username?'@'+authProfile.username:'';

}

function setAuthMode(mode) {
  authMode = mode === 'signup' ? 'signup' : 'signin';
  const signup = authMode === 'signup';
  $('#authDisplayNameWrap').hidden = !signup;
  $('#authUsernameWrap').hidden = !signup;
  $('#authPassword').autocomplete = signup ? 'new-password' : 'current-password';
  $('#authSubmitBtn').querySelector('span:nth-child(2)').textContent = signup ? 'Создать аккаунт' : 'Войти';
  $('#authModeToggle').textContent = signup ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться';
  $('#authError').textContent = '';
  $('#authError').classList.remove('form-success');
}

async function loadMyProfile() {
  if (!supabaseClient || !authSession?.user) return;
  const { data, error } = await supabaseClient.from('profiles')
    .select('id,username,display_name,avatar_path,bio')
    .eq('id', authSession.user.id).maybeSingle();
  if (error) { console.warn('Profile load failed:', error); return; }
  authProfile = data;
  updateAuthInterface();
  const usernameNode=$('#myUsername');
  if(usernameNode) usernameNode.textContent=data?.username?'@'+data.username:'';

}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const button = $('#authSubmitBtn');
  const email = $('#authEmail').value.trim().toLowerCase();
  const password = $('#authPassword').value;
  const displayName = $('#authDisplayName').value.trim().slice(0, 24);
  const username = $('#authUsername').value.trim().toLowerCase();
  const errorNode = $('#authError');
  errorNode.textContent = '';
  errorNode.classList.remove('form-success');
  if (authMode === 'signup' && !displayName) { errorNode.textContent = 'Укажи имя для профиля.'; return; }
  if (authMode === 'signup' && !/^[a-z0-9_]{3,24}$/.test(username)) { errorNode.textContent = 'Username: 3–24 символа, только латинские буквы, цифры и _. '; return; }
  if (authMode === 'recovery' && password.length < 8) { errorNode.textContent = 'Новый пароль должен содержать не менее 8 символов.'; return; }
  setBusy(button, true, authMode === 'signup' ? 'Создаём аккаунт…' : authMode === 'recovery' ? 'Сохраняем…' : 'Входим…');
  try {
    if (authMode === 'recovery') {
      const { error } = await supabaseClient.auth.updateUser({ password });
      if (error) throw error;
      passwordRecoveryPending = false;
      $('#authEmail').readOnly = false;
      $('#authPassword').value = '';
      $('#authPassword').placeholder = 'Не менее 8 символов';
      $('#authModeToggle').hidden = false;
      $('#forgotPasswordBtn').hidden = false;
      authMode = 'signin';
      updateAuthInterface();
      showToast('Пароль успешно изменён.');
    } else if (authMode === 'signup') {
      const { data, error } = await supabaseClient.auth.signUp({
        email, password,
        options: { data: { display_name: displayName, username }, emailRedirectTo: window.location.origin }
      });
      if (error) throw error;
      captureProductEvent('account_signup_submitted', { auth_method: 'email' });
      if (!data.session) {
        errorNode.classList.add('form-success');
        errorNode.textContent = 'АККАУНТ СОЗДАН. Открой письмо от Supabase и нажми «Подтвердить почту». Если письма нет, проверь «Спам» и запроси регистрацию ещё раз только после проверки, что адрес не занят.';
        return;
      }
      authSession = data.session;
      authProfile = null;
      updateAuthInterface();
      await loadMyProfile();
      captureProductEvent('account_signed_up', { auth_method: 'email' });
      showToast('Аккаунт создан. Добро пожаловать в KOTOMASTER.');
    } else {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      authSession = data.session;
      authProfile = null;
      updateAuthInterface();
      await loadMyProfile();
      captureProductEvent('account_signed_in', { auth_method: 'email' });
      showToast('Вход выполнен.');
    }
  } catch (error) {
    captureProductEvent('authentication_failed', {
      auth_method: authMode === 'signup' ? 'email_signup' : 'email_signin',
      error_name: String(error?.name || 'AuthError').slice(0, 48)
    });
    errorNode.textContent = authErrorMessage(error);
  } finally {
    setBusy(button, false);
  }
}

function authErrorMessage(error) {
  const message = String(error?.message || 'Не удалось выполнить запрос.');
  if (/invalid login credentials/i.test(message)) return 'Неверная почта или пароль.';
  if (/user already registered/i.test(message)) return 'Этот адрес уже зарегистрирован. Попробуй войти.';
  if (/password should be at least/i.test(message)) return 'Пароль должен содержать не менее 8 символов.';
  if (/email not confirmed/i.test(message)) return 'Сначала подтверди электронную почту.';
  if (/rate limit/i.test(message)) return 'Слишком много попыток. Подожди немного и повтори.';
  return message;
}

async function openProfileEditor() {
  if(!authProfile) await loadMyProfile();
  $('#profileDisplayName').value=authProfile?.display_name||myName||'';
  $('#profileUsername').value=authProfile?.username||'';
  $('#profileBio').value=authProfile?.bio||'';
  $('#profileEditError').textContent='';
  $('#editProfileModal').hidden=false;
}

async function saveProfileChanges(event) {
  event.preventDefault();
  const displayName=$('#profileDisplayName').value.trim().slice(0,24);
  const username=$('#profileUsername').value.trim().toLowerCase();
  const bio=$('#profileBio').value.trim().slice(0,160);
  const errorNode=$('#profileEditError');
  if(!displayName) { errorNode.textContent='Укажи имя.'; return; }
  if(!/^[a-z0-9_]{3,24}$/.test(username)) {
    errorNode.textContent='Username должен содержать 3–24 символа: латинские буквы, цифры и _.';
    return;
  }
  const button=$('#editProfileForm').querySelector('button[type="submit"]');
  setBusy(button,true,'Сохраняем…');
  try {
    const {data,error}=await supabaseClient.from('profiles')
      .update({display_name:displayName,username,bio,updated_at:new Date().toISOString()})
      .eq('id',communityUserId())
      .select('id,username,display_name,avatar_path,bio').single();
    if(error) throw error;
    authProfile=data;
    myName=displayName;
    nameInput.value=displayName;
    $('#myName').textContent=displayName;
    $('#myAvatar').textContent=firstLetter(displayName);
    $('#myUsername').textContent='@'+username;
    $('#editProfileModal').hidden=true;
    if(socket && socket.connected) socket.emit('profile:update',{name:displayName});
    showToast('Профиль обновлён.');
  } catch(error) {
    if(error.code==='23505') errorNode.textContent='Этот username уже занят. Выбери другой.';
    else errorNode.textContent=error.message||'Не удалось сохранить профиль.';
  } finally { setBusy(button,false); }
}

async function handlePasswordRecovery() {
  const email = $('#authEmail').value.trim().toLowerCase();
  if (!email) {
    $('#authError').textContent = 'Сначала введи электронную почту.';
    $('#authEmail').focus();
    return;
  }
  const button = $('#forgotPasswordBtn');
  button.disabled = true;
  try {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin
    });
    if (error) throw error;
    $('#authError').textContent = 'Если аккаунт с этой почтой существует, письмо для сброса пароля отправлено.';
  } catch (error) {
    $('#authError').textContent = authErrorMessage(error);
  } finally {
    button.disabled = false;
  }
}

async function signOutAccount() {
  if (!supabaseClient) return;
  if (isInCall) stopCall();
  if (roomId) leaveRoom();
  captureProductEvent('account_signed_out');
  const { error } = await supabaseClient.auth.signOut();
  if (error) showToast('Не удалось выйти: ' + error.message);
  else {
    authSession = null;
    authProfile = null;
    updateAuthInterface();
    showToast('Ты вышел из аккаунта.');
  }
}

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
  if (!authSession?.access_token) throw new Error('Сначала войди в аккаунт.');
  if (socket && socket.connected) return;
  if (!window.io) throw new Error('Не загрузился модуль связи. Обнови страницу.');
  if (!socket) {
    socket = window.io({
      auth: {
        accessToken: authSession.access_token,
        posthogSessionId: getAnalyticsSessionId()
      },
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 700,
      reconnectionDelayMax: 9000,
      randomizationFactor: 0.35,
      timeout: 12000
    });
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
  socket.on('room:session-replaced', () => {
    if (isInCall) stopCall();
    roomId = '';
    participants.clear();
    seenMessages.clear();
    appScreen.hidden = true;
    joinScreen.hidden = false;
    showJoinError('Эта вкладка уже подключена к комнате из другого окна. Войди в комнату заново.');
    socket.disconnect();
    showToast('Старое подключение заменено новым. Повторно войди в комнату.');
  });

  socket.on('chat:message', (message) => {
    appendMessage(message);
    if (message && message.from !== socket.id) {
      notifyIncomingMessage(message);
      playKotoNotificationSound();
      if (!document.hidden && activePanel === 'chat') markMessagesRead([message.id]);
    }
  });

  socket.on('chat:edited', (message) => {
    if (!message || !message.id) return;
    messageRecords.set(message.id, message);
    refreshMessageNode(message);
    applyMessageSearch();
  });

  socket.on('chat:deleted', ({ messageId }) => {
    const message = messageRecords.get(messageId);
    if (!message) return;
    message.deleted = true;
    message.text = '';
    message.reactions = {};
    messageRecords.set(messageId, message);
    refreshMessageNode(message);
    if (pinnedMessage && pinnedMessage.id === messageId) {
      pinnedMessage = null;
      renderPinnedMessage();
    }
  });

  socket.on('chat:reaction', ({ messageId, reactions }) => {
    const message = messageRecords.get(messageId);
    if (!message) return;
    message.reactions = reactions || {};
    messageRecords.set(messageId, message);
    refreshMessageNode(message);
  });

  socket.on('chat:pinned', (message) => {
    pinnedMessage = message || null;
    renderPinnedMessage();
    messageRecords.forEach((item) => refreshMessageNode(item));
    showToast(pinnedMessage ? 'Сообщение закреплено' : 'Закрепление снято');
  });

  socket.on('chat:typing', ({ id, name, typing }) => {
    if (!id || id === socket.id) return;
    const previous = typingMembers.get(id);
    if (previous && previous.timer) clearTimeout(previous.timer);
    if (!typing) {
      typingMembers.delete(id);
    } else {
      const entry = { name: name || 'Кто-то', timer: setTimeout(() => {
        typingMembers.delete(id);
        renderTypingIndicator();
      }, 4200) };
      typingMembers.set(id, entry);
    }
    renderTypingIndicator();
  });

  socket.on('chat:read-receipt', ({ messageId, readerId }) => {
    const message = messageRecords.get(messageId);
    if (!message || !readerId) return;
    if (!Array.isArray(message.readBy)) message.readBy = [];
    if (!message.readBy.includes(readerId)) message.readBy.push(readerId);
    refreshMessageNode(message);
  });

  socket.on('room:peer-renamed', (member) => {
    if (!member || !member.id) return;
    const previous=participants.get(member.id)||{};
    participants.set(member.id,{...previous,...member});
    renderParticipants();
    updateCallDescription();
  });

  socket.on('room:peer-joined', (member) => {
    participants.set(member.id, member);
    renderParticipants();
    showToast(`${member.name} присоединился к комнате`);
    updateCallDescription();
  });

  socket.on('room:peer-left', ({ id, reason }) => {
    const member = participants.get(id);
    closePeer(id);
    removeVideoTile(id);
    participants.delete(id);
    updateCallStage();
    renderParticipants();
    updateCallDescription();
    if (member && reason !== 'reconnected') showToast(`${member.name} вышел из комнаты`);
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
      const pc = peerConnections.get(from);
      console.error('WebRTC signal error:', error);
      captureWebRtcDiagnostic('signal', error, pc);
      showToast('Не удалось согласовать видеосвязь. Повторяем подключение…');
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

    // A new Socket.IO ID invalidates the old signalling identity. Recreate P2P peers
    // after rejoining rather than reusing connections negotiated against the old ID.
    const stalePeerIds = Array.from(peerConnections.keys());
    stalePeerIds.forEach((peerId) => {
      closePeer(peerId);
      removeVideoTile(peerId);
    });
    pendingIce.clear();

    const reconnectRoom = roomId;
    try {
      const response = await emitWithAck('room:join', { name: myName, roomId: reconnectRoom, clientId: tabClientId });
      if (roomId !== reconnectRoom) {
        if (response.ok) socket.emit('room:leave');
        return;
      }
      if (response.ok) {
        enterWorkspace(response, true);
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
          await recoverInterruptedMedia();
        }
        showToast('Связь восстановлена. Ты снова в комнате.');
      } else {
        resetAfterRoomRecoveryFailure(response.error || 'Комната больше недоступна.');
      }
    } catch (error) {
      console.warn('Room reconnection failed:', error);
      showToast('Не удалось вернуться в комнату. Повторяем подключение…');
    }
  });
}

function resetAfterRoomRecoveryFailure(message) {
  if (isInCall) stopCall();
  if (previewAudioStream) {
    previewAudioStream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    previewAudioStream = null;
  }
  roomId = '';
  roomConversationId = null;
  try { localStorage.removeItem(ROOM_SESSION_KEY); } catch (_error) {}
  participants.clear();
  seenMessages.clear();
  messagesList.replaceChildren();
  appScreen.hidden = true;
  joinScreen.hidden = false;
  if (myName) nameInput.value = myName;
  showJoinError(`${message} Создай новую комнату или введи действующий код.`);
  if (socket) socket.disconnect();
}

async function syncRoomAfterResume() {
  if (isRoomSyncing || document.hidden || !roomId || !socket || !socket.connected || !participants.has(socket.id)) return;
  isRoomSyncing = true;
  const syncingRoom = roomId;
  try {
    const response = await emitWithAck('room:sync', {});
    if (roomId !== syncingRoom) return;
    if (!response.ok) {
      resetAfterRoomRecoveryFailure(response.error || 'Комната больше недоступна.');
      return;
    }
    enterWorkspace(response, true);
    if (isInCall && localStream) {
      publishMediaState();
      for (const member of participants.values()) {
        if (member.id !== socket.id && member.inCall) {
          createPeerConnection(member.id).catch((error) => showToast(error.message));
        }
      }
      for (const [peerId, pc] of peerConnections.entries()) {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          scheduleIceRestart(peerId, pc);
        }
      }
      await recoverInterruptedMedia();
    }
  } catch (error) {
    console.warn('Room sync after mobile resume failed:', error);
    showToast('Проверяем соединение с комнатой. Попробуй переключиться между вкладками.');
  } finally {
    isRoomSyncing = false;
  }
}

function handlePageResume() {
  if (document.hidden || !roomId || !socket) return;
  if (!socket.connected) {
    socket.connect();
    return;
  }
  unlockRemoteAudioPlayback();
  syncRoomAfterResume().finally(unlockRemoteAudioPlayback);
}

async function restoreSavedRoom() {
  if (!authSession?.user) return;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(ROOM_SESSION_KEY) || 'null');
  } catch (_error) {
    localStorage.removeItem(ROOM_SESSION_KEY);
  }
  if (!saved || !saved.roomId || !saved.name) return;
  if (Date.now() - Number(saved.savedAt || 0) > 7 * 24 * 60 * 60 * 1000) {
    localStorage.removeItem(ROOM_SESSION_KEY);
    return;
  }
  nameInput.value = String(saved.name).slice(0, 24);
  roomInput.value = String(saved.roomId).slice(0, 6);
  resumeCallAfterRestore = Boolean(saved.wasInCall);
  showJoinError('Восстанавливаем последнюю комнату…');
  try {
    await connectSocket();
    await joinRoom(nameInput.value, roomInput.value);
    showJoinError('');
    showToast(resumeCallAfterRestore
      ? 'Комната восстановлена. Нажми «Вернуться в видеозвонок», чтобы снова включить микрофон и камеру.'
      : 'Последняя комната восстановлена.');
  } catch (error) {
    console.warn('Saved room could not be restored:', error);
    if (String(error.message || '').includes('Комната не найдена')) {
      localStorage.removeItem(ROOM_SESSION_KEY);
      showJoinError('Прежняя комната уже закрыта. Создай новую или введи актуальный код.');
    } else {
      showJoinError('Не удалось автоматически открыть прежнюю комнату. Проверь интернет и попробуй войти ещё раз.');
    }
    if (socket && !roomId) {
      socket.disconnect();
      socket = null;
    }
  }
}

async function createRoom(name) {
  const response = await emitWithAck('room:create', { name, clientId: tabClientId });
  if (!response.ok) throw new Error(response.error || 'Не удалось создать комнату.');
  enterWorkspace(response);
}

async function joinRoom(name, code) {
  const response = await emitWithAck('room:join', { name, roomId: code, clientId: tabClientId });
  if (!response.ok) throw new Error(response.error || 'Не удалось войти в комнату.');
  enterWorkspace(response);
}

function enterWorkspace(data, preservePanel = false) {
  roomId = data.roomId;
  roomConversationId = data.conversationId || null;
  myName = data.self.name;
  try {
    localStorage.setItem(ROOM_SESSION_KEY, JSON.stringify({ roomId, name: myName, savedAt: Date.now(), wasInCall: isInCall || resumeCallAfterRestore }));
  } catch (_error) {}
  participants.clear();
  seenMessages.clear();
  messageRecords.clear();
  typingMembers.forEach((entry) => { if (entry.timer) clearTimeout(entry.timer); });
  typingMembers.clear();
  replyTarget = null;
  renderReplyPreview();
  participants.set(data.self.id, data.self);
  pinnedMessage = data.pinnedMessage || null;
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
  renderPinnedMessage();
  renderTypingIndicator();
  if (activePanel === 'chat' && !document.hidden) {
    markMessagesRead((data.messages || []).filter((message) => message.from !== data.self.id).map((message) => message.id));
  }
  renderParticipants();
  updateCallDescription();

  joinScreen.hidden = true;
  appScreen.hidden = false;
  switchPanel(preservePanel ? activePanel : 'chat');
  if (!preservePanel) $('#messageInput').focus();
}

function firstLetter(value) {
  return String(value || 'К').trim().charAt(0).toLocaleUpperCase('ru-RU') || 'К';
}

function renderParticipants() {
  const list = $('#memberList');
  const mobileList = $('#mobileMemberStrip');
  list.replaceChildren();
  if (mobileList) mobileList.replaceChildren();
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
    if(member.id!==(socket&&socket.id)){
      const mute=communityNode('button','member-local-mute',locallyMutedPeers.has(member.userId||member.id)?'Со звуком':'Без звука');
      mute.type='button';mute.setAttribute('aria-pressed',String(locallyMutedPeers.has(member.userId||member.id)));
      mute.addEventListener('click',()=>togglePeerLocalMute(member.id));
      row.append(mute);
    }
    list.append(row);

    if (mobileList) {
      const chip = document.createElement('div');
      chip.className = `mobile-member-chip${member.id === (socket && socket.id) ? ' is-me' : ''}`;
      const chipAvatar = document.createElement('span');
      chipAvatar.className = 'mobile-member-avatar';
      chipAvatar.textContent = firstLetter(member.name);
      const chipName = document.createElement('span');
      chipName.className = 'mobile-member-name';
      chipName.textContent = member.id === (socket && socket.id) ? 'Ты' : member.name;
      const chipState = document.createElement('i');
      chipState.className = `mobile-member-state${member.inCall ? ' in-call' : ''}`;
      chipState.title = member.inCall ? 'В видеозвонке' : 'В комнате';
      chip.append(chipAvatar, chipName, chipState);
      if(member.id!==(socket&&socket.id)){
        const mute=communityNode('button','mobile-local-mute',locallyMutedPeers.has(member.userId||member.id)?'🔇':'🔊');
        mute.type='button';mute.setAttribute('aria-label',locallyMutedPeers.has(member.userId||member.id)?'Включить звук участника':'Выключить звук участника');
        mute.addEventListener('click',event=>{event.stopPropagation();togglePeerLocalMute(member.id);});
        chip.append(mute);
      }
      mobileList.append(chip);
    }
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
  messageRecords.set(message.id, message);
  const row = createMessageNode(message);
  messagesList.append(row);
  $('.chat-welcome').hidden = true;
  applyMessageSearch();
  if (shouldScroll) requestAnimationFrame(() => { chatScroll.scrollTop = chatScroll.scrollHeight; });
}

function createActionButton(label, title, action, messageId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'message-action';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.dataset.action = action;
  button.dataset.messageId = messageId;
  return button;
}



let activeMessageActionMenu = null;

function closeMessageActionMenu(restoreFocus = true) {
  const active = activeMessageActionMenu;
  if (!active) return;
  activeMessageActionMenu = null;
  document.removeEventListener('keydown', active.onKeydown, true);
  active.overlay.remove();
  document.body.style.overflow = active.previousBodyOverflow;
  if (restoreFocus && active.trigger && active.trigger.isConnected) {
    try { active.trigger.focus({ preventScroll: true }); } catch (_error) { active.trigger.focus(); }
  }
}

function createMessageMenuButton(action, icon, title, description, danger = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'message-action-menu-item' + (danger ? ' is-danger' : '');
  button.dataset.menuAction = action;
  button.setAttribute('aria-label', title);
  const symbol = document.createElement('span');
  symbol.className = 'message-action-menu-icon';
  symbol.setAttribute('aria-hidden', 'true');
  symbol.textContent = icon;
  const copy = document.createElement('span');
  copy.className = 'message-action-menu-copy';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const small = document.createElement('small');
  small.textContent = description;
  copy.append(strong, small);
  button.append(symbol, copy);
  return button;
}

function openMessageActionMenu(message, kind = 'room', trigger = null) {
  if (!message) return;
  const community = kind === 'community';
  if (community ? message.deleted_at : message.deleted) return;
  closeMessageActionMenu(false);

  const own = community
    ? message.sender_id === communityUserId()
    : Boolean(socket && message.from === socket.id);
  const pinned = community
    ? communityState.pinnedMessage?.message_id === message.id
    : Boolean(pinnedMessage && pinnedMessage.id === message.id);
  const body = community ? (message.body || '') : (message.text || '');
  const author = community
    ? (own ? 'Ты' : (communityState.currentConversation?.title || 'Участник'))
    : (own ? 'Ты' : (message.name || 'Участник'));

  const overlay = document.createElement('div');
  overlay.id = 'messageActionMenu';
  overlay.className = 'message-action-menu-overlay';
  overlay.setAttribute('role', 'presentation');

  const panel = document.createElement('section');
  panel.className = 'message-action-menu-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'messageActionMenuTitle');
  panel.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'message-action-menu-header';
  const drag = document.createElement('span');
  drag.className = 'message-action-menu-drag';
  drag.setAttribute('aria-hidden', 'true');
  const heading = document.createElement('strong');
  heading.id = 'messageActionMenuTitle';
  heading.textContent = 'Действия с сообщением';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'message-action-menu-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Закрыть меню');
  close.addEventListener('click', () => closeMessageActionMenu(true));
  header.append(drag, heading, close);

  const preview = document.createElement('div');
  preview.className = 'message-action-menu-preview';
  const previewLabel = document.createElement('span');
  previewLabel.textContent = own ? 'ВАШЕ СООБЩЕНИЕ' : ('СООБЩЕНИЕ · ' + author.toLocaleUpperCase('ru-RU'));
  const previewText = document.createElement('p');
  previewText.textContent = body;
  preview.append(previewLabel, previewText);

  const reactionGroup = document.createElement('div');
  reactionGroup.className = 'message-action-menu-reactions';
  reactionGroup.setAttribute('role', 'group');
  reactionGroup.setAttribute('aria-label', 'Быстрые реакции');
  ['❤️', '👍', '😂', '🔥', '🐱', '🎉'].forEach((emoji) => {
    const reaction = document.createElement('button');
    reaction.type = 'button';
    reaction.className = 'message-action-menu-reaction';
    reaction.textContent = emoji;
    reaction.setAttribute('aria-label', 'Поставить реакцию ' + emoji);
    reaction.addEventListener('click', async () => {
      closeMessageActionMenu(true);
      if (community) {
        await toggleCommunityReaction(message.id, emoji);
      } else {
        try {
          const response = await emitWithAck('chat:react', { messageId: message.id, emoji });
          if (!response.ok) showToast('Не удалось добавить реакцию.');
        } catch (error) { showToast(error.message || 'Не удалось добавить реакцию.'); }
      }
    });
    reactionGroup.append(reaction);
  });

  const actions = document.createElement('div');
  actions.className = 'message-action-menu-grid';
  actions.append(
    createMessageMenuButton('reply', '↩', 'Ответить', 'Цитировать сообщение'),
    createMessageMenuButton('pin', '⌑', pinned ? 'Открепить' : 'Закрепить', 'Важное в чате')
  );

  const ownerActions = document.createElement('div');
  ownerActions.className = 'message-action-menu-owner';
  if (own) {
    ownerActions.append(
      createMessageMenuButton('edit', '✎', 'Изменить', 'Исправить текст'),
      createMessageMenuButton('delete', '⌫', 'Удалить', 'Убрать сообщение', true)
    );
  }

  const hint = document.createElement('p');
  hint.className = 'message-action-menu-hint';
  hint.textContent = 'Нажми вне панели или Esc, чтобы закрыть';
  panel.append(header, preview, reactionGroup, actions);
  if (own) panel.append(ownerActions);
  panel.append(hint);
  overlay.append(panel);

  const findMessageNode = () => community
    ? $('#communityMessages')?.querySelector('[data-message-id="' + CSS.escape(String(message.id)) + '"]')
    : messagesList?.querySelector('[data-message-id="' + CSS.escape(String(message.id)) + '"]');

  const runAction = (action) => {
    const row = findMessageNode();
    const selector = community
      ? '[data-action="' + action + '"]'
      : '.message-action[data-action="' + action + '"]';
    const legacyButton = row?.querySelector(selector);
    closeMessageActionMenu(true);
    if (legacyButton) legacyButton.click();
  };
  panel.querySelectorAll('[data-menu-action]').forEach((button) => {
    button.addEventListener('click', () => runAction(button.dataset.menuAction));
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeMessageActionMenu(true);
  });

  const onKeydown = (event) => {
    if (!activeMessageActionMenu || activeMessageActionMenu.overlay !== overlay) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMessageActionMenu(true);
    } else if (event.key === 'Tab') {
      const focusable = [...panel.querySelectorAll('button:not(:disabled)')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const previousBodyOverflow = document.body.style.overflow;
  activeMessageActionMenu = { overlay, trigger, previousBodyOverflow, onKeydown, kind, messageId: message.id };
  document.body.append(overlay);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKeydown, true);
  close.focus({ preventScroll: true });
}

function createMessageNode(message) {
  const mine = Boolean(socket && message.from === socket.id);
  const row = document.createElement('div');
  row.className = `message-row${mine ? ' mine' : ''}`;
  row.dataset.messageId = message.id;

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
  if (message.editedAt) {
    const edited = document.createElement('span');
    edited.className = 'message-edited-label';
    edited.textContent = 'изменено';
    meta.append(edited);
  }
  if (mine && Array.isArray(message.readBy) && message.readBy.length > 0) {
    const read = document.createElement('span');
    read.className = 'message-read-mark';
    read.textContent = '✓✓';
    read.title = 'Прочитано участником комнаты';
    meta.append(read);
  }
  if (pinnedMessage && pinnedMessage.id === message.id) {
    const pin = document.createElement('span');
    pin.className = 'message-pinned-label';
    pin.textContent = 'Закреплено';
    meta.append(pin);
  }

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (message.deleted) {
    bubble.classList.add('message-deleted');
    bubble.textContent = 'Сообщение удалено';
  } else {
    bubble.textContent = message.text || '';
  }
  content.append(meta);

  if (message.replyTo && !message.deleted) {
    const quote = document.createElement('div');
    quote.className = 'message-reply-quote';
    const quoteName = document.createElement('strong');
    quoteName.textContent = message.replyTo.name || 'Участник';
    const quoteText = document.createElement('span');
    quoteText.textContent = message.replyTo.text || 'Сообщение';
    quote.append(quoteName, quoteText);
    content.append(quote);
  }
  content.append(bubble);
  bubble.tabIndex = 0;
  bubble.setAttribute('role', 'button');
  bubble.setAttribute('aria-haspopup', 'dialog');
  bubble.setAttribute('aria-label', 'Открыть действия для сообщения');
  row.addEventListener('click', (event) => {
    if (event.target.closest('button,a,audio,video,input,textarea')) return;
    if (window.getSelection && window.getSelection().toString()) return;
    openMessageActionMenu(message, 'room', bubble);
  });
  row.addEventListener('contextmenu', (event) => {
    if (event.target.closest('button,a,audio,video,input,textarea')) return;
    event.preventDefault();
    openMessageActionMenu(message, 'room', bubble);
  });
  bubble.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMessageActionMenu(message, 'room', bubble);
    }
  });

  if (!message.deleted) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.addEventListener('click',event=>event.stopPropagation());
    actions.append(
      createActionButton('↩', 'Ответить', 'reply', message.id),
      createActionButton('☺', 'Добавить реакцию', 'toggle-reactions', message.id),
      createActionButton(pinnedMessage && pinnedMessage.id === message.id ? '▣' : '⌑',
        pinnedMessage && pinnedMessage.id === message.id ? 'Открепить' : 'Закрепить',
        'pin', message.id)
    );
    if (mine) {
      actions.append(
        createActionButton('✎', 'Изменить сообщение', 'edit', message.id),
        createActionButton('×', 'Удалить сообщение', 'delete', message.id)
      );
    }

    const reactionPicker = document.createElement('div');
    reactionPicker.className = 'message-reaction-picker';
    reactionPicker.hidden = true;
    ['❤️', '👍', '😂', '🔥', '🐱', '🎉'].forEach((emoji) => {
      const reactionButton = document.createElement('button');
      reactionButton.type = 'button';
      reactionButton.className = 'message-reaction-choice';
      reactionButton.textContent = emoji;
      reactionButton.setAttribute('aria-label', 'Поставить реакцию ' + emoji);
      reactionButton.addEventListener('click', () => {
        emitWithAck('chat:react', { messageId: message.id, emoji })
          .then((response) => { if (!response.ok) showToast('Не удалось добавить реакцию.'); })
          .catch((error) => showToast(error.message));
      });
      reactionPicker.append(reactionButton);
    });

    actions.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', async () => {
        const action = button.dataset.action;
        if (action === 'reply') {
          replyTarget = message;
          renderReplyPreview();
          $('#messageInput').focus();
          return;
        }
        if (action === 'toggle-reactions') {
          reactionPicker.hidden = !reactionPicker.hidden;
          return;
        }
        if (action === 'pin') {
          const target = pinnedMessage && pinnedMessage.id === message.id ? '' : message.id;
          try {
            const response = await emitWithAck('chat:pin', { messageId: target });
            if (!response.ok) showToast(response.error || 'Не удалось закрепить сообщение.');
          } catch (error) { showToast(error.message); }
          return;
        }
        if (action === 'edit') {
          const editedText = window.prompt('Измени сообщение:', message.text || '');
          if (editedText === null || !editedText.trim()) return;
          try {
            const response = await emitWithAck('chat:edit', { messageId: message.id, text: editedText });
            if (!response.ok) showToast(response.error || 'Не удалось изменить сообщение.');
          } catch (error) { showToast(error.message); }
          return;
        }
        if (action === 'delete') {
          if (!window.confirm('Удалить это сообщение у всех участников комнаты?')) return;
          try {
            const response = await emitWithAck('chat:delete', { messageId: message.id });
            if (!response.ok) showToast(response.error || 'Не удалось удалить сообщение.');
          } catch (error) { showToast(error.message); }
        }
      });
    });

    const reactions = document.createElement('div');
    reactions.className = 'message-reactions';
    Object.entries(message.reactions || {}).forEach(([emoji, users]) => {
      const count = Array.isArray(users) ? users.length : 0;
      if (!count) return;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'message-reaction-chip' +
        (Array.isArray(users) && socket && users.includes(socket.id) ? ' is-mine' : '');
      chip.textContent = emoji + ' ' + count;
      chip.title = 'Изменить свою реакцию';
      chip.addEventListener('click', () => {
        emitWithAck('chat:react', { messageId: message.id, emoji }).catch((error) => showToast(error.message));
      });
      reactions.append(chip);
    });
    content.append(actions, reactionPicker);
    if (reactions.childElementCount) content.append(reactions);
  }
  row.append(avatar, content);
  return row;
}

function refreshMessageNode(message) {
  const current = messagesList.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  if (!current) return;
  if (activeMessageActionMenu?.kind === 'room' && activeMessageActionMenu.messageId === message.id) closeMessageActionMenu(false);
  current.replaceWith(createMessageNode(message));
}

function renderReplyPreview() {
  const preview = $('#replyPreview');
  if (!preview) return;
  preview.replaceChildren();
  if (!replyTarget) {
    preview.hidden = true;
    return;
  }
  const copy = document.createElement('div');
  copy.className = 'reply-preview-copy';
  const title = document.createElement('strong');
  title.textContent = 'Ответ: ' + (replyTarget.name || 'участник');
  const text = document.createElement('span');
  text.textContent = replyTarget.text || 'Сообщение';
  copy.append(title, text);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'reply-preview-close';
  cancel.textContent = '×';
  cancel.setAttribute('aria-label', 'Отменить ответ');
  cancel.addEventListener('click', () => { replyTarget = null; renderReplyPreview(); });
  preview.append(copy, cancel);
  preview.hidden = false;
}

function renderPinnedMessage() {
  const banner = $('#pinnedMessageBanner');
  if (!banner) return;
  banner.replaceChildren();
  if (!pinnedMessage || pinnedMessage.deleted) {
    banner.hidden = true;
    return;
  }
  const marker = document.createElement('span');
  marker.className = 'pinned-message-marker';
  marker.textContent = '⌑';
  const copy = document.createElement('div');
  copy.className = 'pinned-message-copy';
  const label = document.createElement('strong');
  label.textContent = 'Закреплённое сообщение';
  const text = document.createElement('span');
  text.textContent = (pinnedMessage.name || 'Участник') + ': ' + (pinnedMessage.text || '');
  copy.append(label, text);
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'pinned-message-jump';
  jump.textContent = '↓';
  jump.title = 'Перейти к сообщению';
  jump.addEventListener('click', () => {
    const node = messagesList.querySelector(`[data-message-id="${CSS.escape(pinnedMessage.id)}"]`);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  banner.append(marker, copy, jump);
  banner.hidden = false;
}

function renderTypingIndicator() {
  const indicator = $('#typingIndicator');
  if (!indicator) return;
  const names = [...typingMembers.values()].map((entry) => entry.name);
  indicator.hidden = names.length === 0;
  if (!names.length) return;
  indicator.textContent = names.length === 1
    ? names[0] + ' печатает…'
    : names.slice(0, 2).join(' и ') + (names.length > 2 ? ' и ещё ' + (names.length - 2) : '') + ' печатают…';
}

function markMessagesRead(ids) {
  if (!socket || !socket.connected || !Array.isArray(ids) || !ids.length) return;
  for (let index = 0; index < ids.length; index += 50) {
    socket.emit('chat:read', { messageIds: ids.slice(index, index + 50) });
  }
}

function applyMessageSearch() {
  const query = messageSearchQuery.trim().toLocaleLowerCase('ru-RU');
  messagesList.querySelectorAll('.message-row').forEach((row) => {
    const message = messageRecords.get(row.dataset.messageId);
    const searchable = message ? [message.name, message.text].join(' ').toLocaleLowerCase('ru-RU') : '';
    row.hidden = Boolean(query && !searchable.includes(query));
  });
}

function notifyIncomingMessage(message) {
  if (!notificationsEnabled || !('Notification' in window) ||
      Notification.permission !== 'granted' || !document.hidden ||
      !message || message.from === (socket && socket.id)) return;
  const notification = new Notification(message.name || 'Новое сообщение', {
    body: String(message.text || 'Отправил сообщение').slice(0, 180),
    tag: 'kotomaster-' + message.id
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}


const communityState = {
  tab: 'chats',
  conversations: [],
  friends: [],
  requests: [],
  outgoingRequests: [],
  currentConversationId: null,
  currentConversation: null,
  realtimeChannel: null,
  globalChannel: null,
  searchTimer: null,
  voiceRecorder: null,
  voiceStream: null,
  voiceChunks: [],
  replyTarget: null,
  pinnedMessage: null
};

function updateNotificationsButton() {
  const button=$('#notificationsBtn');
  if(!button) return;
  button.classList.toggle('enabled',notificationsEnabled);
  button.setAttribute('aria-pressed',String(notificationsEnabled));
  button.title=notificationsEnabled?'Отключить уведомления':'Включить уведомления';
}

async function stopCommunityRealtime() {
  if(communityState.globalChannel && supabaseClient) {
    const channel=communityState.globalChannel;
    communityState.globalChannel=null;
    try { await supabaseClient.removeChannel(channel); } catch(_error) {}
  }
  if(communityState.realtimeChannel && supabaseClient) {
    const channel=communityState.realtimeChannel;
    communityState.realtimeChannel=null;
    try { await supabaseClient.removeChannel(channel); } catch(_error) {}
  }
}

async function startCommunityRealtime() {
  if(!supabaseClient || !communityUserId()) {
    await stopCommunityRealtime();
    return;
  }
  if(communityState.globalChannel) {
    const oldChannel=communityState.globalChannel;
    communityState.globalChannel=null;
    await supabaseClient.removeChannel(oldChannel);
  }
  const userId=communityUserId();
  const channel=supabaseClient.channel('kotomaster-inbox-'+userId)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages'},(payload)=>{
      const message=payload.new;
      if(!message || message.sender_id===userId) return;
      loadCommunityConversations().catch((error)=>console.warn('Inbox refresh failed:',error));
      if(document.hidden && notificationsEnabled && 'Notification' in window && Notification.permission==='granted') {
        const conversation=communityState.conversations.find((item)=>item.id===message.conversation_id);
        const title=conversation?.title||'Новое сообщение';
        const body=message.body ? String(message.body).slice(0,120) : 'Тебе отправили вложение';
        try {
          const notification=new Notification('KOTOMASTER · '+title,{body,tag:'kotomaster-'+message.conversation_id});
          notification.onclick=()=>{
            window.focus();
            switchPanel('community');
            setCommunityTab('chats');
            openCommunityConversation(message.conversation_id).catch((error)=>showToast(error.message));
            notification.close();
          };
        } catch(error) { console.warn('Notification failed:',error); }
      }
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'friendships'},()=>{
      loadCommunityFriends().catch((error)=>console.warn('Friend list refresh failed:',error));
      loadCommunityConversations().catch((error)=>console.warn('Conversation refresh failed:',error));
    })
    .subscribe();
  communityState.globalChannel=channel;
}

function communityUserId() {
  return authSession?.user?.id || null;
}


async function openGroupManage(){
  const conversation=communityState.currentConversation;
  if(!conversation||conversation.kind!=='group')return;
  $('#groupManageError').textContent='';
  $('#groupManageModal').hidden=false;
  await renderGroupManageMembers();
}
async function renderGroupManageMembers(){
  const conversation=communityState.currentConversation;
  const list=$('#groupManageMembers');
  list.replaceChildren(communityNode('p','community-empty-note','Загружаем участников…'));
  if(!conversation)return;
  const {data:members,error}=await supabaseClient.from('conversation_members')
    .select('user_id,role').eq('conversation_id',conversation.id);
  if(error)throw error;
  const profiles=await fetchCommunityProfiles((members||[]).map(m=>m.user_id));
  const names=new Map(profiles.map(p=>[p.id,p.display_name||p.username||'Пользователь']));
  const myMember=(members||[]).find(m=>m.user_id===communityUserId());
  const isOwner=myMember?.role==='owner';
  const isAdmin=['owner','admin'].includes(myMember?.role);
  list.replaceChildren();
  (members||[]).forEach(member=>{
    const row=communityNode('div','group-manage-row');
    const copy=communityNode('div','group-manage-copy');
    copy.append(communityNode('strong','',member.user_id===communityUserId()?'Ты':names.get(member.user_id)||'Пользователь'));
    copy.append(communityNode('small','',member.role==='owner'?'Владелец':member.role==='admin'?'Администратор':'Участник'));
    row.append(copy);
    if(member.user_id!==communityUserId() && member.role!=='owner'){
      if(isOwner){
        const roleButton=communityNode('button','community-message-action',member.role==='admin'?'Снять админа':'Назначить админом');
        roleButton.type='button';
        roleButton.addEventListener('click',async()=>{
          try{const {error}=await supabaseClient.rpc('manage_group_role',{p_conversation_id:conversation.id,p_user_id:member.user_id,p_make_admin:member.role!=='admin'});if(error)throw error;await renderGroupManageMembers();showToast('Роль обновлена.');}
          catch(error){$('#groupManageError').textContent=error.message;}
        });
        row.append(roleButton);
      }
      if(isAdmin && member.role==='member'){
        const muteButton=communityNode('button','community-message-action','Мут 10 мин');
        muteButton.type='button';
        muteButton.addEventListener('click',async()=>{
          try{const {error}=await supabaseClient.rpc('mute_group_member',{p_conversation_id:conversation.id,p_user_id:member.user_id,p_duration_minutes:10});if(error)throw error;showToast('Участник временно не может отправлять сообщения.');}
          catch(error){$('#groupManageError').textContent=error.message;}
        });
        row.append(muteButton);
        const unmuteButton=communityNode('button','community-message-action','Снять мут');
        unmuteButton.type='button';
        unmuteButton.addEventListener('click',async()=>{
          try{const {error}=await supabaseClient.rpc('unmute_group_member',{p_conversation_id:conversation.id,p_user_id:member.user_id});if(error)throw error;showToast('Ограничение снято, если оно было активно.');}
          catch(error){$('#groupManageError').textContent=error.message;}
        });
        row.append(unmuteButton);
        const longMute=communityNode('button','community-message-action','На 1 час');
        longMute.type='button';
        longMute.addEventListener('click',async()=>{
          try{const {error}=await supabaseClient.rpc('mute_group_member',{p_conversation_id:conversation.id,p_user_id:member.user_id,p_duration_minutes:60});if(error)throw error;showToast('Ограничение на 1 час установлено.');}
          catch(error){$('#groupManageError').textContent=error.message;}
        });
        row.append(longMute);
        const remove=communityNode('button','community-message-action is-danger','Удалить');
        remove.type='button';
        remove.addEventListener('click',async()=>{
          if(!window.confirm('Удалить участника из группы?'))return;
          try{const {error}=await supabaseClient.rpc('remove_group_member',{p_conversation_id:conversation.id,p_user_id:member.user_id});if(error)throw error;await renderGroupManageMembers();showToast('Участник удалён.');}
          catch(error){$('#groupManageError').textContent=error.message;}
        });
        row.append(remove);
      }
    }
    list.append(row);
  });
}

function setCommunityTab(tab) {
  communityState.tab = ['chats','friends','groups'].includes(tab) ? tab : 'chats';
  document.querySelectorAll('.community-tab').forEach((button) =>
    button.classList.toggle('active', button.dataset.communityTab === communityState.tab)
  );
  $('#communityChatsPanel').hidden = communityState.tab !== 'chats';
  $('#communityFriendsPanel').hidden = communityState.tab !== 'friends';
  $('#communityGroupsPanel').hidden = communityState.tab !== 'groups';
  $('#communityChatTitle').textContent = 'Чаты';
  refreshCommunity();
}

function communityNode(tag, className, textValue) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textValue !== undefined && textValue !== null) node.textContent = String(textValue);
  return node;
}

async function fetchCommunityProfiles(ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length) return [];
  const { data, error } = await supabaseClient.from('profiles')
    .select('id,username,display_name,avatar_path,bio')
    .in('id', uniqueIds);
  if (error) throw error;
  return data || [];
}

function renderCommunityLoading(container, message) {
  container.replaceChildren(communityNode('p','community-empty-note',message));
}

async function loadCommunityFriends() {
  const userId = communityUserId();
  if (!userId) return;
  const { data, error } = await supabaseClient.from('friendships')
    .select('id,requester_id,addressee_id,status,created_at')
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .order('created_at',{ascending:false});
  if (error) throw error;
  const rows = data || [];
  const otherIds = rows.map((row) => row.requester_id === userId ? row.addressee_id : row.requester_id);
  const profiles = await fetchCommunityProfiles(otherIds);
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));
  communityState.friends = rows.filter((row) => row.status === 'accepted').map((row) => {
    const otherId = row.requester_id === userId ? row.addressee_id : row.requester_id;
    return { ...row, userId: otherId, profile: profileMap.get(otherId) || { display_name: 'Пользователь' } };
  });
  communityState.requests = rows.filter((row) => row.status === 'pending' && row.addressee_id === userId).map((row) => ({
    ...row,
    userId: row.requester_id,
    profile: profileMap.get(row.requester_id) || { display_name: 'Пользователь' }
  }));
  communityState.outgoingRequests = rows.filter((row) => row.status === 'pending' && row.requester_id === userId).map((row) => ({
    ...row,
    userId: row.addressee_id,
    profile: profileMap.get(row.addressee_id) || { display_name: 'Пользователь' }
  }));
  renderFriendLists();
  renderGroupMemberChoices();
}

function renderFriendLists() {
  const searchResults = $('#friendSearchResults');
  if (searchResults && !searchResults.dataset.keep) searchResults.replaceChildren();
  const requestList = $('#friendRequestsList');
  requestList.replaceChildren();
  if (!communityState.requests.length) {
    requestList.append(communityNode('p','community-empty-note','Новых заявок пока нет.'));
  } else {
    communityState.requests.forEach((request) => {
      const item = communityNode('div','community-person-item');
      const copy = communityNode('div','community-person-copy');
      copy.append(communityNode('strong','',request.profile.display_name || 'Пользователь'));
      copy.append(communityNode('small','',request.profile.username ? '@'+request.profile.username : 'Хочет добавить тебя в друзья'));
      const actions = communityNode('div','community-person-actions');
      const accept = communityNode('button','community-small-action is-primary','Принять');
      accept.type='button';
      accept.addEventListener('click',()=>respondToFriendRequest(request.id,'accepted'));
      const decline = communityNode('button','community-small-action','Отклонить');
      decline.type='button';
      decline.addEventListener('click',()=>respondToFriendRequest(request.id,'declined'));
      actions.append(accept,decline); item.append(copy,actions); requestList.append(item);
    });
  }
  const friendList = $('#friendList');
  friendList.replaceChildren();
  if (!communityState.friends.length) {
    friendList.append(communityNode('p','community-empty-note','Здесь появятся принятые друзья.'));
  } else {
    communityState.friends.forEach((friend) => {
      const item=communityNode('div','community-person-item');
      const copy=communityNode('div','community-person-copy');
      copy.append(communityNode('strong','',friend.profile.display_name || 'Пользователь'));
      copy.append(communityNode('small','',friend.profile.username ? '@'+friend.profile.username : 'Друг'));
      const button=communityNode('button','community-small-action is-primary','Написать');
      button.type='button';
      button.addEventListener('click',()=>openDirectConversation(friend.userId));
      item.append(copy,button); friendList.append(item);
    });
  }
}

async function searchCommunityUsers(value) {
  const results=$('#friendSearchResults');
  results.replaceChildren();
  const query=String(value||'').trim().replace(/^@/,'').replace(/[^a-zA-Z0-9_а-яА-ЯёЁ -]/g,'').slice(0,32);
  if (query.length < 2) return;
  renderCommunityLoading(results,'Ищем пользователей…');
  const safe=query.replace(/[%_,().]/g,' ').trim();
  const {data,error}=await supabaseClient.from('profiles')
    .select('id,username,display_name')
    .neq('id',communityUserId())
    .or(`username.ilike.%${safe}%,display_name.ilike.%${safe}%`)
    .limit(12);
  results.replaceChildren();
  if(error) { results.append(communityNode('p','community-empty-note','Не удалось выполнить поиск: '+error.message)); return; }
  const known=new Map();
  communityState.friends.forEach((f)=>known.set(f.userId,'accepted'));
  communityState.requests.forEach((f)=>known.set(f.userId,'incoming'));
  communityState.outgoingRequests.forEach((f)=>known.set(f.userId,'outgoing'));
  if(!data?.length) { results.append(communityNode('p','community-empty-note','Никого не нашли. Проверь имя или username.')); return; }
  data.forEach((profile)=>{
    const item=communityNode('div','community-person-item');
    const copy=communityNode('div','community-person-copy');
    copy.append(communityNode('strong','',profile.display_name||'Пользователь'));
    copy.append(communityNode('small','',profile.username?'@'+profile.username:'Пользователь KOTOMASTER'));
    const knownStatus=known.get(profile.id);
    const button=communityNode('button','community-small-action',knownStatus==='accepted'?'Друг':knownStatus==='incoming'?'Заявка получена':knownStatus==='outgoing'?'Заявка отправлена':'Добавить');
    button.type='button';
    button.disabled=Boolean(knownStatus);
    if(!knownStatus) button.addEventListener('click',()=>sendFriendRequest(profile.id,button));
    item.append(copy,button); results.append(item);
  });
}

async function sendFriendRequest(friendId,button) {
  if(!communityUserId() || !friendId || friendId===communityUserId()) return;
  button.disabled=true;
  try {
    const {data,error}=await supabaseClient.rpc('request_friendship',{p_friend_id:friendId});
    if(error) throw error;
    if(data==='accepted') {
      button.textContent='Друг';
      button.disabled=true;
      showToast('Вы теперь друзья.');
      await loadCommunityFriends();
      await loadCommunityConversations();
      return;
    }
    button.textContent='Заявка отправлена';
    button.disabled=true;
    await loadCommunityFriends();
    showToast('Заявка в друзья отправлена.');
  } catch(error) {
    button.disabled=false;
    showToast('Не удалось отправить заявку: '+error.message);
  }
}

async function respondToFriendRequest(requestId,status) {
  try {
    const {data,error}=await supabaseClient.from('friendships')
      .update({status,updated_at:new Date().toISOString()})
      .eq('id',requestId).eq('addressee_id',communityUserId()).eq('status','pending')
      .select('id');
    if(error) throw error;
    if(!data?.length) throw new Error('Заявка уже обработана.');
    await loadCommunityFriends();
    await loadCommunityConversations();
    showToast(status==='accepted'?'Заявка принята.':'Заявка отклонена.');
  } catch(error) { showToast('Не удалось обработать заявку: '+error.message); }
}

async function loadCommunityConversations() {
  const userId=communityUserId();
  if(!userId) return;
  const {data:members,error:memberError}=await supabaseClient.from('conversation_members')
    .select('conversation_id,role,last_read_at,joined_at')
    .eq('user_id',userId);
  if(memberError) throw memberError;
  const ids=(members||[]).map((m)=>m.conversation_id);
  if(!ids.length) {
    communityState.conversations=[];
    renderCommunityConversations();
    return;
  }
  const [convResult,memberResult,messageResult]=await Promise.all([
    supabaseClient.from('conversations').select('id,kind,title,created_at,updated_at').in('id',ids),
    supabaseClient.from('conversation_members').select('conversation_id,user_id,role').in('conversation_id',ids).neq('user_id',userId),
    supabaseClient.from('messages').select('id,conversation_id,body,sender_id,created_at').in('conversation_id',ids).order('created_at',{ascending:false}).limit(250)
  ]);
  if(convResult.error) throw convResult.error;
  if(memberResult.error) throw memberResult.error;
  if(messageResult.error) throw messageResult.error;
  const others=memberResult.data||[];
  const profiles=await fetchCommunityProfiles(others.map((m)=>m.user_id));
  const profileMap=new Map(profiles.map((p)=>[p.id,p]));
  const convMap=new Map((convResult.data||[]).map((c)=>[c.id,c]));
  const lastMessages=new Map();
  (messageResult.data||[]).forEach((m)=>{
    if(!lastMessages.has(m.conversation_id)) lastMessages.set(m.conversation_id,m);
  });
  communityState.conversations=(members||[]).map((member)=>{
    const conv=convMap.get(member.conversation_id);
    if(!conv) return null;
    const otherMembers=others.filter((m)=>m.conversation_id===conv.id);
    const names=otherMembers.map((m)=>profileMap.get(m.user_id)?.display_name||'Пользователь');
    const title=conv.kind==='group'?(conv.title||'Группа'):(names[0]||'Личный чат');
    const last=lastMessages.get(conv.id);
    return {...conv,title,otherMembers,lastMessage:last||null,sortAt:last?.created_at||conv.updated_at};
  }).filter(Boolean).sort((a,b)=>Date.parse(b.sortAt||0)-Date.parse(a.sortAt||0));
  renderCommunityConversations();
}

function renderCommunityConversations() {
  const chats=$('#communityConversationList');
  const groups=$('#communityGroupsList');
  chats.replaceChildren();
  groups.replaceChildren();
  const conversations=communityState.conversations;
  if(!conversations.length) chats.append(communityNode('p','community-empty-note','Пока нет переписок. Добавь друга, чтобы начать.'));
  conversations.forEach((conversation)=>{
    const isSelected=conversation.id===communityState.currentConversationId;
    const item=communityNode('button','community-conversation-item'+(isSelected?' is-selected':''));
    item.type='button';
    item.addEventListener('click',()=>openCommunityConversation(conversation.id));
    const icon=communityNode('span','community-conversation-avatar',conversation.kind==='group'?'#':(conversation.title||'К').slice(0,1).toUpperCase());
    const content=communityNode('span','community-conversation-copy');
    content.append(communityNode('strong','',conversation.title));
    const last=conversation.lastMessage;
    content.append(communityNode('small','',last?(last.body||'Вложение').slice(0,70):'Начни общение'));
    item.append(icon,content);
    chats.append(item);
    if(conversation.kind==='group') {
      const groupItem=item.cloneNode(true);
      groupItem.addEventListener('click',()=>openCommunityConversation(conversation.id));
      groups.append(groupItem);
    }
  });
  if(!groups.children.length) groups.append(communityNode('p','community-empty-note','Групповых чатов пока нет.'));
}

function renderCommunityMessages(rows,profiles,attachments=[],reactions=[],readThrough=0) {
  if (activeMessageActionMenu?.kind === 'community') closeMessageActionMenu(false);
  const list=$('#communityMessages');
  list.replaceChildren();
  if(!rows.length) {
    list.append(communityNode('p','community-empty-note','Сообщений пока нет. Напиши первым.'));
    return;
  }
  const names=new Map((profiles||[]).map((p)=>[p.id,p.display_name||'Пользователь']));
  const reactionMap=new Map();
  (reactions||[]).forEach((reaction)=>{
    if(!reactionMap.has(reaction.message_id)) reactionMap.set(reaction.message_id,[]);
    reactionMap.get(reaction.message_id).push(reaction);
  });
  const messageMap=new Map(rows.map((message)=>[message.id,message]));
  rows.forEach((message)=>{
    const own=message.sender_id===communityUserId();
    const item=communityNode('article','community-message'+(own?' is-own':''));
    item.dataset.messageId=message.id;
    const header=communityNode('div','community-message-header');
    header.append(communityNode('strong','',own?'Ты':(names.get(message.sender_id)||'Пользователь')));
    const date=new Date(message.created_at);
    header.append(communityNode('time','',date.toLocaleString('ru-RU',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'short'})));
    if(own && readThrough && Date.parse(message.created_at)<=readThrough) {
      header.append(communityNode('span','community-read-indicator','✓✓ Прочитано'));
    }
    if(message.reply_to) {
      const replied=messageMap.get(message.reply_to);
      const quote=communityNode('div','community-message-reply',replied?(replied.body||'Сообщение удалено'):'Ответ на сообщение');
      if(replied && replied.sender_id) quote.prepend(communityNode('strong','',names.get(replied.sender_id)||'Пользователь'));
      item.append(quote);
    }
    const body=communityNode('p','',message.deleted_at?'Сообщение удалено':message.body);
    if(message.edited_at && !message.deleted_at) body.append(communityNode('small','community-edited',' · изменено'));
    item.append(header,body);
    const messageAttachments=(attachments||[]).filter((attachment)=>attachment.message_id===message.id);
    messageAttachments.forEach((attachment)=>{
      if(!attachment.signedUrl) return;
      const mime=attachment.mime_type||'';
      if(mime.startsWith('image/')) {
        const link=communityNode('a','community-attachment-link');
        link.href=attachment.signedUrl; link.target='_blank'; link.rel='noopener noreferrer';
        const image=document.createElement('img');
        image.src=attachment.signedUrl; image.alt=attachment.file_name||'Изображение'; image.loading='lazy';
        link.append(image); item.append(link);
      } else if(mime.startsWith('audio/')) {
        const audio=document.createElement('audio');
        audio.controls=true; audio.preload='metadata'; audio.src=attachment.signedUrl;
        audio.className='community-attachment-audio'; item.append(audio);
      } else if(mime.startsWith('video/')) {
        const video=document.createElement('video');
        video.controls=true; video.preload='metadata'; video.src=attachment.signedUrl;
        video.className='community-attachment-video'; item.append(video);
      }
      const link=communityNode('a','community-file-link',attachment.file_name||'Скачать файл');
      link.href=attachment.signedUrl; link.target='_blank'; link.rel='noopener noreferrer';
      item.append(link);
    });
    const reactionRows=message.deleted_at?[]:(reactionMap.get(message.id)||[]);
    if(reactionRows.length) {
      const reactionBar=communityNode('div','community-reactions');
      const heartCount=reactionRows.filter((reaction)=>reaction.emoji==='❤️').length;
      if(heartCount) {
        const heart=communityNode('span','community-reaction-chip',`❤️ ${heartCount}`);
        reactionBar.append(heart);
      }
      item.append(reactionBar);
    }
    const actions=communityNode('div','community-message-actions');
    const replyButton=communityNode('button','community-message-action','↩ Ответить');
    replyButton.type='button';
    replyButton.dataset.action='reply';
    replyButton.addEventListener('click',()=>setCommunityReply(message));
    actions.append(replyButton);
    if(!message.deleted_at) {
      const reactionButton=communityNode('button','community-message-action','❤️');
      reactionButton.type='button'; reactionButton.title='Поставить реакцию';
      reactionButton.dataset.action='react';
      reactionButton.addEventListener('click',()=>toggleCommunityReaction(message.id,'❤️'));
      actions.append(reactionButton);
      const pinButton=communityNode('button','community-message-action',communityState.pinnedMessage?.message_id===message.id?'📌 Снять':'📌 Закрепить');
      pinButton.type='button';
      pinButton.dataset.action='pin';
      pinButton.addEventListener('click',()=>toggleCommunityPin(message.id));
      actions.append(pinButton);
    }
    if(own && !message.deleted_at) {
      const editButton=communityNode('button','community-message-action','Изменить');
      editButton.type='button'; editButton.dataset.action='edit'; editButton.addEventListener('click',()=>editCommunityMessage(message));
      const deleteButton=communityNode('button','community-message-action is-danger','Удалить');
      deleteButton.type='button'; deleteButton.dataset.action='delete'; deleteButton.addEventListener('click',()=>deleteCommunityMessage(message));
      actions.append(editButton,deleteButton);
    }
    item.append(actions);
    item.tabIndex = message.deleted_at ? -1 : 0;
    if (!message.deleted_at) {
      item.setAttribute('aria-haspopup', 'dialog');
      item.setAttribute('aria-label', 'Открыть действия для сообщения');
      item.addEventListener('click', (event) => {
        if (event.target.closest('button,a,audio,video,input,textarea')) return;
        if (window.getSelection && window.getSelection().toString()) return;
        openMessageActionMenu(message, 'community', item);
      });
      item.addEventListener('contextmenu', (event) => {
        if (event.target.closest('button,a,audio,video,input,textarea')) return;
        event.preventDefault();
        openMessageActionMenu(message, 'community', item);
      });
      item.addEventListener('keydown', (event) => {
        if (event.target !== item) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openMessageActionMenu(message, 'community', item);
        }
      });
    }
    list.append(item);
  });
  list.scrollTop=list.scrollHeight;
  renderCommunityPinnedBanner(rows);
}

async function loadCommunityMessages(conversationId) {
  const {data,error}=await supabaseClient.from('messages')
    .select('id,sender_id,body,reply_to,edited_at,deleted_at,created_at')
    .eq('conversation_id',conversationId)
    .order('created_at',{ascending:true})
    .limit(150);
  if(error) throw error;
  const rows=data||[];
  const profiles=await fetchCommunityProfiles(rows.map((m)=>m.sender_id));
  const {data:readers,error:readersError}=await supabaseClient.from('conversation_members')
    .select('user_id,last_read_at').eq('conversation_id',conversationId).neq('user_id',communityUserId());
  if(readersError) throw readersError;
  const readTimestamps=(readers||[]).map((reader)=>reader.last_read_at?Date.parse(reader.last_read_at):0);
  const readThrough=readTimestamps.length&&readTimestamps.every((timestamp)=>timestamp>0)?Math.min(...readTimestamps):0;
  let attachments=[];
  if(rows.length) {
    const {data:attachmentRows,error:attachmentError}=await supabaseClient.from('conversation_attachments')
      .select('id,message_id,bucket_id,object_path,file_name,mime_type,size_bytes')
      .eq('conversation_id',conversationId)
      .in('message_id',rows.map((m)=>m.id));
    if(attachmentError) throw attachmentError;
    attachments=await Promise.all((attachmentRows||[]).map(async(attachment)=>{
      const {data:signed,error:signedError}=await supabaseClient.storage
        .from(attachment.bucket_id).createSignedUrl(attachment.object_path,3600);
      return {...attachment,signedUrl:signedError?null:signed?.signedUrl||null};
    }));
  }
  let reactions=[];
  if(rows.length) {
    const {data:reactionRows,error:reactionError}=await supabaseClient.from('message_reactions')
      .select('message_id,user_id,emoji')
      .in('message_id',rows.map((m)=>m.id));
    if(reactionError) throw reactionError;
    reactions=reactionRows||[];
  }
  const {data:pin,error:pinError}=await supabaseClient.from('conversation_pins')
    .select('conversation_id,message_id,pinned_by,pinned_at')
    .eq('conversation_id',conversationId).maybeSingle();
  if(pinError) throw pinError;
  communityState.pinnedMessage=pin||null;
  renderCommunityMessages(rows,profiles,attachments,reactions,readThrough);
}


function renderCommunityPinnedBanner(rows=[]) {
  const banner=$('#communityPinnedBanner');
  const pinned=communityState.pinnedMessage;
  banner.replaceChildren();
  banner.hidden=!pinned;
  if(!pinned) return;
  const message=(rows||[]).find((row)=>row.id===pinned.message_id);
  banner.append(communityNode('strong','', 'Закреплённое сообщение'));
  banner.append(communityNode('span','',message?.body||'Нажми, чтобы перейти к сообщению'));
  banner.onclick=()=>{
    const target=$('#communityMessages').querySelector(`[data-message-id="${pinned.message_id}"]`);
    if(target) target.scrollIntoView({behavior:'smooth',block:'center'});
  };
}

function setCommunityReply(message) {
  communityState.replyTarget=message;
  const preview=$('#communityReplyPreview');
  preview.replaceChildren();
  preview.hidden=false;
  const copy=communityNode('div','community-reply-copy');
  copy.append(communityNode('strong','',message.sender_id===communityUserId()?'Ты':communityState.currentConversation?.title||'Ответ'));
  copy.append(communityNode('span','',(message.body||'Сообщение').slice(0,100)));
  const close=communityNode('button','community-reply-close','×');
  close.type='button'; close.addEventListener('click',clearCommunityReply);
  preview.append(copy,close);
  $('#communityMessageInput').focus();
}

function clearCommunityReply() {
  communityState.replyTarget=null;
  const preview=$('#communityReplyPreview');
  preview.hidden=true; preview.replaceChildren();
}

async function toggleCommunityReaction(messageId,emoji) {
  const userId=communityUserId();
  try {
    const {data,error}=await supabaseClient.from('message_reactions')
      .select('message_id').eq('message_id',messageId).eq('user_id',userId).eq('emoji',emoji);
    if(error) throw error;
    if(data?.length) {
      const {error:deleteError}=await supabaseClient.from('message_reactions').delete()
        .eq('message_id',messageId).eq('user_id',userId).eq('emoji',emoji);
      if(deleteError) throw deleteError;
    } else {
      const {error:insertError}=await supabaseClient.from('message_reactions')
        .insert({message_id:messageId,user_id:userId,emoji});
      if(insertError) throw insertError;
    }
    captureProductEvent('message_reaction_toggled', { chat_type: 'community' });
    await loadCommunityMessages(communityState.currentConversationId);
  } catch(error) { showToast('Не удалось поставить реакцию: '+error.message); }
}

async function toggleCommunityPin(messageId) {
  const conversationId=communityState.currentConversationId;
  const wasPinned=communityState.pinnedMessage?.message_id===messageId;
  try {
    if(wasPinned) {
      const {error}=await supabaseClient.from('conversation_pins').delete().eq('conversation_id',conversationId);
      if(error) throw error;
      showToast('Закрепление снято.');
    } else {
      if(communityState.pinnedMessage) {
        const {error:deleteError}=await supabaseClient.from('conversation_pins').delete().eq('conversation_id',conversationId);
        if(deleteError) throw deleteError;
      }
      const {error}=await supabaseClient.from('conversation_pins').insert({
        conversation_id:conversationId,message_id:messageId,pinned_by:communityUserId()
      });
      if(error) throw error;
      showToast('Сообщение закреплено.');
    }
    captureProductEvent('message_pin_changed', {
      chat_type: 'community',
      pinned: !wasPinned
    });
    await loadCommunityMessages(conversationId);
  } catch(error) { showToast('Не удалось закрепить: '+error.message); }
}

async function editCommunityMessage(message) {
  const updated=window.prompt('Измени сообщение',message.body||'');
  if(updated===null) return;
  const body=updated.trim();
  if(!body) { showToast('Сообщение не может быть пустым.'); return; }
  try {
    const {error}=await supabaseClient.from('messages')
      .update({body,edited_at:new Date().toISOString()})
      .eq('id',message.id).eq('sender_id',communityUserId());
    if(error) throw error;
    await loadCommunityMessages(communityState.currentConversationId);
  } catch(error) { showToast('Не удалось изменить сообщение: '+error.message); }
}

async function deleteCommunityMessage(message) {
  if(!window.confirm('Удалить это сообщение и прикреплённые файлы?')) return;
  try {
    const {data:attachments,error:attachmentError}=await supabaseClient.from('conversation_attachments')
      .select('id,bucket_id,object_path')
      .eq('message_id',message.id).eq('uploader_id',communityUserId());
    if(attachmentError) throw attachmentError;
    const byBucket=new Map();
    (attachments||[]).forEach((attachment)=>{
      if(!byBucket.has(attachment.bucket_id)) byBucket.set(attachment.bucket_id,[]);
      byBucket.get(attachment.bucket_id).push(attachment.object_path);
    });
    for(const [bucket,paths] of byBucket) {
      const {error:storageError}=await supabaseClient.storage.from(bucket).remove(paths);
      if(storageError) throw storageError;
    }
    if(attachments?.length) {
      const {error:metaError}=await supabaseClient.from('conversation_attachments')
        .delete().eq('message_id',message.id).eq('uploader_id',communityUserId());
      if(metaError) throw metaError;
    }
    await supabaseClient.from('conversation_pins').delete()
      .eq('conversation_id',communityState.currentConversationId).eq('message_id',message.id);
    const {error}=await supabaseClient.from('messages')
      .update({body:'',deleted_at:new Date().toISOString()})
      .eq('id',message.id).eq('sender_id',communityUserId());
    if(error) throw error;
    await loadCommunityMessages(communityState.currentConversationId);
  } catch(error) { showToast('Не удалось удалить сообщение: '+error.message); }
}

async function openCommunityConversation(conversationId) {
  const conversation=communityState.conversations.find((c)=>c.id===conversationId);
  if(!conversation) return;
  captureProductEvent('conversation_opened', { chat_type: conversation.kind === 'group' ? 'group' : 'direct' });
  communityState.currentConversationId=conversationId;
  communityState.currentConversation=conversation;
  $('#communityEmpty').hidden=true;
  $('#communityActiveChat').hidden=false;
  $('#communityChatTitle').textContent=conversation.title;
  $('#communityChatSubtitle').textContent=conversation.kind==='group'?'Групповая переписка':'Личные сообщения';
  $('#manageGroupBtn').hidden=conversation.kind!=='group';
  renderCommunityConversations();
  renderCommunityLoading($('#communityMessages'),'Загружаем историю переписки…');
  if(communityState.realtimeChannel) await supabaseClient.removeChannel(communityState.realtimeChannel);
  try {
    await loadCommunityMessages(conversationId);
    communityState.realtimeChannel=supabaseClient.channel('kotomaster-conversation-'+conversationId)
      .on('postgres_changes',{event:'*',schema:'public',table:'messages',filter:`conversation_id=eq.${conversationId}`},async()=> {
        try {
          await loadCommunityMessages(conversationId);
          await loadCommunityConversations();
          if(!document.hidden) await supabaseClient.from('conversation_members')
            .update({last_read_at:new Date().toISOString()})
            .eq('conversation_id',conversationId).eq('user_id',communityUserId());
        } catch(error) { console.warn('Realtime chat refresh failed:',error); }
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'conversation_attachments',filter:`conversation_id=eq.${conversationId}`},()=>loadCommunityMessages(conversationId).catch((error)=>console.warn(error)))
      .on('postgres_changes',{event:'*',schema:'public',table:'message_reactions'},()=>loadCommunityMessages(conversationId).catch((error)=>console.warn(error)))
      .on('postgres_changes',{event:'*',schema:'public',table:'conversation_pins',filter:`conversation_id=eq.${conversationId}`},()=>loadCommunityMessages(conversationId).catch((error)=>console.warn(error)))
      .on('postgres_changes',{event:'*',schema:'public',table:'conversation_members',filter:`conversation_id=eq.${conversationId}`},()=>loadCommunityMessages(conversationId).catch((error)=>console.warn(error)))
      .subscribe();
    await supabaseClient.from('conversation_members')
      .update({last_read_at:new Date().toISOString()})
      .eq('conversation_id',conversationId).eq('user_id',communityUserId());
  } catch(error) {
    renderCommunityLoading($('#communityMessages'),'Не удалось загрузить чат: '+error.message);
  }
}

async function openDirectConversation(friendId) {
  try {
    const {data,error}=await supabaseClient.rpc('create_direct_conversation',{p_friend_id:friendId});
    if(error) throw error;
    await loadCommunityConversations();
    setCommunityTab('chats');
    await openCommunityConversation(data);
  } catch(error) {
    showToast('Не удалось открыть чат: '+error.message);
  }
}

function renderGroupMemberChoices() {
  const list=$('#newGroupMembers');
  if(!list) return;
  list.replaceChildren();
  if(!communityState.friends.length) {
    list.append(communityNode('p','community-empty-note','Сначала добавь друзей.'));
    return;
  }
  communityState.friends.forEach((friend)=>{
    const label=communityNode('label','community-group-member');
    const checkbox=document.createElement('input');
    checkbox.type='checkbox'; checkbox.value=friend.userId;
    label.append(checkbox,communityNode('span','',friend.profile.display_name||'Пользователь'));
    list.append(label);
  });
}

async function createCommunityGroup(event) {
  event.preventDefault();
  const title=$('#newGroupTitle').value.trim();
  const memberIds=[...$('#newGroupMembers').querySelectorAll('input:checked')].map((input)=>input.value);
  if(memberIds.length===0) { $('#newGroupError').textContent='Выбери хотя бы одного друга.'; return; }
  const button=$('#newGroupForm').querySelector('button[type="submit"]');
  setBusy(button,true,'Создаём группу…');
  try {
    const {data,error}=await supabaseClient.rpc('create_group_conversation',{p_title:title,p_member_ids:memberIds});
    if(error) throw error;
    captureProductEvent('group_created', { member_count: memberIds.length + 1 });
    $('#newGroupModal').hidden=true;
    $('#newGroupForm').reset();
    await loadCommunityConversations();
    setCommunityTab('groups');
    await openCommunityConversation(data);
    showToast('Группа создана.');
  } catch(error) {
    $('#newGroupError').textContent=error.message||'Не удалось создать группу.';
  } finally { setBusy(button,false); }
}

async function uploadCommunityFile(file) {
  const conversationId=communityState.currentConversationId;
  const userId=communityUserId();
  if(!conversationId||!userId||!file) throw new Error('Сначала открой переписку.');
  const maxBytes=50*1024*1024;
  if(file.size>maxBytes) throw new Error('Файл больше 50 МБ. Выбери файл поменьше.');
  const safeName=String(file.name||'file').replace(/[^\p{L}\p{N}._-]/gu,'_').slice(-90)||'file';
  const unique=(window.crypto?.randomUUID?.()||String(Date.now()));
  const objectPath=`${conversationId}/${userId}/${unique}-${safeName}`;
  let uploaded=false;
  let messageId=null;
  try {
    const contentType=String(file.type||'application/octet-stream').split(';')[0];
    const allowedTypes=new Set([
      'image/jpeg','image/png','image/webp','image/gif',
      'video/mp4','video/webm',
      'audio/webm','audio/ogg','audio/mpeg','audio/mp4',
      'application/pdf','text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]);
    if(!allowedTypes.has(contentType)) throw new Error('Этот тип файла не поддерживается. Отправь изображение, видео, аудио, PDF, TXT, DOCX или XLSX.');
    const {error:uploadError}=await supabaseClient.storage.from('chat-files').upload(objectPath,file,{
      cacheControl:'3600',contentType,upsert:false
    });
    if(uploadError) throw uploadError;
    uploaded=true;
    const messageType=contentType.startsWith('image/')?'image':
      contentType.startsWith('video/')?'video':
      contentType.startsWith('audio/')?(String(file.name||'').startsWith('voice-')?'voice':'audio'):'file';
    const {data:message,error:messageError}=await supabaseClient.from('messages')
      .insert({conversation_id:conversationId,sender_id:userId,body:`Файл: ${file.name||safeName}`,message_type:messageType})
      .select('id').single();
    if(messageError) throw messageError;
    messageId=message.id;
    const {error:metadataError}=await supabaseClient.from('conversation_attachments').insert({
      conversation_id:conversationId,message_id:messageId,uploader_id:userId,
      bucket_id:'chat-files',object_path:objectPath,file_name:String(file.name||safeName).slice(0,180),
      mime_type:contentType,size_bytes:file.size
    });
    if(metadataError) throw metadataError;
    await loadCommunityMessages(conversationId);
    await loadCommunityConversations();
  } catch(error) {
    if(uploaded) {
      try { await supabaseClient.storage.from('chat-files').remove([objectPath]); } catch(_cleanupError) {}
    }
    if(messageId) {
      try { await supabaseClient.from('messages').delete().eq('id',messageId).eq('sender_id',userId); } catch(_cleanupError) {}
    }
    throw error;
  }
}

async function handleCommunityFiles(files) {
  if(!files?.length) return;
  const list=[...files];
  for(const file of list) {
    try {
      showToast(`Загружаю: ${file.name}`);
      await uploadCommunityFile(file);
    } catch(error) {
      showToast(`Не удалось отправить ${file.name}: ${error.message}`);
      break;
    }
  }
}

async function toggleCommunityVoiceRecording() {
  const button=$('#communityVoiceBtn');
  if(communityState.voiceRecorder && communityState.voiceRecorder.state==='recording') {
    button.disabled=true;
    button.textContent='…';
    communityState.voiceRecorder.stop();
    return;
  }
  if(!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder==='undefined') {
    showToast('Запись голоса не поддерживается этим браузером.');
    return;
  }
  if(!communityState.currentConversationId) {
    showToast('Сначала открой личный или групповой чат.');
    return;
  }
  try {
    const stream=await navigator.mediaDevices.getUserMedia({audio:{
      echoCancellation:true,noiseSuppression:true,autoGainControl:true
    }});
    communityState.voiceStream=stream;
    communityState.voiceChunks=[];
    const candidates=['audio/webm;codecs=opus','audio/webm','audio/mp4'];
    const mimeType=candidates.find((type)=>MediaRecorder.isTypeSupported(type));
    const recorder=new MediaRecorder(stream,mimeType?{mimeType}:undefined);
    communityState.voiceRecorder=recorder;
    recorder.addEventListener('dataavailable',(event)=>{
      if(event.data&&event.data.size) communityState.voiceChunks.push(event.data);
    });
    recorder.addEventListener('stop',async()=>{
      const blob=new Blob(communityState.voiceChunks,{type:recorder.mimeType||'audio/webm'});
      stream.getTracks().forEach((track)=>track.stop());
      communityState.voiceStream=null;
      communityState.voiceRecorder=null;
      communityState.voiceChunks=[];
      button.disabled=false;
      button.classList.remove('is-recording');
      button.textContent='🎙';
      button.setAttribute('aria-pressed','false');
      if(blob.size) {
        const extension=(recorder.mimeType||'audio/webm').includes('mp4')?'m4a':'webm';
        const file=new File([blob],`voice-${Date.now()}.${extension}`,{type:recorder.mimeType||'audio/webm'});
        try { await uploadCommunityFile(file); showToast('Голосовое сообщение отправлено.'); }
        catch(error) { showToast('Голосовое сообщение не отправлено: '+error.message); }
      }
    });
    recorder.addEventListener('error',(event)=>{
      console.error('Voice recording failed:',event.error);
      showToast('Не удалось записать голосовое сообщение.');
    });
    recorder.start(250);
    button.classList.add('is-recording');
    button.textContent='■';
    button.title='Остановить и отправить запись';
    button.setAttribute('aria-pressed','true');
    showToast('Запись идёт. Нажми ■, чтобы отправить голосовое сообщение.');
  } catch(error) {
    if(communityState.voiceStream) communityState.voiceStream.getTracks().forEach((track)=>track.stop());
    communityState.voiceStream=null;
    showToast(error.name==='NotAllowedError'?'Разреши доступ к микрофону в браузере.':'Не удалось начать запись: '+error.message);
  }
}

async function sendCommunityMessage(event) {
  event.preventDefault();
  const input=$('#communityMessageInput');
  const body=input.value.trim();
  const conversationId=communityState.currentConversationId;
  if(!body||!conversationId||!communityUserId()) return;
  input.disabled=true;
  try {
    const {error}=await supabaseClient.from('messages').insert({
      conversation_id:conversationId,
      sender_id:communityUserId(),
      body,
      reply_to:communityState.replyTarget?.id||null
    });
    if(error) throw error;
    captureProductEvent('message_sent', {
      chat_type: 'community',
      has_reply: Boolean(communityState.replyTarget?.id)
    });
    input.value='';
    clearCommunityReply();
    await loadCommunityMessages(conversationId);
    await loadCommunityConversations();
  } catch(error) {
    captureProductEvent('message_send_failed', { chat_type: 'community', error_name: String(error?.name || 'Error').slice(0, 48) });
    showToast('Сообщение не отправлено: '+error.message);
  } finally { input.disabled=false; input.focus(); }
}

async function refreshCommunity() {
  if(!supabaseClient||!authSession?.user) return;
  try {
    if(communityState.tab==='friends') await loadCommunityFriends();
    else {
      await loadCommunityConversations();
      if(communityState.tab==='groups') {
        const groups=$('#communityGroupsList');
        if(!groups.children.length) groups.append(communityNode('p','community-empty-note','Групповых чатов пока нет.'));
      }
    }
  } catch(error) {
    showToast('Не удалось обновить список: '+error.message);
  }
}

function switchPanel(panel) {
  activePanel = ['call','community'].includes(panel) ? panel : 'chat';
  panel = activePanel;
  const isCall = panel === 'call';
  const isCommunity = panel === 'community';
  chatPanel.hidden = isCall || isCommunity;
  callPanel.hidden = !isCall;
  $('#communityPanel').hidden = !isCommunity;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.panel === panel));
  $('#topbarTitle').textContent = isCall ? 'Видеокомната' : isCommunity ? 'Сообщения и друзья' : 'Общий чат';
  if (isCommunity) refreshCommunity();
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
  const startButton = $('#startCallBtn');
  startButton.hidden = isInCall;
  startButton.innerHTML = resumeCallAfterRestore
    ? '<span>↻</span> Вернуться в видеозвонок'
    : '<span>▶</span> Войти в видеозвонок';
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
  video.disablePictureInPicture = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('disablepictureinpicture', '');
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

function getSpeechAudioConstraints(deviceId = '') {
  const supported = navigator.mediaDevices.getSupportedConstraints
    ? navigator.mediaDevices.getSupportedConstraints()
    : {};
  const constraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  if (supported.channelCount) constraints.channelCount = { ideal: 1 };
  if (supported.sampleRate) constraints.sampleRate = { ideal: 48000 };
  if (supported.latency) constraints.latency = { ideal: 0.01 };
  return constraints;
}

async function captureAudioInput(deviceId = '') {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: getSpeechAudioConstraints(deviceId), video: false });
  } catch (error) {
    if (deviceId && ['NotFoundError', 'OverconstrainedError'].includes(error && error.name)) {
      console.warn('Selected microphone is no longer available; falling back to the system microphone.', error);
      return navigator.mediaDevices.getUserMedia({ audio: getSpeechAudioConstraints(), video: false });
    }
    if (error && error.name === 'OverconstrainedError') {
      console.warn('Advanced microphone constraints are unsupported; retrying with basic audio capture.', error);
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    throw error;
  }
}

async function refreshAudioInputDevices(preferredDeviceId = '') {
  const select = $('#audioInputSelect');
  if (!select) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices || !navigator.mediaDevices.getUserMedia) {
    select.disabled = true;
    select.title = 'Браузер не предоставляет доступ к микрофонам. Открой KOTOMASTER по HTTPS в поддерживаемом браузере.';
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices.filter((device) => device.kind === 'audioinput');
    const activeStream = localStream || previewAudioStream;
    const activeTrack = activeStream && activeStream.getAudioTracks()[0];
    const activeDeviceId = preferredDeviceId || selectedAudioDeviceId ||
      (activeTrack && activeTrack.getSettings ? activeTrack.getSettings().deviceId : '') || select.value || '';
    select.replaceChildren();
    const automatic = document.createElement('option');
    automatic.value = '';
    automatic.textContent = 'Системный микрофон';
    select.append(automatic);
    microphones.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Микрофон ${index + 1}`;
      select.append(option);
    });
    select.value = microphones.some((device) => device.deviceId === activeDeviceId) ? activeDeviceId : '';
    select.disabled = microphones.length === 0 || isSwitchingAudioInput;
    select.title = microphones.length
      ? (isInCall ? 'Выбери микрофон, с которого собеседник будет слышать тебя' : 'Выбери микрофон и проверь уровень сигнала до начала звонка')
      : 'Браузер пока не обнаружил доступные микрофоны';
  } catch (error) {
    console.warn('Could not enumerate microphones:', error);
    select.disabled = true;
    select.title = 'Не удалось получить список микрофонов. Проверь разрешение на микрофон в браузере.';
  }
}

function stopMicInputMeter() {
  if (micMeterTimer) clearInterval(micMeterTimer);
  micMeterTimer = null;
  if (micMeterSource) {
    try { micMeterSource.disconnect(); } catch (_error) {}
  }
  micMeterSource = null;
  micMeterAnalyser = null;
  if (micMeterContext) micMeterContext.close().catch(() => {});
  micMeterContext = null;
  const meter = $('#micInputLevel');
  if (meter) meter.style.width = '0%';
}

function startMicInputMeter(track) {
  stopMicInputMeter();
  if (!track || track.readyState !== 'live') return;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;

  try {
    micMeterContext = new AudioContextClass();
    micMeterAnalyser = micMeterContext.createAnalyser();
    micMeterAnalyser.fftSize = 512;
    micMeterAnalyser.smoothingTimeConstant = 0.72;
    micMeterSource = micMeterContext.createMediaStreamSource(new MediaStream([track]));
    micMeterSource.connect(micMeterAnalyser);

    const samples = new Uint8Array(micMeterAnalyser.fftSize);
    micMeterTimer = setInterval(() => {
      if (!micMeterAnalyser) return;
      micMeterAnalyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const sample = (samples[i] - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / samples.length);
      const level = Math.max(0, Math.min(100, Math.round(rms * 260)));
      const meter = $('#micInputLevel');
      if (meter) meter.style.width = `${level}%`;
      if (micMeterContext && micMeterContext.state === 'suspended') {
        micMeterContext.resume().catch(() => {});
      }
    }, 100);
  } catch (error) {
    console.warn('Microphone meter unavailable:', error);
    stopMicInputMeter();
  }
}

function attachLocalAudioTrackLifecycle(track) {
  if (!track) return;
  markSpeechTrack(track);
  track.onended = () => {
    if (!isInCall || !localStream || !localStream.getAudioTracks().includes(track)) return;
    wasMicInterrupted = isMicOn;
    isMicOn = false;
    updateCallButtons();
    publishMediaState();
    showToast('Микрофон прервался. При возвращении в KOTOMASTER попробуем восстановить его.');
  };
}

function attachLocalVideoTrackLifecycle(track) {
  if (!track) return;
  track.onended = () => {
    if (!isInCall || !localStream || !localStream.getVideoTracks().includes(track)) return;
    wasCameraInterrupted = isCameraOn;
    isCameraOn = false;
    updateCallButtons();
    publishMediaState();
    showToast('Камера прервалась. При возвращении в KOTOMASTER попробуем восстановить её.');
  };
}

async function recoverInterruptedMedia() {
  if (!isInCall || !localStream || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  const profile = getSelectedVideoProfile();

  if (wasMicInterrupted) {
    try {
      const stream = await captureAudioInput(selectedAudioDeviceId);
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('Браузер не вернул микрофон.');
      track.enabled = true;
      attachLocalAudioTrackLifecycle(track);
      const previous = localStream.getAudioTracks();
      previous.forEach((item) => localStream.removeTrack(item));
      localStream.addTrack(track);
      await addLocalTrackToPeers(track, 'audio');
      previous.forEach((item) => { item.onended = null; item.stop(); });
      selectedAudioDeviceId = track.getSettings ? track.getSettings().deviceId || selectedAudioDeviceId : selectedAudioDeviceId;
      isMicOn = true;
      wasMicInterrupted = false;
      startMicInputMeter(track);
      await refreshAudioInputDevices(selectedAudioDeviceId);
      updateTileState(socket.id, { audio: true, video: isCameraOn });
      publishMediaState();
      showToast('Микрофон восстановлен.');
    } catch (error) {
      captureWebRtcDiagnostic('restore_microphone', error);
      console.warn('Could not restore microphone after mobile resume:', error);
      showToast('Микрофон не восстановился автоматически. Нажми кнопку микрофона.');
    }
  }

  if (wasCameraInterrupted) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: profile.width },
          height: { ideal: profile.height },
          frameRate: { ideal: profile.frameRate, max: profile.frameRate }
        }
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('Браузер не вернул камеру.');
      try { track.contentHint = 'motion'; } catch (_error) {}
      attachLocalVideoTrackLifecycle(track);
      const previous = localStream.getVideoTracks();
      previous.forEach((item) => localStream.removeTrack(item));
      localStream.addTrack(track);
      await addLocalTrackToPeers(track, 'video');
      previous.forEach((item) => { item.onended = null; item.stop(); });
      isCameraOn = true;
      wasCameraInterrupted = false;
      const tile = makeVideoTile(socket.id, myName, true);
      tile.querySelector('video').srcObject = localStream;
      updateTileState(socket.id, { audio: isMicOn, video: true });
      publishMediaState();
      showToast('Камера восстановлена.');
    } catch (error) {
      captureWebRtcDiagnostic('restore_camera', error);
      console.warn('Could not restore camera after mobile resume:', error);
      showToast('Камера не восстановилась автоматически. Нажми кнопку камеры.');
    }
  }
}

async function selectAudioInput() {
  if (isSwitchingAudioInput) return;
  const select = $('#audioInputSelect');
  if (!select || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Браузер не поддерживает доступ к микрофону. Открой KOTOMASTER по HTTPS.');
    return;
  }
  isSwitchingAudioInput = true;
  select.disabled = true;
  const requestedDeviceId = select.value;
  const isLiveCall = Boolean(isInCall && localStream);
  let captured = null;
  const changedSenders = [];
  try {
    captured = await captureAudioInput(requestedDeviceId);
    const nextTrack = captured.getAudioTracks()[0];
    if (!nextTrack) throw new Error('Браузер не вернул аудиодорожку микрофона.');
    nextTrack.enabled = true;
    attachLocalAudioTrackLifecycle(nextTrack);
    if (isLiveCall) {
      for (const pc of peerConnections.values()) {
        if (pc.signalingState === 'closed') continue;
        let sender = findAudioSender(pc);
        if (sender) {
          const previousTrack = sender.track;
          await sender.replaceTrack(nextTrack);
          changedSenders.push({ pc, sender, previousTrack });
          await tuneAudioSender(sender);
        } else {
          sender = pc.addTrack(nextTrack, localStream);
          changedSenders.push({ pc, sender, previousTrack: null, added: true });
          await tuneAudioSender(sender);
          preferOpusAudioCodec(pc, sender);
        }
      }
      const previousTracks = localStream.getAudioTracks();
      previousTracks.forEach((track) => localStream.removeTrack(track));
      localStream.addTrack(nextTrack);
      captured = null;
      previousTracks.forEach((track) => { track.onended = null; track.stop(); });
      isMicOn = true;
      updateTileState(socket.id, { audio: true, video: isCameraOn });
      updateCallButtons();
      publishMediaState();
    } else {
      stopMicInputMeter();
      if (previewAudioStream) previewAudioStream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
      previewAudioStream = captured;
      captured = null;
    }
    const activeStream = isLiveCall ? localStream : previewAudioStream;
    const activeTrack = activeStream && activeStream.getAudioTracks()[0];
    const settings = activeTrack && activeTrack.getSettings ? activeTrack.getSettings() : {};
    selectedAudioDeviceId = settings.deviceId || requestedDeviceId || '';
    startMicInputMeter(activeTrack);
    await refreshAudioInputDevices(selectedAudioDeviceId);
    const selectedOption = select.selectedOptions[0];
    const deviceName = selectedOption && selectedOption.textContent ? selectedOption.textContent : 'системный микрофон';
    showToast(isLiveCall
      ? `Микрофон переключён: ${deviceName}. Проверь индикатор уровня.`
      : `Микрофон готов: ${deviceName}. Говори и проверь индикатор уровня до звонка.`);
  } catch (error) {
    console.error('Microphone selection failed:', error);
    for (const entry of changedSenders.reverse()) {
      try {
        if (entry.added) entry.pc.removeTrack(entry.sender);
        else await entry.sender.replaceTrack(entry.previousTrack || null);
      } catch (rollbackError) { console.warn('Microphone rollback failed:', rollbackError); }
    }
    if (captured) captured.getTracks().forEach((track) => track.stop());
    await refreshAudioInputDevices();
    let message = 'Не удалось включить выбранный микрофон. Попробуй системный микрофон.';
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) message = 'Браузеру запрещён доступ к микрофону. Разреши его для KOTOMASTER в настройках сайта.';
    else if (error && error.name === 'NotFoundError') message = 'Выбранный микрофон больше не найден. Выбери системный микрофон.';
    else if (error && error.name === 'NotReadableError') message = 'Микрофон занят другим приложением. Закрой его и попробуй снова.';
    showToast(message);
  } finally {
    isSwitchingAudioInput = false;
    await refreshAudioInputDevices(selectedAudioDeviceId);
  }
}

function markSpeechTrack(track) {
  if (!track) return;
  try { track.contentHint = 'speech'; } catch (_error) {}
}

async function startCall() {
  if (isInCall) return;
  resumeCallAfterRestore = false;
  if (isSwitchingAudioInput) { showToast('Дождись завершения проверки микрофона.'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Для видеозвонка открой KOTOMASTER через HTTPS или localhost.');
    return;
  }

  const button = $('#startCallBtn');
  button.disabled = true;
  button.textContent = 'Подключаем голос…';
  let audioStream = null;
  let usedAudioPreview = false;

  try {
    const profile = getSelectedVideoProfile();
    try {
      const previewTrack = previewAudioStream && previewAudioStream.getAudioTracks().find((track) => track.readyState === 'live');
      if (previewTrack) {
        previewTrack.enabled = true;
        audioStream = previewAudioStream;
        usedAudioPreview = true;
      } else {
        audioStream = await captureAudioInput(selectedAudioDeviceId);
      }
    } catch (error) {
      console.warn('Microphone unavailable; continuing without microphone:', error);
      showToast(error && error.name === 'NotAllowedError'
        ? 'Нет доступа к микрофону. Звонок попробует запуститься без него.'
        : 'Микрофон пока не подключился. Камеру запускаем отдельно.');
    }

    // Start the call as soon as audio is ready. Camera capture must not delay speech.
    localStream = new MediaStream(audioStream ? audioStream.getAudioTracks() : []);
    if (usedAudioPreview) previewAudioStream = null;
    const activeAudioTrack = localStream.getAudioTracks()[0];
    if (activeAudioTrack && activeAudioTrack.getSettings) {
      selectedAudioDeviceId = activeAudioTrack.getSettings().deviceId || selectedAudioDeviceId;
    }
    localStream.getAudioTracks().forEach(attachLocalAudioTrackLifecycle);

    isInCall = true;
    activeCallStartedAt = Date.now();
    isMicOn = localStream.getAudioTracks().length > 0;
    isCameraOn = false;
    wasMicInterrupted = false;
    wasCameraInterrupted = false;
    isSharing = false;

    const localTile = makeVideoTile(socket.id, myName, true);
    const localVideo = localTile.querySelector('video');
    localVideo.srcObject = localStream;
    updateTileState(socket.id, { audio: isMicOn, video: false });
    updateCallButtons();
    socket.emit('media:state', { inCall: true, audio: isMicOn, video: false, sharing: false });
    participants.set(socket.id, { id: socket.id, name: myName, inCall: true, audio: isMicOn, video: false, sharing: false });
    renderParticipants();
    updateCallDescription();
    updateCallStage();

    if (activeAudioTrack) {
      startMicInputMeter(activeAudioTrack);
      await refreshAudioInputDevices(activeAudioTrack.getSettings ? activeAudioTrack.getSettings().deviceId : '');
    } else {
      await refreshAudioInputDevices();
    }

    for (const member of participants.values()) {
      if (member.id !== socket.id && member.inCall) {
        createPeerConnection(member.id).catch((error) => showToast(error.message));
      }
    }

    showToast(isMicOn ? 'Голос подключён. Запускаем камеру…' : 'Звонок запущен. Подключаем камеру и ждём микрофон…');
    enableCameraAfterAudio(profile).catch((error) => {
      console.warn('Camera startup failed:', error);
    });
  } catch (error) {
    captureWebRtcDiagnostic('call_start', error);
    console.error('Call startup error:', error);
    if (isInCall) stopCall();
    else if (audioStream && !usedAudioPreview) audioStream.getTracks().forEach((track) => track.stop());
    let message = 'Не удалось запустить видеозвонок.';
    if (error && error.name === 'NotAllowedError') message = 'Разреши доступ к микрофону в настройках браузера.';
    else if (error && error.name === 'NotFoundError') message = 'На устройстве не найден микрофон.';
    else if (error && error.name === 'NotReadableError') message = 'Микрофон занят другим приложением.';
    showToast(message);
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>▶</span> Войти в видеозвонок';
  }
}

async function enableCameraAfterAudio(profile) {
  if (!isInCall || !localStream || isCameraOn || isSharing) return;
  let videoStream = null;
  try {
    const videoConstraints = {
      width: { ideal: profile.width },
      height: { ideal: profile.height },
      frameRate: { ideal: profile.frameRate, max: profile.frameRate }
    };
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
    } catch (captureError) {
      if (!['OverconstrainedError', 'NotReadableError'].includes(captureError?.name)) throw captureError;
      videoStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 854, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 24, max: 30 }
        }
      });
      showToast('Для этой камеры включён стабильный режим 480p/24 FPS.');
    }
    const videoTrack = videoStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('Браузер не вернул видеодорожку камеры.');
    if (!isInCall || !localStream) {
      videoStream.getTracks().forEach((track) => track.stop());
      return;
    }
    try { videoTrack.contentHint = 'motion'; } catch (_error) {}
    updateLiveFpsFromTrack(videoTrack);
    attachLocalVideoTrackLifecycle(videoTrack);
    localStream.addTrack(videoTrack);
    wasCameraInterrupted = false;
    isCameraOn = true;
    const localTile = makeVideoTile(socket.id, myName, true);
    const localVideo = localTile.querySelector('video');
    localVideo.srcObject = localStream;
    await addLocalTrackToPeers(videoTrack, 'video');
    updateTileState(socket.id, { audio: isMicOn, video: true });
    updateCallButtons();
    publishMediaState();
    showToast('Камера подключена. Голос уже передавался, не дожидаясь её запуска.');
  } catch (error) {
    captureWebRtcDiagnostic('camera_start', error);
    console.warn('Camera unavailable:', error);
    let message = 'Камера не подключилась. Звонок продолжится со звуком.';
    if (error && error.name === 'NotAllowedError') message = 'Браузеру запрещён доступ к камере. Звонок продолжится со звуком.';
    else if (error && error.name === 'NotFoundError') message = 'Камера не найдена. Звонок продолжится со звуком.';
    else if (error && error.name === 'NotReadableError') message = 'Камера занята другим приложением. Звонок продолжится со звуком.';
    showToast(message);
    if (!isMicOn && isInCall) {
      showToast('Не удалось подключить ни микрофон, ни камеру. Проверь разрешения браузера.');
      stopCall();
    }
  }
}

function currentOutgoingVideoSettings() {
  const profile = getSelectedVideoProfile();
  const screenTrack = isSharing && screenStream
    ? screenStream.getVideoTracks().find((track) => track.readyState === 'live')
    : null;
  const sharing = Boolean(screenTrack);
  const settings = sharing && screenTrack.getSettings ? screenTrack.getSettings() : {};
  const frameRate = sharing
    ? Math.min(profile.shareFrameRate, Math.round(Number(settings.frameRate) || profile.shareFrameRate))
    : profile.frameRate;
  return {
    bitrate: sharing ? getScreenShareBitrate(settings, frameRate) : profile.bitrate,
    frameRate,
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

    if ((pc._iceRestartAttempts || 0) >= 4) {
      const member = participants.get(peerId);
      captureWebRtcDiagnostic('ice_restart_exhausted', { name: 'IceRestartExhausted' }, pc);
      showToast(`Связь с ${member && member.name ? member.name : 'участником'} не восстановилась. Сеть может блокировать прямое соединение.`);
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
  pc._lastAdaptiveFrameRate = 0;
  pc._outboundSamples = new Map();

  pc._qualityTimer = setInterval(async () => {
    if (pc._qualityBusy || pc.signalingState === 'closed' || !isInCall) return;
    pc._qualityBusy = true;
    try {
      const stats = await pc.getStats();
      const now = performance.now();
      let selectedPairId = null;
      let selectedPair = null;
      let videoPacketLoss = 0;
      let audioPacketLoss = 0;
      let audioJitterMs = NaN;
      let encoderLimit = 'none';
      let measuredVideoBps = NaN;
      let encodedFps = NaN;
      let droppedFrameRatio = 0;
      let encodeLoad = 0;

      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId;
        }

        if (report.type === 'remote-inbound-rtp') {
          const loss = Math.max(0, Number(report.fractionLost) || 0);
          if (report.kind === 'audio' || report.mediaType === 'audio') audioPacketLoss = Math.max(audioPacketLoss, loss);
          else if (report.kind === 'video' || report.mediaType === 'video') videoPacketLoss = Math.max(videoPacketLoss, loss);
        }

        if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio') &&
            Number.isFinite(report.jitter)) {
          audioJitterMs = Math.max(Number.isFinite(audioJitterMs) ? audioJitterMs : 0, report.jitter * 1000);
        }

        if (report.type === 'outbound-rtp' && (report.kind === 'video' || report.mediaType === 'video') && !report.isRemote) {
          const previous = pc._outboundSamples.get(report.id);
          if (previous) {
            const elapsedMs = now - previous.time;
            if (elapsedMs > 500) {
              const bytesDelta = Math.max(0, (Number(report.bytesSent) || 0) - previous.bytes);
              const encodedDelta = Math.max(0, (Number(report.framesEncoded) || 0) - previous.encoded);
              const droppedDelta = Math.max(0, (Number(report.framesDropped) || 0) - previous.dropped);
              const encodeTimeDelta = Math.max(0, (Number(report.totalEncodeTime) || 0) - previous.encodeTime);

              measuredVideoBps = (bytesDelta * 8 * 1000) / elapsedMs;
              encodedFps = encodedDelta * 1000 / elapsedMs;
              droppedFrameRatio = droppedDelta / Math.max(1, droppedDelta + encodedDelta);
              encodeLoad = encodeTimeDelta * 1000 / elapsedMs;
            }
          }
          pc._outboundSamples.set(report.id, {
            time: now,
            bytes: Number(report.bytesSent) || 0,
            encoded: Number(report.framesEncoded) || 0,
            dropped: Number(report.framesDropped) || 0,
            encodeTime: Number(report.totalEncodeTime) || 0
          });
          if (report.qualityLimitationReason && report.qualityLimitationReason !== 'none') {
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
        const remoteCandidate = stats.get(selectedPair.remoteCandidateId);
        path = localCandidate && localCandidate.candidateType === 'relay' ? 'TURN' : 'P2P';
        if (selectedPair.id !== pc._lastReportedCandidatePairId) {
          pc._lastReportedCandidatePairId = selectedPair.id;
          captureProductEvent('webrtc_route_selected', {
            route: path,
            local_candidate_type: String(localCandidate?.candidateType || 'unknown').slice(0, 16),
            remote_candidate_type: String(remoteCandidate?.candidateType || 'unknown').slice(0, 16),
            protocol: String(localCandidate?.protocol || '').slice(0, 8)
          });
        }
      }

      const sender = findVideoSender(pc);
      const current = currentOutgoingVideoSettings();
      let ratio = 1;

      if (current.keepTextSharp) {
        // Do not let the app's camera-oriented adaptation algorithm clamp screen-share FPS.
        // The browser's WebRTC congestion controller still reacts to real network capacity.
        pc._lastAdaptiveBitrate = current.bitrate;
        pc._lastScaleDown = 1;
        pc._lastAdaptiveFrameRate = current.frameRate;
      } else {
        let desiredBitrate = current.bitrate;

        if (selectedPair && Number.isFinite(selectedPair.availableOutgoingBitrate) && selectedPair.availableOutgoingBitrate > 0) {
          desiredBitrate = Math.min(desiredBitrate, selectedPair.availableOutgoingBitrate * 0.68);
        }

        if (videoPacketLoss > 0.18) desiredBitrate *= 0.48;
        else if (videoPacketLoss > 0.10) desiredBitrate *= 0.68;
        else if (videoPacketLoss > 0.06) desiredBitrate *= 0.84;
        if (encoderLimit === 'bandwidth') desiredBitrate *= 0.68;
        if (encoderLimit === 'cpu' || encodeLoad > 0.78) desiredBitrate *= 0.76;
        if (droppedFrameRatio > 0.10) desiredBitrate *= 0.76;
        if (Number.isFinite(measuredVideoBps) && measuredVideoBps < desiredBitrate * 0.45 &&
            (encoderLimit === 'bandwidth' || droppedFrameRatio > 0.08)) {
          desiredBitrate = Math.min(desiredBitrate, measuredVideoBps * 1.15);
        }

        desiredBitrate = Math.max(100000, Math.round(desiredBitrate));
        const previousBitrate = pc._lastAdaptiveBitrate || 0;
        const targetBitrate = previousBitrate
          ? Math.round(desiredBitrate < previousBitrate
            ? previousBitrate * 0.48 + desiredBitrate * 0.52
            : previousBitrate * 0.86 + desiredBitrate * 0.14)
          : desiredBitrate;

        ratio = targetBitrate / Math.max(current.bitrate, 1);
        let scale = 1;
        let fpsFactor = 1;

        if (ratio < 0.22 || droppedFrameRatio > 0.22 || encoderLimit === 'cpu' && encodeLoad > 0.85) {
          scale = videoQualityBoostEnabled ? 1.8 : 1.55;
          fpsFactor = videoQualityBoostEnabled ? 0.78 : 0.68;
        } else if (ratio < 0.40 || videoPacketLoss > 0.14 || droppedFrameRatio > 0.12 || encoderLimit === 'bandwidth') {
          scale = videoQualityBoostEnabled ? 1.45 : 1.25;
          fpsFactor = videoQualityBoostEnabled ? 0.88 : 0.82;
        } else if (ratio < 0.66 || videoPacketLoss > 0.07 || droppedFrameRatio > 0.06 || encodeLoad > 0.68) {
          scale = videoQualityBoostEnabled ? 1.15 : 1.08;
          fpsFactor = 0.92;
        }

        const minimumFrameRate = videoQualityBoostEnabled ? 20 : 10;
        const targetFrameRate = Math.max(minimumFrameRate, Math.round(current.frameRate * fpsFactor));
        if (sender) {
          const previousScale = pc._lastScaleDown || 1;
          const bitrateChanged = !previousBitrate || Math.abs(targetBitrate - previousBitrate) > Math.max(50000, previousBitrate * 0.09);
          const scaleChanged = scale !== previousScale;
          const frameRateChanged = targetFrameRate !== pc._lastAdaptiveFrameRate;
          if (bitrateChanged || scaleChanged || frameRateChanged) {
            await tuneVideoSender(sender, targetBitrate, targetFrameRate, false, scale);
            pc._lastAdaptiveBitrate = targetBitrate;
            pc._lastScaleDown = scale;
            pc._lastAdaptiveFrameRate = targetFrameRate;
          }
        }
      }

      let level = 'good';
      if (
        audioPacketLoss > 0.12 ||
        (Number.isFinite(audioJitterMs) && audioJitterMs > 80) ||
        videoPacketLoss > 0.18 ||
        droppedFrameRatio > 0.22 ||
        (Number.isFinite(rttMs) && rttMs > 550) ||
        (encoderLimit === 'cpu' && encodeLoad > 0.85)
      ) level = 'poor';
      else if (
        audioPacketLoss > 0.05 ||
        (Number.isFinite(audioJitterMs) && audioJitterMs > 35) ||
        videoPacketLoss > 0.07 ||
        droppedFrameRatio > 0.08 ||
        (Number.isFinite(rttMs) && rttMs > 280) ||
        ratio < 0.72 ||
        encoderLimit !== 'none'
      ) level = 'medium';

      updateRtcQualityIndicator(
        level, path, rttMs, videoPacketLoss,
        (participants.get(peerId) || {}).name,
        audioJitterMs, audioPacketLoss
      );
      const qualityLabel = $('#rtcQualityText');
      if (qualityLabel && Number.isFinite(encodedFps) && encodedFps > 0) {
        qualityLabel.textContent = `${encodedFps.toFixed(0)} FPS · ${level === 'good' ? 'ХОРОШО' : level === 'medium' ? 'СРЕДНЕ' : 'СЛАБО'}`;
      }
      const bars = $('#rtcQualityBars');
      if (bars) {
        const extra = [
          Number.isFinite(measuredVideoBps) ? `Фактическая отправка видео: ${Math.round(measuredVideoBps / 1000)} Кбит/с` : '',
          Number.isFinite(encodedFps) ? `Кодирование: ${encodedFps.toFixed(1)} FPS` : '',
          Number.isFinite(droppedFrameRatio) ? `Пропущено кадров: ${Math.round(droppedFrameRatio * 100)}%` : '',
          encoderLimit !== 'none' ? `Ограничение: ${encoderLimit}` : ''
        ].filter(Boolean);
        if (extra.length) bars.title += ` · ${extra.join(' · ')}`;
      }
    } catch (error) {
      console.warn('WebRTC quality monitor skipped:', error);
    } finally {
      pc._qualityBusy = false;
    }
  }, 2500);
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
        captureWebRtcDiagnostic('negotiation', error, pc);
        showToast(`Не удалось согласовать соединение с ${member.name || 'участником'}.`);
      } finally {
        pc._makingOffer = false;
      }
    };

    localStream.getAudioTracks().forEach((track) => {
      attachLocalAudioTrackLifecycle(track);
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
    pc._lastIceCandidateErrorAt = 0;
    pc.onicecandidateerror = (event) => {
      const now = Date.now();
      if (now - pc._lastIceCandidateErrorAt < 5000) return;
      pc._lastIceCandidateErrorAt = now;
      captureWebRtcDiagnostic('ice_candidate', {
        name: 'IceCandidateError',
        errorCode: Number.isInteger(event.errorCode) ? event.errorCode : 0
      }, pc);
    };
    pc.onicegatheringstatechange = () => {
      captureProductEvent('webrtc_ice_gathering_state_changed', {
        state: String(pc.iceGatheringState || '').slice(0, 20)
      });
    };

    pc.ontrack = (event) => {
      const currentMember = participants.get(peerId) || member;

      if (event.track.kind === 'audio') {
        // Prefer a short voice jitter buffer where the browser exposes this control.
        try {
          if (event.receiver && 'jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 80;
        } catch (error) {
          console.warn('Could not set low-latency audio playout:', error);
        }
        let audioElements = remoteAudioElements.get(peerId);
        if (!audioElements) {
          audioElements = [];
          remoteAudioElements.set(peerId, audioElements);
        }
        const existing = audioElements.find((item) => item.dataset.trackId === event.track.id);
        if (existing) {
          existing.srcObject = new MediaStream([event.track]);
          existing.play().catch(() => {});
          return;
        }

        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.volume = 1;
        audio.muted = locallyMutedPeers.has((participants.get(peerId)||{}).userId || peerId);
        audio.className = 'remote-audio-only';
        audio.dataset.peerId = peerId;
        audio.dataset.trackId = event.track.id;
        audio.setAttribute('autoplay', '');
        audio.srcObject = new MediaStream([event.track]);
        document.body.append(audio);
        audioElements.push(audio);

        const tryPlayback = () => {
          audio.play().catch(() => showToast('Нажми в видеокомнате, чтобы разрешить звук собеседника.'));
        };
        event.track.onunmute = tryPlayback;
        event.track.onended = () => {
          audio.pause();
          audio.srcObject = null;
          audio.remove();
          const current = remoteAudioElements.get(peerId) || [];
          remoteAudioElements.set(peerId, current.filter((item) => item !== audio));
        };
        tryPlayback();
        return;
      }

      const tile = makeVideoTile(peerId, currentMember.name || 'Участник');
      const video = tile.querySelector('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.setAttribute('autoplay', '');
      video.setAttribute('playsinline', '');

      let remoteStream = event.streams && event.streams[0];
      if (!remoteStream) remoteStream = new MediaStream();
      if (!remoteStream.getTracks().some((track) => track.id === event.track.id)) {
        remoteStream.addTrack(event.track);
      }
      video.srcObject = remoteStream;

      const resumeRemoteVideo = () => {
        if (event.track.readyState !== 'live') return;
        if (video.srcObject !== remoteStream) video.srcObject = remoteStream;
        video.play().then(() => {
          if (event.track.readyState === 'live' && !event.track.muted) tile.classList.add('has-video');
        }).catch(() => {});
      };

      event.track.addEventListener('unmute', resumeRemoteVideo);
      event.track.addEventListener('mute', () => tile.classList.remove('has-video'));
      event.track.addEventListener('ended', () => tile.classList.remove('has-video'));
      video.addEventListener('loadedmetadata', resumeRemoteVideo);
      video.addEventListener('canplay', resumeRemoteVideo);
      video.addEventListener('playing', () => tile.classList.add('has-video'));

      tile.classList.toggle('sharing', Boolean(currentMember.sharing));
      updateTileState(peerId, currentMember);
      resumeRemoteVideo();
    };

    pc._lastReportedConnectionState = '';
    pc._lastReportedIceState = '';
    pc.onconnectionstatechange = () => {
      const connectionState = pc.connectionState;
      if (connectionState && connectionState !== pc._lastReportedConnectionState) {
        pc._lastReportedConnectionState = connectionState;
        captureProductEvent('webrtc_connection_state_changed', { state: connectionState });
      }
      if (connectionState === 'failed') {
        captureWebRtcDiagnostic('peer_connection_failed', { name: 'ConnectionFailed' }, pc);
      }
      if (pc.connectionState === 'connected') {
        if (pc._iceRestartTimer) clearTimeout(pc._iceRestartTimer);
        pc._iceRestartTimer = null;
        pc._iceRestartAttempts = 0;
      } else if (pc.connectionState === 'failed') {
        scheduleIceRestart(peerId, pc);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      if (iceState && iceState !== pc._lastReportedIceState) {
        pc._lastReportedIceState = iceState;
        captureProductEvent('webrtc_ice_state_changed', { state: iceState });
      }
      if (iceState === 'failed') {
        captureWebRtcDiagnostic('ice_failed', { name: 'IceConnectionFailed' }, pc);
      }
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
    pc.onicecandidateerror = null;
    pc.onicegatheringstatechange = null;
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

function findAudioSender(pc) {
  if (!pc) return null;
  const active = pc.getSenders().find((sender) => sender.track && sender.track.kind === 'audio');
  if (active) return active;
  const transceiver = pc.getTransceivers().find((item) =>
    item.receiver && item.receiver.track && item.receiver.track.kind === 'audio'
  );
  return transceiver ? transceiver.sender : null;
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

    const sender = kind === 'video' ? findVideoSender(pc) : findAudioSender(pc);
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
      const stream = await captureAudioInput(selectedAudioDeviceId);
      tracks = stream.getAudioTracks();
      tracks.forEach((track) => {
        track.enabled = true;
        attachLocalAudioTrackLifecycle(track);
        localStream.addTrack(track);
      });
      if (tracks[0]) {
        await addLocalTrackToPeers(tracks[0], 'audio');
        startMicInputMeter(tracks[0]);
        await refreshAudioInputDevices(tracks[0].getSettings ? tracks[0].getSettings().deviceId : '');
      }
    } catch (error) {
      captureWebRtcDiagnostic('microphone_toggle', error);
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
      const profile = getSelectedVideoProfile();
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
        attachLocalVideoTrackLifecycle(track);
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
      captureWebRtcDiagnostic('camera_toggle', error);
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
  let attemptedAudio = 0;
  for (const audioElements of remoteAudioElements.values()) {
    for (const audio of audioElements) {
      if (audio.paused) {
        attemptedAudio += 1;
        audio.play().catch(() => {});
      }
    }
  }
  const remoteVideos = videoGrid.querySelectorAll('.video-tile:not(.local) video');
  remoteVideos.forEach((video) => {
    if (video.srcObject && (video.paused || video.readyState < 2)) video.play().catch(() => {});
  });
  if (attemptedAudio) showToast('Пробуем включить звук участников.');
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
    encoding.maxBitrate = 96000;
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
        fallback.encodings[0].maxBitrate = 96000;
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
      // Audio is configured as high priority; video yields bandwidth to speech.
      encoding.priority = keepTextSharp ? 'high' : 'low';
      encoding.networkPriority = keepTextSharp ? 'high' : 'low';
      if (includeScale) encoding.scaleResolutionDownBy = Math.max(1, scaleResolutionDownBy);
      // Camera adapts resolution and frame rate together. Screen sharing protects text sharpness.
      params.degradationPreference = keepTextSharp ? 'maintain-resolution' : 'balanced';
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
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    showToast(isMobile
      ? 'Этот мобильный браузер не поддерживает передачу экрана из веб-страницы. Можно смотреть демонстрацию с компьютера.'
      : 'Браузер не поддерживает передачу экрана. Открой KOTOMASTER в актуальном браузере по HTTPS.');
    return;
  }

  const profile = getSelectedVideoProfile();
  const frameRate = profile.shareFrameRate || 15;
  let capturedStream = null;
  const changedSenders = [];

  try {
    capturedStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        // Do not downscale the desktop capture to the camera's 720p profile.
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
      const captureSettings = screenTrack.getSettings ? screenTrack.getSettings() : {};
      const actualFrameRate = Math.min(frameRate, Math.round(Number(captureSettings.frameRate) || frameRate));
      await tuneVideoSender(sender, getScreenShareBitrate(captureSettings, actualFrameRate), actualFrameRate, true);
    }

    screenStream = capturedStream;
    attachLocalVideoTrackLifecycle(screenTrack);
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
    captureProductEvent('screen_share_started');

    const actual = screenTrack.getSettings ? screenTrack.getSettings() : {};
    const actualSize = actual.width && actual.height ? `${actual.width}×${actual.height}` : 'исходное разрешение экрана';
    const actualFps = Math.round(Number(actual.frameRate) || frameRate);
    showToast(`Демонстрация экрана началась: ${actualSize}, до ${actualFps} FPS.`);
  } catch (error) {
    captureWebRtcDiagnostic('screen_share', error);
    console.error('Screen share error:', error);
    captureProductEvent('screen_share_failed', { error_name: String(error?.name || 'Error').slice(0, 48) });

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

    const isAndroid = /Android/i.test(navigator.userAgent || '');
    if (isAndroid && error && ['NotAllowedError', 'NotSupportedError'].includes(error.name)) {
      showToast('Этот браузер Android не разрешает сайту захватывать экран. На телефоне можно смотреть демонстрацию, а начать её — с компьютера.');
    } else if (error && error.name === 'NotAllowedError') showToast('Доступ к экрану отменён или запрещён браузером. Проверь разрешения и попробуй снова.');
    else if (error && error.name === 'NotFoundError') showToast('Браузер не нашёл источник экрана для передачи.');
    else if (error && error.name === 'NotSupportedError') showToast('Передача экрана не поддерживается этим браузером.');
    else showToast(error.message || 'Не удалось показать экран.');
  }
}

async function stopScreenShare() {
  if (!isSharing) return;
  isSharing = false;
  captureProductEvent('screen_share_stopped');
  const cameraTrack = localStream && localStream.getVideoTracks()[0];
  const profile = getSelectedVideoProfile();
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

const CALL_HISTORY_KEY = 'kotomaster-call-history-v1';

function loadCallHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(CALL_HISTORY_KEY) || '[]');
    return Array.isArray(stored) ? stored.slice(0, 20) : [];
  } catch (_error) {
    return [];
  }
}

function saveCallHistoryEntry(entry) {
  const history = loadCallHistory();
  history.unshift({
    id: window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    roomId: String(entry.roomId || ''),
    name: String(entry.name || 'Котик'),
    startedAt: Number(entry.startedAt) || Date.now(),
    endedAt: Number(entry.endedAt) || Date.now(),
    type: entry.type === 'Видео' ? 'Видео' : 'Аудио'
  });
  try {
    localStorage.setItem(CALL_HISTORY_KEY, JSON.stringify(history.slice(0, 20)));
  } catch (_error) {}
  renderCallHistory();
  persistCallHistoryEntry(entry).catch((error)=>console.warn('Call history sync failed:',error));
}

let remoteCallHistory = [];

async function persistCallHistoryEntry(entry) {
  if(!supabaseClient||!authSession?.user) return;
  const {error}=await supabaseClient.from('call_history').insert({
    user_id:authSession.user.id,
    conversation_id:roomConversationId,
    call_type:entry.type==='Видео'?'video':'audio',
    started_at:new Date(entry.startedAt).toISOString(),
    ended_at:new Date(entry.endedAt).toISOString()
  });
  if(error) throw error;
  await loadRemoteCallHistory();
}

async function loadRemoteCallHistory() {
  if(!supabaseClient||!authSession?.user) return;
  const {data,error}=await supabaseClient.from('call_history')
    .select('id,call_type,conversation_id,started_at,ended_at')
    .eq('user_id',authSession.user.id)
    .order('ended_at',{ascending:false}).limit(20);
  if(error) throw error;
  remoteCallHistory=(data||[]).map((item)=>({
    id:item.id,roomId:item.conversation_id?'Чат':'Комната',name:myName||'KOTOMASTER',
    startedAt:Date.parse(item.started_at)||Date.now(),endedAt:Date.parse(item.ended_at)||Date.now(),
    type:item.call_type==='video'?'Видео':'Аудио'
  }));
  renderCallHistory();
}

function renderCallHistory() {
  const list = $('#callHistoryList');
  if (!list) return;
  list.replaceChildren();
  const localHistory = loadCallHistory();
  const history = [...remoteCallHistory,...localHistory].sort((a,b)=>(b.endedAt||0)-(a.endedAt||0));
  if (!history.length) {
    const empty = document.createElement('p');
    empty.className = 'call-history-empty';
    empty.textContent = 'Здесь появятся завершённые звонки.';
    list.append(empty);
    return;
  }
  history.slice(0, 8).forEach((call) => {
    const item = document.createElement('div');
    item.className = 'call-history-item';
    const icon = document.createElement('span');
    icon.className = 'call-history-icon';
    icon.textContent = call.type === 'Видео' ? '▣' : '☎';
    const copy = document.createElement('div');
    copy.className = 'call-history-copy';
    const title = document.createElement('strong');
    title.textContent = call.type + ' · ' + (call.name || 'Котик');
    const date = new Date(call.endedAt || call.startedAt);
    const duration = Math.max(0, Math.round(((call.endedAt || call.startedAt) - call.startedAt) / 1000));
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const meta = document.createElement('small');
    meta.textContent = date.toLocaleDateString('ru-RU', { day:'2-digit', month:'short' }) + ' · ' +
      date.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }) + ' · ' +
      (mins ? mins + ' мин ' : '') + secs + ' сек · ' + (call.roomId || 'Комната');
    copy.append(title, meta);
    item.append(icon, copy);
    list.append(item);
  });
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
  stopMicInputMeter();
  if (activeCallStartedAt) {
    saveCallHistoryEntry({
      roomId,
      name: myName,
      startedAt: activeCallStartedAt,
      endedAt: Date.now(),
      type: isCameraOn ? 'Видео' : 'Аудио'
    });
    activeCallStartedAt = 0;
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    localStream = null;
  }
  isInCall = false;
  isMicOn = false;
  isCameraOn = false;
  resumeCallAfterRestore = false;
  wasMicInterrupted = false;
  wasCameraInterrupted = false;
  removeVideoTile(socket && socket.id);
  videoGrid.replaceChildren();
  publishMediaState();
  updateCallButtons();
  updateCallStage();
  const audioSelect = $('#audioInputSelect');
  if (audioSelect) audioSelect.disabled = true;
  const meter = $('#micInputLevel');
  if (meter) meter.style.width = '0%';
  saveRoomSessionBeforePageExit();
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
  auto: { width: 1280, height: 720, frameRate: 24, bitrate: 900000, shareFrameRate: 30, shareBitrate: 3000000 },
  '360': { width: 640, height: 360, frameRate: 24, bitrate: 450000, shareFrameRate: 30, shareBitrate: 1500000 },
  '480': { width: 854, height: 480, frameRate: 24, bitrate: 750000, shareFrameRate: 30, shareBitrate: 2000000 },
  '720': { width: 1280, height: 720, frameRate: 24, bitrate: 1150000, shareFrameRate: 30, shareBitrate: 3000000 },
  '1080': { width: 1920, height: 1080, frameRate: 30, bitrate: 2500000, shareFrameRate: 30, shareBitrate: 5500000 }
};

function isMobileVideoDevice() {
  const userAgent = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod/i.test(userAgent) ||
    Boolean(window.matchMedia && window.matchMedia('(max-width: 740px)').matches);
}

function getSelectedVideoProfile() {
  const selected = $('#videoResolutionSelect');
  const key = selected && VIDEO_PROFILES[selected.value] ? selected.value : 'auto';
  const base = VIDEO_PROFILES[key];
  if (!videoQualityBoostEnabled) return base;

  const mobile = isMobileVideoDevice();
  const desktopBitrate = {
    auto: 2100000, '360': 700000, '480': 1250000, '720': 1950000, '1080': 2600000
  };
  const mobileBitrate = {
    auto: 1450000, '360': 550000, '480': 900000, '720': 1450000, '1080': 1900000
  };
  const desktopShareBitrate = {
    auto: 1200000, '360': 520000, '480': 900000, '720': 1450000, '1080': 1800000
  };
  const mobileShareBitrate = {
    auto: 900000, '360': 400000, '480': 650000, '720': 900000, '1080': 1200000
  };

  return {
    ...base,
    width: key === 'auto' ? (mobile ? 1280 : 1920) : base.width,
    height: key === 'auto' ? (mobile ? 720 : 1080) : base.height,
    frameRate: 30,
    bitrate: (mobile ? mobileBitrate : desktopBitrate)[key],
    shareFrameRate: mobile ? 30 : 60,
    shareBitrate: (mobile ? mobileShareBitrate : desktopShareBitrate)[key]
  };
}

function getScreenShareBitrate(settings = {}, frameRate = 30) {
  const width = Math.max(640, Number(settings.width) || 1280);
  const height = Math.max(360, Number(settings.height) || 720);
  const fps = Math.max(15, Math.min(60, Number(frameRate) || 30));
  const pixelsPerSecond = width * height * fps;
  const target = 3000000 * (pixelsPerSecond / (1280 * 720 * 30));
  return Math.max(1500000, Math.min(8000000, Math.round(target)));
}

function updateLiveFpsFromTrack(track) {
  if (!track || typeof track.getSettings !== 'function') return;
  const settings = track.getSettings();
  const fps = Number(settings.frameRate);
  const label = $('#rtcQualityText');
  if (label && Number.isFinite(fps) && fps > 0) {
    label.textContent = `${Math.round(fps)} FPS · КАМЕРА`;
    label.title = `Камера сейчас сообщает ${Math.round(fps)} кадров/с`;
  }
}

function updateVideoQualityBoostButton() {
  const button = $('#videoQualityBoostBtn');
  if (!button) return;
  button.classList.toggle('active', videoQualityBoostEnabled);
  button.setAttribute('aria-pressed', videoQualityBoostEnabled ? 'true' : 'false');
  button.textContent = videoQualityBoostEnabled ? 'ЧЁТЧЕ · ВКЛ' : 'ЧЁТЧЕ · ВЫКЛ';
  button.title = videoQualityBoostEnabled
    ? 'Повышенная плавность демонстрации: до 60 FPS, если источник и сеть поддерживают.'
    : 'Обычный режим демонстрации: до 30 FPS с сохранением исходного разрешения экрана';
}

async function changeVideoResolution() {
  const select = $('#videoResolutionSelect');
  const profile = getSelectedVideoProfile();
  const sharingTrack = isSharing && screenStream ? screenStream.getVideoTracks()[0] : null;
  const cameraTrack = localStream && localStream.getVideoTracks()[0];
  const track = sharingTrack || cameraTrack;
  if (!track || !isInCall) {
    showToast(videoQualityBoostEnabled
      ? 'Режим 60 FPS сохранён и применится при следующем звонке.'
      : 'Качество сохранено и применится при следующем звонке.');
    return;
  }

  const frameRate = sharingTrack ? profile.shareFrameRate : profile.frameRate;
  try {
    if (sharingTrack) {
      // Keep the display's native dimensions; only change its requested frame rate.
      await track.applyConstraints({ frameRate: { ideal: frameRate, max: frameRate } });
    } else {
      await track.applyConstraints({
        width: { ideal: profile.width },
        height: { ideal: profile.height },
        frameRate: { ideal: frameRate, max: frameRate }
      });
      updateLiveFpsFromTrack(track);
    }
    const actualSettings = sharingTrack && track.getSettings ? track.getSettings() : {};
    const actualFrameRate = sharingTrack
      ? Math.min(frameRate, Math.round(Number(actualSettings.frameRate) || frameRate))
      : frameRate;
    const bitrate = sharingTrack
      ? getScreenShareBitrate(actualSettings, actualFrameRate)
      : profile.bitrate;
    for (const pc of peerConnections.values()) {
      const sender = findVideoSender(pc);
      if (sender) await tuneVideoSender(sender, bitrate, actualFrameRate, Boolean(sharingTrack));
    }
    const mode = sharingTrack
      ? `Демонстрация: до ${actualFrameRate} FPS, исходное разрешение экрана`
      : (select.value === 'auto' ? 'Автоматическое качество' : `Качество до ${select.value}p`);
    showToast(sharingTrack ? mode + ' применено.' : mode + ' камеры применено.');
  } catch (error) {
    console.warn('Resolution change failed:', error);
    showToast('Источник не поддерживает этот режим. Попробуй 720p или выключи «Чётче».');
  }
}

async function toggleVideoQualityBoost() {
  videoQualityBoostEnabled = !videoQualityBoostEnabled;
  try {
    localStorage.setItem('kotomaster-video-quality-boost', videoQualityBoostEnabled ? '1' : '0');
  } catch (_error) {}
  updateVideoQualityBoostButton();
  await changeVideoResolution();
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
  try { localStorage.removeItem(ROOM_SESSION_KEY); } catch (_error) {}
  if (previewAudioStream) {
    previewAudioStream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    previewAudioStream = null;
  }
  stopMicInputMeter();
  stopCall();
  // stopCall persists call state; leaving the room is an explicit opt-out.
  try { localStorage.removeItem(ROOM_SESSION_KEY); } catch (_error) {}
  if (socket) {
    socket.emit('room:leave');
    socket.disconnect();
    socket = null;
  }
  roomId = '';
  roomConversationId = null;
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

$('#authForm').addEventListener('submit', handleAuthSubmit);
$('#authModeToggle').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
$('#signOutBtn').addEventListener('click', signOutAccount);
$('#forgotPasswordBtn').addEventListener('click', handlePasswordRecovery);
$('#editProfileBtn').addEventListener('click',openProfileEditor);
$('#closeEditProfileBtn').addEventListener('click',()=>$('#editProfileModal').hidden=true);
$('#editProfileModal').addEventListener('click',(event)=>{if(event.target===$('#editProfileModal'))$('#editProfileModal').hidden=true;});
$('#editProfileForm').addEventListener('submit',saveProfileChanges);


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
document.querySelectorAll('.community-tab').forEach((button)=>button.addEventListener('click',()=>setCommunityTab(button.dataset.communityTab)));
$('#friendSearchInput').addEventListener('input',(event)=>{
  clearTimeout(communityState.searchTimer);
  communityState.searchTimer=setTimeout(()=>searchCommunityUsers(event.target.value).catch((error)=>showToast(error.message)),220);
});
$('#refreshCommunityBtn').addEventListener('click',refreshCommunity);
$('#manageGroupBtn')?.addEventListener('click',()=>openGroupManage().catch(error=>$('#groupManageError').textContent=error.message));
$('#closeGroupManageBtn')?.addEventListener('click',()=>$('#groupManageModal').hidden=true);
$('#groupManageModal')?.addEventListener('click',event=>{if(event.target===$('#groupManageModal'))$('#groupManageModal').hidden=true;});
$('#communityRefreshMessages').addEventListener('click',()=>communityState.currentConversationId&&loadCommunityMessages(communityState.currentConversationId).catch((error)=>showToast(error.message)));
$('#communityMessageForm').addEventListener('submit',sendCommunityMessage);
$('#communityAttachBtn').addEventListener('click',()=>$('#communityFileInput').click());
$('#communityFileInput').addEventListener('change',(event)=>{
  handleCommunityFiles(event.target.files).finally(()=>{event.target.value='';});
});
$('#communityVoiceBtn').addEventListener('click',toggleCommunityVoiceRecording);

$('#newGroupBtn').addEventListener('click',async()=>{
  $('#newGroupError').textContent='';
  $('#newGroupModal').hidden=false;
  try { await loadCommunityFriends(); renderGroupMemberChoices(); }
  catch(error) { $('#newGroupError').textContent=error.message; }
});
$('#closeNewGroupBtn').addEventListener('click',()=>$('#newGroupModal').hidden=true);
$('#newGroupModal').addEventListener('click',(event)=>{if(event.target===$('#newGroupModal'))$('#newGroupModal').hidden=true;});
$('#newGroupForm').addEventListener('submit',createCommunityGroup);


$('#messageForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text || !socket || !socket.connected) return;
  input.value = '';
  if (typingStopTimer) clearTimeout(typingStopTimer);
  socket.emit('chat:typing', { typing: false });
  try {
    const response = await emitWithAck('chat:send', {
      text,
      replyTo: replyTarget ? replyTarget.id : null
    });
    if (!response.ok) {
      captureProductEvent('message_send_failed', { chat_type: 'room', error_name: 'ServerRejected' });
      showToast('Сообщение не отправлено.');
    }
    else {
      replyTarget = null;
      renderReplyPreview();
    }
  } catch (error) {
    showToast(error.message);
  }
});

$('#messageInput').addEventListener('input', () => {
  if (!socket || !socket.connected || !roomId) return;
  const now = Date.now();
  if (now - lastTypingEmitAt >= 300) {
    socket.emit('chat:typing', { typing: true });
    lastTypingEmitAt = now;
  }
  if (typingStopTimer) clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    if (socket && socket.connected) socket.emit('chat:typing', { typing: false });
  }, 1300);
});

$('#messageInput').addEventListener('blur', () => {
  if (typingStopTimer) clearTimeout(typingStopTimer);
  if (socket && socket.connected) socket.emit('chat:typing', { typing: false });
});

$('#chatSearchInput')?.addEventListener('input', (event) => {
  messageSearchQuery = event.target.value || '';
  applyMessageSearch();
});

$('#notificationsBtn')?.addEventListener('click', async () => {
  if (!('Notification' in window)) {
    showToast('Этот браузер не поддерживает уведомления.');
    return;
  }
  if (Notification.permission === 'denied') {
    showToast('Уведомления заблокированы в настройках браузера.');
    return;
  }
  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast('Разрешение на уведомления не выдано.');
      return;
    }
  }
  notificationsEnabled = !notificationsEnabled;
  try { localStorage.setItem('kotomaster-notifications',notificationsEnabled?'1':'0'); } catch(_error) {}
  updateNotificationsButton();
  showToast(notificationsEnabled ? 'Уведомления включены, пока сайт открыт.' : 'Уведомления отключены.');
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && roomId && activePanel === 'chat') {
    markMessagesRead([...messageRecords.values()].filter((message) => message.from !== (socket && socket.id)).map((message) => message.id));
  }
});

$('#startCallBtn').addEventListener('click', startCall);
$('#clearCallHistoryBtn')?.addEventListener('click', async () => {
  if (!window.confirm('Очистить историю звонков на этом устройстве?')) return;
  try { localStorage.removeItem(CALL_HISTORY_KEY); } catch (_error) {}
  remoteCallHistory=[];
  if(supabaseClient&&communityUserId()) {
    const {error}=await supabaseClient.from('call_history').delete().eq('user_id',communityUserId());
    if(error) { showToast('Не удалось очистить историю на сервере: '+error.message); return; }
  }
  renderCallHistory();
});
renderCallHistory();
updateNotificationsButton();
applyKotoPrefs();
$('#settingsBtn')?.addEventListener('click',openSettings);
$('#closeSettingsBtn')?.addEventListener('click',closeSettings);
$('#settingsModal')?.addEventListener('click',event=>{if(event.target===$('#settingsModal'))closeSettings();});
document.querySelectorAll('[data-accent]').forEach(button=>button.addEventListener('click',()=>{kotoPrefs.accent=button.dataset.accent;applyKotoPrefs();}));
document.querySelectorAll('[data-theme-choice]').forEach(button=>button.addEventListener('click',()=>{kotoPrefs.theme=button.dataset.themeChoice;applyKotoPrefs();}));
document.querySelectorAll('[data-scale-choice]').forEach(button=>button.addEventListener('click',()=>{kotoPrefs.scale=button.dataset.scaleChoice;applyKotoPrefs();}));
$('#settingSounds')?.addEventListener('change',event=>{kotoPrefs.sounds=event.target.checked;applyKotoPrefs();});
$('#settingAnimations')?.addEventListener('change',event=>{kotoPrefs.animations=event.target.checked;applyKotoPrefs();});
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
$('#videoQualityBoostBtn').addEventListener('click', toggleVideoQualityBoost);
$('#audioInputSelect').addEventListener('change', selectAudioInput);
$('#micPreviewBtn').addEventListener('click', selectAudioInput);
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    refreshAudioInputDevices();
  });
}
callPanel.addEventListener('click', unlockRemoteAudioPlayback);
$('#copyRoomBtn').addEventListener('click', () => roomId && copyText(roomId));
$('#welcomeCopyBtn').addEventListener('click', () => roomId && copyText(roomId));
$('#inviteBtn').addEventListener('click', () => { $('#modalRoomCode').textContent = roomId; inviteModal.hidden = false; });
$('#closeInviteBtn').addEventListener('click', () => { inviteModal.hidden = true; });
$('#modalCopyBtn').addEventListener('click', () => roomId && copyText(roomId));
$('#leaveRoomBtn').addEventListener('click', leaveRoom);
inviteModal.addEventListener('click', (event) => { if (event.target === inviteModal) inviteModal.hidden = true; });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { inviteModal.hidden = true; if (!$('#videoViewerModal').hidden) closeVideoViewer(); } });

function saveRoomSessionBeforePageExit() {
  if (!roomId || !myName) return;
  try {
    localStorage.setItem(ROOM_SESSION_KEY, JSON.stringify({
      roomId,
      name: myName,
      savedAt: Date.now(),
      wasInCall: isInCall || resumeCallAfterRestore
    }));
  } catch (_error) {}
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveRoomSessionBeforePageExit();
  else handlePageResume();
});
window.addEventListener('pagehide', saveRoomSessionBeforePageExit);
window.addEventListener('pageshow', handlePageResume);
window.addEventListener('online', handlePageResume);

rtcConfigPromise = (async function loadConfig() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (response.ok) appConfig = { ...appConfig, ...await response.json() };
    else console.warn('Using default WebRTC ICE configuration:', response.status);
  } catch (error) {
    console.warn('Using default WebRTC ICE configuration:', error);
  }
})();

refreshAudioInputDevices();
updateCallButtons();
updateVideoQualityBoostButton();
initializeSupabase().then(async () => {
  if (authSession?.user) {
    await loadMyProfile();
    await loadRemoteCallHistory().catch((error)=>console.warn('Could not load remote call history:',error));
    restoreSavedRoom();
  }
}).catch((error) => {
  console.error('KOTOMASTER auth initialization failed:', error);
  $('#authError').textContent = error.message || 'Не удалось подключить авторизацию.';
});
