# Задача установки для агента

Выполните эти этапы после получения или обновления `serpens-sdd`. Останавливайтесь
при любой ошибке. Сохраняйте команды и вывод в отчёте проекта. Во время установки
не удаляйте и не переписывайте существующие репозитории, ветки и локальную работу.

## 0. Требования к окружению, входные данные и устойчивые пути

Сначала докажите наличие инструментов. Каждая строка должна вывести версию; иначе
установка останавливается. Иначе сбой всплывёт посреди этапа 3, когда хранилище
уже заполнено наполовину:

```bash
git --version        # >= 2.13, нужен `submodule --branch`
node --version       # >= 18, на нём работают .mjs-проверки
lefthook version     # ставится из разрешённого внутреннего источника
```

CLI OpenSpec закреплён и внутренний. Пакет называется `@fission-ai/openspec`.
Короткое имя `openspec` в публичном реестре — чужая пустышка версии `0.0.0`: она
установится молча и работать не будет. Запишите закреплённую версию в
`port-facts.md` и один раз докажите её:

```bash
npx @fission-ai/openspec@<закреплённая-версия> --version
```

`@fresh-fx59/serpens-sdd` установлен, и `serpens-sdd version` печатает редакцию `2026-09-11.1`.
Node >= 18. Ни один шаг этой процедуры не копирует скрипт в репозиторий.

В закрытой сети берите пакет из разрешённого внутреннего зеркала и укажите в отчёте,
какой реестр был использован.

Получите `<project-id>`, название корпоративного порта агента, закреплённую версию
OpenSpec, URL и согласованную базовую ветку системного хранилища, доступ к forge.
В корне `serpens-sdd` выполните:

```bash
export SERPENS_SDD_ROOT="$(git rev-parse --show-toplevel)"
export SERPENS_WORKSPACE_ROOT="$(cd "$SERPENS_SDD_ROOT/.." && pwd -P)"
export SERPENS_SYSTEM_STORE_ROOT="${SERPENS_SYSTEM_STORE_ROOT:-$SERPENS_WORKSPACE_ROOT/system-store}"
test -d "$SERPENS_SDD_ROOT/system-store-template"
test "$SERPENS_SYSTEM_STORE_ROOT" != "$SERPENS_SDD_ROOT"
```

Переменные заменяют пути конкретной машины. `system-store` должен находиться
рядом с `serpens-sdd`, а не внутри него.

`<serpens-sdd> index-code` дополнительно требует **Universal Ctags** (`ctags --version` должен печатать
`Universal Ctags`; BSD ctags отвергается по бренду специально — на нём поиск `sym:` умирает
молча) и индексатор Zoekt. И то и другое опционально: без поиска по коду остальной набор
работает.
## 1. Найдите репозитории для `<project-id>`

Это первое действие после определения корней. Получите список доступных MCP-инструментов.
Если есть инструмент привязок репозиториев проекта, вызовите его с `<project-id>`.
Включите только репозитории, привязанные к этому проекту. Нормализуйте ответ:

```json
{
  "schema_version": 1,
  "project": "<project-id>",
  "repository_source": "mcp",
  "repositories": [
    {"name": "service-a", "url": "ssh://git@forge/project/service-a.git", "base_branch": "develop"}
  ]
}
```

Ручной резервный путь: если MCP отсутствует, недоступен или не отдаёт привязки,
соберите такую же JSON-структуру прямо на месте — `schema_version`, `project`,
`repository_source: "manual"` и `repositories[]`, заполненные из проекта forge —
и запишите её как поле `repositories` (и `facts.repository_source`) конфига,
с которым запускается `<serpens-sdd> init`, а не как отдельный файл.
Установка продолжается; в отчёте укажите выбранный источник.

Используйте базовую ветку из MCP, если она передана. Иначе выберите `develop`,
если такая удалённая ветка существует, затем символическую ветку по умолчанию.
Не делайте вывод по текущей рабочей копии. До записи проверьте уникальные безопасные
имена, непустые URL и корректные имена веток Git.

## 2. Исследуйте порт агента до установки

Проверьте реальный порт и запишите доказательства в копию `templates/port-facts.md`:

