import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const delight = fs.readFileSync('public/koto-delight.js', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

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


assert.ok(html.includes('/koto-delight.js?v=20261124-woodland-v1'), 'KOTO delight interactions must load as a versioned script.');
assert.match(html, /data-koto-sticker-trigger/, 'Both chat composers must expose a sticker picker trigger.');
assert.match(html, /id="kotoPawTrailToggle"/, 'Appearance settings must expose the paw cursor trail preference.');
assert.match(delight, /kotoStickerPicker/, 'Sticker picker UI must be implemented.');
assert.match(delight, /watchMascotAvatars/, 'Message and participant avatars must receive mascot styling.');
assert.match(delight, /CURSOR_MODES = \['cat', 'fox', 'bear', 'bunny', 'classic'\]/, 'Animal cursor variants must be supported.');
for (const cursor of ['cat','fox','bear','bunny','classic']) {
  assert.match(html, new RegExp('data-koto-cursor-choice="' + cursor + '"'), 'Animal cursor option is missing: ' + cursor);
}
assert.match(css, /--koto-cursor-cat:/, 'Cat paw cursor SVG must be embedded in the stylesheet.');
assert.match(css, /--koto-cursor-fox:/, 'Fox paw cursor SVG must be embedded in the stylesheet.');
assert.match(css, /--koto-cursor-bear:/, 'Bear paw cursor SVG must be embedded in the stylesheet.');
assert.match(css, /--koto-cursor-bunny:/, 'Bunny paw cursor SVG must be embedded in the stylesheet.');
assert.match(delight, /classList\.contains\('koto-animal-avatar'\)/, 'Real animal portrait avatars must not be covered by the mascot overlay.');
assert.match(delight, /prefers-reduced-motion/, 'Mascot effects must respect reduced-motion accessibility.');
assert.ok(delight.includes('localStorage.setItem(PREFS_KEY'), 'Paw cursor preferences must persist locally.');
for (const requiredId of ['communityMessageInput', 'communityMessageForm', 'kotoPawTrailToggle']) {
  assert.ok(uniqueIds.has(requiredId), 'KOTO delight target is missing: #' + requiredId);
}

assert.match(html, /href="\/magicpath-exact\.css\?v=/, 'The exact MagicPath component stylesheet must be loaded.');
assert.match(html, /class="km-desktop-frame"/, 'The MagicPath four-column desktop frame must exist.');
assert.match(html, /class="km-details"/, 'The MagicPath room information rail must exist.');
assert.match(app, /km-message-bubble/, 'Live chat messages must use the MagicPath message presentation.');

console.log(
  'Frontend integrity OK: ' + uniqueIds.size + ' unique HTML ids, ' +
  new Set(selectorIds).size + ' JavaScript id selectors, ' +
  clientEvents.size + ' client Socket.IO events.'
);
