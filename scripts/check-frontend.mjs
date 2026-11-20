import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
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
  'mobileMemberStrip'
]) {
  assert.ok(uniqueIds.has(requiredId), 'Required UI element is missing: #' + requiredId);
}

console.log(
  'Frontend integrity OK: ' + uniqueIds.size + ' unique HTML ids, ' +
  new Set(selectorIds).size + ' JavaScript id selectors, ' +
  clientEvents.size + ' client Socket.IO events.'
);
