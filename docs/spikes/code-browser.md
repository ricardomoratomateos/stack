# Spike: navegador de código (Monaco + LSP) en la app de escritorio

Rama `worktree-agent-a5e3a2420d3778b9a`, sobre `v1` (`0040827`). Es un spike: el prototipo vive aislado
(`desktop/src/code/`, `desktop/scripts/code-dev-server.mjs`, ruta `?dev=code`) y no toca la app ni stackd.

## Objetivo

Hoy se revisa el trabajo de un agente en la pestaña Review (un diff estilo PR), pero no se puede navegar el
código. La pregunta: ¿podemos incrustar un navegador de código con navegación de verdad (ir a definición,
buscar referencias, hover, símbolos, árbol de ficheros, ⌘P) para **PHP y JS/TS**, en repos del tamaño de
`big-app`? Regla 80/20: "entender lo que ha cambiado el agente", solo lectura; no rehacer VS Code.

## Respuesta corta

**Sí, y es barato en código.** El prototipo lo hace sobre un worktree real de `big-app` (89 418 ficheros
PHP, 10 412 TS/TSX en `frontend/apps/v2/src`): ir a definición en 0–13 ms, referencias en 20 ms–1,7 s, ⌘P sobre
120 539 ficheros en ~60 ms. Lo caro no es el código, es la **memoria de los servidores de lenguaje**:
~1,1 GB (PHP) + 2–3 GB (TS) **por worktree**. Eso decide el diseño: servidores bajo demanda, uno o dos vivos a
la vez, y se apagan solos.

## Qué enseña el prototipo

`http://localhost:1430/?dev=code` (ver "Cómo ejecutarlo"):

- Árbol de ficheros perezoso del worktree; al saltar a un fichero, el árbol lo revela.
- Monaco en solo lectura con el tema de la app (tokens `--app-*` + variables `--vscode-editor-*`).
- **Ir a definición** (⌘-clic / F12), **referencias** (⇧F12, con vista previa de ficheros que nunca se
  abrieron), **hover** y símbolos del fichero (alimentan el outline ⌘⇧O y el sticky scroll de Monaco; el proveedor responde, la UI del outline no la he probado a mano), para PHP (Intelephense) y TS/JS
  (typescript-language-server, o el LSP nativo de TypeScript 7 con `--ts-native`).
- ⌘P: ficheros por nombre difuso. `#texto`: símbolos del proyecto, de los servidores que ya estén
  arrancados (⌘T hace lo mismo, pero en un navegador lo intercepta el propio navegador; valdrá en la app).
- Atrás / adelante con los botones, como "Go Back" de VS Code (el atajo ⌃- está cableado pero solo he probado los botones).
- Píldoras de estado por servidor (arrancando / indexando N de M / listo, memoria, tiempo de indexado).
- Apertura directa en un fichero y línea: `&file=…&line=…` (lo que haría el clic desde Review).
- Backend con la forma que tendría en stackd: lecturas solo dentro de raíces permitidas (con `realpath`),
  solo métodos LSP de navegación, un servidor por (worktree, lenguaje) arrancado al primer uso.

Probado en Chrome contra el worktree `big-app/team/feat-1234-stock-sync`. **No probado dentro de
la app Tauri (WKWebView)**: no se podía reiniciar la app en uso. Es la primera verificación pendiente.

## Medidas

Máquina: Apple silicon, 8 núcleos, 24 GB, macOS 14 (Darwin 23.6), Node 23.11, PHP 8.4.8. Con otros agentes
trabajando a la vez, así que los tiempos son pesimistas.

### Tamaño de los repos

| Repo | Ficheros | PHP | TS/JS | Nota |
|---|---|---|---|---|
| `big-app` (checkout principal, sin `node_modules`, `.worktrees`, `var`) | 418 235 | 314 509 | ~41 000 | Incluye `team/` (otros checkouts dentro del repo) y `vendor/`. Recorrerlo: 8,1 s |
| Un worktree de tarea real (`team/feat-1234-…`) | 116 834 | 89 188 (30 839 propios + 58 349 de `vendor/`) | 11 907 propios | Recorrerlo: 0,5–1,3 s |
| `other-repo` | 670 | 0 | 0 | **Es Go** (560 `.go`): fuera de PHP/JS. Con el mismo puente sería añadir `gopls` |

