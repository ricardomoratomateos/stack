# Spike: navegador de código (Monaco + LSP) en la app de escritorio

Rama `worktree-agent-a5e3a2420d3778b9a`, sobre `v1` (`0040827`). Es un spike: el prototipo vive aislado
(`desktop/src/code/`, `desktop/scripts/code-dev-server.mjs`, ruta `?dev=code`) y no toca la app ni stackd.

## Objetivo

Hoy se revisa el trabajo de un agente en la pestaña Review (un diff estilo PR), pero no se puede navegar el
código. La pregunta: ¿podemos incrustar un navegador de código con navegación de verdad (ir a definición,
buscar referencias, hover, símbolos, árbol de ficheros, ⌘P) para **PHP y JS/TS**, en repos del tamaño de
`big-app`? Regla 80/20: "entender lo que ha cambiado el agente", solo lectura; no rehacer VS Code.

Decisiones tomadas durante el spike:

- **Intelephense, descartado**: licencia propietaria y 1,1 GB estables (2,6 GB de pico) por worktree.
- **No indexar `vendor/` (PHP) ni `node_modules/` (JS/TS).**

## Respuesta corta

**Sí, y con poca memoria en PHP.** Sobre un worktree real de `big-app` (33 223 ficheros PHP propios,
10 412 TS/TSX en `frontend/apps/v2/src`):

- **PHP con Phpactor** (MIT), sin indexar `vendor/`: **~100 MB** de memoria estable, respuestas en 1–50 ms,
  y aun así salta a las clases de `vendor/` (las encuentra por el mapa PSR-4 de Composer, sin indexarlas).
  El precio: el primer indexado tarda **~2,8 min** por worktree y el índice ocupa **750 MB en disco**.
- **JS/TS con el LSP nativo de TypeScript 7**: es lo caro. El proyecto entero sin `node_modules` son
  **1,6 GB**; acotado a los ficheros que se miran y lo que importan, **0,5 GB**. Sin `node_modules` la
  navegación por código propio funciona; los tipos que vienen de librerías pasan a `any`.
- En los dos casos: un servidor por (worktree, lenguaje), arrancado al primer uso y apagado por inactividad.

## Qué enseña el prototipo

`http://localhost:1430/?dev=code` (ver "Cómo ejecutarlo"):

- Árbol de ficheros perezoso del worktree; al saltar a un fichero, el árbol lo revela.
- Monaco en solo lectura con el tema de la app (tokens `--app-*` + variables `--vscode-editor-*`).
- **Ir a definición** (⌘-clic / F12), **referencias** (⇧F12, con vista previa de ficheros que nunca se
  abrieron), **hover** y símbolos del fichero, para PHP (**Phpactor** por defecto) y TS/JS
  (typescript-language-server, o el LSP nativo de TypeScript 7 con `--ts-native`).
- PHP sin indexar `vendor/`: F12 sobre `Request` de Symfony abre `vendor/symfony/http-foundation/Request.php`.
- ⌘P: ficheros por nombre difuso. `#texto`: símbolos del proyecto, de los servidores ya arrancados.
- Atrás / adelante con los botones, como "Go Back" de VS Code.
- Píldoras de estado por servidor (arrancando / indexando N de M / listo).
- Apertura directa en un fichero y línea: `&file=…&line=…` (lo que haría el clic desde Review).
- Backend con la forma que tendría en stackd: lecturas solo dentro de raíces permitidas (con `realpath`),
  solo métodos LSP de navegación, un servidor por (worktree, lenguaje) arrancado al primer uso.

Probado en Chrome contra el worktree `big-app/team/feat-1234-stock-sync`. Sin probar:

- **Dentro de la app Tauri (WKWebView)**: no se podía reiniciar la app en uso. Primera verificación pendiente.
- La UI del outline (⌘⇧O) y los atajos ⌘T / ⌃-: cableados; solo probé el proveedor y los botones.
- El modo TS "acotado / sin `node_modules`" está medido con scripts aparte, **no** cableado en el prototipo.

## Medidas