1. каталог конфигурации и имя файла проектных инструкций;
2. каталог и формат команд, синтаксис вызова и токен аргументов;
3. каталог навыков и автоматическую загрузку проектных навыков;
4. точный вызов OpenSpec CLI, доказанный запуском: процесс использует подкоманды CLI
   (`new change`, `status`, `instructions`, `validate`, `archive`), а не slash-команды агента —
   они меняются от версии и профиля;
5. названия MCP-инструментов проекта, трекера, wiki и поиска кода;
6. поддержку хуков, предел контекста и версию агента.

Не предполагайте имя домашнего каталога агента, slash-команды и имена MCP — этот набор
их намеренно не называет: один и тот же набор ставится на порты, где каталог и файл
инструкций называются по-разному. Один раз инициализируйте OpenSpec на временных данных
закреплённым внутренним пакетом и изучите созданные файлы.

Два из этих фактов читает сама тулинг-часть, поэтому запишите их машиночитаемо, а не только
прозой:

```bash
git -C "$REPO" config serpens.agentDir "<найденный каталог агента, напр. .acme>"
```

`<serpens-sdd> lint` определяет домашний каталог агента в таком порядке: `SERPENS_AGENT_DIR`, затем
`git config serpens.agentDir`, затем единственный dot-каталог в корне репозитория, внутри которого
есть подкаталог `skills/`. Если их больше одного — он выходит с кодом 1, а не угадывает. Файл
проектных инструкций порта — аналог `AGENTS.md`, как бы порт его ни называл — настраивать не
нужно: линт берёт любой `.md` в корне, имя которого записано ЗАГЛАВНЫМИ, кроме обычных
проектных файлов (README, LICENSE, CHANGELOG, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, NOTICE).
Запишите оба имени в `port-facts.md` (P1), чтобы человек, читающий заметку, их знал.

Установленные команды вызывают **CLI** OpenSpec, а не сгенерированные slash-команды.
Slash-команды различаются от версии и профиля: в профиле core у OpenSpec 1.10 есть только
`propose, explore, apply, update, sync, archive`, а `new`, `continue` и `verify` нет вовсе.
Шесть вызовов CLI ниже стабильны и машиночитаемы. Запишите ОДИН токен — точный вызов
закреплённого пакета:

```text
<openspec>
```

Подставьте то, что реально работает на этой машине, например
`npx @fission-ai/openspec@<pinned-version>` или внутреннюю обёртку в PATH, и докажите все
шесть вызовов, которые использует процесс:

```bash
<openspec> new change spns-probe
<openspec> status --change spns-probe --json
<openspec> instructions proposal --change spns-probe --json
<openspec> instructions specs --change spns-probe --json
<openspec> instructions apply --change spns-probe --json
<openspec> validate spns-probe --type change --strict --json
<openspec> archive --help
<openspec> store --help
<openspec> show --help
<openspec> list --help
```

Вызовы со стором нельзя доказать, пока стора нет, поэтому докажите их в конце этапа 3 на
зарегистрированном сторе: `store register`, `store list`,
`show <change-id> --type change --store <id> --json --deltas-only`,
`show <spec-id> --type spec --store <id>`, `list --specs --store <id>` и
`instructions specs --change <id> --store <id> --json`. Записывайте каждый доказанный вызов
с выводом в `port-facts.md`.

Затем удалите пробное изменение. Запишите подставленный токен и шесть доказанных вызовов
в `port-facts.md`.

Внешний Superpowers не требуется. Используйте самостоятельные файлы
`skills/spns-*`. Если порт не поддерживает навыки, вставьте тело каждого нужного
навыка в установленную команду и удалите строку `Follow skill ...`.

## 3. Создайте или проверьте соседнее системное хранилище

Три случая, и выбирает машина: не угадывайте и не спрашивайте у оператора то, на
что отвечает Git:

```bash
git ls-remote --heads "<system-store-remote-url>" "<system-store-base-branch>"
```

**Хранилище уже есть на удалённом сервере** (проверка вывела ссылку) — вы второй или
следующий разработчик. Клонируйте, ничего не создавайте:

```bash
test ! -e "$SERPENS_SYSTEM_STORE_ROOT"
git clone --branch "<system-store-base-branch>" --single-branch "<system-store-remote-url>" "$SERPENS_SYSTEM_STORE_ROOT"
<serpens-sdd> state prepare-base --repo "$SERPENS_SYSTEM_STORE_ROOT" --base "<system-store-base-branch>"
git -C "$SERPENS_SYSTEM_STORE_ROOT" config serpens.baseBranch "<system-store-base-branch>"
```