Dos cosas del disco que condicionan el diseño:

- Los worktrees viven **dentro** del repo (`big-app/team/…`, `big-app/.worktrees/…`). Un servidor
  arrancado en la raíz del repo indexaría todas las copias (clases duplicadas). Hay que arrancar en el
  worktree y excluir worktrees anidados.
- En el worktree, `vendor/` es un directorio real pero `node_modules` son **symlinks al checkout principal**.
  "Ir a definición" de un import de npm acaba en `big-app/frontend/apps/v2/node_modules/…`, fuera del
  worktree: el backend necesita una lista de raíces extra de solo lectura (ver Seguridad).

### PHP — Intelephense 1.18.5 (un worktree, 89 418 ficheros)

| Qué | Resultado |
|---|---|
| Indexado en frío | **61,7 s** |
| Memoria | pico ~2,6 GB indexando; **1,1 GB** estable (`phys_footprint`) |
| Caché en disco (fuera del worktree) | 141 MB |
| Arranque en caliente (con caché) | primera definición respondida a los **2,5 s**; listo a los 5,4 s |
| Ir a definición | 0–10 ms |
| Hover | 14 ms |
| Referencias | 22 ms (39 resultados) · 1,7 s (2 013 resultados, `QueryBus`) |
| Símbolos del proyecto | 2 ms – 470 ms |
| Outline del fichero | 1 ms |

### TS/JS — `frontend/apps/v2` (10 412 ficheros, `paths` en tsconfig)

| Qué | typescript-language-server 6.0.3 + tsserver | TypeScript 7.0.2 nativo (`tsc --lsp --stdio`) |
|---|---|---|
| Primera definición correcta entre ficheros | **~18 s** (carga del proyecto) | **4,8 s** |
| Respuestas mientras carga | **parciales y engañosas**: la definición de un import devuelve el propio import | espera y responde bien |
| Ir a definición | 5–13 ms | 1 ms |
| Hover | 7 ms | 228 ms (el primero) |
| Referencias | 460–550 ms | 87–96 ms |
| Símbolos del proyecto | 0,9–2,1 s | 147 ms |
| Memoria | **2,96 GB** (`phys_footprint` de tsserver) | ~2,0 GB (RSS) |

Ojo al medir: con la máquina cargada macOS comprime la memoria de un proceso ocioso y `ps` enseña 40–180 MB
de RSS para procesos que ocupan 1–3 GB. La cifra fiable es `footprint <pid>`.

### Monaco y ficheros

| Qué | Resultado |
|---|---|
| `monaco-editor` 0.57.0, chunk aparte (carga perezosa) | 3,98 MB (1,03 MB gzip) + 189 KB CSS + 275 KB el worker |
| Bundle principal de la app | 768 KB; Monaco no entra en él |
| ⌘P sobre 120 539 ficheros | ~57 ms de ida y vuelta (filtrado en el backend); primer listado 1,3 s |
| Typecheck y tests | raíz y `desktop` pasan; 134 tests de `desktop` (5 nuevos) |

## Opciones comparadas

### Editor y cliente LSP