Máquina: Apple silicon, 8 núcleos, 24 GB, macOS 14, Node 23.11, PHP 8.4.8. Con otros agentes trabajando a la
vez, así que los tiempos son pesimistas. Memoria = `phys_footprint` (`footprint <pid>`), no RSS: con la
máquina cargada macOS comprime la memoria de un proceso ocioso y `ps` enseña 15–180 MB para procesos de 1–3 GB.

### Tamaño de los repos

| Repo | Ficheros | PHP | TS/JS | Nota |
|---|---|---|---|---|
| `big-app` (checkout principal, sin `node_modules`, `.worktrees`, `var`) | 418 235 | 314 509 | ~41 000 | Incluye `team/` (otros checkouts dentro del repo) y `vendor/` |
| Un worktree de tarea real (`team/feat-1234-…`) | 116 834 | 89 188 (30 839 propios + 58 349 de `vendor/`) | 11 907 propios | Recorrerlo: 0,5–1,3 s |
| `other-repo` | 670 | 0 | 0 | **Es Go** (560 `.go`): fuera de PHP/JS. Con el mismo puente sería añadir `gopls` |

- Los worktrees viven **dentro** del repo (`big-app/team/…`, `big-app/.worktrees/…`): el servidor se
  arranca en el worktree, nunca en la raíz del repo, y se excluyen worktrees anidados.
- En el worktree, `vendor/` es un directorio real y `node_modules` son symlinks al checkout principal.

### PHP: Phpactor frente a Intelephense

Mismo worktree, mismos casos. Phpactor 2026.10.07.0 (Composer, instalación local), Intelephense 1.18.5.

| | **Phpactor, sin `vendor/`** (recomendado) | Phpactor, con `vendor/` | Intelephense, sin `vendor/` | Intelephense, con `vendor/` |
|---|---|---|---|---|
| Ficheros indexados | 33 223 | 93 892 | 32 783 | 89 418 |
| Indexado en frío | **169 s** (dentro del LSP) · 159 s (`index:build`, 6 workers) | 146 s (`index:build`) | 15 s | 62 s |
| Memoria indexando (pico) | 0,3 GB (`footprint`; RSS hasta 0,8 GB) | 0,47 GB | 1,4 GB | 2,6 GB |
| **Memoria estable** | **~100 MB** (0,3 GB justo tras indexar) | ~150 MB | 0,7–1,3 GB | 1,1 GB |
| Índice en disco | **751 MB** (129 027 ficheros) | 1,6 GB (318 491 ficheros) | 55 MB | 141 MB |
| Arranque en caliente: primera respuesta | 4,7–8 s | — | — | 2,5 s |
| Definición de clase | 26–52 ms / 1 ms | 36 / 1 | 5 / 3 | 0–10 |
| Definición de propiedad, método, estático | 1–6 ms / 1 ms | igual | 0–7 | 0–10 |
| Definición de método encadenado (inferencia) | 30 ms; hasta 2–4 s la primera en frío | igual | 2 | — |
| Definición de función nativa (`is_null`) | 1–3 ms (stubs) | igual | 1 | — |
| Definición hacia `vendor/` (clase, método) | **19 ms / 10 ms** (mapa de Composer) | 19 / 8 | **sin respuesta** | 0–10 |
| Hover | 10–39 ms / 1 ms | 8–23 / 1 | 2–13 / 1 | 14 |
| Referencias, símbolo estrecho | 38–80 ms / 4–7 ms (28) | 146 / 5 (28) | 22 / 4 (39) | 22 (39) |
| Referencias, símbolo amplio (`QueryBus`) | 664 ms / 160–288 ms (1 103) | 684 / 155 | 1 093 / 817 (2 013) | 1 700 (2 013) |
| Referencias de un método | 85–144 ms / 13–36 ms (9) | 99 / 19 | 4 / 1 (9) | — |
| Símbolos del proyecto | 24–139 ms / 20–48 ms | 50–108 / 45 | 35–40 / 0–2 | 2–470 |
| Símbolos del fichero | 2–4 ms | 2 | 1 | 1 |

"a / b" es primera petición / repetida. Entre paréntesis, número de resultados.

**Corrección.** Phpactor acertó los 12 casos de definición (clase, interfaz, propiedad, método, método
encadenado dos veces, estático, método de interfaz, función nativa, clase y método de `vendor/`) y los hovers.
Diferencias con Intelephense:

- Referencias: no cuenta las líneas `use …;` (28 frente a 39; 1 103 frente a 2 013). Los usos reales coinciden
  en el caso que comprobé a mano (12 `use` de diferencia).
- Símbolos del proyecto: solo clases, funciones y constantes (no métodos ni propiedades), con el nombre
  completo (`Acme\…\ExternalOrder`). El prototipo enseña el nombre corto.
- Sin el mapa de Composer (`composer.enable: false`) y sin indexar `vendor/`, las tres definiciones hacia
  `vendor/` no responden. Con el mapa, sí.
- Sin medir: si responde mientras indexa por primera vez.

**Configuración que necesita** (el prototipo la pasa como `initializationOptions`, nada en el repo):

- `indexer.exclude_patterns`: `/vendor/**/*`, `/node_modules/**/*`, `/.worktrees/**/*`, `/.php/**/*`.
- `composer.enable: true` + `composer.class_maps_only: true`: lee `vendor/composer/autoload_psr4.php` y
  `autoload_classmap.php` como datos; no registra ni ejecuta el autoloader del proyecto.
  `composer.autoloader_path` puede apuntar al `vendor/autoload.php` del checkout principal: comprobado, sirve
  para worktrees sin `vendor/`.
- **`language_server_configuration.auto_config: false`, obligatorio.** Por defecto, al arrancar, Phpactor
  detecta PHPStan, php-cs-fixer, etc. en el `composer.lock`, pregunta si activarlos y **escribe la respuesta
  (también el "no") en `<proyecto>/.phpactor.json`**. Me pasó en la primera medida: apareció ese fichero en el
  worktree del repo; lo borré (era solo eso, cuatro `…enabled: false`). Con la opción apagada no escribe:
  reproducido en un proyecto de prueba y comprobado después en el worktree real.
- `language_server.enable_trust_check: false` y no confiar en el `.phpactor.json` del repo (puede nombrar
  binarios a ejecutar). Diagnósticos apagados. `indexer.enabled_watchers: ["lsp"]` (sin sondear el árbol).
- `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` hacia el directorio de Stack: el índice queda en
  `<cache>/phpactor/index/<nombre>-<hash de la ruta>`. Con esto y `auto_config: false`, nada en el repo ni en `~`.
- Stubs de PHP: los trae (`jetbrains/phpstorm-stubs`).
- Requisitos: PHP 8.2+ con `mbstring`, `posix`, `tokenizer`. Instalación: 32 MB.

**Muchos worktrees.** Un índice por ruta de worktree (el directorio lleva el hash de la ruta); no se comparte
ni se puede copiar de uno a otro tal cual (guarda rutas absolutas). Coste por worktree: ~2,8 min de CPU la
primera vez y 750 MB de disco; la memoria solo se paga mientras el servidor está vivo (~100 MB). Borrar el
índice al borrar la tarea (129 000 ficheros pequeños).

### TS/JS: `frontend/apps/v2` (10 412 ficheros, `paths` en tsconfig)

Servidor: LSP nativo de TypeScript 7.0.2 (`tsc --lsp --stdio`). Para quitar `node_modules` o acotar el
proyecto sin tocar el repo, un directorio espejo fuera de él: symlinks a `src/` y `config/` y un
`tsconfig.json` generado. El servidor devuelve las rutas reales del worktree.

| Variante | Memoria | Primera respuesta | Definición y referencias en código propio | Librerías |
|---|---|---|---|---|
| Proyecto entero, con `node_modules` | **2,2 GB** | 3,9 s | Completas (28 / 314 referencias) | Definición, hover y referencias (73) bien |
| Proyecto entero, **sin `node_modules`**, `types: []` | **1,6 GB** | 2,6 s | Completas (28 / 314) | Rotas (ver abajo) |
| **Acotado** a un fichero + lo que importa, sin `node_modules` | **0,5 GB** | 1,0 s | Definición bien; **referencias parciales** (6 de 28, 120 de 314) | Rotas |
| Acotado, con `node_modules` | 0,8 GB | 3,1 s | Definición bien; referencias parciales | Bien |
| typescript-language-server + tsserver, proyecto entero con `node_modules` | 3,0 GB | ~18 s, y mientras carga da respuestas engañosas | Completas | Bien |

