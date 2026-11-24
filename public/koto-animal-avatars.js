(() => {
  'use strict';
  const animals = [
    { id: 'cat', label: 'Рыжий кот', x: 0, y: 0 },
    { id: 'shiba', label: 'Сиба-ину', x: 1, y: 0 },
    { id: 'fox', label: 'Лисёнок', x: 2, y: 0 },
    { id: 'rabbit', label: 'Кролик', x: 3, y: 0 },
    { id: 'red-panda', label: 'Красная панда', x: 0, y: 1 },
    { id: 'raccoon', label: 'Енот', x: 1, y: 1 },
    { id: 'panda', label: 'Панда', x: 2, y: 1 },
    { id: 'tiger', label: 'Тигрёнок', x: 3, y: 1 },
    { id: 'lion', label: 'Львенок', x: 0, y: 2 },
    { id: 'hamster', label: 'Хомяк', x: 1, y: 2 },
    { id: 'owl', label: 'Полярная сова', x: 2, y: 2 },
    { id: 'deer', label: 'Оленёнок', x: 3, y: 2 },
    { id: 'koala', label: 'Коала', x: 0, y: 3 },
    { id: 'hedgehog', label: 'Ёжик', x: 1, y: 3 },
    { id: 'penguin', label: 'Пингвин', x: 2, y: 3 },
    { id: 'corgi', label: 'Корги', x: 3, y: 3 }
  ];
  const atlas = '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';
  window.KOTO_ANIMALS = animals;
  window.KOTO_ANIMAL_ATLAS = 'data:image/webp;base64,' + atlas;
  document.documentElement.style.setProperty('--koto-animal-atlas', 'url("' + window.KOTO_ANIMAL_ATLAS + '")');
  document.dispatchEvent(new Event('koto:animal-atlas-ready'));
})();
