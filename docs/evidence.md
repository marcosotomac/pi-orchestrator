# Evidencia y pruebas reales

Los reportes viven en `artifacts/`, excluido de Git. Pueden contener contenido de tareas: no publicarlos sin revisar. Las pruebas reales **consumen cuota**.

[← README](../README.md)

## Estado comprobado

- `Pi (extensión vía SDK) → Codex → Claude Code → Codex → Pi`: probado con agentes reales.
- `Pi (extensión vía SDK) → Claude Code → Codex → Claude Code → Pi`: probado con agentes reales.
- En cada prueba, el hijo leyó una marca aleatoria de un archivo. El padre recibió esa marca mediante MCP y la devolvió a Pi. Se verificaron identidad del padre, ambos estados finales y ausencia de cambios en el directorio de prueba.
- Cancelación real de `Pi → Codex → Claude` y `Pi → Claude → Codex`: comprobada después de que el hijo iniciara una herramienta nativa (`Read` en Claude o `commandExecution` en Codex). Ambos CLI salieron, ambos estados quedaron en `cancelled`, no quedaron procesos activos en sus grupos POSIX y el directorio temporal no cambió.
- Panel TUI con árbol, selección, rechazo/confirmación de cancelación, estado transitorio, retorno al editor, resize y cierre normal: probado con el CLI real de Pi en pseudoterminal, tanto fullscreen como regular. Esas pruebas de interfaz usan motores simulados, no consumen cuota.
- Persistencia opcional: checkpoints privados, intención confirmada antes de iniciar cada runtime, resultados e identidades conservados y comandos de historial/inspección/reconciliación de solo lectura.
- Crash real del coordinador mediante SIGKILL: probado con un trabajador Node simulado que siguió vivo. El checkpoint sobrevivió; reiniciar no adoptó, reanudó ni canceló ese proceso. El arnés limpió después su propio trabajador usando registro IPC previo, no autoridad deducida del archivo.
- Carga del archivo de extensión desde el CLI habitual de Pi: comprobada también en modo JSON.
- Selección de herramientas por el modelo principal de Pi: comprobada con prompts ordinarios, sin comandos `/orch`, llamadas forzadas ni resultados sustituidos. Ejecutó dos raíces independientes y las cadenas **Pi → Codex → Claude → Codex → Pi** y **Pi → Claude → Codex → Claude → Pi**, reuniendo marcas impredecibles y resultados calculados.
- Análisis paralelo de datos y revisión de un bug, reintento idempotente observado por el núcleo, cancelación selectiva sin detener al hermano y fallo deliberado de modelo seguido de una ejecución válida: comprobados con ambos motores como padre.
- No hay instalación global, cambios a Pi/`pi-subagents`, ni dependencia de la interfaz de T3 u Orca.

Los reportes completos de las pruebas viven en `artifacts/live-*.json` y `artifacts/cases-*/report.json`, excluidos de Git. No contienen las credenciales MCP. Pueden contener contenido de tareas: no publicarlos sin revisar.

Evidencia de la entrega previa de persistencia:

| Prueba | Archivo en `artifacts/` |
| --- | --- |
| Resultado Codex → Claude | `live-codex-1793651541475.json` |
| Resultado Claude → Codex | `live-claude-1793651560678.json` |
| Cancelación Codex → Claude | `live-cancel-codex-1793651598262.json` |
| Cancelación Claude → Codex | `live-cancel-claude-1793651611668.json` |

Estas cuatro regresiones se repitieron **con persistencia activada**. `artifacts/durability-verification-1793651734820.json` correlaciona los reportes con sus archivos durables: dos tareas por run, identidades/resultados coincidentes, salida nativa observada, cierre confirmado en disco, permisos 0600 y ningún miembro ejecutándose en sus grupos registrados al verificar. Esto prueba cierre normal con agentes reales; la prueba de SIGKILL usa Node, no esos agentes.

