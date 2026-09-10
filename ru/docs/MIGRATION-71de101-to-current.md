# Runbook миграции — публичный `corp-sdd` @ `71de101` → текущая редакция набора

Аудитория: агент установки, работающий внутри корпоративного окружения.
Ты переносишь установку, сделанную из публичного коммита `71de101`
(2026-08-05, `sync-repos: adopt clones that already exist; add a guarded clean-up step`)
на текущий набор Corp SDD.

Это **не** `docs/UPGRADE.md`. Тот runbook предполагает, что рабочая область уже
является системным хранилищем с подмодулями Git. У `71de101` нет хранилища, нет подмодулей, нет `VERSION`,
нет `UPGRADE.md`; там есть `clones/`, `repos.json` и `sync-repos.sh`. Для этапов 1–6 ниже
нет runbook нигде больше. С этапа 7 поставляемые `docs/UPGRADE.md` и
`docs/SETUP.md` становятся источником истины, и на них ссылаются по номеру этапа.

Правила на весь прогон:

- Останавливайся на каждом провалившемся контроле. Не продолжай после красной проверки.
- Никогда не выполняй `rm -rf`, `git reset`, `git clean`, `git rebase`, `git checkout -f` и
  force-push в этой миграции. Ничто здесь не удаляет клон.
- Записывай каждую команду и её реальный вывод в свою передаточную заметку по ходу дела,
  а не в конце.
- Там, где шаг говорит «ожидаемый вывод», другой вывод — это остановка.

Плейсхолдеры, которые нужно разрешить до старта и держать разрешёнными всё время:

| Токен | Значение |
|---|---|
| `<OLD_ROOT>` | существующая рабочая копия `corp-sdd` на `71de101` |
| `<NEW_KIT>` | распакованный текущий набор (каталог, содержащий `VERSION` и `MANIFEST.sha256`) |
| `<project-id>` | идентификатор корпоративного проекта |
| `<store-remote-url>` | Git-remote системного хранилища |
| `<store-base-branch>` | согласованная базовая ветка хранилища |
| `<pinned-version>` | закреплённая версия `@fission-ai/openspec` |
| `<TICKET>` | реальный ключ трекера для коммитов миграции |

---

## Этап 0 — Предполётная инвентаризация. Запиши всё до того, как что-то трогать.

### 0.1 Докажи наличие инструментов

```bash
git --version        # >= 2.13 — `submodule add -b` needs it
node --version       # >= 18   — runs the .mjs disposers
lefthook version
npx @fission-ai/openspec@<pinned-version> --version
```

Ожидается: пять строк версий. Любой промах останавливает миграцию здесь.
Пакет называется `@fission-ai/openspec`. Короткое имя `openspec` в публичном
реестре — чужая пустышка версии `0.0.0`, она ставит нерабочее
(`docs/SETUP.md` §0).

`index-all.sh` дополнительно требует две **необязательные** зависимости: **Universal Ctags**
(`ctags --version` должен печатать `Universal Ctags` — BSD ctags отвергается по названию
намеренно, потому что на нём поиск `sym:` молча умирает) и индексатор **Zoekt**. Без поиска по
коду остальной набор работает; ни один из этих промахов не останавливает миграцию.

### 0.2 Назови обе редакции

```bash
export OLD_ROOT="<OLD_ROOT>"
export NEW_KIT="<NEW_KIT>"
test -f "$NEW_KIT/VERSION" && cat "$NEW_KIT/VERSION"
bash "$NEW_KIT/scripts/tools/kit-version.sh" verify
git -C "$OLD_ROOT" rev-parse HEAD
test -f "$OLD_ROOT/VERSION" && echo "UNEXPECTED: old checkout has a VERSION" || echo "old checkout is pre-versioning, as expected"
```

Ожидается:
- `cat VERSION` печатает новую редакцию (на момент написания этого runbook:
  `2026-08-26.7`). Используй то, что говорит файл; не зашивай значение ниже.
- `kit-version.sh verify` печатает `✓ 24 file(s) match <edition>` и выходит с 0.
  **Набор, который не проходит собственный манифест, не является релизом — распакуй заново и остановись.**
- `rev-parse HEAD` печатает `71de101…`.
- Последняя строка печатает `old checkout is pre-versioning, as expected`.

### 0.3 Запиши старую раскладку ровно такой, какая она есть

`71de101` поставляет копии `en/` и `ru/` всего. Найди, какую из них использует
установка и где лежат её данные:

```bash
git -C "$OLD_ROOT" ls-tree -r 71de101 --name-only | sed -n '1,120p'
find "$OLD_ROOT" -maxdepth 3 -name repos.json -not -path '*/node_modules/*'
```

Для каждого найденного `repos.json` запиши его и разреши его каталог клонов. Старый
`sync-repos.sh` сначала делает `cd "$(dirname "$0")/.."`, затем читает
`clones_dir` относительно **этого** каталога:

```bash
export REPOS_JSON="<path printed above>"
export OLD_TOOLS_PARENT="$(cd "$(dirname "$REPOS_JSON")" && pwd -P)"
node -e "console.log(require('$REPOS_JSON').clones_dir)"
export CLONES_DIR="$(cd "$OLD_TOOLS_PARENT/$(node -e "console.log(require('$REPOS_JSON').clones_dir)")" && pwd -P)"
echo "$CLONES_DIR"
ls -1 "$CLONES_DIR"
```

Ожидается: `clones_dir` печатает `../clones` в поставляемом примере
(`en/config/repos.json.example`); установка могла его изменить. `ls -1`
должен перечислить по одному каталогу на каждый настроенный репозиторий.

### 0.4 Инвентаризация до миграции — это шаг, который нельзя повторить позже

Для **каждого** каталога внутри `$CLONES_DIR` запиши всё перечисленное. После
усыновления перемещённый клон выглядит ровно как тот, что всегда был на месте, поэтому
незаписанный stash или неотправленная ветка становятся невидимыми.

```bash
for d in "$CLONES_DIR"/*; do
  [ -d "$d/.git" ] || { echo "== $d :: NOT A GIT CLONE"; continue; }
  echo "===== $d"
  echo "-- origin:";        git -C "$d" remote -v
  echo "-- HEAD:";          git -C "$d" rev-parse --abbrev-ref HEAD; git -C "$d" rev-parse HEAD
  echo "-- branches:";      git -C "$d" branch -vv
  echo "-- unpushed:";      git -C "$d" log --branches --not --remotes --oneline
  echo "-- worktree:";      git -C "$d" status --porcelain
  echo "-- stashes:";       git -C "$d" stash list
  echo "-- submodules:";    git -C "$d" config -f .gitmodules --get-regexp '^submodule\.' 2>/dev/null || echo none
done 2>&1 | tee ~/corp-sdd-migration-preflight.txt
```

Ожидается: по блоку на клон. Вставь весь этот файл в передаточную заметку **до**
этапа 2. Явно отметь в заметке:

- любой клон, у которого блок `-- unpushed:` непустой;
- любой клон, у которого блок `-- stashes:` непустой;
- любой клон с выводом `-- worktree:` (грязное дерево);
- любой каталог, напечатавший `NOT A GIT CLONE`;
- любой клон, у которого `origin` отличается от URL в `repos.json` — это ловушка,
  которую включает этап 2.

### 0.5 Запиши каждый файл старой установки, правленный руками

`71de101` появился до штампов `corp-version:`, поэтому `kit-version.sh identify` сообщит
про каждый старый файл `UNSTAMPED`. Этот вердикт здесь ничего не говорит. Используй вместо него Git:

```bash
git -C "$OLD_ROOT" status --porcelain
git -C "$OLD_ROOT" diff 71de101 --stat
git -C "$OLD_ROOT" stash list
git -C "$OLD_ROOT" log --branches --not --remotes --oneline
```

Ожидается: в идеале четыре пустых вывода. Каждая непустая строка — это локальное изменение
старого набора. Для каждого запиши файл, диф и решение «оставить или заменить» с
названным человеком, ровно как требует `docs/UPGRADE.md` §6. Локальные изменения
не переносятся автоматически ничем из описанного ниже.

Также проинвентаризуй установленные сейчас команды и навыки, где бы порт их ни
хранил (формально ты найдёшь этот каталог на этапе 5):

```bash
bash "$NEW_KIT/scripts/tools/kit-version.sh" identify "<current-command-dir>"/corp-*.md || true
bash "$NEW_KIT/scripts/tools/kit-version.sh" identify "<current-skill-dir>"/corp-*/SKILL.md || true
```

Ожидается на установке `71de101`: каждая строка читается как
`UNSTAMPED — predates versioning or is your own copy`, а команда выходит с 1.
Здесь это верно, а не сбой. Запиши листинг.

