# Pi Orchestrator — prototipo experimental

Orquestación de **runtimes reales** de Codex y Claude Code desde Pi, con delegación anidada y resultados de vuelta al padre. No es un cambio de modelo de Pi ni un fork de `pi-subagents`.

## Estado

Prototipo experimental con 275 pruebas locales (`npm test`, sin cuota) y matrices reales probadas en las direcciones Pi → Codex ⇄ Claude ⇄ Antigravity: delegación anidada, cancelación del árbol completo, elección de herramientas por el modelo principal de Pi y persistencia opcional. No es un sistema de producción.

Documentación detallada:

- [docs/evidence.md](docs/evidence.md): pruebas reales, artefactos de evidencia, rendimiento medido y cómo reproducirlas (consumen cuota).
- [docs/security.md](docs/security.md): YOLO, sandbox, permisos por intención y límites de seguridad reales.
- [docs/persistence.md](docs/persistence.md): checkpoints, reconciliación y reinicio explícito después de un crash.
- [docs/antigravity.md](docs/antigravity.md): adaptador ACP experimental, instalación y autenticación.
- [ARCHITECTURE.md](ARCHITECTURE.md) y [RELIABILITY.md](RELIABILITY.md): límites del código y fiabilidad de las pruebas.

## Requisitos

- Node.js >= 22, npm y Pi 1.4.x. Comprobado en macOS; la limpieza de árboles de procesos usa grupos POSIX y no está validada para Windows.
- `codex` y `claude` disponibles en `PATH`, autenticados mediante sus propios mecanismos.
- Python 3 para `npm run test:tui` (pruebas del arnés y pseudoterminal); no se necesita para `npm test`.
- Protocolos comprobados localmente con Codex CLI `0.166.0` y Claude Code `2.1.316`. Los adaptadores son experimentales y otras versiones pueden requerir cambios.

```sh
cd ~/Desktop/pi-orchestrator
npm ci --ignore-scripts
npm run check
npm test
```

La suite contiene 275 pruebas locales; última ejecución paralela completa: 275/275. Los anteriores fallos de deadline/censo motivaron watchdogs de fixtures adecuados para contención y reintentos acotados del censo desconocido, sin cambiar garantías de producción. Véase [RELIABILITY.md](RELIABILITY.md). `npm test` y usa motores simulados y procesos Node: **no ejecuta agentes reales ni consume sus cuotas**. La comprobación TypeScript y `npm audit --omit=dev` también pasaron (sin vulnerabilidades notificadas en dependencias de producción).

## Usar desde Pi, sin instalación global

Desde el directorio en el que quieras trabajar:

```sh
pi --extension ~/Desktop/pi-orchestrator/src/extension.ts
```

La extensión no inicia procesos ni escucha puertos hasta que se utiliza. No es necesario configurar MCP manualmente en Codex ni Claude Code.

En la TUI de Pi:

```text
/orch demo                         # Inicia trabajo real y devuelve el editor
/orch                              # Abre el panel; /orch panel es equivalente
/orch start codex <instrucción>     # Trabajo real en segundo plano
/orch start claude <instrucción>
/orch status
/orch result <task-id o prefijo>
/orch cancel <task-id o prefijo>
/orch reset
```

`/orch demo` autoriza y ejecuta una pequeña tarea real: Codex delega a Claude el cálculo de `17 * 19` y recibe su respuesta. Consume cuotas. En la TUI no bloquea el editor: abre `/orch` después de iniciarla. `/orch start` también devuelve el control inmediatamente. `/orch run codex|claude <instrucción>` espera el resultado; se conserva para scripts y el smoke del SDK.

