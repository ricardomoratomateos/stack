# Spike: navegador de código (Monaco + LSP) en la app de escritorio

Rama `worktree-agent-a5e3a2420d3778b9a`, sobre `v1`. Empezó como spike aislado (`?dev=code`); el último commit
lo lleva a la app: una pestaña **Code** por tarea, servida por stackd. Las medidas de abajo son las del spike.

## Estado: en la app

- **Entrada**: clic en el título de la tarea, a la izquierda de las pestañas de sesión. Abre la pestaña Code
  de esa tarea, igual que Review: solo existe mientras está abierta, ✕ o clic central la cierran, Esc vuelve
  al terminal (salvo que el editor lo esté usando para un peek o ⌘P), una pestaña de sesión vuelve a la sesión.
- **Contenido**: a la izquierda "Changed" (los ficheros del diff de la tarea contra su base) sobre el árbol de
  ficheros; Monaco en solo lectura; ⌘P; atrás/adelante. Se abre en el primer fichero cambiado.
- **Review → Code**: clic en la cabecera de un fichero o en una línea del Review abre ese sitio en Code.
- **Backend**: comandos de stackd (`codeOpen`, `codeTree`, `codeRead`, `codeFiles`, `codeLsp`,
  `codeDiagnostics`, `codeStatus`) en `src/code/`, por el `stackd_command` de siempre.
  - Lecturas: `realpath` dentro del worktree de la tarea; además, solo lectura, `vendor/` del checkout
    principal y los `node_modules` a los que el worktree enlaza.
  - PHP: Phpactor. Binario: ajuste `phpactorPath`, si no `phpactor` en el PATH, si no
    `~/.config/stack/tools/phpactor.phar`. Todo bajo `~/.config/stack/cache/phpactor/<repo>-<hash>/`:
    - **Base por repo** (`src/code/phpBase.ts`): la rama base del repo (`origin/<defaultBaseBranch>`, si no
      la rama local, si no el HEAD del checkout principal). `git archive <commit> -- <dirs con PHP>` + 
      `composer.json/lock` → `base-src/` (solo los `.php`); su índice en `base/`; `base.json` = `{ref,
      commit, ready}`. Se construye en segundo plano al arrancar stackd, y se pone al día cuando la ref se
      mueve (al abrir Code, tras "refresh drift", y cada 5 min): solo se vuelven a extraer los PHP de
      `git diff old new` (los borrados se borran) y Phpactor reindexa por ctime. Phpactor con `nice`, parado
      al acabar. Una tarea nunca escribe en la base.
    - **Tarea** (`tasks/<id>/`): clon APFS del índice base (`clonefileat`, ~1 s) marcado como construido
      ahora, y los PHP que difieren del commit base (`git diff --name-only <base> <HEAD>` + sin commitear y
      sin seguir) en la lista `dirty` del índice, que el primer pase de Phpactor indexa con lo demás. El
      checkout principal es una tarea más. Si la base aún se prepara, la navegación espera ("Preparing
      develop… n/m") y la base no se mata por una tarea.
    - Un Phpactor por repo (todos ven la misma ruta `view/`), arranques en serie, apagado a los 10 min sin
      peticiones. La cabecera de Code enseña la base: "Preparing develop… n/m" o "develop @ 1a2b3c4".
    - Prueba de punta a punta: `desktop/scripts/code-e2e.mjs` (CodeService real, git y Phpactor reales).
  - JS/TS: el índice ligero (`src/code/lightIndex.ts`) + `git grep`, por proyecto (el `tsconfig.json` más
    cercano), construido al primer uso y guardado en memoria.
  - Diagnósticos: `oxlint --lsp` (del PATH o de `~/.config/stack/tools/node_modules/.bin/`) con una
    configuración propia de reglas nativas en `~/.config/stack/cache/oxlint.json`; `php -l` en ficheros PHP.
- **Sin hacer**: recargar ficheros que el agente cambia mientras se navega; buscar en el proyecto; marcas del
  diff en el margen; modo preciso con TypeScript 7; ajuste `phpactorPath` en la pantalla de Settings (se
  pone a mano en `settings.json`); verificación dentro de la app (hecha en navegador con `?dev=code`).

## Objetivo

Hoy se revisa el trabajo de un agente en la pestaña Review (un diff estilo PR), pero no se puede navegar el
código. La pregunta: ¿podemos incrustar un navegador de código con navegación de verdad (ir a definición,
buscar referencias, hover, símbolos, árbol de ficheros, ⌘P) para **PHP y JS/TS**, en repos del tamaño de
`big-app`? Regla 80/20: "entender lo que ha cambiado el agente", solo lectura; no rehacer VS Code.

Decisiones tomadas durante el spike:

- **Intelephense, descartado**: licencia propietaria y 1,1 GB estables (2,6 GB de pico) por worktree.
- **No indexar `vendor/` (PHP) ni `node_modules/` (JS/TS).**

## Respuesta corta

**Sí, y con poca memoria.** Sobre un worktree real de `big-app` (33 223 ficheros PHP propios, 10 412 TS/TSX
en `frontend/apps/v2/src`):

- **PHP con Phpactor** (MIT), sin indexar `vendor/`: **~100 MB** estables, respuestas en 1–50 ms, y salta a
  las clases de `vendor/` por el mapa PSR-4 de Composer. El precio: el primer indexado tarda **1–3 min** por
  worktree y el índice ocupa **~750 MB en disco**. Indexar solo el diff (un servidor sobre el checkout base
  con los ficheros cambiados encima) funciona en 14 de 17 casos y arranca en segundos, pero ensucia el
  índice compartido: se queda como optimización posterior, no para empezar.
- **JS/TS sin servidor**: un índice sintáctico propio (qué declara y exporta cada fichero, imports resueltos
  por los `paths` del tsconfig) más `git grep`. Se construye en **8 s**, ocupa **4 MB**, y acierta 13 de 16
  definiciones en código propio (y una más a medias) frente a TypeScript 7; las referencias coinciden casi línea a línea. No da
  tipos en el hover. El servidor de TypeScript 7 (0,5–2,2 GB) queda como "modo preciso" bajo demanda.
- **Diagnósticos**: `oxlint --lsp` (46 MB) pinta subrayados en Monaco a través del mismo puente.
- SCIP (`scip-typescript`) no termina de indexar este proyecto: descartado.

## Qué enseñaba el prototipo

El prototipo del spike, con un servidor de desarrollo propio (`code-dev-server.mjs`, ya sustituido por stackd).

`http://localhost:1430/?dev=code` (ver "Cómo ejecutarlo"):

- Árbol de ficheros perezoso del worktree; al saltar a un fichero, el árbol lo revela.
- Monaco en solo lectura con el tema de la app (tokens `--app-*` + variables `--vscode-editor-*`).
- **Ir a definición** (⌘-clic / F12), **referencias** (⇧F12, con vista previa de ficheros que nunca se
  abrieron), **hover** y símbolos del fichero, para PHP (**Phpactor** por defecto) y TS/JS
  (typescript-language-server, o el LSP nativo de TypeScript 7 con `--ts-native`).
- PHP sin indexar `vendor/`: F12 sobre `Request` de Symfony abre `vendor/symfony/http-foundation/Request.php`.
- ⌘P: ficheros por nombre difuso. `#texto`: símbolos del proyecto, de los servidores ya arrancados.
- Atrás / adelante con los botones, como "Go Back" de VS Code.
- **Subrayados de oxlint** en ficheros JS/TS (`--oxlint`): el backend convierte el `publishDiagnostics` del
  servidor en una respuesta a `GET /lint`, y Monaco los pinta como marcadores.
- Píldoras de estado por servidor (arrancando / indexando N de M / listo).
- Apertura directa en un fichero y línea: `&file=…&line=…` (lo que haría el clic desde Review).
- Backend con la forma que tendría en stackd: lecturas solo dentro de raíces permitidas (con `realpath`),
  solo métodos LSP de navegación, un servidor por (worktree, lenguaje) arrancado al primer uso.

Probado en Chrome contra el worktree `big-app/team/feat-1234-stock-sync`. Sin probar:

- **Dentro de la app Tauri (WKWebView)**: no se podía reiniciar la app en uso. Primera verificación pendiente.
- La UI del outline (⌘⇧O) y los atajos ⌘T / ⌃-: cableados; solo probé el proveedor y los botones.
- El modo TS "acotado / sin `node_modules`" y el solapado del diff sobre un checkout base están medidos con
  scripts aparte, **no** construidos.

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

## Indexar solo el diff (PHP)

Diff real de la tarea: `git merge-base HEAD origin/develop` = `d5f1e2c`, y `git diff --name-status` contra él:
**16 ficheros PHP** (9 nuevos, 7 modificados), ninguno de TS. Checkout base: `git archive d5f1e2c lib apps www
src` a un directorio fuera del repo (30 310 ficheros PHP); su índice: 69 s, 724 MB. Verdad de referencia:
Phpactor sobre el worktree de la tarea con su índice completo. 17 casos: definiciones desde ficheros nuevos y
modificados hacia código nuevo y hacia código sin cambios, desde código sin cambios hacia una clase
modificada, hover, referencias que deben incluir llamadas añadidas por el diff, y símbolos de clases nuevas.

### Diseño A: un Phpactor sobre el checkout base + los ficheros cambiados como documentos abiertos

Los 16 ficheros de la tarea se envían con `didOpen` bajo las rutas del checkout base (con el texto de la
tarea), y las respuestas se traducen base → tarea cambiando el prefijo.

| Variante | Aciertos (de 17) | Nota |
|---|---|---|
| Solo el checkout base | 3 | Lo esperado: no conoce nada del diff |
| `didOpen` de los cambiados | 2 | Abrir no indexa |
| `didOpen` + **`didSave`** | 13 | Con `didSave`, Phpactor indexa el documento **en memoria**, exista o no en disco |
| `didOpen` + `didSave` + mapa de Composer de la tarea | **14** | Arregla el salto desde `www/` (código sin namespace) a una clase nueva |

- Bien: todas las definiciones (clase, método y método de trait nuevos; desde fichero nuevo, modificado y sin
  cambios), el hover, y las cuatro búsquedas de referencias, **incluidas las llamadas añadidas por el diff**.
- Mal: los tres casos de símbolos del proyecto para clases nuevas (no aparecen). Se tapa sin servidor: las
  clases nuevas están en los ficheros del diff, basta pedir los símbolos de esos 16 ficheros o un `git grep`.
- Coste: superponer los 16 ficheros, 3–13 s. Memoria: **un servidor, ~125 MB, para todas las tareas**.
- Problemas de fondo:
  - **Escribe en el índice compartido.** Tras cerrar y volver a abrir sin superponer nada, las referencias
    seguían incluyendo llamadas de la tarea. Intenté deshacerlo con eventos de fichero (cambiado → releer,
    añadido → borrado) y no quedó limpio. Con dos tareas a la vez, una vería llamadas de la otra.
  - Cada tarea sale de un punto distinto de `develop`: hace falta un checkout base (y su índice) por
    merge-base, o tratar como "cambiado" todo lo que difiera del base, que en una rama vieja son miles.
  - Depende de un detalle interno (que `didSave` indexe el documento en memoria) y de una capa de traducción
    de rutas en cada petición y respuesta.

### Diseño B: copiar el índice base a un índice por tarea y reindexar solo lo cambiado

- **Cómo decide Phpactor qué está obsoleto**: por fecha, no por hash. Un fichero se reindexa si su `mtime`
  es posterior a una única marca de tiempo del índice (`timestamp.v3`). Un índice copiado nunca ve como
  obsoletos los ficheros de la tarea. `index:build <fichero>` sí indexa ese fichero sin condiciones.
- **Rutas**: van como `file:///ruta/absoluta` dentro de registros serializados de PHP (`s:<bytes>:"…"`), y los
  registros de fichero se guardan en `md5(ruta)`. Reescribirlas es tocar los 124 737 ficheros del índice,
  corregir longitudes y recolocar 29 835 registros: **61 s**. Solo copiar (`cp -c`) ya son 44 s.
- Reindexar los 16 ficheros con `index:build <fichero>`: **157 s** (unos 10 s por proceso).
- Resultado: 13 de 17. Definiciones y hover bien; falta una referencia en un caso y los símbolos de clases
  nuevas salen incompletos.
- Total ≈ 220 s, más que indexar el worktree desde cero (69–170 s), con la misma memoria y el mismo disco.

**Entre A y B: A.** B no gana nada. Pero A tampoco sustituye todavía al índice completo por tarea, que es
17 de 17 con ~100 MB y sin capas raras; su único coste real es el tiempo hasta estar listo, que se esconde
indexando en segundo plano al crear la tarea. A pasa a ser la mejora a estudiar si el disco (0,7 GB por
tarea) o la espera molestan, y entonces con una copia privada del índice o resolviendo antes la limpieza.

## JS/TS sin servidor vivo

Casos: 18 definiciones y 6 búsquedas de referencias en un componente real (`Progress.tsx`), puntuados contra
TypeScript 7 nativo con el proyecto entero (2,2 GB, primera respuesta a los 4–7 s). La tarea medida no toca
TS, así que no hay "ficheros TS del diff": los casos son de un módulo cualquiera.

### SCIP (`scip-typescript` 0.6.2)

- **No termina.** Dos intentos sobre `frontend/apps/v2` (con y sin `--no-global-caches`): el proceso muere
  sin memoria a los 4,5–7 min con **4,8 GB** de pico, habiendo escrito 767 de ~10 450 documentos (134 MB).
  Con más heap quizá acabe; el índice completo rondaría 1,7 GB.
- Consultar un `.scip` desde Node es fácil (`@scip-code/scip` + `@bufbuild/protobuf`: una lista de
  documentos con ocurrencias `rango → símbolo` y un bit de "definición"). Con el índice parcial: 0,36 s en
  leerlo y **440 MB** en memoria para 767 documentos. El completo no cabe en memoria de forma razonable; haría
  falta volcarlo a SQLite o similar.
- Construirlo una vez para `develop` y superponer el diff: el formato lo permite (símbolos con nombre
  estable, un documento por fichero), pero generar los documentos de los ficheros cambiados exige el programa
  TypeScript entero, o sea el mismo coste que el servidor.
- Descartado. La precisión no llegó a medirse (el fichero de prueba no estaba entre los 767).

### Índice ligero + `git grep` (`src/code/lightIndex.ts`)

Solo el parser de TypeScript, sin programa ni `node_modules`: por fichero, qué declara (funciones, clases y
sus miembros, tipos, enums, constantes y las claves de los objetos literales) y qué exporta o re-exporta.
"Ir a definición" busca el identificador bajo el cursor: si viene de un import, lo resuelve con los `paths`
del tsconfig y sigue re-exportaciones hasta la declaración; si no, la declaración local más cercana; si no,
por nombre. "Referencias" es `git grep -w` filtrado a los ficheros que importan ese nombre de ese módulo.

| | Índice ligero | TypeScript 7 nativo |
|---|---|---|
| Construir | **7,9 s**, 270 MB de pico | 4–7 s cada arranque |
| Tamaño | **4,3 MB** (10 450 ficheros, 55 680 declaraciones) | — |
| Memoria al consultar | 130–180 MB el proceso (casi todo, el parser); cabe dentro de stackd | 2,2 GB (0,5 GB acotado) |
| Definición | 3–27 ms | 0–1 ms |
| Referencias | ~3,3 s (`git grep` + leer los candidatos) | 90–200 ms |
| Definiciones acertadas, código propio | **13 de 16**, y una a medias | 16 de 16 (es la referencia) |
| Definiciones acertadas, librerías | 0 de 2 (no indexa `node_modules`) | 2 de 2 |
| Hover con tipos | no | sí |

- Acierta: import con nombre y por defecto, llamada a un import, tipos importados, función del mismo
  fichero, componente JSX propio, variable desestructurada, parámetro, miembro de un "enum" hecho con
  `const … as const`.
- Falla: miembro de un valor con tipo (`algo().gray`: da una coincidencia local equivocada donde TS no da
  nada), propiedad del resultado de un hook (`setTrue`: necesita tipos), y devuelve una de las dos
  declaraciones cuando un nombre es a la vez constante y tipo.
- Referencias frente a TS 7: 29/28, 18/16, 2/2, 8/7, 74/73, y las mismas líneas en el caso de 314 (TS cuenta
  varias por línea). Lo que sobra son la propia declaración y menciones en mocks de tests.
- Mantenerlo al día es reparsear los ficheros cambiados: milisegundos.

## Diagnósticos: oxlint

oxlint 1.93.0 (instalación local). La tarea no cambia ficheros JS/TS, así que "los cambiados" se midió con un
directorio de 29 ficheros.

| Qué | Configuración del repo | Solo reglas nativas (config fuera del repo) |
|---|---|---|
| `frontend/apps/v2/src` entero (10 000 ficheros) | 35,5 s · 1,1 GB · 4 054 avisos | 11 s · 0,58 GB · 1 186 avisos |
| Un directorio de 29 ficheros | 2,6 s · 199 MB | 2,1 s · 88 MB |
| `oxlint --lsp`, primer diagnóstico de un fichero | 4,8 s | 0,9 s |
| `oxlint --lsp`, memoria | 43–46 MB | 41–46 MB |

- **`oxlint --lsp` sirve con un cliente LSP normal**: tras `didOpen` envía `textDocument/publishDiagnostics`.
  El puente del prototipo espera ese aviso y lo devuelve como respuesta (`GET /lint`); la UI lo convierte en
  marcadores de Monaco. Comprobado en el navegador: subrayado amarillo en una variable sin usar. Detalle:
  Monaco no pinta subrayados en editores de solo lectura salvo con `renderValidationDecorations: 'on'`.
- **No escribe en el repo**: solo `--init` y `--fix` escriben, y no se usan. Comprobado con `git status`.
- **La configuración del repo ejecuta código del repo**: su `.oxlintrc.json` carga plugins JS
  (`eslint-plugin-*` de `node_modules` y `tools/oxlint-config/plugins/custom-rules.js`). Es el mismo nivel de
  confianza que el agente, pero conviene saberlo. Alternativa: una configuración mínima de Stack con reglas
  nativas, que además es 3–5 veces más rápida. Un worktree sin `node_modules` solo puede usar esta.
- **PHP**: `php -l` (solo sintaxis) tarda 72 ms por fichero, 1,1 s los 16 del diff. Vale como comprobación
  barata sobre los ficheros cambiados. Nada más allá de eso.

## Comparación final

Memoria con el servidor vivo; "listo" = tiempo desde que se crea la tarea hasta que se puede navegar.

### PHP

| Opción | Memoria | Listo para una tarea nueva | Disco por tarea | Aciertos |
|---|---|---|---|---|
| **Phpactor, índice completo por tarea** (sin `vendor/`) | ~100 MB por tarea abierta | 1–3 min (en segundo plano); después 5–8 s | ~750 MB | 17 de 17 |
| Phpactor, A: checkout base + diff superpuesto | ~125 MB en total | 3–13 s (con el índice base ya hecho) | 0 (base: 724 MB una vez por merge-base) | 14 de 17; ensucia el índice compartido |
| Phpactor, B: índice copiado y reescrito | ~100 MB por tarea abierta | ~220 s | ~700 MB | 13 de 17 |
| Intelephense (descartado) | 0,7–1,3 GB por tarea abierta | 15 s | 55 MB | referencia de la ronda anterior |

### JS/TS

| Opción | Memoria | Listo para una tarea nueva | Aciertos (definición, código propio) | Referencias |
|---|---|---|---|---|
| **Índice ligero + `git grep`** | ~150 MB al consultar, 0 en reposo | 8 s (4 MB de índice) | 13 de 16, y una a medias | casi idénticas, ~3 s |
| TS 7 acotado, sin `node_modules` | 0,5 GB | 1 s | 16 de 16 | parciales |
| TS 7 proyecto entero, sin `node_modules` | 1,6 GB | 2,6 s | 16 de 16 | completas |
| TS 7 proyecto entero | 2,2 GB | 4–7 s | 16 de 16, y librerías | completas |
| SCIP | 4,8 GB al indexar | no termina | sin medir | — |
| oxlint `--lsp` (diagnósticos, no navegación) | 46 MB | 1–5 s | — | — |

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

**Por defecto, el índice ligero** (sin servidor): definición por imports y `git grep` para los usos. Cubre
"de dónde viene esto y quién lo usa" en código propio con 4 MB.

**Modo preciso, bajo demanda: LSP nativo de TypeScript 7** (`typescript@7`, 30 MB con el binario). Para
cuando hagan falta tipos en el hover o saltar por un valor con tipo. Acotado a los ficheros que se miran y
sin `node_modules` son 0,5 GB; el proyecto entero, 1,6–2,2 GB. Arranca en 1–4 s, no da respuestas parciales
y no ejecuta plugins JS del repo. Se apaga solo.

### Quién ejecuta los servidores

stackd: ya es un proceso Node de larga vida, conoce los worktrees y su repo, y la app ya le habla por
`stackd_command`. La navegación LSP es petición/respuesta, así que cabe en comandos nuevos (`codeTree`,
`codeFile`, `codeFiles`, `codeSearch`, `codeLsp`) sin WebSocket ni eventos Tauri. El estado de indexado puede
ir en el snapshot que ya se emite por SSE.

### Política de servidores

- Arrancar solo al primer "ir a definición / hover" en un fichero de ese lenguaje, no al abrir la pestaña.
- Apagar a los 5–10 min sin peticiones o al cerrar la pestaña Code. Phpactor vuelve en 5–8 s; TS acotado en 1 s.
- Como mucho un servidor TS vivo a la vez (el caro), y solo si se pide el modo preciso; Phpactor puede haber
  varios (100 MB cada uno); oxlint, uno por worktree abierto (46 MB).
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
| 6 | Buscar en el proyecto | `git grep` desde stackd y lista de resultados | S–M |
| 7 | TS/JS con el índice ligero | `lightIndex.ts` dentro de stackd: construir al abrir Code, reparsear lo cambiado, definición y usos | M |
| 7b | Diagnósticos | `oxlint --lsp` por worktree con config nativa de Stack (o la del repo, a elegir) y `php -l` sobre los ficheros del diff | S |
| 7c | TS 7 "modo preciso" | Bajo demanda: proyecto espejo (symlinks + tsconfig) acotado a los ficheros que se miran; botón "proyecto completo" | M |
| 8 | Cambios en disco | El agente edita mientras se navega: `fs.watch` en stackd → recargar los modelos abiertos y avisar al servidor (`workspace/didChangeWatchedFiles`, que es el watcher `lsp` de Phpactor) | M |

1–3 dan un navegador útil sin ningún servidor de lenguaje (≈ una semana). 4–6 añaden PHP con navegación
completa y búsqueda (≈ otra). 7 y 7b, unos días más. 7c y 8 después. Indexar solo el diff en PHP (diseño A)
queda fuera hasta que el disco o la espera lo pidan.

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
- **Índice ligero**: 13 de 16 en un componente React; sin medir en otros estilos de código (clases con
  herencia, módulos con `export =`, JS sin tipos). Cuando falla puede dar un destino equivocado en vez de
  ninguno: marcar en la UI que es una navegación aproximada.
- **Diseño A de PHP**: descansa en que `didSave` indexe el documento en memoria; ensucia el índice compartido.
- **oxlint con la config del repo** ejecuta plugins JS del repo y tarda 3–5 veces más.
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

## Cómo ejecutarlo fuera de la app

`?dev=code` es la misma pestaña Code sin la app ni stackd: `desktop/scripts/code-dev-backend.mjs` sirve el
`CodeService` de stackd para un directorio por localhost. No escribe nada en ese directorio.

```sh
# Herramientas (una vez): las mismas que usa stackd
mkdir -p ~/.config/stack/tools && cd ~/.config/stack/tools
curl -L -o phpactor.phar https://github.com/phpactor/phpactor/releases/download/2026.10.07.0/phpactor.phar
npm install --prefix . oxlint

# Backend para un worktree (y, opcional, la referencia contra la que calcular "Changed")
cd <este repo>
node desktop/scripts/code-dev-backend.mjs --root /ruta/al/worktree --repo /ruta/al/checkout-principal --base <ref>

# Front, en otro puerto que el de la app
cd desktop && npx vite --port 1430 --strictPort
open 'http://localhost:1430/?dev=code'      #  &file=ruta/relativa.php&line=42
```

Repetir las medidas: `node desktop/scripts/code-lsp-bench.mjs <escenario.json>` arranca un servidor por
stdio, espera al indexado y cronometra peticiones (frío y repetida), con memoria (`footprint`) al final. El
formato del escenario está en la cabecera del script.

Ficheros:

- `src/code/CodeService.ts` — lo que stackd hace por la pestaña Code: ficheros, navegación, diagnósticos,
  ciclo de vida de los servidores.
- `src/code/pathGuard.ts`, `files.ts` — qué se puede leer; listados, lectura, ⌘P, ficheros del diff.
- `src/code/LspProcess.ts` — un servidor de lenguaje por stdio como cliente petición/respuesta.
- `src/code/lightIndex.ts` — índice ligero de JS/TS.
- `test/code/` — guardia de rutas, lista blanca de métodos, apagado por inactividad, índice ligero.
- `desktop/src/code/CodeHost.tsx` — la pestaña en la app (y en `?dev=code`); `CodeBrowser.tsx`, `monaco.ts`,
  `lsp.ts`, `protocol.ts`, `api.ts`, `code.css` — el navegador.
- `desktop/scripts/code-dev-backend.mjs`, `code-lsp-bench.mjs` — desarrollo y medidas.