### 0.6 Заморозь старую установку

Не удаляй её. Держи `$OLD_ROOT`, `$REPOS_JSON` и `$CLONES_DIR` на диске, пока
чек-лист приёмки этапа 10 не станет зелёным — они единственный откат для этапов 1–6.

---

## Этап 1 — Создай соседнее системное хранилище

У старой раскладки нет хранилища. Создай его сейчас; каждый следующий этап пишет в него.

```bash
export CORP_SDD_ROOT="$(cd "$NEW_KIT" && git rev-parse --show-toplevel 2>/dev/null || echo "$NEW_KIT")"
export CORP_WORKSPACE_ROOT="$(cd "$CORP_SDD_ROOT/.." && pwd -P)"
export CORP_SYSTEM_STORE_ROOT="${CORP_SYSTEM_STORE_ROOT:-$CORP_WORKSPACE_ROOT/system-store}"
test -d "$CORP_SDD_ROOT/system-store-template"
test "$CORP_SYSTEM_STORE_ROOT" != "$CORP_SDD_ROOT"
```

Ожидается: обе строки `test` молча выходят с 0. Хранилище должно жить **рядом** с набором,
никогда внутри него (`docs/SETUP.md` §0).

Спроси у Git, в каком из двух случаев ты находишься — не угадывай, не спрашивай оператора:

```bash
git ls-remote --heads "<store-remote-url>" "<store-base-branch>"
```

**Случай A — проба напечатала ref.** Другой разработчик уже создал хранилище.
Клонируй его; ничего не создавай:

```bash
test ! -e "$CORP_SYSTEM_STORE_ROOT"
git clone --branch "<store-base-branch>" --single-branch "<store-remote-url>" "$CORP_SYSTEM_STORE_ROOT"
bash "$CORP_SDD_ROOT/scripts/tools/repository-state.sh" prepare-base \
  --repo "$CORP_SYSTEM_STORE_ROOT" --base "<store-base-branch>"
git -C "$CORP_SYSTEM_STORE_ROOT" config corp.baseBranch "<store-base-branch>"
```

**Случай B — проба ничего не напечатала**, и это первая установка вообще:

```bash
test ! -e "$CORP_SYSTEM_STORE_ROOT"
cp -R "$CORP_SDD_ROOT/system-store-template" "$CORP_SYSTEM_STORE_ROOT"
git -C "$CORP_SYSTEM_STORE_ROOT" init -b "<store-base-branch>"
git -C "$CORP_SYSTEM_STORE_ROOT" remote add origin "<store-remote-url>"
git -C "$CORP_SYSTEM_STORE_ROOT" config corp.baseBranch "<store-base-branch>"
```

Случай B против remote, где хранилище уже есть, создаёт вторую, не связанную
историю и стоит переписывания, а не повтора (`docs/SETUP.md` §3).

Проверь любой из случаев:

```bash
test "$(git -C "$CORP_SYSTEM_STORE_ROOT" rev-parse --show-toplevel)" = "$CORP_SYSTEM_STORE_ROOT"
git -C "$CORP_SYSTEM_STORE_ROOT" config corp.baseBranch
git -C "$CORP_SYSTEM_STORE_ROOT" status --short --branch
```

Ожидается: `test` выходит с 0; `config` печатает `<store-base-branch>`; `status` печатает
строку ветки и чистое дерево либо только файлы шаблона.

Установи инструменты хранилища сейчас — это список копирования из `docs/SETUP.md` §3, и он
идентичен `docs/UPGRADE.md` §3:

```bash
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/sync-submodules.sh"            "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/repository-state.sh"           "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/index-all.sh"                  "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/verify-docs.sh"                "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/check-git-naming.sh"           "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0755 "$CORP_SDD_ROOT/scripts/tools/check-openspec-root.sh"        "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0644 "$CORP_SDD_ROOT/scripts/tools/aggregate-index.mjs"           "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0644 "$CORP_SDD_ROOT/scripts/tools/gen-index.mjs"                 "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0644 "$CORP_SDD_ROOT/scripts/tools/corp-lint.mjs"                 "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0644 "$CORP_SDD_ROOT/scripts/tools/check-contract-split-brain.mjs" "$CORP_SYSTEM_STORE_ROOT/tools/"
install -m 0644 "$CORP_SDD_ROOT/templates/port-facts.md"                     "$CORP_SYSTEM_STORE_ROOT/port-facts.md"
install -m 0644 "$CORP_SDD_ROOT/templates/conventions-branching.md"          "$CORP_SYSTEM_STORE_ROOT/conventions/branching.md"
```

Замечание: `port-facts.md` ставится как **незаполненный шаблон** и должен быть ЗАПОЛНЕН — этап 5.1
опрашивает реальный порт — **до финальной проверки на этапе 12**. `corp-lint.mjs` теперь выдаёт ОШИБКУ
на `port-facts.md`, у которого в P-строках остался плейсхолдер `...` или в заголовке всё ещё стоит
`<port name + version> (probed YYYY-MM-DD)`, поэтому нетронутая копия валит `verify-docs.sh`.

Замечание: `sync-repos.sh` из старого набора **не** входит в этот список и не должен копироваться.
Он заменяется, а не обновляется (этап 2).

Проверь:

```bash
bash -n "$CORP_SYSTEM_STORE_ROOT/tools/sync-submodules.sh"
bash -n "$CORP_SYSTEM_STORE_ROOT/tools/repository-state.sh"
bash "$NEW_KIT/scripts/tools/kit-version.sh" identify \
  "$CORP_SYSTEM_STORE_ROOT"/tools/*.sh "$CORP_SYSTEM_STORE_ROOT"/tools/*.mjs
```

Ожидается: `bash -n` молчит, выход 0; каждая строка `identify` читается как
`pristine <new edition>  (kit path scripts/tools/…)`, команда выходит с 0.

---

## Этап 2 — Усынови `clones/` в подмодули, на месте, без повторного клонирования

Ничто в наборе не мигрирует старые клоны. Оставленные как есть, они просто перестают читаться
любым инструментом — вместе с неотправленными ветками и stash-ами. Этот этап перемещает реальные рабочие копии.

### 2.0 Что меняется и почему старая команда больше не работает

Старое (`71de101`, `en/scripts/tools/sync-repos.sh`), обычные соседние клоны, усыновление по
наличию каталога:

```
# --- present: ADOPT it — prove it is the right repo before pulling anything -------------
have=$(git -C "$dir" remote get-url origin 2>/dev/null || true)
```

Новое (`scripts/tools/sync-submodules.sh`), подмодули зарегистрированы в `.gitmodules`,
и каталог, который *не* зарегистрирован, — жёсткая остановка:

```
  elif [ -e "$STORE_ROOT/$expected_path" ] && [ -z "$registered_path" ]; then
    echo "✗ $name: target exists but is not a registered submodule" >&2
```

Эта инверсия и есть причина, по которой перенос надо завершить явным `git submodule add`
до того, как `sync-submodules.sh` вообще будет запущен.

### 2.1 СНАЧАЛА докажи реальный origin каждого клона

**Ловушка:** `git submodule add` записывает URL, который ты передал в командной строке, и
никогда не смотрит на собственный `origin` рабочей копии. Расхождение оставляет `.gitmodules` и
рабочую копию указывающими на разные remote, и **ни один контроль в наборе это не ловит.**
Поэтому считай истину с каждого клона до того, как наберёшь какой-либо URL:

```bash
for d in "$CLONES_DIR"/*; do
  [ -d "$d/.git" ] || continue
  printf '%s\t%s\n' "$(basename "$d")" "$(git -C "$d" remote get-url origin)"
done
```

Ожидается: по одной строке `name<TAB>url` на клон. Сравни каждую строку с `repos.json`:

```bash
node -e "const c=require('$REPOS_JSON');for(const r of c.repos)console.log(r.name+'\t'+r.url)"
```

Ожидается: два листинга совпадают, имя к имени. При любом расхождении остановись и реши
с названным человеком, **какой URL правильный**, до продолжения. URL, который ты несёшь
в шаг 2.3, — тот, который ты счёл правильным; и если у клона `origin` неверный,
сначала почини клон:

```bash
git -C "$CLONES_DIR/<name>" remote set-url origin "<correct-url>"
git -C "$CLONES_DIR/<name>" remote get-url origin
```

### 2.2 Перемести рабочие копии — `mv`, никогда копирование, никогда повторное клонирование

```bash
mkdir -p "$CORP_SYSTEM_STORE_ROOT/submodules"
mv "$CLONES_DIR/<name>" "$CORP_SYSTEM_STORE_ROOT/submodules/<name>"
test -d "$CORP_SYSTEM_STORE_ROOT/submodules/<name>/.git"
```