| Opción | Qué es | A favor | En contra | Veredicto |
|---|---|---|---|---|
| **`monaco-editor` + cliente LSP propio y fino** | Proveedores de Monaco (definición, referencias, hover, símbolos) que hacen una petición cada uno al backend | ~150 líneas (`desktop/src/code/lsp.ts`), sin dependencias nuevas aparte de Monaco, encaja con `POST /commands/<name>` de stackd: **no hace falta WebSocket** | Hay que escribir cada capacidad que se quiera (para solo lectura son 4–6) | **Recomendada** |
| `monaco.lsp` (cliente LSP que trae `monaco-editor` 0.57) | `MonacoLspClient(transport)`, nuevo | Viene incluido (135 KB) | Experimental: fija `rootUri: null`, sin `workspaceFolders` ni `initializationOptions`, así que no sirve para servidores de proyecto (Intelephense necesita raíz y ruta de caché). Sincroniza documentos desde el cliente | Descartada hoy; revisar en unos meses |
| `monaco-languageclient` + `@codingame/monaco-vscode-api` | Monaco con los servicios de VS Code por debajo | Cliente LSP completo, extensiones de VS Code, TextMate | Arrastra decenas de paquetes `@codingame/monaco-vscode-*`, sustituye el `monaco-editor` normal, acopla a versiones concretas de VS Code. Peso no medido | Es "rehacer VS Code": fuera del 80/20 |
| Worker de TypeScript integrado en Monaco | El servicio de lenguaje TS en un web worker | Sin proceso externo | Solo conoce los modelos que se le den: habría que cargarle 10 000 ficheros, los `.d.ts` de `node_modules` y los `paths` del tsconfig. +6 MB de worker. No hace nada por PHP | Descartada: el prototipo ni lo carga |

### PHP

| | Intelephense | Phpactor |
|---|---|---|
| Licencia | Propietaria ("personal, non-transferable"); gratis con funciones premium de pago por clave | MIT |
| Requisitos | Node (ya lo exige stackd) | PHP 8.1+ en la máquina (aquí hay 8.4.8); instalación por Composer o phar |
| Gratis incluye | Definición, referencias, hover, símbolos de fichero y de proyecto, resaltado, diagnósticos, completado | Todo |
| De pago (texto de su licencia) | Rename, folding, **find implementations**, go to type definition, go to declaration, code actions, code lens, jerarquía de tipos, inlay hints | — |
| Velocidad en `big-app` | Medida arriba: 62 s en frío, 2,5 s en caliente, respuestas en ms | **No medido** (no está instalado y no he instalado nada fuera del worktree). Reputación: indexado bastante más lento y referencias menos fiables en repos grandes |
| Riesgo | No se puede redistribuir dentro de `Stack.app` sin permiso: instalarlo con `npm` en la máquina del usuario al primer uso (como hace la extensión de VS Code). "Ir a implementación" de una interfaz es premium; el sustituto gratis es "referencias" | Depender del PHP del usuario; rendimiento por comprobar |

Recomendación: **Intelephense**, instalado bajo demanda en `~/.config/stack/lsp/`. Si la licencia molesta,
Phpactor entra por el mismo puente cambiando una entrada de la tabla de servidores; antes habría que medirlo.

### JS/TS

**LSP nativo de TypeScript 7** (`typescript@7`, trae el binario de la plataforma, 30 MB): 4× más rápido en
arrancar, no da respuestas parciales, no ejecuta plugins JS del repo. `typescript-language-server` + tsserver
queda como alternativa si un proyecto necesita el TypeScript exacto de su `node_modules`.

### Quién ejecuta los servidores

stackd: ya es un proceso Node de larga vida, conoce los worktrees y su repo, y la app ya le habla por
`stackd_command` (petición/respuesta JSON por el socket Unix). La navegación LSP es petición/respuesta, así
que cabe en comandos nuevos (`codeTree`, `codeFile`, `codeFiles`, `codeSearch`, `codeLsp`) sin WebSocket ni
eventos Tauri. El estado de indexado puede ir en el snapshot que ya se emite por SSE.

### Muchas tareas = muchos worktrees

Un servidor por worktree; **no** se puede compartir un índice entre worktrees del mismo repo: con varias
carpetas en un mismo servidor, cada clase existe N veces e "ir a definición" devuelve N candidatos de ramas
distintas. Coste por worktree con PHP + TS: ~3–4 GB y ~1 min de indexado la primera vez. Por eso:

- Arrancar solo cuando se abre la pestaña Code de esa tarea, y solo el lenguaje del fichero que se mira.
- Apagar a los N minutos sin peticiones o al cerrar la pestaña; como mucho 1–2 worktrees vivos (LRU).
- La caché de Intelephense (141 MB por worktree, fuera del repo) hace que volver cueste 2,5 s, no 62 s.
  Borrarla al borrar la tarea.

## Recomendación y alcance del MVP

Construir, en este orden:

| # | Pieza | Qué | Esfuerzo |
|---|---|---|---|
| 1 | Comandos de ficheros en stackd | `codeTree`, `codeFile`, `codeFiles` (lista con `git ls-files` + no trackeados, cacheada), guardia de rutas, tests | S |
| 2 | Pestaña **Code** | Junto a las pestañas de sesión y Review. Monaco solo lectura, árbol, ⌘P, atrás/adelante. Arriba del árbol, "Changed": los ficheros del diff (`getDiff` ya existe). Se abre en el primer fichero cambiado | M |
| 3 | Review → Code | El `openFile {path, line}` que Review ya emite (hoy abre VS Code) abre la pestaña Code en esa línea. Marcas de líneas cambiadas en el margen | S |
| 4 | Gestor LSP en stackd (`src/lsp/`) | Arranque bajo demanda por (worktree, lenguaje), apagado por inactividad, tope de servidores, estado en el snapshot, reinicio si muere. Es el `LspServer` del prototipo con tests | M |
| 5 | PHP con Intelephense | Instalación bajo demanda, caché por worktree, excluir worktrees anidados, `includePaths` al `vendor/` del checkout principal cuando el worktree no tiene | S |
| 6 | TS/JS con el LSP nativo de TS 7 | Misma tabla de servidores; mostrar "cargando proyecto" hasta que esté listo | S |
| 7 | Cambios en disco | El agente edita mientras se navega: `fs.watch` recursivo en stackd → recargar los modelos abiertos y avisar al servidor (`workspace/didChangeWatchedFiles`). Sin esto el índice envejece | M |
| 8 | Buscar en el proyecto | `git grep` desde stackd (en esta máquina no hay `rg` instalado aparte del de Claude Code) y lista de resultados | S–M |

1–3 dan un navegador útil sin ningún servidor de lenguaje (≈ una semana). 4–6 añaden la navegación (≈ otra).
7–8 después.

No construir: edición y guardado, completado, diagnósticos, rename, formateo, depurador, extensiones, varias
raíces, terminal en el editor, UI de git, temas, ajustes. Tampoco el worker de TS de Monaco ni
`monaco-vscode-api`. "Ediciones ligeras" más adelante sería quitar `readOnly` y un comando `codeWrite` con la
misma guardia de rutas; no cambia la arquitectura.

## Seguridad

- **Lecturas**: toda ruta se resuelve con `realpath` y debe caer dentro del worktree de la tarea (un symlink
  que apunte fuera se rechaza). Raíces extra de solo lectura, explícitas: los `node_modules`/`vendor` del
  checkout principal y la instalación de los servidores (stubs de PHP, `lib.d.ts`). stackd debe derivar esas
  rutas del estado (repo y worktree de la tarea), nunca aceptarlas del cliente. Tope de 2 MB por fichero;
  binarios no se envían.
- **LSP**: lista blanca de métodos de navegación; nada que escriba (`rename`, `executeCommand`, formateo,
  code actions). El texto de `didOpen` lo lee el backend del disco, no viene del cliente.
- **Proceso del servidor**: corre con los permisos del usuario, como el agente. Intelephense solo analiza,
  no ejecuta código del repo. **tsserver sí puede cargar plugins declarados en el tsconfig** desde
  `node_modules` del worktree: código del repo ejecutándose. El LSP nativo de TS 7 no carga plugins JS, otra
  razón para preferirlo. Se desactiva la descarga automática de `@types`. Endurecer más (perfil
  `sandbox-exec` sin red y con escritura solo en la caché) es posible pero no lo he probado.
- El socket de stackd ya es 0600: los comandos nuevos no abren superficie nueva. El servidor HTTP del
  prototipo es solo para desarrollo (localhost, CORS limitado a orígenes localhost).

## Riesgos y cosas sin resolver

- **WKWebView sin probar.** Tauri tiene `csp: null`, así que el worker de Monaco no debería tropezar, y el
  mínimo es macOS 12. Por verificar en la app: el worker bajo `tauri://`, portapapeles, ⌘-clic, que ⌘P/⌘T no
  choquen con atajos de la app, rendimiento del scroll. Media jornada.
