# Аудит ленты, `Thinking`, `Tool Calls`, карточек и мыши/хоткеев в Grok CLI 1.0.92 и `@conarti/pi-ui`

Исследование по тикету [Research: Аудит ленты, Thinking, Tool Calls, карточек и мыши/хоткеев в Grok CLI 1.0.92](https://github.com/conarti/pi-ui/issues/30) в рамках карты [Wayfinder: Целостный TUI поверх Pi в духе Grok CLI — ревизия базы, второй спеки и новые возможности](https://github.com/conarti/pi-ui/issues/29).

## Первоисточники

Все утверждения ниже проверены напрямую по первоисточникам:

1. **Grok CLI `1.0.92` (локальная установка `~/.grok/`)**:
   - документация и справочники: `~/.grok/README.md`, `~/.grok/CHANGELOG.md`, `~/.grok/CHANGELOG.json`, `~/.grok/settings_cache.json` (`grok_version: "1.0.92"`, `client: "grok-shell"`), `~/.grok/docs/user-guide/01-getting-started.md`, `03-keyboard-shortcuts.md`, `04-slash-commands.md`, `05-configuration.md`, `06-theming.md`, `16-subagents.md`, `19-plan-mode.md`, `20-background-tasks.md`, `21-terminal-support.md`, `23-dashboard.md`, `25-status-line.md`, `26-config-reference.md`, `~/.grok/bundled/`;
   - бинарник `~/.grok/downloads/grok-1.0.92-macos-aarch64` (Mach-O 64-bit arm64): секция строковых литералов `__TEXT,__const` (`offset 139472896`, `size 0x1365d08`) и таблица символов крейтов `xai-grok-pager` / `xai-grok-pager-render` (320 исходных путей `.rs` и 713 UI-символов). Файл `~/.grok/auth.json` не читался.
2. **Исходный код и git-история `@conarti/pi-ui`**:
   - текущий `HEAD` (`81b9a5f`) в сравнении с коммитом `6e58ad8` (состояние до [Spec: Grok-caliber TUI polish — composited viewport chrome, unified Prompt Chips, layout-agnostic quoting, 30 fps animations, and refined cards](https://github.com/conarti/pi-ui/issues/9)) и неслитой [Spec: OS Appearance Auto-Sync, built-in Status Bar, curated One Blue themes, Grok Plan & Auto governance, Settings Modal, and quote cards](https://github.com/conarti/pi-ui/issues/16);
   - модули `src/features/transcript/`, `src/features/tool-calls/`, `src/features/sticky-prompt/`, `src/features/outline-rail/`, `src/features/chrome/`, `src/features/prompt-chips/`, `src/features/prompt-suggestion/`, `src/features/quotes/`, `src/features/ask-user/`, `src/features/command-palette/`, `src/features/context-inspector/`, `src/features/plan-studio/`, `src/shared/modal-card.ts`, `src/shared/fullscreen-layout.ts`, `src/shared/ansi.ts`.
3. **Хост Pi SDK / TUI**:
   - `@earendil-works/pi-coding-agent` (`docs/tui.md`, `dist/modes/interactive/chat-viewport.js`, `dist/modes/interactive/components/user-message.js`, `assistant-message.js`, `tool-execution.js`);
   - `@earendil-works/pi-tui` (`dist/tui.js`, `dist/tui-alt-screen.js`, `dist/components/input.js`, `dist/components/editor.js`).

---

## Сводная матрица расхождений

| Поверхность | Grok CLI `1.0.92` | `@conarti/pi-ui` (`6e58ad8`, до полировки) | `@conarti/pi-ui` (`HEAD` `81b9a5f`) | Где усложнено восприятие или сломан UX |
|---|---|---|---|---|
| **Главный ответ агента** | Чистый Markdown на основном холсте (`bg_base`), без плашки и без всплывающего поверх текста бейджа копирования; копирование всего ответа — `Ctrl+O` / `/copy` (с бэкапом в `~/.grok/last-copy.txt`), а под завершённым `Turn` — строка `Worked for Xs` | На строке `y = 0` каждого текстового блока при hover врезается бейдж ` Copy `, отрезая правый край текста (`sliceByColumn`) | То же поведение (`src/features/transcript/markdown-cards.ts:269-295`) + безусловный `Spacer(1)` перед каждым подблоком | Бейдж `Copy` мигает и режет первую строку абзаца при проходе мыши; нет финального разделителя/маркера завершённого `Turn` |
| **Блок `Thinking` (стриминг и раскрытый вид)** | Заголовок `Thinking…` + `truncated_lines = 3` хвоста с волной `30 fps` (`wave_rows = 32`); Markdown сильно смешан с фоном (`bg_blend = 70`), `max_thoughts_width = 120`, `header_bright = false` | Плоский монохромный текст без `###`-маркеров и без заборов кода (`dimBody`), хвост 4 строки, отдельный таймер `65 ms` / волна 12 строк, подсказка `· клик свернуть` | Таймер `30 fps` / 32 строки, хвост 3 строки, убраны микро-хинты, **но** корпус переведён на полноценный `Markdown` (`createSoftThinkingMarkdown`) | Внутри `Thinking` появились многострочные кодовые блоки, подсветка `codeFg`, жирные заголовки и пустые строки параграфов — мысль визуально спорит с ответом |
| **Блок `Thinking` (свёрнутый вид и управление)** | 1 строка `❙ › Thought for Xs`, внутри серий инструментов при `Compact`/`Grouped` прячется в общую сводку серии; `Ctrl+E` глобально разворачивает/сворачивает все `Thinking` и сбрасывает ручные пины; двойной клик мимо текста тела не сворачивает блок | `❙ › Thought (N) — первый сниппет…`; клик левой кнопкой в любую точку переключает блок | Чистая строка `❙ › Thought for Xs` (fallback `❙ › Thought`), **но** одиночный клик в любую строку раскрытого тела сворачивает блок, а `Ctrl+T` не сбрасывает ручные `thinkingVisibilityOverrides` | Случайный клик по тексту раскрытого `Thinking` схлопывает его; после ручного клика глобальный `Ctrl+T` перестаёт управлять этим блоком |
| **`Tool Calls` и `Tool Density`** | **5 уровней** (`Detailed`, `Diff focus`, `Balanced`, `Grouped`, `Compact`); **по умолчанию `Compact` (`compact-all-grouped`)**, где любая серия вызовов (включая правки, команды и `Thinking` между ними) складывается в 1 строку (`Edited 2 files, ran 1 command +12 -4`) | Раздельные стили `compact` / `claude` / `codex` без единого `Tool Density` | **3 уровня** (`Detailed`, `Diff Focus`, `Compact`), **по умолчанию `Detailed`** (самый подробный!), а `Compact` равен лишь `Balanced` (`compact-ungrouped`) из Grok; нет hover-отклика на строках и группах | По умолчанию лента перегружена диффами и превью команд (`2 + … + 3`), нет группировки серий правок/команд, лишние пустые строки между шагами |
| **Карточка `User Prompt`** | Приподнятая полоса `bg = "light"` с `vpad = true`, префикс без двойной черты, `timestamps` справа (`on`/`minimal`/`off`), без прыгающей кнопки `Copy` в верхнем паддинге; двойной клик разворачивает усечённый промпт | Без `vpad`, боковые поля `outerPad = 2`, двойной префикс `┃ › `, при hover `Copy` резал текст первой строки | Полная ширина, верхний/нижний `vpad`, `HH:MM` справа в фиксированном гаттере, кликабельные `Prompt Chip`, **но** `Copy` рисуется в верхней строке `vpad` (`y = 0`), а RGB фона захардкожен `[27, 35, 50]` | При движении мыши верхний пустой ряд карточки вспыхивает меткой `Copy` прямо над `HH:MM`; тёмно-синий RGB конфликтует с нейтрально-графитовыми темами |
| **Блоки кода `Markdown`** | Подсветка `.tmTheme` на `md_code_bg`; кнопка `[Copy]` рисуется **снизу** отдельной `affordance`-строкой только после завершения ответа (и пропускается на пустых заборах) | Двухтоновая карточка с постоянной верхней шапкой `lang … Copy` и полосой `▎`, тёмные RGB захардкожены | Адаптивная палитра `ThemeSurfacePalette`, но та же постоянная верхняя шапка `lang … Copy` на всю ширину даже на 1-строчном коде и во время стриминга | Тяжёлая шапка удваивает вес коротких сниппетов, `Copy` постоянно шумит на каждом блоке, а hover в любой строке кода перекрашивает всю шапку |
| **`Sticky Prompt` и `Outline Rail`** | `Sticky Prompt` (`sticky_headers = true`, `min_lines = 2`) разворачивается двойным кликом / `Enter`; **`ui.show_timeline = false` по умолчанию и заменяет скроллбар** (`Per-turn tick rail in place of the scrollbar`), а не висит рядом с ним | `Sticky Prompt` — отдельная 1-строчная панель над `ScrollView` (меняла `viewportHeight`), `Outline Rail` сдвигал скроллбар влево | Оба композитятся поверх 100%-ширины `ScrollView`; `Outline Rail` (`width - 3 .. width - 2`) включён **одновременно** со скроллбаром (`width - 1`); `Sticky Prompt` переключается одиночным кликом и делит `Ctrl+O` с `app.tools.expand` | Справа одновременно соседствуют `HH:MM`, `Outline Rail` и скроллбар; одиночный клик по неусечённому `Sticky Prompt` перехватывает мышь, а `Ctrl+O` побочно дёргает шапку |
| **Управление мышью в `Composer` и модалках** | Полная поддержка мыши (клик и hover строк в модалках/пикерах, `double-click to expand` на чипах вставки, скролл, `Shift+drag` для терминального выделения) | В `ask_user_question` только колесо; в `Command Palette` и `Plan Studio` клик + hover | Добавлены кликабельные `Prompt Chip` и `Hover Popup` `╭ ❝ Цитировать ╮`, **но**: в `ask_user_question` 0 кликов/hover, `Prompt Suggestion` не принимается мышью, `Quotes` в режиме `edit` игнорирует мышь в редакторе | Опросник `ask_user_question` невозможно пройти одной мышью (ни пункты, ни вкладки, ни кнопки не кликаются) |
| **Видимый текстовый курсор** | `OSC 12` цвет курсора `accent_user` (`OSC 112` сброс) + явная каретка во всех полях ввода (включая свободный ответ в `Question card`) | В `ask_user_question` `editorDisplay` вырезает `FAKE_CURSOR_START`/`END`; `SingleLineInput` без стрелок и paste | В `Composer` каретка поверх первой графемы плейсхолдера работает отлично, **но** в `ask_user_question` курсор **полностью невидим**, а `createSingleLineInput` ломает paste и не двигает курсор `←`/`→` | При вводе своего ответа или заметки в `ask_user_question` пользователь печатает «вслепую» без текстового курсора |
| **Контекстные подсказки хоткеев** | Единая нижняя `Shortcuts Bar` + динамический футер `Composer` (`Tab:accept suggestion`, `Shift+Enter:newline · Enter:send` / `Enter:queue`, `Ctrl+L:add to chat`) + точечные `ui.contextual_hints.*` | Микро-подсказка `⌥↵ строка · ↵ отправить` в нижней рамке `Composer`, разнобой футеров модалок | Из `Composer` убраны все подсказки (включая `Prompt Suggestion` и перенос строки); `ask_user_question` на английском; в `Quotes` хоткеи скрыты с пилюль; в `Command Palette` устаревший `Shift+Tab` для `Thinking` | Неочевидно, как принять `Prompt Suggestion` (`Tab`/`→`), как вставить перенос строки, как цитировать с клавиатуры (`Alt+Q`) и какими клавишами управлять `Quotes` |

---

## 1. Текст ответа ассистента, `Thinking`, `Tool Calls`, превью диффов и вывода команд

### 1.1. Подача главного ответа и его отделение от служебных шагов

**Как устроено в Grok CLI `1.0.92`:**
- Текст ответа рендерится в `crates/codegen/xai-grok-pager/src/scrollback/blocks/markdown_content.rs` напрямую на базовом фоне `bg_base` слотом `md_text` / `text_primary` без фоновой карточки и без боковой рельсы (`~/.grok/docs/user-guide/06-theming.md:347-366`). Базовые отступы вьюпорта задаются в `[scrollback.layout]` (`06-theming.md:191-199`): `outer_vpad = 1`, `outer_hpad_left = 2`, `outer_hpad_right = 2`, `block_pad_left = 2`, `block_pad_right = 2`.
- Главное визуальное отделение ответа от промежуточной работы обеспечивается тремя приёмами:
  1. **Агрессивное схлопывание служебных шагов по умолчанию** (`ui.tool_call_density = "compact-all-grouped"`, `05-configuration.md:80-82`), благодаря чему между промптом пользователя и финальным ответом обычно остаётся всего одна приглушённая сводная строка вместо простыни вызовов;
  2. **Приглушение свёрнутых служебных блоков** (`[scrollback.blocks.tool] muted_collapsed = true`, `dim_details = true`, `[scrollback.display] dim_accent = 0.5`, `06-theming.md:233,275-277`);
  3. **Финальный маркер хода `Worked for <duration>`** внизу завершённого `Turn` (`20-background-tasks.md:193-203`, `26-config-reference.md:799`, строковые литералы `Worked for ` в `__TEXT,__const` `+353900`), который при `ui.timestamps = "minimal"` или `"on"` несёт время завершения и не копируется при протяжке выделения мышью через ход (`03-keyboard-shortcuts.md:630`).
- **Копирование ответа без визуального мусора**: Grok **не рисует** всплывающий поверх первой строки ответа бейдж `Copy` при движении мыши (`[scrollback.display] selection_buttons = false`, `06-theming.md:235`). Для копирования всего ответа используются `Ctrl+O` и `/copy [N] [path]` (`03-keyboard-shortcuts.md:428`, `04-slash-commands.md:52-65`), копирующие исходный Markdown с раскрытыми ссылками и сохраняющие резервную копию в `~/.grok/last-copy.txt`.

**Где отошёл `@conarti/pi-ui` (`6e58ad8` и `HEAD`):**
- В `src/features/transcript/markdown-cards.ts:269-295,325-330` наведение мыши на `event.y === 0` любого текстового `Markdown`-блока ответа монтирует поверх первой строки правый бейдж ` Copy ` / ` ✓ Copied `, отрезая правую часть текста через `sliceByColumn(row0, 0, targetCol, true)`. При обычном чтении и ведении указателя по экрану первая строка ответа мигает и обрезается, а если ответ разбит вызовами инструментов на несколько текстовых блоков, кнопка копирует только один фрагмент, а не весь ответ хода.
- В `src/features/transcript/thinking-block.ts:414-420` (`installAssistantTranscriptBlocks`) между всеми дочерними блоками ставится одинаковый `new Spacer(1)`, а каждый `ToolExecutionComponent` добавляет собственную ведущую пустую строку (`@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js:184`), из-за чего служебные шаги занимают столько же вертикального воздуха, сколько и финальный ответ.

### 1.2. Блоки `Thinking`: стриминг, завершённый вид, таймер длительности и сворачивание

**Как устроено в Grok CLI `1.0.92`:**
- Параметры блока зафиксированы в `pager.toml` (`~/.grok/docs/user-guide/06-theming.md:241-246,260-270`) и `[ui]` (`05-configuration.md:75,79`, `~/.grok/settings_cache.json`):
  - `max_thoughts_width = 120` (диапазон `40..500`, `26-config-reference.md:775`);
  - `show_thinking_blocks = true`;
  - `accent_enabled = true`, `animate = true` (`fps = 30`, `wave_rows = 32`), `truncated_lines = 3`, `bg_blend = 70`, `header = true`, `header_bright = false`;
  - глифы свёрнутого акцента и шеврона (`06-theming.md:230-232`, таблица глифов в `__TEXT,__const` `+167500`): `collapsed_accent_char = "❙"`, `expandable_indicator_char = "›"`, раскрытый шеврон `⌄` и сплошная направляющая `│` (`Thought for `, `Thinking…`, `│` в `__TEXT,__const` `+161200`).
- **Во время стриминга**: показывается приглушённый заголовок `Thinking…` и хвост до `truncated_lines = 3` строк с плавной волной по вертикальной линии. Ключевая деталь `bg_blend = 70`: цвета внутри `Thinking` на 70% сведены к фону холста, поэтому они выглядят как тихий монохромный шёпот, а не как второй полноценный ответ.
- **В завершённом виде**:
  - отдельный блок сворачивается в одну компактную строку с длительностью `Thought for <duration>` (без счётчика строк и без текстового сниппета);
  - если завершённый `Thinking` находится *внутри* серии `Tool Calls` при режимах группировки, он складывается прямо внутрь сводной строки серии (`Finished thinking inside a run folds with it`, `04-slash-commands.md:183`).
- **Сворачивание/разворачивание мышью и с клавиатуры**:
  - мышью: двойной клик по заголовку/строке переключает сворачивание, причём в раскрытом или стримящемся `Thinking` двойной клик ниже заголовка мимо текста (по пустым ячейкам, рельсе `│`, строке `…`) намеренно **не** сворачивает блок, чтобы не мешать выделению текста (`03-keyboard-shortcuts.md:638`);
  - с клавиатуры: `Ctrl+E` разворачивает или сворачивает **все** блоки `Thinking` в сессии сразу (работает в том числе поверх открытой карточки `ask_user_question`, `03-keyboard-shortcuts.md:64,204`, и сбрасывает ручные пины `respect_manual_folds`, `03-keyboard-shortcuts.md:75`). После трёх ручных закрытий подряд при включённом expand-all Grok показывает контекстную подсказку `ui.contextual_hints.thinking_collapse` (`26-config-reference.md:761`).

**Сравнение `@conarti/pi-ui` (`6e58ad8` против `HEAD` в `src/features/transcript/thinking-block.ts`):**
- **Что улучшилось в `HEAD` относительно `6e58ad8`**:
  - вместо шумной свёрнутой строки `❙ › Thought (N) — firstSnippet…` (`6e58ad8:158-169`) и микро-хинта `⌄ Thought  · клик свернуть` (`6e58ad8:175`) в `HEAD` выводится лаконичная метка `❙ › Thought for Xs` / `│ ⌄ Thought for Xs` с корректным замером времени по стриминг-событиям `thinking_end` / `text_start` / `toolcall_start` и fallback `Thought` на исторических записях (`thinking-block.ts:27-50,151-188,314-339`);
  - хвост стриминга сокращён с 4 до 3 строк (`STREAMING_THOUGHT_TAIL_LINES = 3`, `thinking-block.ts:24`), а отдельный таймер `65 ms` / 12 строк заменён общим планировщиком `30 fps` / `32` строки (`src/shared/animation-scheduler.ts`).
- **Где `HEAD` ухудшил восприятие или оставил пробелы**:
  1. **Перегруз полноценным `Markdown`-рендером (`createSoftThinkingMarkdown`, `thinking-block.ts:201-235,342-347`)**: в `6e58ad8:99-121` корпус `Thinking` очищался от `^#{1,6}\s+`, схлопывал лишние пустые строки и рендерился единым спокойным `dimBody` (`wrapTextWithAnsi` без блочных декораций). В `HEAD` внутри `Thinking` монтируется полноценный `Markdown`, который рисует кодовые блоки с отступами, голубой `codeFg` (`[128, 178, 218]`), высветленный жирный `strongFg` (`[156, 174, 200]`), списки и пустые строки между абзацами; в стриминге даже потребовался регулярный фильтр заборов ```` ``` ```` (`thinking-block.ts:302-304`). В итоге раскрытый и стримящийся `Thinking` выглядит почти как основной ответ.
  2. **Слишком агрессивный клик по телу раскрытого `Thinking` (`thinking-block.ts:357-365`)**: `press` перехватывается только на строке заголовка (`event.y === 0`), чтобы разрешить выделение текста в теле, однако одиночный `click` (`press` + `release` на одной ячейке без движения) срабатывает на **любой** строке `event.y` раскрытого блока и немедленно схлопывает его. Клик внутри тела для сброса выделения закрывает блок под курсором.
  3. **Рассинхрон с глобальным хоткеем `Ctrl+T` (`app.thinking.toggle`)**: в `AssistantMessageComponent` ручной клик записывает `self.thinkingVisibilityOverrides.set(runIndex, isExpanded)` (`thinking-block.ts:518-522`), а штатный переключатель Pi меняет только `self.hideThinkingBlock` без очистки `thinkingVisibilityOverrides` (и при `override === undefined` в `thinking-block.ts:482` жёстко форсирует `isExpanded = false`, из-за чего глобальное раскрытие всех `Thinking` через `Ctrl+T` в `HEAD` вообще перестало раскрывать блоки, у которых нет индивидуального `override`!).

### 1.3. Строки и группировка `Tool Calls`, `Tool Density`, превью диффов и вывода команд

**Как устроено в Grok CLI `1.0.92`:**
- **Индикаторы и типографика** (`06-theming.md:272-302`, `crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/{edit,execute_output,read,other}.rs`):
  - дефолтный маркер `bullet = "diamond"` (`◆`), свёрнутые строки приглушены (`muted_collapsed = true`), метаданные в скобках приглушены (`dim_details = true`);
  - shell-команды (`[scrollback.blocks.execute]`): заголовок `Running` / `Ran` (`header_style = "label"`), приглушённая команда в свёрнутом виде (`muted_command_collapsed = true`), анимированная левая линия во время выполнения (`accent_enabled = true`), усечённый превью вывода `first_lines = 2` + `…` + `last_lines = 3`;
  - диффы правок (`[scrollback.blocks.edit]`): `indent = true`, `vpad = false`, `hunk_separator = "…"`, `dual_line_numbers = false`, `bg = "none"`.
- **Пятиступенчатая шкала `Tool Density` (`/density`, `[ui] tool_call_density`, `04-slash-commands.md:169-190`, `26-config-reference.md:800`, `__TEXT,__const` `+1861900`)**:

| Метка в UI | Значение в конфиге | Правки (`edit`/`write`) | Команды (`bash`/code) | Группировка серий |
|---|---|---|---|---|
| `Detailed` | `detailed` | Показан inline-дифф | Показано превью `2 + … + 3` | Складываются чтения, поиски и прочие инструменты |
| `Diff focus` | `compact-shells` | Показан inline-дифф | 1 строка без вывода | Складываются чтения, поиски и прочие инструменты |
| `Balanced` | `compact-ungrouped` | 1 строка с `+N/-M` | 1 строка без вывода | Складываются чтения, поиски и прочие инструменты |
| `Grouped` | `compact-grouped` | 1 строка | 1 строка | Серии правок, серии команд и серии чтений складываются каждая отдельно |
| **`Compact` (дефолт)** | **`compact-all-grouped`** | **1 строка** | **1 строка** | **Любая непрерывная серия `Tool Calls` (вместе с завершёнными `Thinking` внутри неё) складывается в 1 сводную строку** |

- Примеры реальных сводных строк Grok (`04-slash-commands.md:183`, `__TEXT,__const` `+361860`, `+321400`): `Explored 3 files, 2 searches` и `Edited 2 files, ran 1 command +12 -4`. Одиночный вызов без соседних группируемых шагов всегда остаётся собственной строкой (`a lone tool call with nothing else to fold keeps its own row`).

**Где отошёл `@conarti/pi-ui` (`HEAD`, `src/features/tool-calls/`):**
1. **Инвертированный дефолт и отсутствие `Grouped` / истинного `Compact`**: в `src/features/tool-calls/types.ts` и `config.ts` реализованы только 3 уровня (`detailed`, `diff-focus`, `compact`) с дефолтом `detailed` — то есть по умолчанию включён самый многословный режим, от которого сам Grok ушёл на `compact-all-grouped`. Более того, режим `compact` в `pi-ui` (`density.ts:724-755`) соответствует лишь `Balanced` (`compact-ungrouped`) из Grok: если агент подряд отредактировал 6 файлов и запустил 4 теста, `pi-ui` даже в `Compact` выведет 10 отдельных строк (с пустыми строками между ними) вместо одной сводки `◆ Edited 6 files, ran 4 commands (+… -…)`.
2. **Три параллельных рендерера в одном модуле**: в `src/features/tool-calls/` одновременно поддерживаются `density.ts`, `claude.ts` и `codex.ts`/`codex-rows.ts` (`index.ts:103-113`, `grouping.ts:260-325`), хотя целевым языком пакета является единый `Tool Density`.
3. **Рыхлый вертикальный ритм между вызовами**: каждый `ToolExecutionComponent` в режиме `renderShell = "self"` добавляет сверху пустую строку `""` (`tool-execution.js:184`), и `ToolGroupController.drawDensity` также начинает массив с `""` (`grouping.ts:598`). В результате последовательность отдельных `Ran …` / `Edited …` распадается на разреженные островки с двойным шагом по вертикали вместо плотного компактного лога шагов.
4. **Нет hover-индикации на строках и сводных группах**: ни `DensityLiveLines` (`density.ts:465-494`), ни `ToolGroupComponent` (`grouping.ts:230-255`) не обрабатывают `event.type === "move"`, поэтому при наведении курсора мыши интерактивность раскрытия никак не считывается.

---

## 2. Карточки `User Prompt`, блоки кода `Markdown`, `Sticky Prompt` и `Outline Rail`

### 2.1. Карточки сообщений пользователя (`User Prompt`)

**Как устроено в Grok CLI `1.0.92`:**
- В `pager.toml` (`06-theming.md:304-312`): `[scrollback.blocks.prompt]` задаёт `vpad = true`, `bg = "light"` (однотонная приподнятая полоса на всю ширину контента; в терминальной теме — на один шаг от фона к тексту, `06-theming.md:27`), `show_prefix = true`, `min_lines = 2`.
- Временные метки регулируются `[ui] timestamps = "off" | "minimal" | "on"` (`04-slash-commands.md:615-619`, `26-config-reference.md:798-800`). Кнопка `Copy` поверх верхнего паддинга при наведении мыши **не рендерится**.
- При отправке нового сообщения `[ui] page_flip_on_send = true` (`05-configuration.md:83-85`) прокручивает отправленный промпт к верху экрана, чтобы ответ начинался с чистого листа.
- Вставленные изображения `[Image #N]` в отправленной карточке подсвечиваются как чип, если изображение реально ушло с запросом, и зачёркиваются, если ушёл только текстовый плейсхолдер (`03-keyboard-shortcuts.md:473`).

**Сравнение `@conarti/pi-ui` (`6e58ad8` против `HEAD` в `src/features/transcript/user-prompt.ts`):**
- В `HEAD` исправлены главные дефекты `6e58ad8`: убраны боковые поля `outerPad = 2` (теперь карточка идёт вровень с `Composer`), убран избыточный префикс `┃ › ` в пользу чистого `› `, добавлен верхний и нижний `vpad` по 1 строке, зарезервирован `timeGutterWidth` (`9` колонок при `width >= 32`) под `HH:MM`, чтобы строки не переносились при наведении, и поддержаны кликабельные `Prompt Chip` пилюли.
- **Что мешает восприятию в `HEAD`**:
  1. **Мигающий `Copy` в верхнем `vpad`-ряду (`user-prompt.ts:423-446`)**: при `hovered || copied` пустая верхняя строка паддинга (`y = 0`) заполняется справа кнопкой `Copy` / `✓ Copied` прямо над меткой времени `HH:MM` (`y = 1`). Из-за этого при проходе курсора мыши через ленту верхний воздух карточки вспыхивает текстом и создаёт двухэтажный правый угол (`Copy` над `12:40`).
  2. **Захардкоженный синий фон карточки (`user-prompt.ts:349-355`)**: вместо семантического токена темы (`userMessageBg` или производного от фона темы) тёмная карточка всегда красится в `[27, 35, 50]` (hover `[33, 43, 60]`), что на нейтрально-графитовом холсте (`#21252b`) даёт чужеродный синий оттенок.
  3. **Сырые `>`-цитаты**: многострочные `>`-цитаты внутри `User Prompt` и `Sticky Prompt` пока не рефлоуятся во вложенную плашку с вертикальной чертой (зафиксировано в открытом тикете [Reflowed nested Markdown blockquote callouts in User Prompt and Sticky Prompt](https://github.com/conarti/pi-ui/issues/22); в самом Grok для этого выделен отдельный модуль `crates/codegen/xai-grok-pager/src/scrollback/blocks/quote_bar.rs` с функцией `quote_rail_wrapped`).

### 2.2. Оформление блоков кода `Markdown`

**Как устроено в Grok CLI `1.0.92`:**
- Кодовые блоки подсвечиваются встроенными `.tmTheme` на спокойном фоне `md_code_bg` (`06-theming.md:172-183,365`).
- Кнопки действий рендерятся модулем `crates/codegen/xai-grok-pager/src/affordance/model.rs` (`MarkdownAffordances`, `affordance_rows`, `01-getting-started.md:161-166`, `__TEXT,__const` `+160900`):
  - строка действий (`[Copy]`, для таблиц `[Copy TSV]` `[Copy CSV]`, для цитат `[Copy]`) появляется **под блоком** и **только когда ответ завершён**;
  - пустые заборы кода, indented-код и вложенные цитаты не получают строку кнопок;
  - во время стриминга ответа кнопки отсутствуют, не отвлекая от чтения.

**Где перегружен `@conarti/pi-ui` (`HEAD`, `src/features/transcript/markdown-cards.ts:92-158,234-267`):**
- Каждый заборный блок кода (даже из 1 строки и даже у нетипизированного текстового забора без языка, где выводится заглушка `"code"`) получает полноширинную контрастную верхнюю шапку `codeHeaderBg` с постоянной надписью `Copy  ` справа и левую цветную рельсу `▎` на каждой строке тела.
- При движении мыши по *любой* строке кода (`markdown-cards.ts:319-323`) вся шапка перекрашивается в `codeHeaderActiveBg` с ярким акцентом `Copy  `. В ответах с 3–5 короткими примерами команд шапки создают тяжёлую «зебру», конкурирующую с заголовками разделов ответа.
- Палитра `DARK_SURFACE_PALETTE` / `LIGHT_SURFACE_PALETTE` в `src/shared/ansi.ts:187-270` захардкожена статическими RGB вместо вычисления поверх активной темы `Theme`.

### 2.3. `Sticky Prompt`, `Outline Rail` и правый скроллбар

**Как устроено в Grok CLI `1.0.92`:**
- **Правый край экрана не дублирует две шкалы сразу**: настройка `ui.show_timeline` (`26-config-reference.md:791`, описание в реестре `/settings` на `__TEXT,__const` `+1860322`) сформулирована буквально: *«Per-turn tick rail in place of the scrollbar: hover previews a turn, click jumps to it»*, и по умолчанию **выключена** (`default = false`), оставляя чистый скроллбар у самого края экрана (`[scrollback.scrollbar] gap_left = 0, gap_right = 0`, `06-theming.md:205-208`). Когда пользователь включает `/timeline`, `TimelineRail` (`TimelineRail::hit`, `render_tick_hover_popup`, `timeline_chevron_up`, `timeline_chevron_down`, глифы `▲`, `━━`, `══`, `━`, `╌`, `▼`) встаёт **вместо** скроллбара, а `Hover Popup` всегда показывает 24-часовое время (`26-config-reference.md:798`).
- **`Sticky Prompt`** (`[scrollback.display] sticky_headers = true`, `[scrollback.blocks.prompt] min_lines = 2`, функция `compute_sticky_layout`): закрепляет активный промпт сверху и разворачивается по двойному клику или `Enter` / `Ctrl+F` (`01-getting-started.md:160-161`, `03-keyboard-shortcuts.md:637`).

**Что удалось и где остались трения в `@conarti/pi-ui` (`HEAD`):**
- Позиционная архитектура `ADR-0002` (`src/shared/fullscreen-layout.ts`) по сравнению с `6e58ad8` работает чисто: `ScrollView` сохраняет 100% ширины и стабильный `viewportHeight`, `computeStickyPushOffset` плавно вытесняет `Sticky Prompt` следующим промптом, а коммит `81b9a5f` сохраняет под `Outline Rail` (`width - 3 .. width - 2`) истинный цвет фона карточки.
- **Точки трения для прототипирования**:
  1. **Тройное соседство в правом верхнем углу (`HH:MM` + `Outline Rail` + скроллбар)**: когда `Outline Rail` включён по умолчанию одновременно со скроллбаром, в последних 10 колонках экрана скапливаются время промпта, `▲`/`──`/`▼` рельсы и ползунок скроллбара.
  2. **Безусловный перехват одиночного клика на `Sticky Prompt` (`src/features/sticky-prompt/index.ts:157-179`)**: `StickyPromptBar.handleMouse` поглощает `press` и переключает `toggleExpanded()` по одиночному левому клику на *любом* активном промпте — даже если промпт состоит из 1 короткой строки (`truncated === false`) и разворачивать в нём нечего! Кроме того, у усечённого 3-строчного `Sticky Prompt` нет явного визуального индикатора сворачивания/разворачивания, кроме тихого многоточия `…`.
  3. **Коллизия хоткея `Ctrl+O` (`app.tools.expand`)**: `bindStickyExpandKey` (`sticky-prompt/index.ts:298-314`) слушает `app.tools.expand`, поэтому каждое нажатие `Ctrl+O` для раскрытия вывода инструментов неожиданно переключает и `Sticky Prompt`.

---

## 3. Мышь, видимый текстовый курсор и контекстные подсказки хоткеев

### 3.1. Полнота управления мышью: клики, hover, выделение, копирование и прокрутка

**Как устроено в Grok CLI `1.0.92`:**
- **Выделение и копирование в ленте** (`crates/codegen/xai-grok-pager/src/scrollback/text_selection.rs`, `03-keyboard-shortcuts.md:627-646`, `06-theming.md:349`, `settings_cache.json`):
  - ячейки выделения инвертируются по месту;
  - при протяжке мыши (`drag`) через несколько блоков свёрнутые строки `Tool Calls`, сводки `Explored …`, свёрнутые `Thinking` и маркер `Worked for …` **пропускаются**, поэтому протяжка сверху вниз копирует чистый текст промпта и ответа без служебного мусора (`03-keyboard-shortcuts.md:630`);
  - дефолтный режим `ui.keep_text_selection = "word_select"` (`settings_cache.json`): двойной клик по сообщению выделяет и копирует слово, тройной — логическую строку со всеми визуальными переносами; подсветка держится до `Esc`, клика или скролла; при этом двойной клик по строке `Tool Calls`, группе или `Thinking` всегда переключает их сворачивание (`03-keyboard-shortcuts.md:637-638`);
  - при копировании сообщений на daemon-маршруте инлайн-код автоматически оборачивается обратно в `` `backticks` `` (`ui.copy_inline_code_backticks = true`, кроме копирования внутри одного спана кода, чтобы команда вставлялась в shell чисто, `03-keyboard-shortcuts.md:632`).
- **Интерактивные поверхности**: все списки, пикеры, вкладки и модальные окна обрабатывают `move` (`row_hover_bg` / reverse-video на выбранной и наведённой строке, `06-theming.md:27`), клик по пункту/кнопке и колесо прокрутки (`handle_modal_mouse`, `select_slash_hovered`, `hovered_stop_button_rect`, `update_row_hover`). В `Composer` двойной клик по чипу вставки разворачивает его (`double-click to expand`, `expand_paste_element_at_cursor`, `prompt_widget/mod.rs:2755`).

**Конкретные пробелы мышиного управления в `@conarti/pi-ui` (`HEAD`):**
1. **`ask_user_question` (`src/features/ask-user/questionnaire.ts:173-190`) — 0% кликов и hover**:
   - `Questionnaire.handleMouse` обрабатывает *исключительно* `wheel` / `mouse_wheel_up` / `mouse_wheel_down` (и даже это отключается при `this.editing || this.confirming` на строке `174`!).
   - Нельзя кликнуть мышью: ни по вариантам ответа `1..N`, ни по чекбоксам мультивыбора `[✔]`, ни по строке своего ответа (`Type something.`), ни по кнопке `Submit` / `Next`, ни по `Explain this question` / `Chat about this`, ни по верхним вкладкам вопросов `← ☐ Q1 ☐ Q2 ✔ Submit →` (`questionnaire.ts:413-425`), ни по строкам экрана `Review your answers` (`Submit answers` / `Cancel`), ни по диалогу `Keep editing` / `Discard answers`. Нет и hover-подсветки строк.
2. **`Prompt Suggestion` в `Composer` (`src/features/prompt-suggestion/index.ts:71-86`, `composer.ts:818-829`)**:
   - Подсказка принимается только клавишами `Tab` / `→` и отклоняется `Esc`. У пользователя, работающего мышью, нет способа ни принять `Prompt Suggestion` кликом (клик по пустому `Composer` лишь фокусирует редактор), ни увидеть кликабельную пилюлю действия.
3. **`Prompt Chip` в `Composer` (`src/features/prompt-chips/index.ts:285-360`, `composer.ts:880-954`)**:
   - В отправленной карточке `User Prompt` пилюля кликабельна (открывает/закрывает `PromptChipPreviewPopup`), а в самом `Composer` клик лишь ставит каретку перед чипом; двойной клик по чипу `[❝ Quote #N …]` не открывает редактирование этой цитаты в `Quotes` `Modal Card`, а двойной клик по `[📋 Pasted #N …]` не разворачивает вставленный текст.
4. **Редактор цитаты в `Quotes` `Modal Card` (`src/features/quotes/quotes-modal.ts:490-523`)**:
   - В режиме `mode === "inspect"` клик по строке выбирает цитату, а двойной клик (`clickCount >= 2`) открывает `mode === "edit"`. Но внутри `mode === "edit"` `handleMouse` проверяет только футерные пилюли `card.handleMouse(event)` и полностью игнорирует клики/колесо по строкам встроенного `editBuffer` (`Editor`), не позволяя поставить курсор мышью внутри редактируемой цитаты.
5. **Отсутствие колеса прокрутки в `Context Inspector` (`src/features/context-inspector/index.ts:214-217`)**: на невысоких сплитах терминала тело модалки не скроллится колесом.
6. **Протяжка выделения в `TuiAltScreen`**: поскольку `TuiAltScreen` выделяет экранные строки кадра целиком (маскируются только `Sticky Prompt`, `Outline Rail` и видимые оверлеи в `src/shared/fullscreen-layout.ts`), протяжка мыши через ответ с промежуточными вызовами захватывает все свёрнутые строки `◆ Read …` / `◆ Explored …` и `❙ › Thought for Xs`.

### 3.2. Видимый текстовый курсор во всех полях ввода

**Как устроено в Grok CLI `1.0.92` и в хосте Pi TUI:**
- В Grok CLI `1.0.92` терминальный курсор окрашивается в `accent_user` через `OSC 12` при старте и смене темы и сбрасывается через `OSC 112` при выходе (`06-theming.md:144-152`, функция `apply_cursor_color`), а внутри виджетов ввода всегда рисуется явная каретка (в `1.0.90` отдельно исправлен крайний случай пропадания каретки при заполнении последней строки промпта, `CHANGELOG.md:53`).
- В `@earendil-works/pi-tui` (`dist/tui.js:69-78,255,1185-1191`) действует другой контракт: **по умолчанию аппаратный курсор терминала выключен (`showHardwareCursor = false`)**, а видимый курсор создаётся вызовом `renderFakeCursor(grapheme)`, который оборачивает символ под курсором в zero-width APC-маркеры `FAKE_CURSOR_START` (`\x1b_pi:fc\x07`) и `FAKE_CURSOR_END` (`\x1b_pi:/fc\x07`). В конце рендера `TuiBase.resolveFakeCursors()` превращает их в reverse-video `\x1b[7m...\x1b[27m`, а `CURSOR_MARKER` (`\x1b_pi:c\x07`) используется только для расчёта координат IME.

**Первопричина пропажи курсора в `ask_user_question` и дефекты остальных полей в `@conarti/pi-ui`:**
1. **Полностью невидимый курсор в `ask_user_question` (`src/features/ask-user/display.ts:4-12` и `questionnaire.ts:304,347-352`)**:
   - И многострочный редактор заметки (`this.editor.render(width).map(editorDisplay)`), и поле своего ответа (`editorDisplay(input.render(...)[0].trimEnd())`) пропускаются через `editorDisplay()` в `src/features/ask-user/display.ts:9-12`:
     ```ts
     export function editorDisplay(line: string): string {
       return line.split(/(\x1b\[[\d;:]*m|\x1b_pi:c\x07)/g)
         .map(part => part === CURSOR_MARKER || /^\x1b\[[\d;:]*m$/.test(part) ? part : display(part)).join("");
     }
     ```
   - `editorDisplay` сохраняет только SGR-коды `\x1b[...m` и `CURSOR_MARKER` (`\x1b_pi:c\x07`), а всё остальное передаёт в `display()`, чей regex `/\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\|$)/g` **удаляет все APC-последовательности `\x1b_...`, включая `FAKE_CURSOR_START` (`\x1b_pi:fc\x07`) и `FAKE_CURSOR_END` (`\x1b_pi:/fc\x07`)**!
   - Дополнительно на строке `questionnaire.ts:351` вызов `.trimEnd()` срезает хвостовой пробел `" "` в конце `Input.render()`, на котором должен был рисоваться курсор в конце набранного текста, а затем `choice()` (`questionnaire.ts:294`) перекрашивает всю строку в однотонный `theme.fg("accent", text)`.
   - Поскольку `TuiBase.showHardwareCursor === false`, после удаления `FAKE_CURSOR_START`/`FAKE_CURSOR_END` **ни в поле `Type something.`, ни в редакторе заметки `Question note` нет вообще никакого видимого курсора**.
2. **Урезанный самописный `createSingleLineInput` в `Command Palette` и `Plan Studio` (`src/shared/modal-card.ts:128-188`)**:
   - Курсор в нём виден (`renderFakeCursor(" ")`), но на пустом поле ставится пробелом *перед* плейсхолдером (`[█]Поиск команд…`), сдвигая плейсхолдер на 1 символ, вместо инверсии первой графемы плейсхолдера, как сделано в `PiUiComposerEditor.renderEmptyPlaceholderCell` (`src/features/chrome/composer.ts:766-777`) и в штатном `Input` (`@earendil-works/pi-tui/dist/components/input.js:349-358`).
   - Ещё серьёзнее: `createSingleLineInput.handleInput` (`modal-card.ts:141-164`) поддерживает только `Ctrl+U` и `Backspace` с конца строки — в нём **нет перемещения курсора `←`/`→`, `Home`/`End`, удаления слов `Alt+Backspace`/`Ctrl+W`, `Undo` и полностью сломана вставка `Cmd+V`/`Ctrl+V`**, так как проверка `!data.startsWith("\x1b")` на строке `156` отбрасывает весь поток bracketed paste `\x1b[200~...\x1b[201~`. Штатный `Input` из `@earendil-works/pi-tui` решает все эти задачи из коробки.

### 3.3. Контекстные подсказки хоткеев в `Composer`, опросниках и оверлеях

**Как устроено в Grok CLI `1.0.92`:**
- **Контекстная `Shortcuts Bar` и адаптивный футер `Composer`** (`03-keyboard-shortcuts.md:86,112-135,200,615-623,693-702`, функции `compute_effective_hints`, `shortcuts_hints`, `fit_hints_to_width`, `ShortcutsBar::compact`, `render_modal_shortcuts`):
  - на пустом `Composer` в покое интерфейс остаётся предельно тихим (плейсхолдер `? Build anything` / `Type a message…`, минимум базовых хинтов);
  - как только появляется `Prompt Suggestion`, показывается явная подсказка принятия (`Tab` / `→` `accept suggestion`, `__TEXT,__const` `+1435820`);
  - как только черновик становится непустым, футер `Composer` показывает ровно актуальную пару клавиш: `Shift+Enter` (или `Alt+Enter` по SSH / без KKP) для переноса строки рядом с `Enter:send` (или `Enter:queue` во время активного хода, плюс аккорд немедленной отправки `Ctrl+Enter` / `Enter Enter`, `03-keyboard-shortcuts.md:693-702`);
  - пока в ленте активно выделение текста мышью, первым хинтом встаёт `Ctrl+L` (`add to chat`, `03-keyboard-shortcuts.md:86`);
  - когда открыта карточка вопроса `ask_user_question`, `Permission Prompt` или `Plan Approval`, полоса подсказок показывает **только** клавиши активной карточки (`↑/↓`, `Tab`, `1-9`, `z` для перехода к свободному ответу `z Type your answer here`, `Ctrl+E` для раскрытия `Thinking` позади карточки, `Esc` для снятия выбора / парковки фокуса в ленту с закреплённым возвратным хинтом `Tab: question`, `03-keyboard-shortcuts.md:186-210`, `__TEXT,__const` `+351960`).
- **Событийные `ui.contextual_hints.*`** (`26-config-reference.md:756-763`): короткие ситуативные подсказки только в момент действия (`Ctrl+Z` после очистки черновика, `Shift+Tab` для `Plan` на планировочном запросе, `Enter` на пустом промпте после постановки сообщения в очередь, вставка изображения из буфера).

**Где разошёлся `@conarti/pi-ui` (`6e58ad8` против `HEAD`):**
1. **От крайности постоянного шума к полному молчанию в `Composer`**: в `6e58ad8` (`composer.ts:154-158`) при непустом тексте прямо в нижнюю горизонтальную линию рамки врезалось ` ⌥↵ строка · ↵ отправить `. В `HEAD` (`src/features/chrome/composer.ts:843`) нижнюю рамку сделали полностью глухой (`╰─── … ───╯`), но не добавили спокойную контекстную строку подсказок под/у рамки. В результате:
   - когда появляется `Prompt Suggestion` (`prompt-suggestion/index.ts:71-86`), она рисуется тем же `theme.fg("dim", ...)` в ячейке плейсхолдера **без единого намёка**, что её принимает `Tab` или `→`, а скрывает `Esc`;
   - при непустом черновике и во время стриминга агента не видно ни клавиши переноса строки (`Shift+Enter` / `Alt+Enter`), ни режима отправки (`Enter` в очередь vs steer);
   - при наличии активных чипов `[❝ Quote #N …]` не подсказана команда/хоткей управления цитатами (`/quotes`), а на плавающем `Hover Popup` выделения `╭ ❝ Цитировать ╮` (`src/features/quotes/selection-popup.ts:40`) не указан хоткей `Alt+Q`.
2. **Языковой и визуальный разнобой опросника и модалок**:
   - `ask_user_question` (`src/features/ask-user/questionnaire.ts:297-378`) целиком англоязычный (`Type something.`, `Explain this question`, `Chat about this`, `Enter select · ↑/↓ navigate · Tab/←→ switch · N note · Esc cancel`), визуально не оформлен в единую карточку с остальными поверхностями и показывает неочевидный `N note`, перехватывающий букву `n` вне режима ввода;
   - в `Command Palette` (`src/features/command-palette/index.ts:179,336`) осталась устаревшая подсказка `Shift+Tab` у пункта `Уровень рассуждений` (конфликтующая с переносом `Session Mode` на `Shift+Tab` и `Thinking` на `Alt+T` во второй спеке) и текстовый футер вместо единого стандарта футера `Modal Card`;
   - в `Quotes` `Modal Card` (`src/features/quotes/quotes-modal.ts:340-367,465-487`) пилюли подписаны `Изменить`, `Удалить`, `Очистить все`, `Закрыть` **без указания рабочих клавиш** (`Enter`/`e`, `Del`/`d`, `c`, `Esc`), хотя в `Context Inspector` (`context-inspector/index.ts:192-204`) и `Plan Studio` (`studio-overlay.ts:169-203`) клавиши и эмодзи вшиты прямо внутрь текста пилюль (`⚡ Сжать контекст (c)`), а над планом в `Plan Studio` (`studio-overlay.ts:103`) висит длинная обучающая фраза.

---

## 4. Практические выводы для последующих тикетов

### Для тикета [Редизайн Thinking и вывода агента / Tool Calls в ленте](https://github.com/conarti/pi-ui/issues/33)

1. **Вернуть корпусу `Thinking` тихую плоскую подачу из `6e58ad8`, сохранив таймер и волну из `HEAD`**:
   - отказаться от полноразмерного `Markdown` с кодовыми заборами и пустыми строками внутри `ThinkingBlock` в пользу компактного однотонного обёрнутого текста (либо строго плоского inline-форматирования с сильным смешиванием к фону по принципу `bg_blend = 70`), шириной до `120` колонок и хвостом в `3` строки при стриминге;
   - сохранить свёрнутую строку `❙ › Thought for Xs` (`Thought` без длительности для старых записей) и `30 fps` / `32`-строчную волну `animation-scheduler.ts`;
   - ограничить сворачивание раскрытого `Thinking` кликом по строке заголовка `⌄ Thought for Xs` (либо двойным кликом по заголовку/тексту, игнорируя пустые поля и рельсу `│`), чтобы одиночный клик при чтении/выделении тела не схлопывал блок;
   - синхронизировать `Ctrl+T` (`app.thinking.toggle`) с `thinkingVisibilityOverrides` (очищать ручные overrides при глобальном переключении, как `Ctrl+E` в Grok).
2. **Довести `Tool Density` и группировку `Tool Calls` до реальной модели Grok `1.0.92`**:
   - добавить группировку серий мутирующих и командных вызовов (`Edited N files, ran M commands (+A -R)`) со складыванием завершённых промежуточных `Thinking` внутрь серии, и пересмотреть дефолтный пресет `Tool Density` (в Grok дефолт — компактная группировка серий, а не `Detailed`);
   - убрать лишние пустые строки между соседними компактными строками `Tool Calls`, чтобы серия шагов читалась единым плотным блоком, а главный ответ отделялся от неё чистым отступом;
   - добавить `move` hover-подсветку на кликабельные строки `Tool Calls` и сводные строки групп;
   - убрать мигающий поверх первой строки ответа бейдж `Copy` в `markdown-cards.ts` (перенести копирование ответа на явное действие уровня ответа/хода без обрезки текста `sliceByColumn`).

### Для тикета [Выравнивание карточек реплик, Markdown-кода, Sticky Prompt и Outline Rail](https://github.com/conarti/pi-ui/issues/34)

1. **Карточка `User Prompt`**:
   - убрать появление `Copy` в верхней строке `vpad` (`y = 0`) над `HH:MM`, чтобы верхний и нижний `vpad` всегда оставались чистым воздухом (либо совместить действие копирования с мета-зоной без прыжка по высоте, либо вынести из `vpad`);
   - отвязать цвет поверхности карточки и блоков кода (`src/shared/ansi.ts`, `user-prompt.ts`) от захардкоженного синего RGB `[27, 35, 50]` в пользу адаптивного вычисления от активной темы `Theme` (`userMessageBg` / `mixColors`), чтобы на нейтрально-графитовой палитре не возникало чужеродного тёмно-синего пятна;
   - учесть в композиции карточки будущий рефлоу вложенных `>`-цитат ([Reflowed nested Markdown blockquote callouts in User Prompt and Sticky Prompt](https://github.com/conarti/pi-ui/issues/22)).
2. **Блоки кода `Markdown`**:
   - облегчить подачу fenced-блоков кода: отказаться от тяжёлой полноширинной шапки на каждом коротком сниппете и постоянного свечения `Copy` во время стриминга (рассмотреть компактную нижнюю `affordance`-строку после завершения ответа как в Grok `1.0.92`, либо минималистичную метку языка без полноширинной цветной полосы).
3. **`Sticky Prompt` и `Outline Rail`**:
   - в `Sticky Prompt`: пропускать клик/разворачивание только когда промпт реально усечён (`truncated === true` или уже раскрыт), добавить явный спокойный шеврон состояния (`›` / `⌄`) и отвязать `bindStickyExpandKey` от `app.tools.expand` (`Ctrl+O`);
   - в `Outline Rail`: решить конфликт одновременного показа `HH:MM` + `Outline Rail` + нативного скроллбара в последних колонках (в Grok `TimelineRail` заменяет скроллбар и выключен по умолчанию, либо требует разнесения/уплотнения правой зоны).

### Для тикета [Единый стандарт мыши, видимого курсора и подсказок хоткеев в Composer и модалках](https://github.com/conarti/pi-ui/issues/35)

1. **Немедленное исправление видимого курсора и однострочного ввода**:
   - в `src/features/ask-user/display.ts:9-12` обновить `editorDisplay`, чтобы сохранять `FAKE_CURSOR_START` (`\x1b_pi:fc\x07`) и `FAKE_CURSOR_END` (`\x1b_pi:/fc\x07`), убрать `.trimEnd()` после `input.render()` в `questionnaire.ts:351` и не затирать внутренние SGR курсора внешним `theme.fg("accent", ...)` в `choice()`; визуально выделить строку своего ответа как поле ввода даже до начала печати;
   - заменить урезанный `createSingleLineInput` в `src/shared/modal-card.ts` на обёртку вокруг штатного `Input` из `@earendil-works/pi-tui` (возвращает `←`/`→`, `Home`/`End`, `Alt+Backspace`/`Ctrl+W`, `Undo`, bracketed paste `Cmd+V`/`Ctrl+V` и каретку поверх первой графемы плейсхолдера).
2. **Сквозное управление одной мышью**:
   - в `ask_user_question` (`questionnaire.ts`): реализовать полноценный `handleMouse` (`move` hover + `press`/`click`) по вариантам ответа, чекбоксам мультивыбора, полю своего ответа, вкладкам вопросов `← … →`, кнопкам `Submit`/`Next`, `Explain`, `Chat` и подтверждению отмены;
   - в `Composer`: дать мышиный способ принять `Prompt Suggestion` (например, кликабельный чип-хинт `⇥ Tab` рядом с подсказкой) и поддержать двойной клик по `Prompt Chip` цитаты/вставки (открытие редактора цитаты в `Quotes` / разворачивание текста вставки);
   - в `Quotes` `Modal Card` (`quotes-modal.ts`): пробрасывать события мыши в `editBuffer.handleMouse` при `mode === "edit"`, а в `Context Inspector` добавить прокрутку колесом на малых высотах.
3. **Единая система ненавязчивых контекстных подсказок хоткеев и язык UI**:
   - ввести спокойную контекстную строку подсказок у `Composer` (по образцу Grok: показывать `Tab` / `→` только пока видна `Prompt Suggestion`; показывать `Shift+Enter` / `Alt+Enter` + `Enter` только при непустом черновике или активном ходе; на `Hover Popup` выделения показывать `╭ ❝ Цитировать · Alt+Q ╮`);
   - унифицировать язык `ask_user_question` (русский в соответствии с остальными поверхностями `@conarti/pi-ui`) и привести футеры всех `Modal Card` (`Command Palette`, `Context Inspector`, `Quotes`, `Plan Studio`) к единому безэмодзийному формату кликабельных действий с консистентными подписями клавиш (исправив устаревший `Shift+Tab` в `Command Palette`).

### Для сборки спеки [Сборка и границы спеки выравнивания базового TUI (Эшелон 1)](https://github.com/conarti/pi-ui/issues/36) и связи со вторым эшелоном

- Выделить общую палитру поверхностей (`src/shared/ansi.ts`) так, чтобы Эшелон 1 убрал захардкоженные тёмно-синие RGB карточек/кода и опёрся на токены активной `Theme`, а Эшелон 2 ([Spec: OS Appearance Auto-Sync, built-in Status Bar, curated One Blue themes, Grok Plan & Auto governance, Settings Modal, and quote cards](https://github.com/conarti/pi-ui/issues/16)) бесшовно подставил выверенные темы `one-blue-dark` / `one-blue-light` и перенёс `Status Bar` под контекстные подсказки `Composer` без переделки геометрии.
- Покрыть новые инварианты на реальном `InteractiveMode` (`tests/harness/interactive-harness.ts` согласно `ADR-0006`): наличие `\x1b[7m` (разрешённого `renderFakeCursor`) в рендере `ask_user_question`, прохождение `ask_user_question` исключительно кликами мыши через SGR-последовательности `VirtualTerminal`, отсутствие схлопывания раскрытого `Thinking` при клике по телу и работу `Cmd+V`/стрелок в поисковой строке `Command Palette`.