La matriz ampliada consta de **nueve casos reales aprobados**: análisis, cancelación selectiva y fallo/ejecución posterior, cada uno en ambas direcciones; dos raíces elegidas por el modelo de Pi; y delegación anidada elegida por Pi en ambas direcciones. Los reportes más recientes están en `artifacts/cases-*/report.json`, junto a su run durable privado. `artifacts/cases-verification-1793653361304.json` reúne los nueve y verifica identidades, estados, salidas, cierre y permisos; conserva también el intento fallido. Cada caso verifica archivos sin cambios, salida nativa observada antes de asentar la tarea, cierre durable coincidente y ausencia de miembros ejecutándose en los grupos propios al finalizar.

La prueba del modelo principal pasó con el modelo configurado `openai-codex/gpt-5.6-sol`. Un intento previo con `anthropic/claude-haiku-4-5` no produjo respuesta ni lanzó trabajadores: se conserva como fallo, no como éxito. La elección del modelo de Pi es independiente del modelo de cada CLI. Esto valida estos casos acotados, no todos los modelos ni una inspección visual humana.

### Última validación del endurecimiento

`artifacts/hardening-live-8j77igbj/verification.json` correlaciona **116 pruebas locales**, tres regresiones Python, PTY fullscreen/regular, **nueve casos reales y dos cancelaciones completas de árbol** con sus journals cerrados. Incluye hashes de las fuentes ejecutadas, permisos privados y salida observada antes del settlement. El modelo principal de Pi fue `openai-codex/gpt-5.6-sol`.

El verificador lee archivos: no adopta ni señaliza PIDs archivados. La ausencia de miembros ejecutándose fue comprobada por cada arnés mientras conservaba autoridad viva; no se deduce de números históricos. Los fallos anteriores se conservan y no se cuentan como éxitos.

### Validación ampliada y escalabilidad del núcleo

`artifacts/scale-native-ndyjnzyd/verification.json` correlaciona seis ejecuciones reales posteriores con fuentes y journals cerrados:

- El modelo principal `openai-codex/gpt-5.6-sol` eligió herramientas con prompts ordinarios para **Pi → Antigravity → Codex → Antigravity → Pi** y **Pi → Codex → Antigravity → Codex → Pi**. Sin comandos, llamadas forzadas ni resultados sustituidos; devolvió la marca impredecible y `PAID_TOTAL=550`.
- Cancelación del árbol completo **Antigravity → Codex**, **Codex → Antigravity**, **Antigravity → Claude** y **Claude → Antigravity**: sesiones y procesos vivos, actividad nativa antes de cancelar, ambas tareas `cancelled`, salida observada antes de settlement, sin resultado tardío, workspace intacto y ningún miembro ejecutándose en sus grupos propios al verificar.
- Dos fallos previos de cancelación con Antigravity padre se conservan: intentó una herramienta fuera del puente permitido y fue denegada. Se precisó el prompt del harness; no se relajó la política de permisos. El diagnóstico de denegaciones usa categorías fijas, no cuerpos ni argumentos de herramientas.

```sh
# Consumen cuota real. No garantizan compatibilidad con cualquier modelo de Pi.
PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=1 \
PI_ORCHESTRATOR_PI_PROVIDER=openai-codex \
PI_ORCHESTRATOR_PI_MODEL=gpt-5.6-sol npm run smoke:cases -- pi-nested antigravity codex

PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=1 npm run smoke:cancel -- antigravity codex
# También: codex antigravity, antigravity claude, claude antigravity.
```

El núcleo mantiene un índice de hijos y un contador de tareas activas; cancelar un subárbol no recorre repetidamente todas las tareas y usa recorrido iterativo. Sin persistencia ya no construye snapshots completos para checkpoints inexistentes. Con persistencia se mantienen las barreras síncronas: no se omiten escrituras para mejorar un benchmark.

Fixture reproducible sin agentes: `npx tsx scripts/benchmark-core.ts 1000`. Las observaciones locales guardadas en `artifacts/core-benchmark-{before,after}.json` pasaron de 6.999.000 proyecciones/unos 309 ms a cero proyecciones/unos 26 ms. Son ejecuciones sintéticas individuales, **no una garantía de throughput, memoria máxima ni aceleración de los CLI**. Pruebas deterministas cubren 1.000 tareas sin proyecciones ocultas, liberación de capacidad y una cadena de 1.500 tareas con cancelación sin afectar a su raíz hermana. Estos tamaños son solo fixtures en memoria: no aumentan los valores predeterminados ni el límite de 256 tareas del journal.