Ожидается: `test` выходит с 0. Повтори для каждого репозитория. Вариант с целым каталогом
(`mv "$CLONES_DIR" "$CORP_SYSTEM_STORE_ROOT/submodules"`) эквивалентен и тоже
проверен, при условии что в `$CLONES_DIR` нет ничего, кроме клонов.

### 2.3 Зарегистрируй каждую перемещённую рабочую копию как подмодуль

Запускай из корня хранилища, по разу на репозиторий, с той веткой, на которой
основан каждый репозиторий:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule add --name "<name>" -b "<base-branch>" \
  "<url>" "submodules/<name>"
```

Ожидаемая строка вывода:

```
Adding existing repo at 'submodules/<name>' to the index
```

Это сообщение — доказательство усыновления: без сетевого обращения, без второго клона.
Если Git вместо этого начал клонировать, каталог не был перемещён на место — остановись.

`--name "<name>"` не опционален: он закрепляет имя секции в `.gitmodules` за
именем репозитория, а это тот идентификатор, по которому работают `sync-submodules.sh`, `.gitmodules`
и каталог.

### 2.4 Докажи, что ничего не потеряно

Для каждого усыновлённого репозитория сравни с записью этапа 0.4:

```bash
d="$CORP_SYSTEM_STORE_ROOT/submodules/<name>"
git -C "$d" remote -v
git -C "$d" branch -vv
git -C "$d" log --branches --not --remotes --oneline
git -C "$d" stash list
git -C "$d" status --porcelain
```

Ожидается: побайтово те же ветки, неотправленные коммиты, stash-и и грязные файлы,
которые `~/corp-sdd-migration-preflight.txt` записал для этого клона. Любое отличие — это
остановка.

Затем докажи регистрацию и согласие URL:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" config -f .gitmodules --get-regexp '^submodule\.'
git -C "$CORP_SYSTEM_STORE_ROOT" submodule status
```

Ожидается: для каждого репозитория `submodule.<name>.path = submodules/<name>`,
`submodule.<name>.url`, равный реальному `origin` рабочей копии, и
`submodule.<name>.branch`, равный его базовой ветке. `submodule status` перечисляет каждый
репозиторий с SHA коммита и без ведущего `-` (не инициализирован) или `+` (расхождение
указателя, которого ты не хотел).

Сверь каждый записанный URL с живой рабочей копией последний раз — это
единственная проверка, ловящая ловушку 2.1 постфактум:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet \
  'echo "$name  gitmodules=$(git -C "$toplevel" config -f .gitmodules --get submodule.$name.url)  origin=$(git remote get-url origin)"'
```

Ожидается: `gitmodules=` и `origin=` — один и тот же репозиторий в каждой строке.

### 2.5 Не трогай старый каталог

Не удаляй `$CLONES_DIR`. После 2.2 он пуст или содержит только то, чего никогда
не было в `repos.json` — а именно там и может прятаться чья-то единственная копия ветки.
Запиши, что осталось, в передаточную заметку и передай решение человеку.

---

## Этап 3 — `repos.json` → `project-repositories.json`

Старое (`71de101`, `en/config/repos.json.example`), дословно:

```json
{
  "clones_dir": "../clones",
  "repos": [
    {
      "name": "pilot-repo-a",
      "url": "ssh://git@your-forge/org/pilot-repo-a.git"
    },
    {
      "name": "pilot-repo-b",
      "url": "ssh://git@your-forge/org/pilot-repo-b.git"
    }
  ]
}
```

Новое (`config/project-repositories.json.example`), дословно:

```json
{
  "schema_version": 1,
  "project": "<project-id>",
  "repository_source": "manual",
  "repositories": [
    {
      "name": "<repository-name>",
      "url": "ssh://git@<forge>/<project>/<repository>.git",
      "base_branch": "develop"
    }
  ]
}
```

Поле за полем:

| Старое поле | Новое поле | Преобразование |
|---|---|---|
| `clones_dir` | *(нет)* | **Убрано.** Расположение фиксировано: `submodules/<name>` под корнем хранилища. `sync-submodules.sh` вычисляет `expected_path="submodules/$name"` и отвергает любой другой зарегистрированный путь. |
| *(нет)* | `schema_version` | **Обязательное, должно быть целым `1`.** `sync-submodules.sh` выходит с 2 на всём остальном: `✗ inventory requires schema_version 1 and a non-empty project`. |
| *(нет)* | `project` | **Обязательное, непустая строка.** Задай его равным `<project-id>`. |
| *(нет)* | `repository_source` | Поставь `"mcp"`, если список получен из MCP-инструмента привязок проекта, `"manual"`, если ты преобразовал `repos.json` руками. Ручное преобразование `71de101` — это `"manual"`, если только ты не выведешь его заново из MCP на этапе 3.3. |
| `repos[]` | `repositories[]` | Переименованный массив. |
| `repos[].name` | `repositories[].name` | Без изменений, но теперь проверяется по `/^[a-z0-9][a-z0-9._-]*$/` и обязано быть уникальным. |
| `repos[].url` | `repositories[].url` | Без изменений, но теперь обязано быть непустым и не содержать пробелов. |
| *(нет)* | `repositories[].base_branch` | **Обязательное, новое, значения по умолчанию нет.** Должно проходить `git check-ref-format --branch`. |

### 3.1 Заполняй `base_branch` из remote, а не из рабочей копии

Никогда не выводи базу из той ветки, на которой случайно стоит клон
(`docs/SETUP.md` §1). Для каждого репозитория предпочитай `develop`, если такая удалённая ветка
существует, иначе удалённую символическую ветку по умолчанию:

```bash
d="$CORP_SYSTEM_STORE_ROOT/submodules/<name>"
git -C "$d" ls-remote --heads origin develop
git -C "$d" remote show origin | sed -n 's/.*HEAD branch: //p'
```

Ожидается: первая печатает ref, если `develop` существует; вторая печатает имя ветки
по умолчанию. Используй `develop`, когда она есть, иначе напечатанную ветку по умолчанию.

### 3.2 Запиши файл

Положи его в корень хранилища, по точному пути, которого ждут все инструменты и CI-задачи:

```bash
cat > "$CORP_SYSTEM_STORE_ROOT/project-repositories.json" <<'JSON'
{
  "schema_version": 1,
  "project": "<project-id>",
  "repository_source": "manual",
  "repositories": [
    {"name": "<name>", "url": "<url>", "base_branch": "<base-branch>"}
  ]
}
JSON
node -e "JSON.parse(require('fs').readFileSync('$CORP_SYSTEM_STORE_ROOT/project-repositories.json','utf8'))" && echo "valid JSON"
```

Ожидается: `valid JSON`.

### 3.3 Необязательно — вывести заново из MCP вместо ручного преобразования

Перечисли доступные MCP-инструменты; если инструмент привязок проекта есть, вызови его с
`<project-id>`, включи только репозитории, привязанные к этому проекту, и нормализуй его
результат в ту же схему с `"repository_source": "mcp"`. Сообщи, какой источник
ты использовал. Оба пути допустимы; форма файла идентична.

### 3.4 Докажи, что инвентарь сходится с усыновлёнными подмодулями

```bash
bash "$CORP_SYSTEM_STORE_ROOT/tools/sync-submodules.sh" \
  --inventory "$CORP_SYSTEM_STORE_ROOT/project-repositories.json" \
  --store-root "$CORP_SYSTEM_STORE_ROOT"
```

Ожидается: по одной строке `✓ <name> (registered)` на усыновлённый репозиторий, затем
`✓ reconciled <N> project-bound submodule(s) in <store>/submodules`, выход 0.

Режимы отказа и что они значат:

- `✗ <name>: target exists but is not a registered submodule` — этап 2.3 не был выполнен
  для этого репозитория. Вернись и запусти `submodule add`.
- `✗ <name>: registered URL does not match project inventory` — `.gitmodules` и
  `project-repositories.json` расходятся. Разреши с человеком; не правь вслепую.
- `✗ <name>: registered path is '<x>', expected 'submodules/<name>'` — рабочая копия
  не на своём месте. Перемести её.
- `⚠ orphaned submodule binding: <name> (<path>) — absent from inventory; preserved` —
  репозиторий зарегистрирован, но не перечислен. Он никогда не удаляется. Подтверди его
  привязку к проекту, прежде чем трогать.

Затем подтверди идемпотентность:

```bash
bash "$CORP_SYSTEM_STORE_ROOT/tools/sync-submodules.sh" \
  --inventory "$CORP_SYSTEM_STORE_ROOT/project-repositories.json" \
  --store-root "$CORP_SYSTEM_STORE_ROOT"