Путь с шаблоном здесь создал бы через `git init` вторую, не связанную историю против
сервера, где хранилище проекта уже лежит. Это единственная ошибка этого этапа,
которая стоит не повтора, а переделки.

**Проект осознанно создаёт новое пустое хранилище** (проверка ничего не вывела, и это
первая установка вообще) — начните с поставляемого шаблона:

```bash
test ! -e "$SERPENS_SYSTEM_STORE_ROOT"
cp -R "$SERPENS_SDD_ROOT/system-store-template" "$SERPENS_SYSTEM_STORE_ROOT"
git -C "$SERPENS_SYSTEM_STORE_ROOT" init -b "<system-store-base-branch>"
git -C "$SERPENS_SYSTEM_STORE_ROOT" remote add origin "<system-store-remote-url>"
git -C "$SERPENS_SYSTEM_STORE_ROOT" config serpens.baseBranch "<system-store-base-branch>"
```

**Хранилище уже есть на этой машине** — не копируйте и не клонируйте поверх.
Докажите, что это отдельный Git-корень, затем проверьте ветку и рабочее дерево до
изменения списка репозиториев и установленных файлов:

```bash
test "$(git -C "$SERPENS_SYSTEM_STORE_ROOT" rev-parse --show-toplevel)" = "$SERPENS_SYSTEM_STORE_ROOT"
git -C "$SERPENS_SYSTEM_STORE_ROOT" status --short --branch
<serpens-sdd> state prepare-base --repo "$SERPENS_SYSTEM_STORE_ROOT" --base "<system-store-base-branch>"
git -C "$SERPENS_SYSTEM_STORE_ROOT" config serpens.baseBranch "<system-store-base-branch>"
```

Проверка состояния отклоняет грязное дерево, detached HEAD, неотправленные коммиты
на самой базовой ветке, чужой upstream и расхождение. Она делает только проверенный
fast-forward. Про stash и коммиты на других локальных ветках она сообщает, но не
блокирует работу и ничего не трогает — жёсткой остановкой stash остаётся только для
`assert-archivable`.

Сохраните результат этапа 1 (нормализованные строки репозиториев) для этапа 4 —
там они передаются в `sync-submodules --repos-from -`, а не пишутся в файл
`project-repositories.json`. Запишите shim и скопируйте шаблоны, не удаляя
проектные файлы:

```bash
# Shim: один сгенерированный файл заменяет одиннадцать копий. `serpens-sdd init` пишет его на этом
# этапе (вызов `writeShim()` в `stage3()`, src/stages/stage3-store.mjs — имя функции, а не номер
# строки, чтобы ссылка не устарела). Если этапы выполняются вручную, доказательство:
test -x "$SERPENS_SYSTEM_STORE_ROOT/tools/serpens-sdd" && "$SERPENS_SYSTEM_STORE_ROOT/tools/serpens-sdd" version
install -m 0644 "$SERPENS_SDD_ROOT/templates/port-facts.md" "$SERPENS_SYSTEM_STORE_ROOT/port-facts.md"
install -m 0644 "$SERPENS_SDD_ROOT/templates/conventions-branching.md" "$SERPENS_SYSTEM_STORE_ROOT/conventions/branching.md"
mkdir -p "$SERPENS_SYSTEM_STORE_ROOT/templates"
install -m 0644 "$SERPENS_SDD_ROOT/templates/store-contract.md"  "$SERPENS_SYSTEM_STORE_ROOT/templates/"
install -m 0644 "$SERPENS_SDD_ROOT/templates/testing-stack.md"   "$SERPENS_SYSTEM_STORE_ROOT/templates/"
install -m 0644 "$SERPENS_SDD_ROOT/templates/research.md"        "$SERPENS_SYSTEM_STORE_ROOT/templates/"
install -m 0644 "$SERPENS_SDD_ROOT/templates/adr.md"             "$SERPENS_SYSTEM_STORE_ROOT/templates/"
```

Инициализируйте OpenSpec в хранилище закреплённым пакетом и портом из этапа 2.
Запустите проверку корня. Зарегистрируйте абсолютный путь со стабильным `<store-id>`.
Докажите через `openspec store list`, что id и путь точны. До этого не выполняйте
другие OpenSpec-команды.

