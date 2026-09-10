---
title: SDD decks — source & rebuild
type: reference
status: active
created: 2026-07-22
updated: 2026-07-22
tags: [sdd, presentation, content, enterprise-sdd-agents]
links: []
---

# SDD-презентации — исходник

Воспроизводимый исходник русской HTML-презентации `../deck-ru-talk5.html`
(доклад о решении на 5 минут). Управляется данными: **один движок, контент в JSON.**

> Старые презентации для руководства и команды удалены: они перестали совпадать
> с исполняемым комплектом. Новый материал собирайте по `docs/SETUP.md`,
> `docs/OPERATIONS.md` и текущим телам команд.

## Файлы
- `deck-template.html` — движок: дизайн-система CSS (два акцента, светлая+тёмная темы),
  data-driven рендерер (12 макетов слайдов), навигация с клавиатуры, прогресс, авто-подгонка высоты,
  печать в PDF. Плейсхолдеры: `/*__TOKENS_CSS__*/`, `/*__META_JSON__*/`, `/*__SLIDES_JSON__*/`.
- `build-decks.mjs` — инжектит цветовые токены каждой презентации + JSON слайдов в шаблон; выдаёт
  автономный `.html` (с `<head>`) **и** `.artifact.html` (только body, для публикатора
  Artifact) в `dist/`.
- `content/talk5.json` — контент слайдов.
  **Это поверхность редактирования** — меняйте формулировки здесь, а не в собранном HTML.

## Пересборка
```
node build-decks.mjs talk5                # -> dist/deck-ru-talk5.html (+ .artifact.html)
cp dist/deck-ru-talk5.html ../deck-ru-talk5.html
```
Чтобы переопубликовать Artifact на месте, переопубликуйте соответствующий `dist/*.artifact.html` с
существующим URL Artifact (см. `../index.md`).

## Макеты (поле `layout` каждого слайда)
`title · bullets · statement · two-col · cards · stack · fanout · pipeline · timeline · table · map · closing`
См. блок комментария со схемой у начала рендерера в `deck-template.html`.

## Происхождение
Актуальные утверждения должны подтверждаться `docs/SETUP.md`, `docs/OPERATIONS.md`,
телами команд и проверенными командами. Последнее обновление процесса: 2026-08-20.
