# `@conarti/pi-ui`

Современный модульный UI-пакет для **Pi Coding Agent** от **conarti**: продуманная типографика ленты чата, карточки кода с копированием мышкой, живая волна рассуждений, закреплённый сверху активный промпт, правая навигация по репликам (бок о бок с нативным скроллбаром), компактные строки инструментов, интерактивный опросник `ask_user_question`, студия планирования с построчными комментариями и синие темы без фиолетового.

## Установка

```bash
pi install git:github.com/conarti/pi-ui
```

Для локальной разработки пропишите путь к репозиторию (`~/Projects/pi-ui`) в `packages` внутри `~/.pi/agent/settings.json`.

## Архитектура пакета

```text
pi-ui/
├── package.json                  # Pi-манифест (@conarti/pi-ui): расширения + темы
├── themes/                       # Синие цветовые темы
│   ├── one-blue-pro.json
│   ├── one-blue-light.json
│   ├── nordic-ocean.json
│   └── midnight-cobalt.json
└── src/
    ├── index.ts                  # Точка входа: регистрация и композиция всех фич
    ├── shared/                   # Общее ядро без привязки к конкретной фиче
    │   ├── ansi.ts               # TrueColor, карточки, пилюли, определение светлой/тёмной темы
    │   ├── runtime-hooks.ts      # Reload-safe hookMethod, координатор hover, буфер обмена
    │   ├── session-store.ts      # Реактивный стейт режимов и планов с сохранением в сессию
    │   └── fullscreen-layout.ts  # Единый VStack/HStack каркас (Sticky + ScrollView + OutlineRail)
    └── features/
        ├── transcript/           # Оформление сообщений чата
        │   ├── user-prompt.ts    # Карточки пользователя (поля, грань `┃ ›`, hover Copy)
        │   ├── markdown-cards.ts # Двухтоновые карточки кода + Copy и заголовки без `###`
        │   ├── thinking-block.ts # Блоки мыслей (120 кол., волна `┃`, сворачивание по клику)
        │   └── index.ts
        ├── tool-calls/           # Рендер вызовов тулзов (Tool Density / Silent)
        │   ├── index.ts          # Оркестрация, команды /compact-tools и /silent
        │   ├── config.ts         # Настройки стилей и авто-компакта тулзов
        │   └── ...               # Модули рендера строк, группировки и диффов
        ├── ask-user/             # Интерактивный опросник ask_user_question с превью и пояснениями
        │   ├── questionnaire.ts  # TUI-компонент опросника (без ложной блокировки на nonCapturing оверлеях)
        │   └── index.ts          # Регистрация тулза ask_user_question
        ├── sticky-prompt/        # Закреплённый активный промпт сверху при прокрутке
        │   ├── prompt-locator.ts # Поиск позиций реплик в транскрипте
        │   └── index.ts          # StickyPromptBar + /sticky
        ├── outline-rail/         # Правая панель навигации по репликам (рядом со скроллбаром)
        │   ├── turn-tracker.ts   # Индексация реплик и переходы по транскрипту
        │   ├── rail-view.ts      # Геометрия рисок ▲/━━/─/▼ и карточка превью
        │   └── index.ts          # Оверлей превью + /outline + Ctrl+Alt+O
        ├── chrome/               # Обрамление экрана
        │   ├── header.ts         # Однострочная шапка сессии
        │   └── composer.ts       # Поле ввода (Option+Enter newline, волна генерации, hover рамки)
        ├── plan-approval/          # Режим планирования без воды, построчные комменты и Auto-Safe
        │   ├── approval-overlay.ts # Оверлей ревью плана с комментариями под строками
        │   └── index.ts          # Хуки режимов, виджет прогресса, /plan и /mode
        ├── command-palette/      # Единое меню команд и тем (Ctrl+K, /palette)
        │   └── index.ts
        └── context-inspector/    # Визуальная разбивка контекста и токенов (/context)
            └── index.ts
```

## Основные команды и шорткаты

- **`Ctrl+K`** / `/palette` — единая палитра команд, режимов, тем и скиллов
- **`Alt+M`** / `/mode [code|plan|safe]` — переключение режимов
- **`Ctrl+Alt+P`** / `/plan [on|off|review|run|clear]` — Plan Mode и Plan Approval с построчными комментариями
- **`/context`** — инспектор заполнения контекстного окна
- **`/sticky`** — управление закреплённым сверху промптом
- **`Ctrl+Alt+O`** / `/outline` — показать / скрыть правую панель навигации по репликам
- **`/compact-tools`** и **`/silent`** — настройка стиля строк вызова инструментов