Идентификаторы — это контракт, а не подпись: межрепозиторные ссылки ищут по id, и
два агента, ставящие один проект, обязаны получить одну строку. Для `<store-id>`
берите `<project-id>-store`, для репозитория — его имя из этапа 1, оба в нижнем
регистре через дефис. Запишите оба в `port-facts.md`.

## 4. Создайте подмодули репозиториев проекта

```bash
printf '%s\t%s\t%s\n' service-a ssh://git@forge/project/service-a.git develop \
  | <serpens-sdd> sync-submodules --repos-from - --store-root "$SERPENS_SYSTEM_STORE_ROOT"
git -C "$SERPENS_SYSTEM_STORE_ROOT" submodule status
git -C "$SERPENS_SYSTEM_STORE_ROOT" diff -- .gitmodules
```

Каждая строка на stdin — это `имя<TAB>url<TAB>base_branch`, те самые строки,
которые разрешил этап 1, по одной на репозиторий. `--inventory <путь-к-json>`
по-прежнему поддерживается (читает ту же схему, которую этап 1 раньше писал в
`project-repositories.json`) — для тех, кто собирает это вручную из JSON-файла,
а не передаёт строки через stdin.

Синхронизация только добавляет и допускает повторный запуск. Она записывает базовые
ветки в `.gitmodules`, отклоняет несовпадающие URL и пути, а исчезнувшие привязки
показывает как сохранённые orphan-записи. Удаляйте такую запись только вручную после
проверки привязки и локальной работы.

## 5. Подключите каждый зарегистрированный подмодуль

Для каждого пути из `.gitmodules`:

1. запустите корневой `<serpens-sdd> state prepare-base` и устраните каждую ошибку;
2. инициализируйте OpenSpec в этом репозитории закреплённым пакетом и портом;
3. запустите `<serpens-sdd> openspec-root` и докажите, что корень совпадает с подмодулем;
4. shim заменяет копии инструментов спицы: `serpens-sdd init` пишет его в этот подмодуль
   (вызов `writeShim()` в `onboardOne()`, `src/stages/stage5-onboard.mjs`), никогда вручную. Доказательство то же, что для
   хранилища: `test -x "$submodule/tools/serpens-sdd" && "$submodule/tools/serpens-sdd" version`.
   Скопируйте в `templates/` этого репозитория только шаблоны, на которые установленные
   команды ссылаются по пути: `adr.md` (spns-archive), `research.md`
   и `testing-stack.md`. Команда, называющая отсутствующий шаблон, — мёртвая инструкция;
5. скопируйте `config/lefthook.yml.example` в `lefthook.yml` **и подставьте токен в копии** —
   в примере четыре буквальных токена `<serpens-sdd>`, а подстановка этапа 6 покрывает только
   каталоги установленных команд и навыков, но не этот файл. `lefthook.yml`, в котором осталось
   `run: <serpens-sdd> verify-docs`, ломает КАЖДЫЙ коммит в репозитории:

   ```bash
   shim='"$(git rev-parse --show-toplevel)"/tools/serpens-sdd'   # тот же вызов, что на этапе 6
   sed "s|<serpens-sdd>|$shim|g" "$SERPENS_SDD_ROOT/config/lefthook.yml.example" > "$submodule/lefthook.yml"
   grep -n '<serpens-sdd>' "$submodule/lefthook.yml" && exit 1 || true   # не должно найти ничего
   ```

   затем установите lefthook из разрешённого внутреннего источника и выполните `lefthook install`;
6. создайте стабильный id в `openspec/repo.txt`, создайте каталог `openspec/adr/`
   (с `.gitkeep`, чтобы он пережил clone: `spns-archive` пишет
   `openspec/adr/NNNN-<slug>.md` и сам каталог не создаёт), сгенерируйте индекс и
   запустите корневой `<serpens-sdd> verify-docs`;