- **Memoria**: 3–4 GB por worktree con los dos lenguajes. Sin apagado por inactividad, tres tareas abiertas
  se comen la máquina.
- **Licencia de Intelephense**: no redistribuir; confirmar que instalarlo por `npm` en la máquina del
  usuario desde una app de terceros encaja con su licencia. Plan B: Phpactor (sin medir).
- **Respuestas parciales de tsserver** mientras carga: si se usa, bloquear la navegación TS hasta "listo".
- **Monaco por dentro**: para que el peek de referencias enseñe ficheros no abiertos hay que sustituir su
  `textModelService`, y solo se puede hacer antes de que nada toque los servicios (`monaco.ts`). No es API
  pública estable: fijar la versión de `monaco-editor`.
- **Referencias masivas**: 2 013 resultados funcionan pero la lista es inútil; el prototipo corta en 500.
- **Índice desactualizado** cuando el agente edita (pieza 7). Sin probar: no podía escribir en los repos.
- **Worktrees sin `vendor/`**: `includePaths` está cableado en el prototipo (`--include`) pero sin medir.
- **`git grep` / `git ls-files`** sin medir en `big-app` (el spike no podía ejecutar git en esos repos);
  el recorrido por `fs` da 0,5–1,3 s por worktree como cota superior.
- **Colores de sintaxis**: Monarch (gramáticas de Monaco) es más pobre que TextMate; PHP y TSX se leen bien
  pero no igual que en VS Code. Mejorarlo (tokens semánticos del LSP) es opcional.
- `other-repo` es Go: no entra en este alcance.

## Cómo ejecutar el prototipo

Nada de esto toca la app ni stackd en marcha (puertos 1430 y 1431).

```sh
# 1. Servidores de lenguaje, en un directorio cualquiera fuera del repo
mkdir -p ~/stack-code-spike && cd ~/stack-code-spike
npm init -y && npm install intelephense typescript-language-server typescript@6
npm install --prefix ts7 typescript@7        # opcional: el LSP nativo de TS 7

# 2. Backend: una o varias raíces (worktrees). Nunca escribe dentro de ellas.
cd <este worktree de stack>
node desktop/scripts/code-dev-server.mjs --port 1431 \
  --root /ruta/al/worktree \
  --include /ruta/al/checkout-principal/node_modules \
  --servers ~/stack-code-spike \
  --cache ~/stack-code-spike/cache
#   --ts-native ~/stack-code-spike/ts7/node_modules/.bin/tsc   usa el LSP nativo de TS 7
#   --exclude '<glob>'                                          exclusiones extra para Intelephense

# 3. Front (otro puerto que el de la app)
cd desktop && npm install && npx vite --port 1430 --strictPort

# 4. Abrir
open 'http://localhost:1430/?dev=code'
#   &root=/ruta/al/worktree  &file=ruta/relativa.php  &line=42
```

Teclas: ⌘P ficheros · `#texto` símbolos · ⌘-clic o F12 definición · ⇧F12 referencias · botones atrás/adelante. La primera petición PHP arranca Intelephense (la píldora enseña "N de M ficheros"); la primera TS
arranca el servidor de TypeScript. Parar: Ctrl-C en los dos procesos (el backend mata a sus servidores).

Ficheros del spike:

- `desktop/scripts/code-dev-server.mjs` — backend: ficheros con guardia de rutas, ⌘P, gestor LSP por stdio.
- `desktop/src/code/api.ts` — interfaz `CodeBackend` (la que implementaría stackd) y su versión HTTP.
- `desktop/src/code/monaco.ts` — Monaco recortado, worker, tema desde los tokens, modelos bajo demanda.
- `desktop/src/code/lsp.ts` — cliente LSP fino (proveedores de Monaco).
- `desktop/src/code/protocol.ts` (+ test) — conversiones LSP ↔ Monaco, lenguajes, historial.
- `desktop/src/code/CodeBrowser.tsx`, `code.css`, `DevCode.tsx` — la UI y la página `?dev=code`.
- `desktop/src/main.tsx` — la ruta `?dev=code`, con carga perezosa.