## Reproducir las pruebas reales

**Opt-in: consume las cuotas de ambos runtimes.**

```sh
npm run smoke:live -- codex   # Pi → Codex → Claude → Pi
npm run smoke:live -- claude  # Pi → Claude → Codex → Pi
```

Pruebas reales de cancelación, también opt-in y con consumo de cuota:

```sh
npm run smoke:cancel -- codex
npm run smoke:cancel -- claude
```

Esperan a que ambos procesos y sesiones nativas estén activos y el hijo inicie una herramienta (`Read` de Claude o `commandExecution` de Codex). Después cancelan el padre, verifican la cascada y las salidas observadas y consultan `ps` únicamente para los grupos propios. Un hijo que no arranque, termine antes de la cancelación o no llegue a esa operación provoca fallo, no un falso positivo. El evento `commandExecution` por sí solo no demuestra lectura efectiva del archivo; la devolución de contenido leído se prueba por separado con `smoke:live`.

Cada prueba crea y elimina un directorio temporal. Los resultados y el árbol de eventos se guardan en `artifacts/`. Las sesiones nativas pueden quedar registradas en los directorios propios de los CLI, conforme a su comportamiento habitual.

### Matriz ampliada: tareas, aislamiento de fallos y modelo principal

**También consume cuota.** Los casos `analysis`, `selective` y `failure` usan la API del servicio como host; el padre nativo decide y ejecuta sus herramientas MCP. No son peticiones al modelo de Pi:

```sh
npm run smoke:cases -- analysis codex
npm run smoke:cases -- analysis claude
npm run smoke:cases -- selective codex
npm run smoke:cases -- selective claude
npm run smoke:cases -- failure codex
npm run smoke:cases -- failure claude
```

- `analysis`: dos hijos con procesos nativos solapados; uno calcula una suma filtrada y otro revisa un predicado incorrecto. El padre reenvía ambas marcas aleatorias. El evento `request-reused` acredita que el reintento realmente llegó al núcleo sin crear otro intento; no se acepta solo la afirmación del modelo.
- `selective`: espera dos hijos y una operación nativa del elegido, cancela exclusivamente ese hijo y exige que el hermano y el padre completen. Iniciar `Read`/`commandExecution` en el cancelado no acredita lectura completa; el hermano sí debe devolver su marca.
- `failure`: configura temporalmente un modelo inexistente para el motor hijo, exige `failed` sin resultado ni reintento oculto, y que el padre informe el fallo. Restaura la variable del proceso de prueba y exige una ejecución válida posterior. Es un fallo deliberado de configuración, no una prueba de caída del proveedor o recuperación de sesión. No cambia archivos de configuración globales.

`pi-model` y `pi-nested` sí envían un prompt ordinario al modelo principal de Pi. Solo se exponen las cuatro herramientas de esta extensión; no se fuerza la elección de herramientas ni se llama a comandos desde el arnés. Selecciona un proveedor/modelo ya autenticado en Pi, por ejemplo el comprobado aquí:

```sh
export PI_ORCHESTRATOR_PI_PROVIDER=openai-codex
export PI_ORCHESTRATOR_PI_MODEL=gpt-5.6-sol
npm run smoke:cases -- pi-model          # Pi elige dos raíces, Codex y Claude
npm run smoke:cases -- pi-nested codex   # Pi elige Codex; este delega a Claude
npm run smoke:cases -- pi-nested claude  # Pi elige Claude; este delega a Codex
```

El arnés usa el SDK y una sesión Pi en memoria, sin extensiones globales, herramientas builtin ni interfaz alternativa. Registra las herramientas realmente ejecutadas y los estados del modelo, no cuerpos HTTP ni credenciales. La selección está acotada a estas herramientas y tareas autorizadas; no prueba elección entre todos los plugins posibles. Impone hasta 16 turnos/240 segundos al host y limita el número de tareas permitido por caso; no es un presupuesto monetario duro.

