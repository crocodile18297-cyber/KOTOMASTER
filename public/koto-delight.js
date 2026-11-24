(() => {
  'use strict';

  const PREFS_KEY = 'kotomaster-delight-v1';
  const DEFAULTS = { cursor: 'paw', pawTrail: false };
  const $ = (id) => document.getElementById(id);
  const safeReadPrefs = () => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
    } catch (_error) {
      return { ...DEFAULTS };
    }
  };

  let prefs = safeReadPrefs();
  let activeInput = null;
  let activeForm = null;
  let activeTrigger = null;
  let activeCategory = 'Котики';
  let lastTrailAt = 0;
  let trailCount = 0;
  let picker = null;

  const STICKER_PACKS = {
    'Котики': [
      ['😺', 'Привет'], ['😸', 'Радость'], ['😹', 'Смешно'], ['😻', 'Обожаю'],
      ['😼', 'Хитрюга'], ['😽', 'Чмок'], ['🙀', 'Ого'], ['😿', 'Грущу'],
      ['😾', 'Сердитый'], ['🐱', 'Котик'], ['🐈', 'Кот'], ['🐈‍⬛', 'Чёрный кот']
    ],
    'Эмоции': [
      ['🥹', 'Умиление'], ['😂', 'Смеюсь'], ['😍', 'Восторг'], ['🤔', 'Думаю'],
      ['🥰', 'Тепло'], ['😴', 'Сонный'], ['🤗', 'Обнимашки'], ['😎', 'Круто'],
      ['😭', 'Очень грустно'], ['🤩', 'Вау'], ['🫶', 'Любовь'], ['✨', 'Сияю']
    ],
    'Лапки': [
      ['🐾', 'Лапки'], ['🐾✨', 'Волшебные лапки'], ['🐈💚', 'Котик с сердцем'],
      ['🐱🌙', 'Ночной кот'], ['🐈‍⬛✨', 'Звёздный кот'], ['🐾💗', 'Розовые лапки'],
      ['💚', 'Зелёное сердце'], ['🌸', 'Цветочек'], ['⭐', 'Звёздочка'],
      ['☁️', 'Облачко'], ['🍓', 'Клубничка'], ['🧸', 'Мишка']
    ]
  };

  function persistPrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_error) {}
  }

  function applyPreferences() {
    document.documentElement.dataset.kotoCursor = prefs.cursor === 'classic' ? 'classic' : 'paw';
    document.querySelectorAll('[data-koto-cursor-choice]').forEach((button) => {
      const selected = button.dataset.kotoCursorChoice === prefs.cursor;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    const trail = $('kotoPawTrailToggle');
    if (trail) {
      trail.checked = Boolean(prefs.pawTrail);
      trail.setAttribute('aria-checked', prefs.pawTrail ? 'true' : 'false');
    }
  }

  function makeElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ensurePicker() {
    if (picker) return picker;

    picker = makeElement('section', 'koto-sticker-picker');
    picker.id = 'kotoStickerPicker';
    picker.hidden = true;
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Кошачьи стикеры');

    const header = makeElement('header', 'koto-sticker-header');
    const titleWrap = makeElement('div', 'koto-sticker-title-wrap');
    titleWrap.append(
      makeElement('strong', '', 'Кото-стикеры'),
      makeElement('small', '', 'Маленькие эмоции для большого чата')
    );
    const close = makeElement('button', 'koto-sticker-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Закрыть стикеры');
    close.addEventListener('click', closePicker);
    header.append(titleWrap, close);

    const tabs = makeElement('div', 'koto-sticker-tabs');
    tabs.setAttribute('role', 'tablist');
    Object.keys(STICKER_PACKS).forEach((category) => {
      const tab = makeElement('button', 'koto-sticker-tab', category);
      tab.type = 'button';
      tab.dataset.category = category;
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => renderPack(category));
      tabs.append(tab);
    });

    const grid = makeElement('div', 'koto-sticker-grid');
    grid.id = 'kotoStickerGrid';
    grid.setAttribute('role', 'group');
    const hint = makeElement('p', 'koto-sticker-hint', 'Выбери стикер — он отправится в текущий диалог.');
    picker.append(header, tabs, grid, hint);
    document.body.append(picker);
    renderPack(activeCategory);
    return picker;
  }

  function renderPack(category) {
    activeCategory = STICKER_PACKS[category] ? category : 'Котики';
    const root = ensurePicker();
    const grid = root.querySelector('#kotoStickerGrid');
    if (!grid) return;
    grid.replaceChildren();

    root.querySelectorAll('.koto-sticker-tab').forEach((tab) => {
      const active = tab.dataset.category === activeCategory;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    STICKER_PACKS[activeCategory].forEach(([emoji, label]) => {
      const button = makeElement('button', 'koto-sticker-item');
      button.type = 'button';
      button.dataset.sticker = emoji;
      button.setAttribute('aria-label', label);
      button.title = label;
      const art = makeElement('span', 'koto-sticker-art', emoji);
      art.setAttribute('aria-hidden', 'true');
      const caption = makeElement('small', '', label);
      button.append(art, caption);
      button.addEventListener('click', () => chooseSticker(emoji));
      grid.append(button);
    });
  }

  function openPicker(trigger) {
    const root = ensurePicker();
    const inputId = trigger.dataset.kotoStickerInput;
    const formId = trigger.dataset.kotoStickerForm;
    activeInput = $(inputId);
    activeForm = $(formId);
    activeTrigger = trigger;
    if (!activeInput || !activeForm) return;

    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(332, window.innerWidth - 24);
    const left = Math.max(12, Math.min(bounds.left + bounds.width / 2 - width / 2, window.innerWidth - width - 12));
    root.style.width = width + 'px';
    root.style.left = left + 'px';
    root.style.top = 'auto';
    const estimatedHeight = 330;
    const top = bounds.top - estimatedHeight - 10;
    if (top >= 12) {
      root.style.bottom = 'auto';
      root.style.top = Math.max(12, top) + 'px';
    } else {
      root.style.top = Math.min(window.innerHeight - estimatedHeight - 12, bounds.bottom + 10) + 'px';
      root.style.bottom = 'auto';
    }
    root.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const focusable = root.querySelector('.koto-sticker-item');
    focusable?.focus({ preventScroll: true });
  }

  function closePicker() {
    if (!picker || picker.hidden) return;
    picker.hidden = true;
    if (activeTrigger) activeTrigger.setAttribute('aria-expanded', 'false');
    const trigger = activeTrigger;
    activeInput = null;
    activeForm = null;
    activeTrigger = null;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  function chooseSticker(emoji) {
    if (!activeInput || !activeForm) return;
    const current = activeInput.value.trim();
    if (current) {
      activeInput.value = current + ' ' + emoji;
      activeInput.focus();
    } else {
      activeInput.value = emoji;
      if (typeof activeForm.requestSubmit === 'function') activeForm.requestSubmit();
      else activeForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    closePicker();
  }

  function bindStickerTriggers() {
    document.querySelectorAll('[data-koto-sticker-trigger]').forEach((button) => {
      if (button.dataset.kotoStickerBound === '1') return;
      button.dataset.kotoStickerBound = '1';
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (picker && !picker.hidden && activeTrigger === button) closePicker();
        else openPicker(button);
      });
    });
  }

  function addPawTrail(x, y) {
    if (!prefs.pawTrail || prefs.cursor === 'classic' || window.matchMedia('(pointer: coarse)').matches) return;
    const now = performance.now();
    if (now - lastTrailAt < 120 || trailCount >= 5) return;
    lastTrailAt = now;
    trailCount++;

    const paw = makeElement('span', 'koto-paw-trail', '🐾');
    paw.setAttribute('aria-hidden', 'true');
    paw.style.left = x + 'px';
    paw.style.top = y + 'px';
    document.body.append(paw);
    paw.addEventListener('animationend', () => {
      paw.remove();
      trailCount = Math.max(0, trailCount - 1);
    }, { once: true });
  }

  const emojiOnly = (() => {
    try {
      return new RegExp('^[\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\uFE0F\\u200D\\u20E3\\u200B\\s]+$', 'u');
    } catch (_error) {
      return /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D\u20E3\s]+$/u;
    }
  })();

  function decorateStickerMessages(root) {
    if (!root) return;
    root.querySelectorAll('.message-bubble, .community-message > p').forEach((node) => {
      if (node.classList.contains('message-deleted') || node.querySelector('small')) return;
      const value = (node.textContent || '').trim();
      if (!value || !emojiOnly.test(value) || !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(value)) return;
      node.classList.add('koto-sticker-message');
      node.setAttribute('aria-label', 'Стикер: ' + value);
    });
  }

  function watchMessageLists() {
    const roots = [ $('messagesList'), $('communityMessages') ].filter(Boolean);
    roots.forEach((root) => {
      decorateStickerMessages(root);
      const observer = new MutationObserver(() => decorateStickerMessages(root));
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    });
  }

  function bindSettings() {
    document.querySelectorAll('[data-koto-cursor-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        prefs.cursor = button.dataset.kotoCursorChoice === 'classic' ? 'classic' : 'paw';
        persistPrefs();
        applyPreferences();
      });
    });
    const trail = $('kotoPawTrailToggle');
    trail?.addEventListener('change', () => {
      prefs.pawTrail = Boolean(trail.checked);
      persistPrefs();
      applyPreferences();
    });
  }

  document.addEventListener('pointerdown', (event) => {
    if (!picker || picker.hidden) return;
    if (event.target.closest('#kotoStickerPicker') || event.target.closest('[data-koto-sticker-trigger]')) return;
    closePicker();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePicker();
  });

  document.addEventListener('pointermove', (event) => addPawTrail(event.clientX, event.clientY), { passive: true });
  window.addEventListener('resize', closePicker, { passive: true });
  window.addEventListener('scroll', closePicker, { passive: true, capture: true });

  bindStickerTriggers();
  bindSettings();
  applyPreferences();
  watchMessageLists();
})();