Latencias una vez cargado: definición 0–1 ms, hover 0–40 ms (el primero hasta 300 ms), referencias 40–100 ms,
símbolos 10–140 ms.

Qué se rompe sin `node_modules`:

- Ir a definición de un import de librería (`useDebounce`, `<Typography>`) se queda en la línea del import.
- Hover: todo lo que pasa por tipos de librería es `any`. `const t: any` (antes `TFunction<…>`),
  `useSidePanel: () => any` (su tipo sale de un contexto de React), `formatter: any`. Los tipos que no tocan
  librerías siguen bien (`showTooltip: boolean`).
- Referencias a un símbolo de librería: solo las del fichero.

Qué sigue funcionando: definición entre ficheros propios (import, llamada, tipo, función, miembro de enum,
desestructurado), referencias en código propio, símbolos del proyecto y del fichero.

Quitar `node_modules` ahorra solo un 26 % (0,6 GB): lo que pesa es el programa propio, 10 000 ficheros. Lo
que de verdad baja la memoria es **acotar**: 0,5 GB, a cambio de referencias incompletas.

### Saltar a `vendor/` o a una librería sin indexarla

- **PHP: resuelto, y no hay que escribirlo.** Es lo que hace Phpactor con el mapa de Composer: 19 ms a la
  clase, 10 ms a un método, 0 MB de índice. Vale la pena y ya está en el prototipo.
- **TS: barato pero pobre.** Resolver el import al fichero de tipos del paquete (subir por `node_modules`,
  leer `types`/`exports` del `package.json`) resolvió 5 de 5 imports de librería en 8 ms. Pero aterriza en
  el fichero de entrada del paquete, que suele ser un índice de re-exportaciones, no en el símbolo. Vale como
  detalle posterior (S), no para el MVP.

### Monaco y ficheros

| Qué | Resultado |
|---|---|
| `monaco-editor` 0.57.0, chunk aparte (carga perezosa) | 3,98 MB (1,03 MB gzip) + 189 KB CSS + 275 KB el worker |
| Bundle principal de la app | 768 KB; Monaco no entra en él |
| ⌘P sobre 120 539 ficheros | ~57 ms de ida y vuelta (filtrado en el backend); primer listado 1,3 s |
| Typecheck y tests | raíz y `desktop` pasan; 134 tests de `desktop` (5 nuevos) |

## Por qué ocupan tanta memoria

Un servidor de lenguaje contesta "¿dónde se define esto?" en milisegundos porque ya lo tiene todo leído y
entendido. Ese "todo" es lo que ocupa.

- **Intelephense** lee cada fichero PHP del proyecto, `vendor/` incluido, y guarda en memoria una ficha por
  cada clase, método, función, propiedad y constante, más un índice inverso "quién usa qué" para las
  referencias. Todo vive dentro de un proceso Node, como objetos JavaScript, que ocupan varias veces lo que el
  texto original. 89 000 ficheros dan 1,1 GB; mientras indexa necesita el doble. Su caché en disco es
  pequeña (141 MB) porque al arrancar la vuelve a cargar entera en memoria.
- **Phpactor** hace lo contrario: escribe el índice en disco, un ficherito por clase y por símbolo, y solo
  carga lo que cada pregunta necesita. Por eso usa 100 MB y, a cambio, ocupa 750 MB de disco, tarda más en
  indexar y contesta en decenas de milisegundos en vez de en uno.
- **TypeScript (tsserver o TS 7)** no tiene un índice: tiene el programa entero. Para saber el tipo de una
  variable hay que haber analizado el fichero, lo que importa, lo que importa eso, y los `.d.ts` de las
  librerías (React y MUI son miles de ficheros de tipos). Guarda el árbol sintáctico de cada fichero, las
  tablas de símbolos y una caché de tipos ya calculados. Con 10 000 ficheros propios son 1,6 GB; las
  librerías suman 0,6 GB. tsserver además es JavaScript (3 GB); TS 7 es un binario nativo (2,2 GB).