Todos estos casos activan persistencia en su propio directorio privado dentro de `artifacts/cases-*`, aunque no hayas definido `PI_ORCHESTRATOR_STATE_DIR`. Guardan evidencia también al fallar y limpian el workspace temporal. No adoptan procesos desde archivos.

Prueba automatizada de la TUI, sin peticiones a modelos (requiere Python 3, POSIX y `pi` en PATH):

```sh
npm run test:tui
```

Primero ejecuta tres regresiones del arnés: EOF anterior a la salida, vencimiento del plazo real y auto-salida del trabajador al cerrar su FIFO privado. Después carga `test/fixtures/tui-extension.ts`, que reutiliza la extensión, el servicio y el núcleo con dos procesos Node simulados. Activa persistencia en su workspace temporal y comprueba también cierre durable en reset e historial/inspección/reconciliación sin alterar archivos. Guarda trazas ANSI y pasos comprobados en `artifacts/tui-*`; **no es una inspección visual humana ni una prueba del renderizado con modelos reales**. Se corrigió una espera por número de iteraciones que podía agotarse al recibir EOF antes de la salida del proceso; ahora usa un plazo monotónico. Los fixtures se auto-cierran al perder un FIFO privado mantenido por el arnés: no se envían señales a trabajadores usando PIDs guardados en archivos. Los dos modos pasaron en dos ejecuciones consecutivas después de estos cambios.

Opcionalmente, selecciona modelos que ya funcionen en cada CLI:

```sh
PI_ORCHESTRATOR_CODEX_MODEL=<id> PI_ORCHESTRATOR_CLAUDE_MODEL=<id> npm run smoke:live -- codex
```

Sin variables se conservan los modelos predeterminados de cada runtime. Codex recibe esfuerzo de razonamiento `low`. Claude tiene un máximo de 12 turnos y la opción de presupuesto API de USD 1; **esa opción no es un límite garantizado de consumo para suscripciones OAuth**. No hay un límite monetario duro para Codex. El límite general es el plazo de ejecución.

## Otras mejoras medidas

- **Codex más barato por llamada:** se desactivan familias de herramientas que un trabajador no usa (navegador, uso del ordenador, imágenes, sugerencias…). Medido: de 17 400 a 16 160 tokens de entrada por llamada, un 7,1 % menos; la ejecución de comandos y MCP siguen funcionando.
- **Motores precalentados: no se implementan.** Medido: el hilo de Codex está listo en 0,5–0,9 s y la respuesta del modelo tarda 3,5–5 s, así que el ahorro posible no compensa mantener procesos vivos.
- **Resultados largos:** el texto completo se guarda en un archivo privado (0600) y el resultado publicado indica su ruta.
- **Plazo blando también en Claude:** su entrada queda abierta durante el turno y la indicación se atiende en la siguiente pausa entre herramientas. Medido con un plazo de 60 s: respondió `WRAPPED-UP` a los 53 s y quedó completada. Con pasos de 20 s no da tiempo dentro de un plazo de 60 s; con el de 15 min por defecto el margen es de 2,25 min. Ahora Claude también se puede redirigir (`s`).
- **Antigravity:** su `usage_update` se muestra como "contexto X de Y", ocupación y no consumo.
- **Internet por tarea (`web`):** solo la concede el operador (diálogo en la TUI), las subtareas no la heredan, y el Bash de Claude sigue sin red. Medido: Claude con permiso abrió example.com, sin permiso lo bloqueó el sandbox, y Codex usó su búsqueda.
- **Atajo `/orch codex: …`, `/orch claude: …` o `/orch agy: …`:** delega directamente sin una vuelta del modelo principal; la tarjeta es la respuesta.
- **Menos trabajo de interfaz:** el widget se instala una vez y luego solo se repinta, y los eventos frecuentes se escriben en la sesión como mucho cada 2 s por tarea. Medido en una tarea real: de 18 a 1 reinstalaciones del widget y de 18 a 10 escrituras en la sesión.

## Rendimiento medido