git -C "$CORP_SYSTEM_STORE_ROOT" diff -- .gitmodules
```

Ожидается: вывод, идентичный первому запуску, и **пустой** диф `.gitmodules`.

Наконец удали устаревший конфиг, чтобы его больше никто не читал — но только после того,
как всё выше зелёное, и запиши это в передаточную заметку:

```bash
git -C "$OLD_ROOT" mv "$REPOS_JSON" "$REPOS_JSON.superseded" 2>/dev/null \
  || mv "$REPOS_JSON" "$REPOS_JSON.superseded"
```

Ожидается: файл переименован, а не удалён.

---

## Этап 4 — Прогони контроль по каждому репозиторию до первого копирования

Каждый репозиторий ниже — отдельный репозиторий Git, коммитится отдельно, поэтому каждый
контролируется отдельно (`docs/UPGRADE.md` §1):

```bash
bash "$CORP_SDD_ROOT/scripts/tools/repository-state.sh" prepare-base \
  --repo "$CORP_SYSTEM_STORE_ROOT" --base "$(git -C "$CORP_SYSTEM_STORE_ROOT" config corp.baseBranch)"
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do
      bash "$CORP_SDD_ROOT/scripts/tools/repository-state.sh" prepare-base --repo "$repo"
    done
```

Ожидается: блок состояния на каждый репозиторий и выход 0 для каждого. Контроль отказывает
грязным рабочим деревьям, отсоединённому HEAD, неотправленным коммитам на базовой ветке, неверным upstream и
расхождению; он делает только проверенный fast-forward. Он никогда не делает reset, clean,
rebase, не удаляет ветку и не трогает stash. Stash и коммиты на *других* локальных
ветках сообщаются как предупреждения, а не блокировки — только `assert-archivable` считает
stash жёсткой остановкой.

Разрешай каждую остановку с владельцем этой работы. Репозиторий, который не проходит контроль,
**пропускается целиком** и называется в передаточной заметке с провалившимся контролем и его выводом.
Наполовину смигрированный репозиторий — то единственное состояние, которое ежедневный процесс не может обнаружить.

Не создавай общую ветку «migration» через репозитории. Каждый репозиторий получает
свой коммит на своей базе.

---

## Этап 5 — Найди дом агента; никогда не называй его

Набор намеренно не называет ни каталог дома агента, ни slash-команду, ни MCP-инструмент:
один и тот же набор ставится на порты, где дома и файлы инструкций называются
по-разному (`docs/SETUP.md` §2).

### 5.1 Найди его

Прощупай реальный порт и запиши ответы в `port-facts.md` хранилища
(установлен на этапе 1 из `templates/port-facts.md`):

1. каталог конфигурации и имя файла проектных инструкций;
2. каталог команд, формат файла, синтаксис вызова и токен аргументов;
3. каталог навыков и загружаются ли проектные навыки автоматически;
4. точный вызов CLI OpenSpec, **доказанный запуском** (этап 6);
5. имена MCP-инструментов для привязок репозиториев проекта, трекера, вики и поиска по коду;
6. поддержка хуков, ограничения контекста и версия агента.

Чтобы найти дом механически, инициализируй OpenSpec один раз во временном каталоге с
закреплённым внутренним пакетом и посмотри, в какой dot-каталог он генерирует файлы.

### 5.2 Сделай находку машиночитаемой

Два из этих фактов читаются инструментами обратно, поэтому их надо записать туда, куда смотрит
машина, а не только в прозу. Для каждого репозитория, включая хранилище:

```bash
git -C "<repo>" config corp.agentDir "<the agent home you found, e.g. .acme>"
git -C "<repo>" config --get corp.agentDir
```

Ожидается: вторая строка повторяет каталог, который ты задал.

`corp-lint.mjs` разрешает дом агента в таком порядке, и заголовок файла
формулирует это дословно:

```
// it is CORP_AGENT_DIR, else `git config corp.agentDir`, else the one dot-directory at the
// repository root that contains a `skills/` subdirectory.
```

Если больше одного корневого dot-каталога содержит `skills/`, линт **выходит с 1, а не
угадывает**, и печатает:

```
   ↳ set CORP_AGENT_DIR or `git config corp.agentDir <dir>` so the lint knows which one to read
```

`CORP_AGENT_DIR` в окружении перекрывает Git-конфиг; используй Git-конфиг для
устойчивого ответа, чтобы новая оболочка тоже была права.

Файл проектных инструкций порта — аналог `AGENTS.md`, как бы этот порт его
ни называл — не требует настройки: линт подхватывает каждый `.md` В ВЕРХНЕМ РЕГИСТРЕ в
корне репозитория, кроме README, LICENSE, CHANGELOG, CONTRIBUTING, SECURITY,
CODE_OF_CONDUCT и NOTICE. Запиши оба имени в `port-facts.md`.

Замечание про старую установку: `corp-lint.mjs` из `71de101` зашивал `.qwen/`. Если твой порт
не `.qwen`, правило каталога агента в старом линте и его лимит в 250 строк на навык проходили
**вхолостую** на твоей установке. Ожидай, что новый линт сообщит про длину файлов навыков
ошибки, которых старый никогда не поднимал, — но только для навыков `corp-*`: регулярка лимита
это `<agent-dir>/skills/corp-[^/]+/…`, поэтому собственные навыки порта в том же каталоге
(на голом `openspec init` два из них длиннее 300 строк) под лимит не попадают: ограничивать
файл, который этот набор не пишет и не вправе править, значит красить свежую установку в
красное без разрешённого способа починки. Перегенерируй содержимое навыка `corp-*`; лимит не поднимай.

### 5.3 Идентификаторы — это контракт

Используй `<project-id>-store` для `<store-id>` и имя репозитория из этапа 3 для каждого
идентификатора репозитория, оба в нижнем kebab-case, и запиши оба в `port-facts.md`.
Миграция никогда не переименовывает уже используемый идентификатор — межрепозиторные ссылки
разрешаются по идентификатору и молча сломаются.

---

## Этап 6 — Разреши `<openspec>` и докажи шесть вызовов

Установленные команды вызывают **CLI** OpenSpec, никогда сгенерированную slash-команду.
Slash-команды различаются между версиями и профилями — core-профиль OpenSpec 1.10
поставляет `propose, explore, apply, update, sync, archive` и вообще не имеет `new`, `continue` или
`verify`. Шесть CLI-вызовов ниже стабильны и машиночитаемы.

Набор поставляет ровно **один** токен, записанный как `<openspec>`. Разреши его в то, что реально
работает на этой машине — например `npx @fission-ai/openspec@<pinned-version>` или
внутреннюю обёртку в `PATH`.

Докажи все шесть в одноразовом репозитории с инициализированным OpenSpec:

```bash
export OPENSPEC="npx @fission-ai/openspec@<pinned-version>"   # or your resolved invocation
$OPENSPEC new change corp-probe
$OPENSPEC status --change corp-probe --json
$OPENSPEC instructions proposal --change corp-probe --json
$OPENSPEC instructions apply --change corp-probe --json
$OPENSPEC validate corp-probe --type change --strict --json
$OPENSPEC archive --help
```

Ожидается:
- `new change` создаёт `openspec/changes/corp-probe/`;
- `status --json` печатает JSON со списком идентификаторов артефактов, их путей и состояния;
- каждый `instructions … --json` печатает JSON с указаниями и точным
  путём вывода для этого артефакта;
- `validate … --json` печатает JSON с полем `valid`;
- `archive --help` печатает справку и выходит с 0.

Удали пробную change после этого. Запиши разрешённый токен и все шесть доказанных
вызовов в `port-facts.md`. Какая команда что использует:

| Команда | CLI-вызовы, которые она обязана содержать после разрешения |
|---|---|
| `corp-spec` | `new change`, `instructions proposal`, `instructions specs`, `validate --type change --strict --json` |
| `corp-plan` | `instructions design`, `instructions tasks` |
| `corp-implement` | `instructions apply` |
| `corp-review` | `validate`, `status` |
| `corp-archive` | `validate --type change --strict --json`, `archive <change-id> --yes --json` |

---

## Этап 7 — Установи новые инструменты в каждый репозиторий

Каждый подключённый репозиторий несёт семь spoke-инструментов. Скопируй их из свежеобновлённого
`tools/` хранилища, по одному репозиторию за раз, пропуская любой репозиторий, который этап 4
не смог провести через контроль:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do
      mkdir -p "$repo/tools"
      install -m 0755 "$CORP_SYSTEM_STORE_ROOT/tools/repository-state.sh"            "$repo/tools/"
      install -m 0755 "$CORP_SYSTEM_STORE_ROOT/tools/verify-docs.sh"                 "$repo/tools/"
      install -m 0755 "$CORP_SYSTEM_STORE_ROOT/tools/check-openspec-root.sh"         "$repo/tools/"
      install -m 0755 "$CORP_SYSTEM_STORE_ROOT/tools/check-git-naming.sh"            "$repo/tools/"
      install -m 0644 "$CORP_SYSTEM_STORE_ROOT/tools/corp-lint.mjs"                  "$repo/tools/"
      install -m 0644 "$CORP_SYSTEM_STORE_ROOT/tools/gen-index.mjs"                  "$repo/tools/"
      install -m 0644 "$CORP_SYSTEM_STORE_ROOT/tools/check-contract-split-brain.mjs" "$repo/tools/"
      bash -n "$repo/tools/verify-docs.sh"
    done
```