6a. скопируйте `templates/testing-stack.md` в `docs/testing-stack.md` этого репозитория и
   заполните его вместе с командой. ПЯТЬ обязательных разделов: быстрый и медленный уровни с
   командой запуска каждого, границы связывания, которые ловит только медленный уровень,
   порядок границ при отладке и `Ручной доступ для тестирования` — двенадцать слотов о том, что
   тестировщик может отправить, положить, запросить и увидеть снаружи. `spns-tdd`,
   `spns-debugging`, `spns-test-plan` и `spns-autotest` не называют собственных фреймворков,
   транспортов, хранилищ и языков запросов — они читают этот файл, поэтому незаполненный файл
   оставляет четыре команды без опоры. `<serpens-sdd> verify-docs` падает, пока какой-то раздел
   отсутствует или какой-то слот не заполнен, и называет каждый из них. Там, где слот допускает
   `none`, `none` — ПОЛНЫЙ ответ: «такой поверхности у этого репозитория нет», и это не то же
   самое, что оставить слот пустым. Ответ, одинаковый для всего контура, должен лежать в ОДНОМ
   документе: назовите его в слоте `estate-reference` и напишите `inherit` в каждом слоте,
   который он покрывает, чтобы тридцать репозиториев не носили по копии, которая разъедется.
   `inherit` принимается только пока `estate-reference` называет документ. Держите таблицу слотов
   ровно в три колонки — четвёртая колонка положит ответ туда, где шлюз его не найдёт, поэтому
   свои заметки пишите под таблицей. Не удаляйте комментарии `<!-- serpens:section ... -->`:
   по ним gate находит раздел, чей заголовок вы переписали, и по ним более поздняя редакция
   дописывает новый раздел, не тронув уже написанный ответ;
6b. приведи `.gitignore` этого репозитория в порядок до первого запуска: вывод сборки, кеши
   языка (`__pycache__/`, `*.py[cod]`, `target/`, `build/`, `node_modules/`) и локальные
   настройки должны быть там. За основу возьми `system-store-template/.gitignore`.
   Untracked-файлы не блокируют ни один gate, но игнорируемый файл невидим для всех gate И его
   нельзя случайно закоммитить — именно это нужно для файла настроек с паролем;
7. объявите хранилище в `openspec/config.yaml` этого репозитория, чтобы спека
   ссылалась на общий контракт, а не повторяла его:

   ```yaml
   references:
     - <store-id>
   ```

   Без этого блока не разрешается ни один из маршрутов получения — строк, которые `spns-spec`
   пишет в каждую межрепозиторную delta, — а `<serpens-sdd> split-brain` завершается нулём,
   ничего не проверив: вставленная копия контракта пройдёт незамеченной.

   Объявляйте и remote, а не только id, если CLI это принимает:

   ```yaml
   references:
     - id: <store-id>
       remote: <store-clone-url>
   ```

   С указанным remote машина, где стор не зарегистрирован, получает готовую строку
   `git clone … && openspec store register … --id <store-id>` вместо простой ошибки.

   Маршрута всегда два. Живая спека читается как
   `openspec show <spec-id> --type spec --store <store-id>`, но ТОЛЬКО после архивации change
   контракта. Пока он открыт — а это всё межрепозиторное окно, ведь контракт мержится последним —
   контракт существует только внутри своей change-папки и читается как
   `openspec show <change-id> --type change --store <store-id> --json --deltas-only`. Проверено на
   CLI 2026-08-26: до архивации spec-маршрут выходит с кодом 1 и
   `Spec '<id>' not found at <store>/openspec/specs/<id>/spec.md`, после архивации change-маршрут
   выходит с кодом 1 и `Change "<id>" not found`. `openspec context` печатает только spec-рецепт,
   поэтому в открытом окне ему доверять нельзя.

Создайте собственный OpenSpec-корень каждого подмодуля до запуска сгенерированных
команд внутри него. Иначе родительское хранилище может перехватить изменения.

Если один подмодуль подключить нельзя, доведите остальные, оставьте этот репозиторий
неподключённым, а не подключённым наполовину, и назовите его в отчёте вместе с
упавшей проверкой и её выводом. Наполовину подключённый репозиторий — единственное
состояние, которое ежедневный поток не замечает.

Добавьте правило границы записи в файл инструкций проекта, который порт читает по
данным этапа 2, — в каждом подключённом репозитории и в хранилище:

