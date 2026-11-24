import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');
const stickerParts = [
  'part01','part05','part02','part03','part06','part07','part04','part08'
].map((part) => fs.readFileSync('public/stickers/animal-sheet.' + part + '.txt', 'utf8'));
stickerParts[1] = stickerParts[1].slice(0, 4000);
const stickerData = stickerParts.join('');
const stickerBytes = Buffer.from(stickerData, 'base64');

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const uniqueIds = new Set(ids);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.equal(duplicateIds.length, 0, 'Duplicate HTML ids: ' + [...new Set(duplicateIds)].join(', '));

const selectorIds = [...app.matchAll(/\$\(\s*(['"])#([A-Za-z][\w-]*)\1\s*\)/g)]
  .map((match) => match[2]);
const missingIds = [...new Set(selectorIds.filter((id) => !uniqueIds.has(id)))];
assert.equal(missingIds.length, 0, 'JavaScript references missing HTML ids: ' + missingIds.join(', '));

const socketHandlers = new Set(
  [...server.matchAll(/socket\.on\(\s*(['"])([^'"]+)\1/g)].map((match) => match[2])
);
const clientEvents = new Set([
  ...[...app.matchAll(/socket\.emit\(\s*(['"])([^'"]+)\1/g)].map((match) => match[2]),
  ...[...app.matchAll(/emitWithAck\(\s*(['"])([^'"]+)\1/g)].map((match) => match[2])
]);
const missingHandlers = [...clientEvents].filter((event) => !socketHandlers.has(event));
assert.equal(missingHandlers.length, 0, 'Client emits without server handlers: ' + missingHandlers.join(', '));

for (const event of ['chat:typing', 'chat:edit', 'chat:delete', 'chat:react', 'chat:pin', 'chat:read']) {
  assert.ok(socketHandlers.has(event), 'Required chat interaction handler is missing: ' + event);
}

const socketScriptIndex = html.indexOf('/socket.io/socket.io.js');
const appScriptIndex = html.indexOf('/app.js?');
assert.ok(socketScriptIndex >= 0, 'Socket.IO client script is missing.');
assert.ok(appScriptIndex > socketScriptIndex, 'app.js must load after the Socket.IO client.');
assert.match(
  html,
  /<script\s+src="\/app\.js\?v=[^"]+"\s+defer><\/script>/,
  'app.js must have a versioned cache-busting URL.'
);

for (const requiredId of [
  'createRoomBtn',
  'joinRoomBtn',
  'messageForm',
  'kotoStickerBtn',
  'communityStickerBtn',
  'startCallBtn',
  'micBtn',
  'cameraBtn',
  'shareBtn',
  'leaveCallBtn',
  'audioInputSelect',
  'micPreviewBtn',
  'videoQualityBoostBtn',
  'videoResolutionSelect',
  'mobileMemberStrip',
  'chatSearchInput',
  'notificationsBtn',
  'pinnedMessageBanner',
  'typingIndicator',
  'replyPreview',
  'callHistoryList',
  'clearCallHistoryBtn',
  'authForm',
  'authEmail',
  'authPassword',
  'authUsername',
  'signOutBtn',
  'communityPanel',
  'friendSearchInput',
  'friendRequestsList',
  'friendList',
  'communityConversationList',
  'communityMessages',
  'communityMessageForm',
  'communityFileInput',
  'communityVoiceBtn',
  'newGroupForm',
  'editProfileForm'
]) {
  assert.ok(uniqueIds.has(requiredId), 'Required UI element is missing: #' + requiredId);
}

assert.match(html, /supabase-js@2\.119\.2/, 'Supabase browser SDK must be version-pinned.');
assert.match(server, /io\.use\(async \(socket, next\)/, 'Socket.IO must validate Supabase sessions.');
assert.match(server, /fetchAuthenticatedProfile/, 'Room identity must use the authenticated profile.');
assert.match(app, /request_friendship/, 'Friend requests must use the guarded RPC.');
assert.match(app, /create_direct_conversation/, 'Private chats must use the guarded RPC.');
assert.match(app, /create_group_conversation/, 'Group creation must use the guarded RPC.');
assert.match(app, /chat-files/, 'Private file uploads must use the configured storage bucket.');
assert.match(app, /MediaRecorder/, 'Voice messages must use browser media recording.');
assert.match(app, /beginRoomEventBuffer/, 'Room join must buffer presence events until the room snapshot is applied.');
assert.match(app, /flushRoomEventBuffer/, 'Buffered room events must be applied after a successful room join.');
assert.match(app, /queueRoomEvent/, 'Live room events must not be dropped during room entry.');
assert.match(app, /new RNNoiseNode\(context\)/, 'Voice calls must use the local RNNoise audio worklet when available.');
assert.match(app, /enhanceMicrophoneStream/, 'Captured microphone audio must pass through the noise-reduction pipeline.');
assert.match(html, /id="micDenoiseStatus"/, 'Microphone settings must display the active noise-reduction engine.');
assert.match(server, /vendor\/simple-rnnoise-wasm/, 'Server must serve the locally installed RNNoise assets.');


assert.match(app, /buildKotoStickerPicker/, 'Animal sticker pickers must be initialized for both message composers.');
assert.match(app, /renderKotoStickerText/, 'Animal sticker markers must render as safe inline photo stickers.');
assert.ok(app.includes("const marker = ':koto:' + sticker.id + ':'"), 'Sticker messages must use a shared, serializable marker format.');
assert.match(app, /data:image\/avif;base64,/, 'Realistic sticker sheet must load as an AVIF sprite.');
assert.match(app, /KOTO_LEGACY_STICKER_ALIASES/, 'Messages sent with the previous sticker IDs must remain readable.');
assert.equal(stickerData.length, 31904, 'The realistic animal sticker sprite data must be complete.');
assert.equal(stickerBytes.length, 23926, 'The realistic animal sticker sprite binary must be complete.');
assert.equal(stickerBytes.toString('ascii', 4, 12), 'ftypavif', 'The sticker sprite must be a valid AVIF image.');
assert.match(css, /\.koto-photo-sticker\s*\{[^}]*background-size:400% 400%/s, 'Photo stickers must crop the 4x4 portrait sheet correctly.');
assert.match(app, /Обнимаю/);
assert.match(app, /Спокойной ночи/);


assert.match(app, /picker\.append\(head, tabs, grid, footer\)/, 'Sticker picker must append its header, categories, grid and footer.');
assert.match(app, /document\.body\.append\(picker\)/, 'Sticker picker must mount outside the clipped chat composer.');
assert.match(css, /\.koto-sticker-picker\s*\{[^}]*position:fixed/s, 'Sticker picker must be viewport-positioned to avoid scroll clipping.');

console.log(
  'Frontend integrity OK: ' + uniqueIds.size + ' unique HTML ids, ' +
  new Set(selectorIds).size + ' JavaScript id selectors, ' +
  clientEvents.size + ' client Socket.IO events.'
);