`aggregate-index.mjs`, `index-all.sh` и `sync-submodules.sh` — **только для хранилища**. Spoke,
у которого они заводятся, начинает поддерживать второй список репозиториев.

Удали старый `sync-repos.sh` везде, где старая установка оставила копию — он заменён,
а не обновлён:

```bash
find "$CORP_SYSTEM_STORE_ROOT" "$CORP_SYSTEM_STORE_ROOT"/submodules -maxdepth 3 -name sync-repos.sh
```

Ожидается: пустой вывод. Если копия есть, сделай ей `git rm` в том репозитории и запиши это.

OpenSpec и хуки на каждый репозиторий (`docs/SETUP.md` §5), для каждого подмодуля:

1. инициализируй OpenSpec в этом репозитории закреплённым пакетом и найденным портом;
2. запусти `bash "$repo/tools/check-openspec-root.sh"` и докажи, что сообщённый корень — это тот
   подмодуль, а не хранилище. Ожидается: напечатанный корень равен `$repo`. Здесь это важнее,
   чем при чистой установке: OpenSpec идёт вверх мимо `.git`, а новая раскладка
   помещает каждый репозиторий *внутрь* хранилища, у которого есть свой `openspec/`;
3. добавь стабильный идентификатор репозитория в `openspec/repo.txt` (имя репозитория из этапа 3)
   и создай каталог `openspec/adr/` с файлом `.gitkeep`, чтобы он пережил клонирование:
   `corp-archive` пишет `openspec/adr/NNNN-<slug>.md` и сам каталог не создаёт;
4. скопируй `config/lefthook.yml.example` в `lefthook.yml`, установи lefthook через
   разрешённый внутренний канал, затем выполни `lefthook install` в этом репозитории;
5. объяви хранилище в `openspec/config.yaml`:

   ```yaml
   references:
     - <store-id>
   ```

   Без этого блока не разрешается ни один маршрут получения — строк, которые `corp-spec`
   пишет в каждую межрепозиторную дельту, — а `check-contract-split-brain.mjs` выходит с 0,
   ничего не проверив, и вставленная форма контракта остаётся незамеченной. **Маршрута всегда
   два**, потому что контракт хранилища мержится ПОСЛЕДНИМ: пока его change открыт, контракт
   существует только внутри своей change-папки, а архивация удаляет эту папку ровно тогда,
   когда начинает работать spec-маршрут. Каждая дельта спицы несёт ОБА, с подписями:

   ```text
   while the contract change is open:
     <openspec> show <contract-change-id> --type change --store <store-id> --json --deltas-only
   after the contract change is archived:
     <openspec> show <contract-spec-id> --type spec --store <store-id>
   which window am I in: <openspec> list --specs --store <store-id> — the spec id absent means open
   if the CLI refuses (a broken contract proposal, an unregistered store), read the file:
     <openspec> instructions specs --change <contract-change-id> --store <store-id> --json  # prints changeDir
     cat <changeDir>/specs/<contract-spec-id>/spec.md
   ```

   Измерено на CLI 2026-08-26: до архивации spec-маршрут выходит с 1 и
   `Spec '<id>' not found at <store>/openspec/specs/<id>/spec.md`, а после архивации
   change-маршрут выходит с 1 и `Change "<id>" not found`. `--json` обязателен на
   change-маршруте: без него CLI печатает только proposal.md, молча опускает дельту и всё
   равно выходит с 0. `openspec context` печатает только spec-рецепт, поэтому в открытом
   окне ему доверять нельзя;
6. сгенерируй индекс: `node "$repo/tools/gen-index.mjs"`.

Допиши правило границы записи в файл проектных инструкций, который этап 5 доказал как
читаемый портом, в каждом подключённом репозитории и в хранилище:

```markdown
## HARD RULE — disposer self-check
After creating or editing ANY file under openspec/ or docs/, run:
    bash "$(git rev-parse --show-toplevel)/tools/verify-docs.sh"
Fix every ✗ (each error carries a remediation hint) and re-run until green
BEFORE reporting work done or proposing a commit. Rejected writes are corrected
by regenerating the content — never by loosening caps or deleting checks.
CIRCUIT BREAKER: if the same error survives 3 fix attempts, STOP and ask a human —
do not keep looping.
```

Проверь этап:

```bash
bash "$NEW_KIT/scripts/tools/kit-version.sh" identify \
  "$CORP_SYSTEM_STORE_ROOT"/submodules/*/tools/*.sh "$CORP_SYSTEM_STORE_ROOT"/submodules/*/tools/*.mjs
```

Ожидается: каждая строка `pristine <new edition>`, выход 0.

---

## Этап 8 — Установи команды, навыки, шаблоны и конфиг в дом агента

### 8.1 Копирование

Скопируй `skills/corp-*` в каталог проектных навыков, записанный в
`port-facts.md`, и `commands/corp-*.md` в записанный каталог команд. Адаптируй
только обёртку порта, frontmatter и токен `{{args}}`.

Новый набор поставляет **шесть** навыков; `71de101` поставлял пять. `corp-repository-state` —
новый и не имеет старого аналога:

```
corp-code-review  corp-debugging  corp-drill-down
corp-repository-state (NEW)  corp-tdd  corp-verification
```

Скопируй шаблоны, на которые ссылаются команды, в хранилище:

```bash
install -m 0644 "$CORP_SDD_ROOT/templates/adr.md"            "$CORP_SYSTEM_STORE_ROOT/templates/adr.md"
install -m 0644 "$CORP_SDD_ROOT/templates/research.md"       "$CORP_SYSTEM_STORE_ROOT/templates/research.md"
install -m 0644 "$CORP_SDD_ROOT/templates/store-contract.md" "$CORP_SYSTEM_STORE_ROOT/templates/store-contract.md"
```

(`adr.md`, `conventions-branching.md` и `research.md` побайтово идентичны
`71de101`; `port-facts.md` и `store-contract.md` изменились и уже были установлены
на этапе 1 / устанавливаются здесь.)

### 8.2 Разреши каждый токен `<openspec>` — обязательно, а не по желанию

Свежий файл команды поставляется с **неразрешёнными** плейсхолдерами. Замени каждый токен
`<openspec>` в установленных копиях на вызов, который ты доказал на этапе 6. Затем поставь контроль:

```bash
grep -rn '<openspec>' "<installed-command-dir>" && exit 1 || true
grep -rn '<openspec>' "<installed-skill-dir>"   && exit 1 || true
```

Ожидается: совпадений нет. Непустой результат значит, что миграция оставила команду,
которая не может работать.

Также докажи, что старый словарь исчез. `corp-archive` из `71de101` говорит:

```
1. Run the OpenSpec archive step (opsx archive) — delta folds into openspec/specs/.
```

а шаг 3 `corp-spec` говорит «via the opsx workflow». Ни одна из этих строк не должна уцелеть:

```bash
grep -rn 'opsx' "<installed-command-dir>" "<installed-skill-dir>" && exit 1 || true
```

Ожидается: совпадений нет.

### 8.3 Если у порта нет механизма навыков

Встрой тело каждого упомянутого навыка прямо в установленную команду и убери её
фразу `Follow skill …`, затем докажи, что не осталось ссылок на недоступный навык. Этот
запасной путь ставит полный процесс без внешнего Superpowers, который этому набору
не требуется.

### 8.4 Изменения поведения, о которых надо объявить команде

Это семантика команд, которая изменилась между `71de101` и текущей редакцией.
Она ломает мышечную память, а не файлы:

- **`corp-plan` теперь контролирует ветку.** Новый шаг 0:
  `bash "$REPO_ROOT/tools/repository-state.sh" assert-change <TICKET> --checkout`,
  **без** `--allow-dirty`. Грязное рабочее дерево теперь останавливает планирование. У старого `corp-plan`
  шага 0 не было вовсе.