- **Un índice por worktree.** Cada worktree es otra rama: los mismos ficheros con contenido distinto. Si
  varios worktrees compartieran servidor, cada clase existiría N veces e "ir a definición" devolvería N
  candidatos de ramas distintas. Así que el coste se multiplica por el número de worktrees **abiertos**, y
  la única defensa es no tenerlos abiertos a la vez.

## Opciones comparadas

### Editor y cliente LSP

| Opción | A favor | En contra | Veredicto |
|---|---|---|---|
| **`monaco-editor` + cliente LSP propio y fino** | ~150 líneas (`desktop/src/code/lsp.ts`); cada proveedor es una petición al backend, encaja con `POST /commands/<name>` de stackd: **no hace falta WebSocket** | Cada capacidad se escribe a mano (para solo lectura son 4–6) | **Recomendada** |
| `monaco.lsp` (cliente que trae `monaco-editor` 0.57) | Viene incluido (135 KB) | Experimental: fija `rootUri: null`, sin `workspaceFolders` ni `initializationOptions`; no sirve para servidores de proyecto | Descartada hoy |
| `monaco-languageclient` + `@codingame/monaco-vscode-api` | Cliente LSP completo, extensiones de VS Code | Arrastra decenas de paquetes, sustituye el `monaco-editor` normal. Peso no medido | Es "rehacer VS Code" |
| Worker de TypeScript integrado en Monaco | Sin proceso externo | Solo conoce los modelos que se le den: habría que cargarle 10 000 ficheros y los `paths` del tsconfig. +6 MB. Nada para PHP | Descartada |

### PHP

**Phpactor**: MIT, 100 MB, acierta todos los casos, salta a `vendor/` sin indexarlo. Pide PHP 8.2+ en la
máquina (quien trabaja en un repo PHP lo tiene; si no, la pestaña Code funciona sin navegación PHP) y paga
el primer indexado (~2,8 min) y 750 MB de disco por worktree. Intelephense queda en el prototipo solo para
comparar (`--php-server intelephense`).

### JS/TS

**LSP nativo de TypeScript 7** (`typescript@7`, 30 MB con el binario): arranca en 1–4 s, no da respuestas
parciales, no ejecuta plugins JS del repo. Modo por defecto: **acotado y sin `node_modules`** (0,5 GB), con
el proyecto generado a partir de los ficheros TS del diff de la tarea. "Buscar usos" completo se cubre con
búsqueda de texto (`git grep`), marcando que las referencias del servidor son parciales. Un botón "cargar
proyecto completo" sube a 1,6 GB (sin librerías) cuando haga falta.

### Quién ejecuta los servidores

stackd: ya es un proceso Node de larga vida, conoce los worktrees y su repo, y la app ya le habla por
`stackd_command`. La navegación LSP es petición/respuesta, así que cabe en comandos nuevos (`codeTree`,
`codeFile`, `codeFiles`, `codeSearch`, `codeLsp`) sin WebSocket ni eventos Tauri. El estado de indexado puede
ir en el snapshot que ya se emite por SSE.

### Política de servidores

- Arrancar solo al primer "ir a definición / hover" en un fichero de ese lenguaje, no al abrir la pestaña.
- Apagar a los 5–10 min sin peticiones o al cerrar la pestaña Code. Phpactor vuelve en 5–8 s; TS acotado en 1 s.
- Como mucho un servidor TS vivo a la vez (el caro); Phpactor puede haber varios (100 MB cada uno).
- Phpactor: lanzar el primer indexado en segundo plano al crear la tarea o al abrir Code por primera vez, con
  progreso visible; hasta que acabe, la navegación PHP avisa de que está indexando.

## Recomendación y alcance del MVP