`npm run bench:live -- ETIQUETA fanout|trivial [N]` (con `BENCH_MODE=rpc|json`) ejecuta el modelo principal real de Pi y los motores reales sobre un repo con tres errores plantados; consume cuota. Resultados del 2026-11-03 con `gpt-6.1-sol` como modelo principal (tres tareas en paralelo: 2 Claude y 1 Codex):

| Métrica | Antes (2 ejecuciones) | Después, TUI/RPC (3) | Después, JSON bloqueante (1) |
| --- | --- | --- | --- |
| Chat bloqueado | 39–103 s | 12–14 s | 31 s |
| Vueltas del modelo principal | 7 (1–2 sin aporte) | 3–5 (0 sin aporte) | 5 (0) |
| Tokens de entrada del modelo principal | 26 000–26 800 | 10 900–17 400 | 16 700 |
| Coste de las tareas Claude | $0.067–0.086 (Opus por defecto) | $0.028–0.048 (Sonnet) | $0.028 |
| Aciertos / evidencia `archivo:línea` | 3/3 · 3/3 | 3/3 · 3/3 | 3/3 · 3/3 |

- Sin `--model`, Claude usa el modelo predeterminado de la cuenta (medido: `claude-opus-5-5`). La extensión usa `sonnet` salvo que lo pida la tarea o `PI_ORCHESTRATOR_CLAUDE_MODEL`. El modelo resuelto se registra por tarea.
- El formato de respuesta de los motores (`src/worker-contract.ts`) se midió aislado (A/B, 6 tareas por motor): aciertos 6/6 en ambos, resultados un 12 % (Claude) y un 25 % (Codex) más cortos y tokens totales iguales. No se aplica a Antigravity: añadido a su prompt, las tareas anidadas restringidas fallaron (0/4 frente a 6/6).
- Antigravity 1.4.5 en paralelo: 18/18 tras el arreglo de notificaciones previas a la sesión. Antigravity→Claude: 6/6 tras denegar sin abortar (antes fallaban ~2 de 13).
- Coste fijo de una delegación trivial: unos 14 000 tokens con Claude y 36 000 con Codex. Por eso la herramienta indica no delegar lo que el modelo principal resuelve en uno o dos pasos (medido: en ese caso el modelo principal ya lo resuelve sin delegar).

### Mejoras de eficiencia del 2026-11-04

- **Comandos de solo lectura en Antigravity restricted** (`src/readonly-commands.ts`). Medido en vivo (1.4.5): leer, listar y buscar no piden permiso; solo `execute`, con `rawInput.CommandLine`. Una lista blanca (ls, du, ps, git log/status/diff, find sin `-exec`/`-delete`, docker/brew/npm de consulta…) se aprueba `allow_once` sin humano; lo demás sigue pidiendo aprobación. Rechaza `;`, `&&`, `||`, redirección a archivo, `$`, backticks y escapes; tuberías solo entre comandos permitidos. Nada que use la red recibe un destino elegido por el modelo: `npm view`/`npm outdated`/`pnpm outdated` y `git remote show` piden aprobación, y cualquier URL o `--registry`/`--userconfig` en npm, pnpm, git o brew también (evita sacar datos dentro de una URL). Sonda real, mismo prompt (tres comandos), Flash low: **diálogos humanos 3 → 0, duración 44 s → 31 s**, workspace intacto en ambas. Tests: 47 comandos de inspección permitidos y 78 de escritura, ejecución o red denegados. Desactivar: `PI_ORCHESTRATOR_ANTIGRAVITY_READONLY_AUTO=0`.
- **Links `file://` → `ruta:línea`** (`src/result-links.ts`), antes de truncar. Sobre los 27 resultados del historial: **176 links → 0**, 187.445 → 176.829 caracteres (−5,7 % total; −9,0 % en los 10 resultados con links; unos 3.000 tokens). Los links apuntaban a worktrees ya borrados.
- **Estimación de tokens de Antigravity**: sin contador propio, cuenta el pico de contexto (`context.peak`), una cota inferior de la entrada facturada. El tope `PI_ORCHESTRATOR_MAX_TOKENS` deja de ignorarlas. Cobertura del historial: tareas con medición **8/31 → 28/31**.