- **`corp-archive` изменил форму аргументов, размещение, контроль и сообщение коммита.**
  Старое: `Precondition: … you are on updated main` и
  `5. Commit ("archive <change-id>: living spec + ADR + index")`.
  Новое: `{{args}}` — это `<change-id> [--here | --branch <name>]`, по умолчанию режется свежая
  **без суффикса** `feature/<TICKET>` от подготовленной базы — слияние обычно удалило ветку
  истории, так что имя свободно. Суффикса нет потому, что `check-git-naming.sh`
  принимает `^feature/ABCD-1234$` и ничего больше: `feature/ABCD-1234-archive` не проходит
  pre-push guard, и push отклоняется. Каждый режим запускает
  `assert-archivable`, а сообщение коммита —
  `docs(<TICKET>): archive {{args}} living spec and ADR`. Старая тема
  `archive <id>: …` теперь **отвергается** `check-git-naming.sh`.
- **`corp-plan` и `corp-spec` теперь коммитят по пути.** `git add <path>`; никогда
  `git add -A`, `git add .` или `git commit -a`.
- **`corp-test-plan` переписан** (11 → 73 строк) и теперь чёрный ящик: запрос
  или асинхронное сообщение, которое надо отправить, ожидаемый ответ и ожидаемые строки базы данных на
  dev-стенде — публикуется комментарием в том же тикете, никогда отдельной задачей на тестирование.
- **`index-all.sh` сменил каталог индекса Zoekt по умолчанию** на
  `${CORP_ZOEKT_INDEX_DIR:-$STORE_ROOT/.cache/zoekt/index}`. Перенаправь любую cron- или CI-задачу,
  где старый путь был зашит.

---

## Этап 9 — Поставь `templates/` и заполни `docs/testing-stack.md` в каждом репозитории

Этот файл новый в текущем наборе и не имеет аналога в `71de101`. Он не
опционален: `corp-tdd` и `corp-debugging` не называют собственного фреймворка — они читают
этот файл, поэтому пустой файл оставляет оба навыка без стека. Тот же цикл ставит шаблоны,
которые команды называют ПО ПУТИ: `docs/SETUP.md` §5, шаг 4, теперь копирует `adr.md`
(`corp-archive`), `research.md` и `testing-stack.md` в `templates/` каждого репозитория, а
`docs/UPGRADE.md`, этап 4a, делает то же при обновлении. Команда, называющая шаблон,
которого в репозитории нет, — мёртвая инструкция.

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do
      mkdir -p "$repo/docs" "$repo/templates"
      install -m 0644 "$CORP_SDD_ROOT/templates/adr.md"           "$repo/templates/"
      install -m 0644 "$CORP_SDD_ROOT/templates/research.md"      "$repo/templates/"
      install -m 0644 "$CORP_SDD_ROOT/templates/testing-stack.md" "$repo/templates/"
      test -f "$repo/docs/testing-stack.md" \
        || install -m 0644 "$CORP_SDD_ROOT/templates/testing-stack.md" "$repo/docs/testing-stack.md"
    done
```

Ожидается: `adr.md`, `research.md` и `testing-stack.md` в `templates/` каждого репозитория
и `docs/testing-stack.md` в каждом репозитории; существующий никогда не перезаписывается.

Заполняй каждый **вместе с командой**, из того, что сборка реально запускает — а не из того, что
команда собирается использовать. В шаблоне четыре раздела, и на каждый надо
ответить:

1. Таблица **уровня FAST** — по компоненту: что здесь считается быстрым тестом и команда, которая
   запускает *только* их. Должно оставаться в секундах; `corp-tdd` запускает её после каждого зелёного шага.
2. Таблица **уровня SLOW** — по компоненту: что здесь считается медленным тестом и команда, которая
   запускает *только* их. Запускается на границах задач и перед PR, никогда внутри
   микроцикла.
3. **Ошибки связывания** — назови в этом стеке границы, которые ловит ТОЛЬКО медленный уровень
   (внедрение зависимостей, сериализация, профили конфигурации). Задача, которая трогает одну
   из них, не считается сделанной по одному лишь зелёному быстрому уровню.
4. **Порядок границ отладки** — цепочка, по которой `corp-debugging` идёт от симптома к
   причине, от самой внутренней: падающий unit → его прямые входы → границы сериализации/конфига
   → сохранённое состояние → вышестоящие системы, с названными конкретными технологиями
   на каждом шаге.

Также поставь дату в заголовке: `# Testing stack — <repository name> (recorded YYYY-MM-DD)`.

Проверь по каждому репозиторию:

```bash
grep -n '^| \.\.\. ' "$repo/docs/testing-stack.md" && echo "UNFILLED PLACEHOLDER ROWS" || echo "no placeholder rows"
grep -c 'YYYY-MM-DD' "$repo/docs/testing-stack.md"
bash "$repo/tools/verify-docs.sh"
```

Ожидается: `no placeholder rows`; `0` для grep по дате; `verify-docs.sh` зелёный.
Запись, которую никто не может выполнить, хуже пустой строки — вставь реальный вывод
одной быстрой и одной медленной команды на репозиторий в передаточную заметку.

---

## Этап 9b — Дай каждому репозиторию честный `.gitignore`

`docs/SETUP.md` §5, шаг 6b, тоже новый: до первого запуска `.gitignore` каждого
репозитория должен покрывать вывод сборки, кеши языка (`__pycache__/`, `*.py[cod]`,
`target/`, `build/`, `node_modules/`) и локальные настройки.
За основу берётся `system-store-template/.gitignore`. Untracked-файлы не блокируют ни один
gate, но игнорируемый файл невидим для всех gate И его нельзя случайно закоммитить — именно
это нужно для файла настроек с паролем.

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do
      test -f "$repo/.gitignore" \
        || install -m 0644 "$CORP_SDD_ROOT/system-store-template/.gitignore" "$repo/.gitignore"
    done
```

Ожидается: `.gitignore` в каждом репозитории. Существующий дополняй, а не заменяй, и не
позволяй этому шагу выбросить правило, на которое команда уже полагается.

---

## Этап 10 — Почини незавершённые delta spec

Любая папка change, существовавшая до миграции, была написана против старого
правила дельт в `corp-lint.mjs`. Источник истины сместился: новый линт намеренно убрал
четыре проверки, которые делает сам OpenSpec, и теперь грамматику определяет CLI. Часть
спецификаций, проходящих сегодня, упадёт.

Найди их:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do
      ls -1 "$repo/openspec/changes" 2>/dev/null | grep -v '^archive$' | while read -r id; do
        echo "== $repo :: $id"
        ( cd "$repo" && $OPENSPEC validate "$id" --type change --strict --json )
      done
    done
```

Ожидаемое конечное состояние: `"valid": true` для каждой change. Чини каждый отказ в его причине:

| Симптом | Причина | Исправление |
|---|---|---|
| lint: `heading "### <x>" (line N) is not a requirement heading` | заголовок `### `, который не `### Requirement:` | Используй `### Requirement: <text>` **дословно**. Upstream пишет только INFO, оставляет `valid: true` и молча **выбрасывает это требование из дельт** — оно никогда не доходит до живой спецификации. Русским может быть только `<text>`. |
| lint: `requirement "<x>" (line N) sits outside a delta section` | требование выше первой `## ADDED\|MODIFIED\|REMOVED\|RENAMED Requirements` | Перенеси его под секцию дельты. Upstream молча его выбрасывает с `valid=true`; эта ошибка — единственное, что стоит между тобой и потерянным требованием. |
| lint: `no "## Why" section` (proposal.md) | в proposal нет дословного заголовка `## Why` | Добавь его. Без него change-маршрут, которым читает контракт каждая межрепозиторная спица — `<openspec> show <change-id> --type change --store <store-id> --json --deltas-only` — падает с `{"code":"show_error","message":"Change must have a Why section"}`, а `validate --strict` при этом всё равно сообщает `"valid": true`. Ни один флаг это не обходит. Новая жёсткая ошибка в `corp-lint.mjs` (проверка 4b); старые proposal без неё теперь краснеют. |
| lint: `no "## What Changes" section` (proposal.md) | в proposal нет дословного заголовка `## What Changes` | Добавь его рядом с `## Why` — схема ждёт пару. Новая жёсткая ошибка в `corp-lint.mjs` (проверка 4b). |
| CLI: missing delta section / no requirement in a delta section | нет `## ADDED Requirements` и т. п. | Добавь заголовок секции. `DELTA_SECTION` — это `/^##\s+(ADDED\|MODIFIED\|REMOVED\|RENAMED)\s+Requirements\s*$/im`. |
| CLI: ADDED/MODIFIED requirement with no scenario | под ним нет заголовка четвёртого уровня | Добавь хотя бы один. Годится любой заголовок `####`, включая `#### Сценарий: …`. |
| lint: `MODIFIED targets capability "<id>", which has no living spec` | дельта `MODIFIED`/`REMOVED`/`RENAMED` на capability, у которой нет `openspec/specs/<id>/spec.md` | Используй `## ADDED Requirements` для capability, у которой ещё нет живой спецификации, или исправь имя каталога capability. `validate --strict` здесь сообщает `"valid": true`; затем `openspec archive` падает уже после merge с `archive_spec_update_failed: "<id>: target spec does not exist; only ADDED requirements are allowed for new specs. MODIFIED and RENAMED operations require an existing spec."` Новая жёсткая ошибка в `corp-lint.mjs`. |
| lint warning: `requirement "<x>" states no SHALL/MUST` | нет нормативного глагола | Поставь SHALL или MUST в текст требования. |
| lint warning: `requirement "<x>" names no observable surface` | нет ничего, что тестировщик-чёрный-ящик может отправить или наблюдать | Назови endpoint, топик, таблицу, код статуса или запрос в сценарии. Требование, проверяемое только изнутри, относится к `corp-autotest`, а не к `corp-test-plan`. |