| # | Pieza | Qué | Esfuerzo |
|---|---|---|---|
| 1 | Comandos de ficheros en stackd | `codeTree`, `codeFile`, `codeFiles` (lista con `git ls-files` + no trackeados, cacheada), guardia de rutas, tests | S |
| 2 | Pestaña **Code** | Junto a las pestañas de sesión y Review. Monaco solo lectura, árbol, ⌘P, atrás/adelante. Arriba del árbol, "Changed": los ficheros del diff (`getDiff` ya existe). Se abre en el primer fichero cambiado | M |
| 3 | Review → Code | El `openFile {path, line}` que Review ya emite (hoy abre VS Code) abre la pestaña Code en esa línea. Marcas de líneas cambiadas en el margen | S |
| 4 | Gestor LSP en stackd (`src/lsp/`) | Arranque bajo demanda por (worktree, lenguaje), apagado por inactividad, tope de servidores, estado en el snapshot, reinicio si muere. Es el `LspServer` del prototipo con tests | M |
| 5 | PHP con Phpactor | Detectar PHP 8.2+, instalar Phpactor bajo demanda en `~/.config/stack/lsp/`, perfil de arriba, índice por worktree fuera del repo, borrarlo con la tarea | S–M |
| 6 | Buscar en el proyecto | `git grep` desde stackd y lista de resultados. Cubre también "usos" en TS acotado | S–M |
| 7 | TS/JS con TS 7 acotado | Generar el proyecto espejo (symlinks + tsconfig) a partir de los ficheros TS del diff; regenerar cuando cambie el diff; botón "proyecto completo" | M |
| 8 | Cambios en disco | El agente edita mientras se navega: `fs.watch` en stackd → recargar los modelos abiertos y avisar al servidor (`workspace/didChangeWatchedFiles`, que es el watcher `lsp` de Phpactor) | M |

1–3 dan un navegador útil sin ningún servidor de lenguaje (≈ una semana). 4–6 añaden PHP con navegación
completa y búsqueda (≈ otra). 7–8 después; TS es la pieza con más incógnitas.

No construir: edición y guardado, completado, diagnósticos, rename, formateo, depurador, extensiones, varias
raíces, terminal en el editor, UI de git, temas, ajustes, indexado de `vendor/` o `node_modules`.

## Seguridad

- **Lecturas**: toda ruta se resuelve con `realpath` y debe caer dentro del worktree de la tarea (un symlink
  que apunte fuera se rechaza). Raíces extra de solo lectura, explícitas: `vendor/` y `node_modules` del
  checkout principal y los stubs del servidor. stackd debe derivarlas del estado, nunca aceptarlas del
  cliente. Tope de 2 MB por fichero; binarios no se envían.
- **LSP**: lista blanca de métodos de navegación; nada que escriba. El texto de `didOpen` lo lee el backend
  del disco.
- **Proceso del servidor**: corre con los permisos del usuario, como el agente. Phpactor con
  `class_maps_only` incluye dos ficheros PHP generados por Composer (`autoload_psr4.php`,
  `autoload_classmap.php`): son datos, pero es código PHP del worktree que se evalúa; el autoloader y sus
  `files` no se ejecutan. No se carga el `.phpactor.json` del repo. TS 7 nativo no carga plugins del tsconfig
  (tsserver sí). Endurecer más (`sandbox-exec` sin red, escritura solo en la caché) es posible; sin probar.
- El socket de stackd ya es 0600. El servidor HTTP del prototipo es solo para desarrollo (localhost).

## Riesgos y cosas sin resolver

- **WKWebView sin probar.** Media jornada: worker bajo `tauri://`, portapapeles, ⌘-clic, atajos, scroll.
- **Primer indexado de Phpactor: ~2,8 min y 750 MB por worktree.** Con diez tareas son 7,5 GB de disco. Hay
  que borrar índices de tareas eliminadas y quizá caducar los que lleven semanas sin uso.
- **TS acotado**: medido con un fichero (0,5 GB). Con los ficheros de un diff real el cierre de imports puede
  ser mayor; sin medir. Las referencias parciales hay que señalarlas en la UI o confunden.
- **El espejo de TS** (symlinks + tsconfig generado) funciona con TS 7; sin probar con tsserver ni con
  cambios en disco. Los `paths` del tsconfig se copian tal cual; proyectos con `extends` o referencias entre
  proyectos necesitarán más cuidado.
- **Phpactor escribe en el proyecto si se le deja** (`.phpactor.json`, ver su configuración). El perfil lo
  impide, pero es el tipo de sorpresa que una versión nueva puede repetir: test en stackd que arranque el
  servidor sobre un proyecto de prueba y compruebe que el directorio queda intacto.