En el panel:
- `↑` / `↓`: seleccionar una tarea del árbol. Se conservan las relaciones reales por `parentId`.
- `c`: pedir cancelación de la tarea seleccionada y sus descendientes. `y` confirma; `n` o `Esc` rechazan. No se envía nada antes de confirmar.
- `PgUp` / `PgDn`: recorrer el resultado, error y detalles.
- `f`: alternar todas / activas / fallidas; las raíces activas aparecen primero.
- `d`: mostrar u ocultar detalles técnicos (tarea, intento, workspace, sesión y proceso), paginados junto al resultado.
- `Esc`: cerrar el panel **sin detener las tareas**.
- Las tarjetas del chat y las herramientas tienen presentación legible, sin JSON por defecto; los contratos JSON para el modelo permanecen intactos. Se distingue modelo/thinking solicitado de confirmado, sin atribuir confirmación a los defaults.
- Se muestran estado, duración y última actividad informada por el motor. «Esperando tu permiso/respuesta» se muestra únicamente mientras está abierto el diálogo humano correspondiente, no por inferencia del texto del runtime. Los fallos incluyen una acción conservadora; nunca disparan reintentos ni cambio de modelo. En terminales muy bajas se priorizan el árbol y los controles.
- Esta presentación se verifica con fixtures y PTY; no sustituye una revisión visual humana ni prueba permisos nativos nuevos.
- Los prefijos de ID deben tener al menos ocho caracteres y ser únicos. `/orch reset` pide confirmación en TUI si quedan tareas activas.

Para delegar desde el modelo principal de Pi están disponibles:

- `orchestrator_delegate`: inicia una tarea; devuelve identificador y un campo `next` que dice al modelo si debe terminar su turno o esperar. En la TUI y en RPC el modelo **no se bloquea**: cuando terminan todas las tareas que delegó, sus resultados llegan en **un único mensaje** que inicia su siguiente turno. En `print`/`json`, donde nada despertaría al modelo, sigue esperando con `orchestrator_wait`.
- `orchestrator_status`: lista tareas (sin el texto de los resultados) o consulta una concreta con su resultado completo.
- `orchestrator_wait`: espera una o varias tareas (`taskIds`), 5 min por defecto y 10 como máximo; repetir si siguen en ejecución. Cada resultado se envía al modelo **una sola vez**; las consultas posteriores devuelven una referencia.
- `orchestrator_cancel`: cancela el árbol y espera la limpieza de los runtimes.

Ejemplo de petición al modelo de Pi:

> Autorizo ejecutar Codex en modo de solo lectura. Pídele que delegue una revisión pequeña a Claude Code usando pi_orchestrator, espere su resultado y me devuelva una síntesis. No modificar archivos.

No se lanzan agentes solo por abrir Pi. La autorización de nuevas tareas sigue correspondiendo al operador; el prototipo no implementa un sistema adicional de confirmaciones por presupuesto.

Los resultados raíz se muestran y se añaden a la conversación de Pi. No despiertan automáticamente su modelo; las herramientas `wait` permiten continuar de forma explícita. Los eventos se registran como entradas personalizadas de la sesión. `/orch reset` cancela las tareas existentes y descarta el estado en memoria; si activaste persistencia, conserva el archivo histórico.

### `/orch` por instrucción: motor, modelo y thinking

Codex, Claude y Antigravity están disponibles sin activación manual de motores. Antigravity sigue siendo experimental y conserva validaciones de runtime/autenticación y permisos humanos por defecto; no inicia procesos hasta una delegación autorizada. Ya no necesita `PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=1` (los ejemplos anteriores que la incluyen siguen siendo válidos). Para deshabilitarlo explícitamente usa `PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=0`; valores no reconocidos también lo bloquean. Tras actualizar el paquete local, `/reload` carga este comportamiento.

Solo escribe `/orch` y tu instrucción. No hay que configurar modelos fijos ni abrir selectores:

```text
/orch delega a agy 3.8 flash high para explorar este repo sin modificar archivos
/orch usa Claude sonnet con thinking high para revisar la arquitectura
/orch delega a OpenAI con reasoning high para explicar los tests
```

La extensión envía la instrucción al modelo principal de Pi como un nuevo turno (o follow-up si está ocupado). Pi interpreta motor/modelo/thinking y llama a `orchestrator_delegate`, después espera los resultados. `openai` corresponde al motor Codex; `agy` a Antigravity. Los nombres ambiguos deben aclararse, no convertirse en versiones inventadas. Esto utiliza el modelo y la cuota de Pi para interpretar la instrucción, además de la cuota del motor delegado. Los tests locales prueban el encaminamiento y los campos del tool, no garantizan la interpretación de cualquier modelo principal.