Структурные ключевые слова остаются английскими — `## ADDED|MODIFIED|REMOVED|RENAMED Requirements`
и `### Requirement:` — потому что OpenSpec их зашивает. Текст требования и
заголовки сценариев могут быть русскими.

Никогда не чини красную проверку ослаблением. Лимиты отвергают, а не подрезают: перегенерируй
содержимое.

По каждому репозиторию оба контроля должны быть зелёными вместе:

```bash
bash "$repo/tools/verify-docs.sh"
( cd "$repo" && $OPENSPEC validate "<change-id>" --type change --strict --json )
```

---

## Этап 11 — Докажи защиты

Новые байты инструментов означают, что защиты не доказаны. Прогони каждую против **временного
плохого входа**, в хранилище и в одном представительном spoke (`docs/SETUP.md` §8):

1. плохой корень OpenSpec должен провалить `check-openspec-root.sh`;
2. продублированная форма общего контракта должна провалить `check-contract-split-brain.mjs`;
3. плохое имя ветки и коммит с несовпадающим тикетом должны провалить `check-git-naming.sh`;
4. `git -C "<repo>" config core.hooksPath` должен быть пустым или указывать на хуки
   этого репозитория;
5. намеренно плохой временный коммит должен быть отвергнут установленным хуком lefthook;
6. репозиторий, которому не принадлежит собственный корень OpenSpec, должен быть отвергнут
   каждым проверяющим режимом `repository-state.sh` — `prepare-base`, `assert-change` и
   `assert-archivable` — с `✗ OpenSpec root is not this repository` и следом
   `  ↳ resolved root: <path>`. `inspect` остаётся нефатальным: он лишь печатает новую
   строку `openspec_root=`, поэтому ещё не онбордженный репозиторий можно посмотреть;
7. плохое имя ветки из пункта 3 должно быть отвергнуто на **pre-commit**, а не только на
   pre-push. `config/lefthook.yml.example` запускает `check-git-naming.sh --branch` на обоих,
   потому что lefthook пропускает pre-push команду, когда push не несёт файлов, которые он
   может перечислить, — это ровно тот push, который публикует новую ветку, первый раз, когда
   имя важно. У коммита всегда есть staged-файлы, поэтому pre-commit копию пропустить нельзя.

Ожидается: все семь **красные** (пункт 6 — красный только в проверяющих режимах).
Зелёный негативный тест значит, что защита не подключена. Никогда не ослабляй защиту,
чтобы этот этап прошёл.

---

## Этап 12 — Финальный чек-лист проверки

Прогони каждую строку и вставь реальный вывод в передаточную заметку.

```bash
# 1. the kit you installed from is intact
bash "$NEW_KIT/scripts/tools/kit-version.sh" show
bash "$NEW_KIT/scripts/tools/kit-version.sh" verify
```
Ожидается: строка редакции; затем `✓ 24 file(s) match <edition>`, выход 0.

```bash
# 2. every installed file is pristine at the new edition
bash "$NEW_KIT/scripts/tools/kit-version.sh" identify \
  "$CORP_SYSTEM_STORE_ROOT"/tools/*.sh "$CORP_SYSTEM_STORE_ROOT"/tools/*.mjs \
  "$CORP_SYSTEM_STORE_ROOT"/submodules/*/tools/*.sh "$CORP_SYSTEM_STORE_ROOT"/submodules/*/tools/*.mjs \
  "<installed-command-dir>"/corp-*.md
```
Ожидается: каждая строка инструмента читается как `pristine <edition>  (kit path scripts/tools/…)`,
выход 0.
**Файлы команд — исключение:** после того как этап 8.2 разрешил `<openspec>`, они
отредактированы по замыслу и сообщат
`stamped <edition> but MODIFIED (bytes not in this kit edition)`. Это правильный
результат для разрешённой команды; отметь это в передаточной заметке, чтобы следующее обновление
не пересматривало вопрос заново. Команда, сообщающая `pristine`, всё ещё содержит неразрешённый токен —
вернись к этапу 8.2.

```bash
# 3. the disposer is green everywhere
bash "$CORP_SYSTEM_STORE_ROOT/tools/verify-docs.sh"
git -C "$CORP_SYSTEM_STORE_ROOT" submodule foreach --quiet 'echo "$toplevel/$sm_path"' \
  | while IFS= read -r repo; do echo "== $repo"; bash "$repo/tools/verify-docs.sh"; done
```
Ожидается: нигде ни одной строки `✗`, выход 0 для каждого. `verify-docs.sh` собирает
`gen-index.mjs --check`, `corp-lint.mjs` и `check-contract-split-brain.mjs`; каждая
ошибка несёт подсказку по исправлению. Учти, что `--check` сообщает о расхождении индекса и ничего
не пишет — если он сообщает о расхождении, выполни `node "$repo/tools/gen-index.mjs"` и запусти заново.

```bash
# 4. every in-flight change validates
( cd "<repo>" && $OPENSPEC validate "<change-id>" --type change --strict --json )
```
Ожидается: JSON с `"valid": true` для каждой change в каждом репозитории.

```bash
# 5. the submodule layer is stable and idempotent
bash "$CORP_SYSTEM_STORE_ROOT/tools/sync-submodules.sh" \
  --inventory "$CORP_SYSTEM_STORE_ROOT/project-repositories.json" \
  --store-root "$CORP_SYSTEM_STORE_ROOT"
git -C "$CORP_SYSTEM_STORE_ROOT" diff -- .gitmodules
git -C "$CORP_SYSTEM_STORE_ROOT" submodule status
node "$CORP_SYSTEM_STORE_ROOT/tools/aggregate-index.mjs" --strict "$CORP_SYSTEM_STORE_ROOT"
```
Ожидается: `✓ <name> (registered)` на каждый репозиторий плюс
`✓ reconciled <N> project-bound submodule(s) …`; **пустой** диф `.gitmodules`;
одна чистая строка `submodule status` на репозиторий; `aggregate-index --strict` выход 0
(красный репозиторий валит его громко).

```bash
# 6. no token, no old vocabulary, no old script
grep -rn '<openspec>' "<installed-command-dir>" "<installed-skill-dir>"; echo "rc=$?"
grep -rn 'opsx' "<installed-command-dir>" "<installed-skill-dir>"; echo "rc=$?"
find "$CORP_SYSTEM_STORE_ROOT" -name sync-repos.sh
find "$CORP_SYSTEM_STORE_ROOT" -name repos.json
```
Ожидается: `rc=1` (совпадений нет) для обоих вызовов `grep`; ни один `find` ничего не печатает.

```bash
# 7. syntax
bash -n "$CORP_SYSTEM_STORE_ROOT/tools/sync-submodules.sh"
bash -n "$CORP_SYSTEM_STORE_ROOT/tools/repository-state.sh"
bash -n "$CORP_SYSTEM_STORE_ROOT/tools/verify-docs.sh"
```
Ожидается: молча, выход 0 для каждого.

```bash
# 8. one real command in the real port
```
Файлы на диске — это не работающая установка. Запусти `corp-spec` на одноразовом тикете в
одном подключённом репозитории, подтверди, что он доходит до интервью и пишет
`openspec/changes/<id>/proposal.md`, затем удали ветку и папку change. Миграция,
в которой ни одна команда не выполнялась в реальном порту, не доказана, что бы ни печатал
`identify`.

### Коммит

Один коммит на репозиторий Git, каждый откатывается сам по себе:

```bash
git -C "<repo>" add tools/ docs/testing-stack.md openspec/
git -C "<repo>" commit -m "chore(<TICKET>): corp-sdd migration 71de101 -> <new edition>"
git -C "$CORP_SYSTEM_STORE_ROOT" add tools/ conventions/ templates/ project-repositories.json .gitmodules submodules
git -C "$CORP_SYSTEM_STORE_ROOT" commit -m "chore(<TICKET>): adopt clones as submodules; corp-sdd <new edition>"
```