- **Phpactor mientras indexa**: sin medir si responde o bloquea.
- **PHP del usuario**: versión antigua o extensiones ausentes dejan PHP sin navegación; hay que decirlo claro
  en la UI (y en `stackd doctor`).
- **Monaco por dentro**: sustituir su `textModelService` (para el peek de ficheros no abiertos) no es API
  pública estable: fijar la versión de `monaco-editor`.
- **Referencias masivas**: 1 000+ resultados funcionan pero la lista es inútil; el prototipo corta en 500.
- **Índice desactualizado** cuando el agente edita (pieza 8). Sin probar: no podía escribir en los repos.
- **`git grep` / `git ls-files`** sin medir en `big-app` (el spike no podía ejecutar git en esos repos).
- **Colores de sintaxis**: Monarch es más pobre que TextMate; PHP y TSX se leen bien, no igual que en VS Code.
- `other-repo` es Go: fuera de este alcance.

## Cómo ejecutar el prototipo

Nada de esto toca la app ni stackd en marcha (puertos 1430 y 1431), ni escribe en los repos.

```sh
# 1. Servidores de lenguaje, en un directorio cualquiera fuera del repo
mkdir -p ~/stack-code-spike/phpactor && cd ~/stack-code-spike/phpactor
echo '{"minimum-stability":"dev","prefer-stable":true,"require":{"phpactor/phpactor":"2026.10.07.0"}}' > composer.json
composer update --no-dev                              # Phpactor (PHP 8.2+)
npm install --prefix ~/stack-code-spike/ts7 typescript@7   # LSP nativo de TS 7

# 2. Backend: una o varias raíces (worktrees)
cd <este worktree de stack>
node desktop/scripts/code-dev-server.mjs --port 1431 \
  --root /ruta/al/worktree \
  --phpactor ~/stack-code-spike/phpactor/vendor/bin/phpactor \
  --ts-native ~/stack-code-spike/ts7/node_modules/.bin/tsc \
  --include /ruta/al/checkout-principal/node_modules \
  --cache ~/stack-code-spike/cache
#   --composer-autoload /ruta/al/checkout-principal/vendor/autoload.php   worktree sin vendor/
#   --exclude '/otra/carpeta/**/*'                                         exclusiones extra del índice PHP
#   --php-server intelephense --servers <dir con node_modules/.bin>        solo para comparar

# 3. Front (otro puerto que el de la app)
cd desktop && npm install && npx vite --port 1430 --strictPort

# 4. Abrir
open 'http://localhost:1430/?dev=code'
#   &root=/ruta/al/worktree  &file=ruta/relativa.php  &line=42
```

La primera petición PHP arranca Phpactor y, si el worktree no tiene índice, lo construye (~3 min; la píldora
enseña el avance). La primera TS arranca el servidor de TypeScript (proyecto entero, con `node_modules` si
son alcanzables: el modo acotado no está en el prototipo). Parar: Ctrl-C en los dos procesos.

Repetir las medidas: `node desktop/scripts/code-lsp-bench.mjs <escenario.json>` arranca un servidor por
stdio, espera al indexado y cronometra peticiones (frío y repetida), con memoria (`footprint`) al final. El
formato del escenario está en la cabecera del script.

Ficheros del spike:

- `desktop/scripts/code-dev-server.mjs` — backend: ficheros con guardia de rutas, ⌘P, gestor LSP por stdio.
- `desktop/scripts/code-lsp-bench.mjs` — banco de pruebas de servidores de lenguaje.
- `desktop/src/code/api.ts` — interfaz `CodeBackend` (la que implementaría stackd) y su versión HTTP.
- `desktop/src/code/monaco.ts` — Monaco recortado, worker, tema desde los tokens, modelos bajo demanda.
- `desktop/src/code/lsp.ts` — cliente LSP fino (proveedores de Monaco).
- `desktop/src/code/protocol.ts` (+ test) — conversiones LSP ↔ Monaco, lenguajes, historial.
- `desktop/src/code/CodeBrowser.tsx`, `code.css`, `DevCode.tsx` — la UI y la página `?dev=code`.
- `desktop/src/main.tsx` — la ruta `?dev=code`, con carga perezosa.