Cada tarea recibe su propia selección; no se recuerda como modelo fijo para la siguiente. Las herramientas Pi y MCP `delegate` admiten `model` y `thinking` para **Codex, Claude y Antigravity**, sujeto al soporte de cada modelo, cuenta y runtime. Sin valores explícitos se conservan las variables de entorno/runtime. Tras actualizar usa `/reload` una vez para cargar el comando y los esquemas nuevos. Los subcomandos administrativos exactos y `start/run ENGINE ...` siguen disponibles para compatibilidad; no son necesarios para pedir delegaciones.

- **Codex:** thinking se pasa como reasoning effort en la configuración y en `turn/start.effort`; se valida contra `model/list` para el modelo nativo seleccionado antes del prompt. Ya no se fuerza `low` cuando se omite.
- **Claude:** thinking se pasa como `--effort`, junto con `--model` por tarea. El CLI instalado anuncia low/medium/high/xhigh/max, pero no todos los modelos admiten todos los niveles. El protocolo no confirma de forma independiente el esfuerzo efectivo: `selection` registra lo solicitado, no una garantía de confirmación. Claude puede aplicar sus propias restricciones/remapeos; no se declara verificación universal de equivalencia de modelo o esfuerzo. Referencia: [configuración de modelos Claude](https://code.claude.com/docs/en/model-config).
- **Antigravity:** modelo y `thought_level` se validan contra opciones ACP y se configuran por separado con confirmación antes del prompt. Un valor no anunciado falla sin fallback ni sufijos legacy adivinados. `modelState` registra el catálogo y la selección confirmada; resume conserva la selección confirmada del origen. Referencia conceptual T3: su `setModel` usa `session/set_config_option` en ACP 1.4; implementación propia sin copiar módulos.

Pruebas nativas de lectura, workspace intacto y salida observada: `artifacts/native-model-codex-7pLLuG/report.json` (reasoning high), `artifacts/native-model-claude-BPXtwB/report.json` (sonnet, --effort high), `artifacts/antigravity-live-Zn9Y4a/report.json` (gemini-3.8-flash/high confirmado). No son una prueba nativa end-to-end de interpretación de lenguaje natural. Los primeros intentos Codex `xUlsuF` y Claude `tmJCFH` conservan resultado failed del arnés: las tareas completaron y leyeron correctamente, pero el arnés comprobaba erróneamente `process` en vez de `runtimeProcess`; se corrigió y repitió. El intento Antigravity `IKSZbc` falló al probar la API antigua y se conserva.

### Nuevos controles: alcance y evidencia

- `/orch capabilities TASK`: capacidad del adaptador y disponibilidad actual; no inicia un servicio ni adopta archivos históricos.
- `/orch steer TASK TEXTO`: solo Codex y su turno vivo. Correlaciona hilo/turno esperado; un ACK no demuestra obediencia. `artifacts/native-steer-mqHjxW/report.json` sí verifica que el resultado contiene una marca enviada exclusivamente por steer.
- `/orch resume TASK TEXTO`: solo Antigravity, desde una tarea completada con limpieza confirmada en **el coordinador todavía vivo**. Crea tarea/intento/proceso/credencial nuevos y conserva la sesión nativa; exclusión por sesión evita continuaciones simultáneas. No importa archivos, no adopta PIDs y no reenvía transcripts. La sesión puede contener continuaciones anteriores; no es un fork del estado histórico del origen. `artifacts/native-resume-bRLi0Z/report.json` verifica recuerdo de una marca ausente del segundo prompt, misma sesión e intentos distintos.
- En modo restringido, Antigravity traslada solicitudes adicionales a confirmación/selección humana en Pi. Permisos adicionales solo ofrecen `allow_once`, nunca aprobación persistente. Sin TUI, al expirar o sin handler, la operación se deniega (`cancelled`) y el turno continúa sin ella, como en Codex y Claude; el resultado lleva un aviso con el número de denegaciones. Más de 8 denegaciones, una petición de otra sesión o fuera del turno vivo siguen haciendo fallar la tarea. Texto externo no confiable y detalles redactados; las respuestas tardías pierden autoridad. Codex/Claude no ganan permisos interactivos.
- `PI_ORCHESTRATOR_QUEUE=fair` es el valor por defecto de la extensión: cola limitada de raíces, FIFO por motor y round-robin entre motores (no equidad multiusuario). `reject` restaura el rechazo inmediato. `PI_ORCHESTRATOR_MAX_QUEUED` y `PI_ORCHESTRATOR_RESERVED_CHILD_SLOTS` ajustan límites; los hijos rechazan saturación en vez de esperar detrás de sus ancestros.
- `PI_ORCHESTRATOR_MAX_RUNTIME_MS` limita la suma monotónica de milisegundos ocupados por slots de runtime, incluidos padres esperando. Al agotarse cierra admisión y cancela activos/pendientes; el cleanup puede exceder el límite. No mide CPU, tokens ni facturación. `/orch usage` informa consumo y coste monetario no disponible.
- `/orch config`: muestra todas las variables `PI_ORCHESTRATOR_*`, su valor efectivo, si viene del entorno o del valor predeterminado, si la configuración es válida y qué variables con ese prefijo no se reconocen (p. ej. erratas). No inicia el servicio. Una prueba exige que toda variable leída en `src/` esté en el registro (`settingsRegistry` en `src/configuration.ts`).
- También se validan `PI_ORCHESTRATOR_MAX_CONCURRENT`, `MAX_TASKS`, `MAX_DEPTH` e `INTERACTION_TIMEOUT_MS` con el mismo prefijo completo.

Suite secuencial histórica: **166/166**; evidencia `artifacts/interactive-scheduling-tests.log`. Los smokes nuevos también verificaron Pi→Antigravity→Codex y cancelación Codex→Antigravity. Un intento Pi anterior falló por red sin crear tareas y se conserva en `artifacts/cases-pi-nested-antigravity-xsBb86/report.json`. No extrapolar estos casos a garantías de producción ni a pruebas de supervisor SSH.

## Continuar una sesión

`orchestrator_continue` (y `r` en el panel) envía un seguimiento a la **misma sesión nativa** de una tarea completada: los hilos de Codex (`thread/resume`; ya no son efímeros) y las sesiones de Antigravity. Se ofrece cuando el resultado lleva `continuable: true`, nunca para YOLO. Medido con la misma pregunta de seguimiento sobre Codex: 18 309 tokens de entrada (261 sin caché) frente a 36 149 (18 357 sin caché) de una tarea nueva, 6 s frente a 8 s, y la misma respuesta correcta. En un hilo reanudado Codex informa totales acumulados del hilo: cada continuación registra solo su parte. En una prueba real de extremo a extremo, el modelo principal eligió `orchestrator_continue` por sí mismo para el seguimiento.

## Catálogo de modelos y topes de gasto

- **Motor alternativo (opcional):** `PI_ORCHESTRATOR_FALLBACK=claude:codex,codex:claude` repite **una vez** en el otro motor una tarea que falla por cuota o autenticación, con las mismas condiciones de seguridad que el reintento automático (restringida, sin hijos, proceso terminado, sin aprobación humana, sin continuación nativa). Usa el modelo por defecto del motor alternativo, no el del original; la tarea queda marcada con `fallbackFrom`. Sin la variable no cambia nada.
- **Historial por motor:** `orchestrator_engines` añade `trackRecord` con las tareas recientes de cada motor (de los últimos 20 runs guardados, o de la sesión si no hay persistencia): completadas, fallidas por categoría, mediana de duración y de tokens, y `blocked` si su último resultado fue un fallo de cuota o autenticación sin éxitos después. Delegar en un motor bloqueado no se impide (la cuota puede renovarse), pero el resultado de `orchestrator_delegate` lleva un `warning` para que el modelo pueda elegir otro motor o avisar.
- `orchestrator_engines` lista lo que cada motor ofrece de verdad, sin enviar ningún prompt, y lo cachea 15 min:
  - Codex con `model/list`.
  - Antigravity abre una sesión breve para leer su catálogo.
  - Claude muestra sus alias, que se resuelven por cuenta; el modelo resuelto queda registrado en cada tarea.
  - Medido: los tres motores responden en 4,3 s. En una prueba real, el modelo principal resolvió "argon" como `gemini-4-argon` consultando el catálogo, en lugar de adivinar.
- `PI_ORCHESTRATOR_MAX_TOKENS` y `PI_ORCHESTRATOR_MAX_COST_USD` limitan el gasto de la sesión según lo que informa cada motor (solo Claude informa dólares). Al alcanzarse se rechaza trabajo nuevo, pero no se mata el que está en curso, salvo con `PI_ORCHESTRATOR_SPEND_ENFORCEMENT=abort`: entonces el primer cruce del tope cancela todo el trabajo vivo y conserva sus resultados parciales. Como solo Claude informa dólares, en ese modo el tope en USD sigue sin ver el gasto de Codex y Antigravity. `/orch usage` muestra el consumo frente al tope.

## Historial por defecto

La extensión guarda el historial en `~/.pi/agent/orchestrator-state` (directorio 0700, archivos 0600). `PI_ORCHESTRATOR_STATE_DIR` elige otro directorio y `PI_ORCHESTRATOR_STATE_DIR=off` lo desactiva. Retención: se conservan los 100 runs más recientes; solo se borran runs más antiguos con cierre registrado y archivo válido (nunca runs sin cierre, que podrían seguir vivos, ni archivos inválidos). La actividad se escribe en disco como mucho cada 5 s por tarea (medido en una tarea real de Codex: 18 → 11 escrituras); el cierre de cada tarea siempre se escribe.

Los lotes se agrupan por ejecución del agente: una tarea larga de una ejecución anterior no retrasa los resultados de un lote posterior más rápido. Si una tarea del lote **falla** mientras sus hermanas siguen en curso, el modelo se despierta en ese momento solo con el fallo, para que pueda volver a delegar sin esperar a la más lenta; el resto llega después en otro mensaje y nada se entrega dos veces. Cuesta un turno extra solo cuando hay un fallo; `PI_ORCHESTRATOR_EARLY_FAILURE_WAKE=0` lo desactiva. `/orch usage` cuenta ambos tipos de despertar.

## Verificación

- `npm run verify`: compilador, batería completa y arnés PTY con Pi real (sin cuota).
- `npm run verify:live`: lo anterior más `scripts/live-matrix.ts`, que ejecuta los tres motores solos y anidados en paralelo (consume cuota; sale con código 1 si un caso falla).

## Arquitectura

```text
Pi: herramientas / comandos / estado en TUI
                 │
          Núcleo de ejecución en memoria
          ├── checkpoint privado opcional → archivos JSON por run
          ├── tarea + intento + identidad nativa
          ├── permisos por subárbol y límites
          ├── adaptador Codex (app-server JSONL)
          ├── adaptador Claude Code (CLI stream-json)
          └── servidor MCP HTTP en 127.0.0.1:puerto-aleatorio
                           ▲
                 cada runtime puede delegar
```

Las herramientas MCP son `delegate`, `status`, `wait` y `cancel`. La identidad del llamante procede de una credencial aleatoria por intento, **no de un `parentId` elegido por el modelo**. Los agentes externos no reciben autoridad raíz.

- Un `requestKey` estable hace idempotente la creación de tareas dentro de un padre. Reutilizarlo con otros argumentos da error. `request-reused` observa la reutilización sin registrar la clave ni crear otro intento/checkpoint.
- Cada ejecución tiene tarea, intento e identificador de sesión nativa separados. Solo hay un intento por tarea en esta versión.
- Un padre puede observar y cancelar descendientes, no hermanos ni ancestros.
- Claude no puede leer almacenes de credenciales (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.config/gcloud`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.pi/agent/auth.json`, `~/.codex/auth.json`, el perfil OAuth de Antigravity…): reglas `Read(...)` para Read/Grep/Glob y `sandbox.filesystem.denyRead` para Bash, en restricted y YOLO. Medido en vivo con un señuelo en `~/.ssh`: Read, `cat` y Grep fueron denegados en ambos modos. Con `PI_ORCHESTRATOR_YOLO_SANDBOX=off` Bash queda sin sandbox y solo aplican las reglas de las herramientas. Codex y Antigravity siguen pudiendo leer lo que tu usuario lee.
- Las credenciales se revocan al cancelar o terminar. La admisión del padre se cierra antes de esperar la limpieza de sus hijos; no puede crear otro durante ese intervalo. El puente revalida la credencial después de leer el cuerpo HTTP, evitando aceptar cuerpos demorados tras la revocación. El token de Claude se entrega en un archivo temporal 0600, no en argumentos del proceso; el de Codex viaja por stdin.
- La cancelación entra primero en `cancelling`. Se confirma `cancelled` después de la limpieza del runtime. Se envía SIGTERM al grupo propio y después SIGKILL si hace falta, incluyendo descendientes. Si el adaptador informa `RuntimeCleanupError`, un proceso observado no tiene salida confirmada o un descendiente conserva limpieza incierta, el resultado es `failed`, nunca una cancelación confirmada. El panel tampoco presenta una promesa resuelta como prueba de limpieza.
- `EPERM` por sí solo no acredita limpieza. Solo se tolera en un grupo propio con censo disponible, ningún miembro no-zombi y líder observado salido o zombi. Un censo desconocido o cualquier miembro ejecutándose conserva el fallo. Los grupos comprobados como retirados no reciben señales posteriores; el censo no concede autoridad sobre procesos ajenos.
- Al terminar un padre se cancelan hijos todavía activos. Al cerrar/reemplazar/recargar la sesión de Pi se cierran tareas y puente MCP.
- Los fallos del proveedor, respuestas vacías y permisos denegados no se presentan como éxito. También fallan rechazos con valores como `undefined`, `null` o `false`.
- JSONL exige UTF-8 válido y objetos, con límite de 1 MiB por registro. Se admite un último registro completo sin salto de línea, no uno truncado. El primer error se conserva incluso si llega después de un resultado.
- Codex correlaciona hilo y turno, con buffer previo al ack acotado. Claude exige inicialización única, puente conectado y sesión coherente. Las respuestas duplicadas o de otra identidad fallan; no se publican cuerpos malformados en errores.

### Límites predeterminados

| Límite | Valor |
| --- | --- |
| Profundidad | 2 runtimes por debajo de Pi |
| Concurrencia | 4 en la extensión (`PI_ORCHESTRATOR_MAX_CONCURRENT`), incluyendo padres que esperan; con la cola justa una plaza queda reservada para subtareas, así que corren 3 raíces a la vez. El núcleo como librería mantiene 3 |
| Cola de raíces | `fair` por defecto en la extensión (`PI_ORCHESTRATOR_QUEUE=reject` vuelve al rechazo); las tareas que exceden la capacidad esperan en cola, sin límite de tiempo salvo `PI_ORCHESTRATOR_MAX_QUEUE_WAIT_MS`, que cancela sin lanzar las que esperan más |
| Tareas por sesión del núcleo | 32, incluyendo terminadas (`PI_ORCHESTRATOR_MAX_TASKS`); es un freno contra delegación desbocada |
| Plazo por intento | 15 minutos (`PI_ORCHESTRATOR_TASK_TIMEOUT_MS`); al 85 % se pide a Codex (vía steer) que cierre y responda ya; al vencer se cancela el árbol |
| Resultado parcial | si una tarea falla o se cancela (plazo, turnos, presupuesto), su último texto se publica como `partialResult` marcado como parcial; nunca cuenta como completada |
| Permisos y preguntas pendientes | 5 min en la extensión (`PI_ORCHESTRATOR_INTERACTION_TIMEOUT_MS`); después se deniegan |
| Prompt | 32 000 caracteres |
| Resultado completo, después de redactar | 20 000 caracteres; el exceso se **trunca con un aviso explícito** en vez de descartar el trabajo |
| Espera del host (`orchestrator_wait`) | 5 min por defecto, máx. 10 min; acepta `taskIds` para esperar varias tareas en una llamada. Las esperas MCP anidadas de Codex y Claude: 5 min por defecto, máx. 10 (sus clientes MCP se configuran con 660 s); Antigravity mantiene 30 s / 60 s porque el límite de su cliente no está verificado |
| Esfuerzo de Codex sin `thinking` explícito | `medium` (`PI_ORCHESTRATOR_CODEX_DEFAULT_THINKING`); nunca se hereda el `model_reasoning_effort` global del usuario |
| Turnos de Claude | 40 (`PI_ORCHESTRATOR_CLAUDE_MAX_TURNS`, 1–500); presupuesto `--max-budget-usd` 1.00 por tarea (`PI_ORCHESTRATOR_CLAUDE_MAX_BUDGET_USD`, hasta 100) |
| Notificaciones | `PI_ORCHESTRATOR_NOTIFY=desktop` (por defecto: aviso en Pi y notificación de escritorio OSC 777, compatible con Ghostty), `bell` o `off`; al terminar una tarea raíz o cuando un motor pide permiso o respuesta |

**Panel (`/orch`).**

- **Un solo sitio a la vez:**
  - Con el panel abierto, el widget no se dibuja.
  - Ya no hay barra de estado que repita el resumen.
  - El widget solo lista el trabajo activo y lo que te necesita; lo terminado es un contador ("terminadas: 2 listas · 1 cancelada").
- **Títulos cortos:** el modelo pasa un `title` de 2 a 6 palabras (medido en vivo: "Detectar NaN con vacío", "Revisar secretos en logs"). Si no lo pasa, se usa la primera frase del encargo con las rutas reducidas a su último nombre. El encargo completo se ve con `d`.
- **Orden:** primero lo activo y debajo lo terminado, atenuado (lo fallido en rojo). Una tarea cancelada o fallida que luego se repitió, aunque fuera con otras palabras, se marca como "sustituida". Las filas se limitan a 120 columnas para que el estado quede junto a su título en terminales anchas.
- **Plazo visible:** en los últimos 2 minutos antes del corte, la fila muestra «quedan 45s de plazo», con «(acotado al de su padre)» cuando su plazo se ajustó al del padre. Antes solo se veía el tiempo transcurrido y el corte llegaba sin aviso.
- **Motor alternativo visible:** una tarea repetida por `PI_ORCHESTRATOR_FALLBACK` dice «Codex · en lugar de Claude, que falló por cuota o sesión».
- **`/orch engines`** muestra también el historial reciente de cada motor (completadas, fallos por categoría, medianas de duración y tokens) y marca con ⚠ el que está bloqueado por cuota o autenticación.
- **Lenguaje llano:** "Antigravity · Gemini 3.8 Flash · razonamiento alto · YOLO (solo esta tarea)"; el origen exacto del modelo y del nivel está en `d`. También "Aún sin respuesta." y "c cancelar", que avisa si hay subtareas.
- **Actividad real:** los tres motores informan la herramienta y su objetivo ("leyendo AGENTS.md", "ejecutando `ls -la`", "editando a.ts"). El panel muestra los últimos 3 pasos con su antigüedad.
- **Teclas en una sola línea abajo,** solo las que funcionan para la tarea seleccionada. Si no caben, se acortan o se quitan las menos importantes; `Esc cerrar` siempre queda.

Con la cola justa por defecto, las raíces que exceden la capacidad esperan; una subtarea también espera, con prioridad sobre las raíces, siempre que alguna tarea en ejecución no sea ancestro de ninguna tarea en cola (esa plaza se libera sin depender de la cola); si no, se rechaza en vez de bloquearse. Un test con árboles de delegación aleatorios (profundidad 4, 3 plazas, semilla en `ORCH_TREE_SEED`) comprueba que todo termina. Cada subtarea termina antes del plazo blando de su padre (con 2 s de margen para su limpieza), y un `wait` anidado vuelve como tarde en ese plazo blando, para que el padre aún pueda sintetizar. `/orch usage` muestra en la sección «Orquestación» los contadores de cada decisión: tareas que esperaron plaza (media y máximo), hojas en cola, subtareas rechazadas, caducadas en cola, subtareas cortadas por el plazo del padre, esperas anidadas acortadas, tareas por llamada de espera y despertares del modelo (por lote y anticipados por fallo). Sirven para medir en sesiones reales y ajustar límites. Cada checkpoint guarda esos contadores en el run, y `/orch history` muestra su tendencia sumada entre runs y, por run, cuántas tareas se completaron, fallaron o se cancelaron; los archivos anteriores sin métricas se siguen leyendo. La cadena de tres runtimes `Pi → Codex → Claude → Antigravity` requiere aumentar la profundidad predeterminada; esa cadena de tres runtimes no se ha probado.

## Archivos

- `src/extension.ts`: herramientas, comando `/orch`, eventos y ciclo de vida de Pi.
- `src/dashboard.ts` y `src/presentation.ts`: panel, árbol, selección, confirmación y presentación segura.
- `src/orchestrator.ts`: identidad, límites, idempotencia, barreras durables opcionales, resultados y cancelación en árbol.
- `src/journal.ts`: snapshots versionados, validación, permisos, escritura atómica e historial por run.
- `src/reconciliation.ts`: observaciones numéricas conservadoras, sin adopción ni señales.
- `src/service.ts`: composición, persistencia opcional y cierre de recursos previo al cierre del archivo.
- `src/mcp-bridge.ts`: herramientas MCP con autoridad por sesión.
- `src/adapters/`: protocolos y gestión de procesos.
- `scripts/live-smoke.ts`: prueba real bidireccional desde el SDK de Pi.
- `scripts/live-cancel.ts`: cancelación real, evidencia de salida y grupos de procesos, auditoría HTTP sin headers/cuerpos/credenciales.
- `scripts/live-cases.ts`: matriz opt-in con análisis paralelo, reintento observado, cancelación selectiva, fallo nativo deliberado y elección de herramientas/cadenas por el modelo de Pi.
- `scripts/tui-smoke.py`: interacción PTY con el CLI real y motores simulados.
- `test/tui_harness_test.py` y `test/fixtures/tui-worker.cjs`: regresiones de plazo/EOF y cierre de fixtures por FIFO, sin autoridad basada en archivos de PIDs.
- `test/`: pruebas locales del núcleo, MCP, protocolos, procesos, panel y carga de la extensión.

## Referencias de diseño

Se implementó código propio utilizando APIs públicas, sin copiar módulos de T3 u Orca:

- T3 Code `47f2c8d2`: MCP por sesión y adaptadores por runtime. La revisión de `OrchestratorMcpService.ts` y sus tests inspira comprobar idempotencia por ámbito y distinguir cancelación solicitada de limpieza completada.
- Orca `ba453588`: separación entre tarea, intento y autoridad de reporte. Sus pruebas de `worker-dispatch-settlement.test.ts` distinguen asentar un resultado de acreditar salida del proceso; aquí exigimos ambas observaciones por separado.
- Pi 1.4.0: contratos públicos de extensiones, SDK, herramientas, componentes TUI y cierre de sesión.
- [Codex: tipos oficiales de configuración MCP](https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs): aprobación limitada por herramienta; el comportamiento se comprobó además con el CLI instalado.

La selección de herramientas por el modelo principal ya está validada en los casos descritos; sigue pendiente la revisión visual humana de la TUI. Las preguntas/permisos de Antigravity tienen ahora cobertura de fixtures y contrato UI; falta revisión visual humana y una aprobación nativa supervisada. La futura recuperación de ejecución necesita identidad verificable de la encarnación de cada proceso y un protocolo explícito de adopción/reanudación; no basta con persistir PIDs o transcripts. Antigravity ACP experimental ya se instala y autentica de forma privada y tiene pruebas nativas bidireccionales; la cancelación nativa de sus árboles y su elección por el modelo principal de Pi también están comprobadas en las direcciones documentadas. Siguen pendientes presupuesto monetario agregado y supervisores remotos; no se presenta el prototipo como un sistema completo de producción.