```markdown
## ЖЁСТКОЕ ПРАВИЛО — самопроверка
После создания или правки ЛЮБОГО файла в openspec/ или docs/ выполните:
    <serpens-sdd> verify-docs
Исправьте каждый ✗ (в каждой ошибке есть подсказка) и повторяйте до зелёного
результата ДО отчёта о готовности и до предложения коммита. Отклонённую запись
исправляют, переписывая содержимое, — никогда ослаблением лимитов или удалением
проверок.
СТОП-ПРАВИЛО: если та же ошибка держится после 3 попыток, остановитесь и спросите
человека, не зацикливайтесь.
```

Одна команда держит границу для всех троих: агента после записи, человека на
pre-commit через lefthook и CI как последнюю преграду.

## 6. Установите Serpens-команды и навыки

Скопируйте `skills/spns-*` в проектный каталог навыков из этапа 2. Скопируйте
`commands/spns-*.md` в найденный каталог команд. Меняйте только оболочку порта,
frontmatter и токен `{{args}}`, если это требуется.

Замените каждый токен `<openspec>` в установленных копиях подставленным вызовом из
`port-facts.md`, а каждый токен `<serpens-sdd>` — вызовом shim из этапа 3/5: буквально
`"$(git rev-parse --show-toplevel)"/tools/serpens-sdd`, собственный закоммиченный shim репозитория.
Это ровно та строка, которую этап 5 пишет в `lefthook.yml`, поэтому хуки и команды не могут
расходиться. Это ЗНАЧЕНИЕ ПО УМОЛЧАНИЮ, применяемое, когда ничего не настроено; магазин, который
вызывает пакет иначе, задаёт `serpens_sdd.invocation` в файле конфигурации (или
`--serpens-sdd-invocation`), а `resolveCallRoute()` называет резервные маршруты для репозитория без
shim. Никогда не подставляйте голый `serpens-sdd`: он есть в PATH только при глобальной установке. `spns-spec` вызывает `new change` и `instructions` по артефактам,
`spns-plan` — `instructions design` и `instructions tasks`, `spns-implement` —
`instructions apply`, `spns-review` — `validate` и `status`, `spns-archive` — `archive`.

```bash
grep -rnE '<openspec>|<serpens-sdd>' "<installed-command-dir>" "<installed-skill-dir>" && exit 1 || true
```

Если навыки не поддерживаются, вставьте их тела сейчас и докажите отсутствие
недоступных ссылок. Полный процесс устанавливается без Superpowers.

## 7. Подключите проверку в CI

ШАБЛОН — адаптируйте под внутренний CI и проверьте дымовым прогоном, прежде чем на
него полагаться. Каждый репозиторий-спица гоняет ту же проверку, что агент и хук.
Образу CI нужен глобально установленный `@fresh-fx59/serpens-sdd`, ИЛИ задача должна
вызывать собственный закоммиченный shim репозитория, `./tools/serpens-sdd` — тот же
файл, в который уже резолвится токен `<serpens-sdd>` — потому что в свежем checkout
shim есть, а глобальной установки нет, если её не организовать отдельно. Добавьте шаг,
который выполняется при каждом push в репозиторий-спицу:

```bash
<serpens-sdd> verify-docs
```

Системное хранилище гоняет сборку каталога ночью и на merge в репозиториях. Её шаги
по порядку:

```bash
# Передайте sync-submodules собственный .gitmodules хранилища как источник строк —
# эта задача выполняется в хранилище, где сабмодули уже существуют, поэтому
# читать inventory этапа 1 неоткуда.
git config -f .gitmodules --get-regexp '^submodule\..*\.url$' | while read -r key url; do
  name=$(echo "$key" | sed -E 's/^submodule\.(.*)\.url$/\1/')
  branch=$(git config -f .gitmodules --get "submodule.$name.branch")
  printf '%s\t%s\t%s\n' "$name" "$url" "$branch"
done | <serpens-sdd> sync-submodules --repos-from - --store-root "$(git rev-parse --show-toplevel)"
<serpens-sdd> catalog --strict   # красный репозиторий валит сборку, громко
git add catalog.json catalog.md && git diff --cached --quiet || { git commit -m "chore(<TICKET>): refresh catalog" && git push; }
```

Контрактные тесты, проверку совместимости схем и линт миграций держите в отдельных
пайплайнах со своими доступами: у задачи для агента не должно быть их прав.

## 8. Докажите работу хуков и защит