Индексируй по пути. Никогда `git add -A`: эти репозитории законно держат локальные
настройки, файлы с учётными данными и черновики. Запиши SHA каждого коммита в передаточную заметку.

### Закрывай миграцию только когда держится каждая строка

- [ ] `~/corp-sdd-migration-preflight.txt` — инвентаризация клонов до миграции — есть в
      передаточной заметке, клоны с неотправленным / stash / грязным деревом отмечены поимённо;
- [ ] `kit-version.sh verify` был зелёным на новом наборе **до** первого копирования;
- [ ] каждый клон усыновлён через `mv` + `submodule add`, и каждый напечатал
      `Adding existing repo at 'submodules/<name>' to the index`;
- [ ] каждый URL в `.gitmodules` равен реальному `origin` соответствующей рабочей копии;
- [ ] `$CLONES_DIR` не был удалён, и всё, что в нём осталось, названо в
      передаточной заметке;
- [ ] `project-repositories.json` существует с `schema_version: 1`, `project`,
      `repository_source` и `base_branch` на каждый репозиторий;
- [ ] `repos.json` переименован в `.superseded`, нигде нет `sync-repos.sh`;
- [ ] каждый репозиторий прошёл контроль `prepare-base` до своего копирования; пропущенные
      репозитории названы с провалившимся контролем и его выводом;
- [ ] `corp.agentDir` задан в каждом репозитории и повторён в ответ;
- [ ] токен `<openspec>` разрешён, все шесть CLI-вызовов доказаны и записаны в
      `port-facts.md`, `grep` не находит ни `<openspec>`, ни `opsx`;
- [ ] `port-facts.md` заполнен: ни в одной P-строке не осталось `...`, в заголовке указаны реальные
      имя порта, версия и дата опроса, и `corp-lint.mjs` зелёный на хранилище;
- [ ] в каждом репозитории есть каталог `openspec/adr/` с файлом `.gitkeep`;
- [ ] все шесть навыков установлены, включая новый `corp-repository-state`;
- [ ] `docs/testing-stack.md` заполнен и без плейсхолдеров в каждом репозитории, с
      вставленным выводом одной быстрой и одной медленной команды на репозиторий;
- [ ] каждая незавершённая change сообщает `"valid": true`;
- [ ] пять негативных тестов этапа 11 красные там, где обязаны быть красными;
- [ ] `sync-submodules.sh` перезапущен чисто, диф `.gitmodules` пуст,
      `aggregate-index --strict` зелёный;
- [ ] одна команда Corp выполнена от начала до конца в реальном порту после миграции;
- [ ] один коммит на репозиторий, записан по SHA.

---

## Откат

Этапы 7–10 — это один коммит на репозиторий, поэтому они откатываются по одному репозиторию за раз:

```bash
git -C "<repo>" revert --no-edit <migration-commit>
bash "<repo>/tools/verify-docs.sh"
```

Этап 2 (усыновление клонов) — единственный необратимый средствами Git шаг, и он обратим
руками, потому что ничего не удалялось:

```bash
git -C "$CORP_SYSTEM_STORE_ROOT" submodule deinit -f -- "submodules/<name>"   # leaves the work tree
git -C "$CORP_SYSTEM_STORE_ROOT" config -f .gitmodules --remove-section "submodule.<name>"
mv "$CORP_SYSTEM_STORE_ROOT/submodules/<name>" "$CLONES_DIR/<name>"
git -C "$CLONES_DIR/<name>" status --porcelain
git -C "$CLONES_DIR/<name>" stash list
```

Сверься с `~/corp-sdd-migration-preflight.txt`, что ветки, неотправленные коммиты и
stash-и не изменились. Держи `$OLD_ROOT` и `$CLONES_DIR`, пока этап 12 не станет зелёным — они
единственный откат для этапов 1–6.

Откат команд и навыков означает переустановку `en/commands/` и
`en/skills/` из `71de101`, потому что каталог порта обычно не является репозиторием Git. Держи старую
рабочую копию распакованной.

---

## Известные дефекты набора, открытые в текущей редакции

Из `content/enterprise-sdd-agents/kit-review-2026-08-25.md`. Они не вызваны
миграцией; знай их до того, как на них наткнёшься.

- **Ничто в ежедневном процессе не доказывает корень OpenSpec.** `check-openspec-root.sh`
  существует именно потому, что OpenSpec идёт вверх мимо `.git`, а новая раскладка помещает каждый
  репозиторий *внутрь* хранилища, у которого есть свой `openspec/`. Ни одна команда его не вызывает (grep
  по всем командам и навыкам: ноль попаданий) — только этап 5 в `docs/SETUP.md`.
  Репозиторий, потерявший или не закоммитивший свой `openspec/`, молча пишет в хранилище.
  Смягчение: запускай `bash "$REPO_ROOT/tools/check-openspec-root.sh"` сам перед каждой
  записью спецификации и добавь это в файл инструкций своей команды.
- ~~`corp-lint.mjs` зашивает каталог порта~~ — **исправлено в редакции `2026-08-25.11`**
  (находка 6 из ревью набора). Имя дома агента нигде в наборе не встречается; линт разрешает
  `CORP_AGENT_DIR` → `git config corp.agentDir` → единственный корневой dot-каталог, содержащий
  `skills/`, и выходит с 1, вместо того чтобы угадывать между двумя. Явно задавать `corp.agentDir`
  (этап 5.2) всё равно более безопасная привычка и обязательно, когда в корне репозитория больше
  одного такого каталога.
- **`verify-docs.sh`, запущенный из распакованного набора, падает** вместо объяснения: он
  разрешает `REPO_ROOT` в содержащий его репозиторий Git и умирает с
  `Cannot find module '<that repo>/tools/gen-index.mjs'`. Это инструмент только для установленного состояния.
  Всегда запускай установленную копию из корня репозитория.

---

## Не проверено

Всё выше прослеживается до файла, прочитанного в этом репозитории. Эти пункты — нет, и они
должны быть разрешены на целевой машине до или во время прогона — не выдумывай их:

1. **Реальная раскладка на диске установки `71de101` у оператора.** Публичный коммит
   поставляет деревья `en/` и `ru/` и `config/repos.json.example`. Где реально лежат живой
   `repos.json`, `clones/` и установленные `tools/`, выясняется на этапе
   0.3, а не предполагается здесь.
2. **Использует ли установка дерево `en/` или `ru/`.** Оба есть в `71de101` и
   функционально идентичны. Для этого runbook читался каталог текущего набора — английский
   `corp-sdd-starter/`; рядом с ним есть `corp-sdd-starter-ru/`. Ставь тот язык,
   на котором команда уже работает.
3. **Существует ли уже системное хранилище на `<store-remote-url>`.** Этап 1 спрашивает Git
   через `git ls-remote`; отсюда ответ узнать нельзя.
4. **Закреплённая версия `@fission-ai/openspec` и разрешённый вызов `<openspec>`.**
   Набор записывает токен, никогда значение. Этап 6 его доказывает.
5. **Домашний каталог порта агента, каталог команд, каталог навыков, имя файла инструкций
   и имена MCP-инструментов.** Набор намеренно не называет ни одного. Этап 5
   их находит.
6. **Поддерживает ли порт навыки вообще.** Если нет, возьми запасной путь со встраиванием
   из этапа 8.3.
7. **Базовые ветки по репозиториям.** Этап 3.1 читает их из каждого remote; в
   `repos.json` нет значения для преобразования.
8. **Дифы старое-против-нового для `corp-review`, `corp-implement`, `corp-autotest` и `corp-test-plan`**
   не читались построчно для этого runbook; читались только `corp-spec`, `corp-plan` и
   `corp-archive`. Изменения поведения, перечисленные в 8.4 для остальных четырёх, взяты
   из записанной сводки дифа в заметке проекта (`projects/active/corp-sdd-transition.md`,
   запись от 2026-08-25: 21 ломающее / 14 дополняющих / 9 нейтральных по 25 файлам), а не из
   прямого чтения здесь. Пересними диф, прежде чем полагаться на любую деталь сверх того, что говорит 8.4.
9. **Точная система CI.** `docs/SETUP.md` §7 поставляет шаблон CI-пайплайна и помечает
   его TEMPLATE. Адаптируй и прогони дымовой тест; этот runbook не мигрирует CI.
10. **Редакция набора двигается быстро.** Во время написания этого runbook `VERSION`
    читался как `2026-08-25.13`, затем через минуты `2026-08-25.14`; последняя сверка была
    против `2026-08-26.7`. Всегда читай `VERSION` на том наборе, который распаковал, а не
    доверяй строке редакции, приведённой здесь.