Сначала докажите, что сам shim разрешается — сломанный shim обесценивает каждую
защиту ниже:

```bash
<serpens-sdd> version
```

Затем прогоните все инструменты на временных плохих данных до реального изменения:

- неверный OpenSpec-корень должен завершиться ошибкой;
- повторённая форма общего контракта должна упасть на split-brain проверке;
- неверная ветка и несовпадающий ticket в коммите должны быть отклонены;
- `git config core.hooksPath` должен быть пустым или указывать на хуки репозитория;
- намеренно неверный временный коммит должен быть отклонён установленным хуком.

Не ослабляйте проверку ради зелёного результата.

## 9. Финальная приёмка

После последнего изменения докажите, что shim разрешается, и повторите синхронизацию,
чтобы доказать идемпотентность:

```bash
<serpens-sdd> version                       # shim разрешается; печатает редакцию ПАКЕТА (см. ниже)
# Те же строки, что на этапе 4 (§4) — синхронизация идемпотентна, повторная подача
# не должна ничего менять.
printf '%s\t%s\t%s\n' service-a ssh://git@forge/project/service-a.git develop \
  | <serpens-sdd> sync-submodules --repos-from - --store-root "$SERPENS_SYSTEM_STORE_ROOT"
git -C "$SERPENS_SYSTEM_STORE_ROOT" status --short --branch
git -C "$SERPENS_SYSTEM_STORE_ROOT" submodule status
```

`<serpens-sdd> version` доказывает, что shim разрешается, и печатает редакцию пакета, до которого
он доходит. Он НЕ доказывает, что сам shim свежий: shim — это двухстрочный `exec` абсолютного
пути внутрь установленного пакета, поэтому shim прошлой редакции печатает ту же строку, что и
новый. Чтобы доказать, что shim написан этой установкой, сравните цель его `exec` с пакетом,
установленным сейчас:

```bash
installed_bin=$(node -e 'console.log(require.resolve("@fresh-fx59/serpens-sdd/bin/serpens-sdd.mjs"))' 2>/dev/null \
  || readlink -f "$(command -v serpens-sdd)")
for shim in "$SERPENS_SYSTEM_STORE_ROOT/tools/serpens-sdd" \
    $(git -C "$SERPENS_SYSTEM_STORE_ROOT" submodule --quiet foreach 'echo "$toplevel/$sm_path/tools/serpens-sdd"'); do
  grep -q 'serpens-sdd shim' "$shim" || { echo "✗ $shim отсутствует или это не сгенерированный shim"; continue; }
  grep -qF "$installed_bin" "$shim" || { echo "✗ $shim ведёт в другую установку"; continue; }
  printf '%s -> ' "$shim"; "$shim" version
done
```

Также проверьте в каждом подмодуле OpenSpec-корень, базовую ветку, текущее состояние,
хуки, docs-проверки, команды и навыки. Коммитьте хранилище и каждый репозиторий
отдельно. Укажите источник списка (`mcp` или `manual`) и приложите свежий вывод.

Файлы на диске — ещё не работающая установка. Вызовите одну Serpens-команду в самом
порту: запустите `spns-spec` на выдуманном тикете в одном подключённом репозитории,
убедитесь, что дело дошло до интервью и появился `openspec/changes/<id>/proposal.md`,
затем удалите ветку и папку изменения. Установка, в которой ни одна команда ни разу
не отработала в реальном порту, не доказана, что бы ни показывал список файлов.

Закрывайте установку, только когда верна каждая строка:

- [ ] хранилище живо: синхронизация и `<serpens-sdd> catalog --strict` зелёные в ночной задаче CI;
- [ ] в каждом подключённом репозитории проверка зелёная в pre-commit и в CI, индекс
      и `repo.txt` закоммичены;
- [ ] команды и навыки установлены, ни одного токена `<openspec>` и `<serpens-sdd>` не осталось;
- [ ] `tools/serpens-sdd` есть в хранилище и в каждом подмодуле, а `tools/*.sh` — нет ни в одном;
- [ ] одна Serpens-команда отработала целиком в порту;
- [ ] назван чемпион в каждой команде и назван владелец харнесса: за ним закрепления
      версий, задача каталога и повторные проверки порта;
- [ ] записан путь исключения: любую задачу можно вести мимо потока, причина
      фиксируется в трекере.
