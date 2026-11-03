# Pi Orchestrator — prototipo experimental

Orquestación de **runtimes reales** de Codex y Claude Code desde Pi, con delegación anidada y resultados de vuelta al padre. No es un cambio de modelo de Pi ni un fork de `pi-subagents`.

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

## Antigravity ACP: instalación y autenticación propias

Se implementó un adaptador **experimental** para el runtime ACP oficial, no para `agy --print`. Siguiendo las referencias de T3/Orca, servidor y helper se instalan juntos, con versión, tamaño y SHA-256 fijados. El instalador actual solo está cualificado para **macOS arm64, versión 1.4.5**. Es software propietario de Google: [términos oficiales](https://antigravity.google/terms); no se redistribuye como código MIT del proyecto.

```sh
npm run antigravity:install  # descarga explícita; solo .runtimes/ dentro del proyecto
npm run antigravity:probe    # initialize, sin login ni llamadas de modelo
npm run antigravity:auth     # OAuth oficial; interacción explícita en navegador
npm run test:installer       # seis pruebas Python, sin red ni agentes

PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=1 \
  pi --extension "$HOME/Desktop/pi-orchestrator/src/extension.ts"
```

Dentro de Pi: `/orch engines` detecta el runtime sin iniciarlo ni crear estado; `/orch start antigravity INSTRUCCIÓN` crea una tarea. También puede seleccionarse `antigravity` en las herramientas de Pi y MCP. No se añade nada al PATH ni se modifica configuración global.

- Perfil dedicado: `.runtimes/antigravity/profile`, con `GEMINI_HOME` y almacenamiento administrado por el runtime. No se importan credenciales del IDE, CLI ni de Pi. El entorno del hijo excluye claves/configuración Google heredadas. Los archivos de autenticación son sensibles y están excluidos de Git.
- Se exige identidad/version compatible y MCP HTTP. Se usa modo ACP `default`. Por defecto solo se preaprueban una vez las cuatro herramientas del servidor MCP propio, con sesión y metadatos coincidentes; otras operaciones requieren permiso humano. Con autorización YOLO explícita por tarea, Pi aprueba automáticamente permisos de herramientas `allow_once`, sin cambiar el modo nativo ni guardar aprobaciones persistentes. Las preguntas genuinas no se contestan automáticamente. Escritura y terminal solicitados al cliente siguen sin estar implementados y fallan cerrados. Esto no es un sandbox completo del ordenador.
- Antigravity 1.4.5 puede enviar notificaciones (`usage_update`) antes de responder a `session/new`. Se guardan con tope (64 mensajes / 256 KiB) y se validan contra el ID de sesión al conocerlo; una de otra sesión sigue fallando cerrada. Antes de este arreglo, varias tareas de Antigravity en paralelo fallaban de forma intermitente con `Antigravity update has unknown session`.
- `_meta.antigravity.disabledTools = ["run_workflow"]` evita la escritura de un skill al crear sesión observada en esta familia de versiones. Los fixtures comprueban este parámetro; los cinco casos reales comprobaron su workspace intacto.
- Login realizado y `initialize` real comprobados con el runtime oficial. **Cinco casos reales aprobados:** lectura de marca impredecible; Antigravity → Codex, Antigravity → Claude y ambas inversas, con delegación MCP, resultado devuelto al padre, salida observada y journal cerrado. Evidencia: `artifacts/antigravity-verification.json`. Los dos primeros fallos por permisos se conservan.
- La primera matriz partía del servicio y del padre nativo. Posteriormente se comprobaron también la elección de Antigravity por el modelo principal de Pi y la cancelación nativa de árboles en cuatro direcciones; véase la validación ampliada siguiente. Los fixtures cubren además abort, protocolo y denegaciones.

Pruebas reales opt-in, **consumen cuota y no tienen tope monetario duro**:

```sh
PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=1 npm run smoke:antigravity
PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=1 npm run smoke:antigravity-nested -- antigravity codex
# También: antigravity claude, codex antigravity, claude antigravity
```

Para un runtime externo: `PI_ORCHESTRATOR_ANTIGRAVITY_ACP=/ruta/agy_acp_server.par`, con helper compatible al lado, y opcionalmente `PI_ORCHESTRATOR_ANTIGRAVITY_PROFILE=/perfil/privado`. Encontrar un binario no acredita autenticación ni compatibilidad. El login no se abre automáticamente al delegar: las credenciales vencidas deben renovarse explícitamente.

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

## Reinicio explícito después de crash

La recuperación implementada es **reinicio seguro con un intento nuevo**, no adopción del proceso ni reanudación de la sesión nativa:

```text
/orch history
/orch inspect RUN
/orch restart RUN TASK --accept-duplicate-risk INSTRUCCIONES_NUEVAS
```

Requiere persistencia habilitada, mismo workspace, run histórico y IDs completos o prefijos únicos de al menos ocho caracteres. La TUI solicita además confirmación. No se inicia servicio antes de validar la solicitud y aceptar el riesgo.

El prompt completo no está archivado: debes suministrar instrucciones nuevas. Se crea una raíz con nuevos IDs de tarea/intento, sesión nueva y credenciales nuevas; `recoverySource` conserva run/tarea/intento anteriores, incluso en el journal. El archivo original queda byte-idéntico. No se reutilizan PID/PGID, tokens ni sesiones, no se señalizan huérfanos y no se repite automáticamente el subárbol. El intento anterior **puede seguir activo**, por lo que aceptar duplicados es obligatorio; no hay garantía de ejecución exactamente una vez.

Comprobado con SIGKILL real del coordinador y trabajador Node superviviente: ninguna adopción implícita; el relanzamiento explícito ejecuta otro intento y deja al anterior intacto. No es una prueba de recuperación nativa tras SIGKILL de Codex/Claude/Antigravity.

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

La suite contiene 176 pruebas locales; última ejecución paralela completa: 176/176. Los anteriores fallos de deadline/censo motivaron watchdogs de fixtures adecuados para contención y reintentos acotados del censo desconocido, sin cambiar garantías de producción. Véase [RELIABILITY.md](RELIABILITY.md). `npm test` y usa motores simulados y procesos Node: **no ejecuta agentes reales ni consume sus cuotas**. La comprobación TypeScript y `npm audit --omit=dev` también pasaron (sin vulnerabilidades notificadas en dependencias de producción).

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

## Persistencia y reconciliación conservadora

Desactivadas por defecto. Para activarlas, usa un directorio **absoluto, privado y de tu usuario**, en un filesystem POSIX local y con ancestros de confianza:

```sh
PI_ORCHESTRATOR_STATE_DIR="$HOME/Desktop/pi-orchestrator/.state" \
  pi --extension "$HOME/Desktop/pi-orchestrator/src/extension.ts"
```

Se crea con modo 0700 si falta; un directorio existente que permita acceso a grupo/otros se rechaza, no se corrige automáticamente. `.state/` está excluido de Git. Importar la extensión no escribe archivos ni abre puertos. La primera operación que necesite el servicio crea un run independiente; el historial solo lee.

```text
/orch history                 # Hasta 50 archivos recientemente modificados; marca omisiones/errores
/orch inspect <run-id>        # Últimos estados e identidades; expande para resultados guardados
/orch reconcile <run-id>      # Diagnóstico numérico actual de ps, sin adoptar ni enviar señales
```

Admiten ID completo o prefijo único de al menos ocho caracteres. `history` distingue sesión actual, cierre registrado y run sin reconciliar; **sin cierre no implica que su coordinador haya muerto**, porque podría seguir activo en otra sesión de Pi. Se puede inspeccionar un ID completo fuera de la ventana del historial. Los archivos inválidos aparecen como no disponibles; no se mezclan con los válidos ni se descartan silenciosamente.

- Un UUID de run por vida del servicio, un archivo `<run-id>.json` y una secuencia de checkpoints. Varios Pi comparten el directorio sin sobrescribir los runs ajenos. Reset/cambio/cierre de sesión cierran el propio; no borran archivos anteriores.
- Se guardan tareas, intentos, relación padre/hijo, título limitado a 160 caracteres, última actividad, identidades nativas, PID/PGID y salida observada, resultados/errores y cierre. Se excluyen los campos de especificaciones ejecutables completas, mapas de autoridad, configuración/credenciales MCP y claves de idempotencia. Los textos siguen pudiendo contener datos sensibles; la redacción de Bearer **no es un filtro universal de secretos**. No publiques esos archivos sin revisarlos.
- Escritura en temporal 0600, `fsync`, renombrado atómico y `fsync` del directorio. La intención se confirma **antes de programar el runtime**. Un checkpoint `running` no demuestra por sí solo que el CLI arrancó. Los callbacks confirman por separado sesión, proceso y salida.
- Fallar al escribir impide nuevo trabajo, revoca y cancela los intentos activos y espera su limpieza. Un éxito nativo cuyo checkpoint final falla no se presenta como `completed`. Un fallo de almacenamiento no impide cerrar primero procesos y transporte.
- Es un snapshot versionado y validado, **no un event log ni una especificación ejecutable completa**. Cada archivo admite hasta 4 MiB/256 tareas; los límites normales del núcleo siguen siendo ocho tareas por servicio. No hay poda ni presupuesto de disco global: administra la retención de archivos manualmente, fuera de runs activos.
- No se importa ningún archivo como tarea activa, ni se recrean tokens, ni se repiten tareas automáticamente. Las herramientas `orchestrator_*` y el panel controlan solo el núcleo actual. Los comandos históricos no requieren iniciar servicio ni consumen cuota de modelos.
- Reconciliar compara únicamente metadatos numéricos (`pid`, `pgid`, estado de `ps`) con identidades guardadas, sin argv, entorno ni contenido de proceso. PID ausente no demuestra limpieza de descendientes; PID/PGID coincidente **no demuestra identidad ni propiedad**, incluso si el PID del coordinador coincide. Si `ps` falla, la observación queda desconocida. No se convierte esa observación en autoridad para matar procesos.

Tras un crash/SIGKILL pueden quedar procesos y temporales del runtime, incluido el archivo MCP de Claude. Esta versión permite inspeccionar el último checkpoint, **no garantiza limpiar huérfanos, reanudar sesiones ni recuperar ejecución**. No se han probado cortes de alimentación ni filesystems remotos. La prueba local de SIGKILL y la TUI automatizada no sustituyen una revisión humana ni prueban crash de los motores reales.

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

## Verificación

- `npm run verify`: compilador, batería completa y arnés PTY con Pi real (sin cuota).
- `npm run verify:live`: lo anterior más `scripts/live-matrix.ts`, que ejecuta los tres motores solos y anidados en paralelo (consume cuota; sale con código 1 si un caso falla).

## Escritura aislada (YOLO) y sandbox

- Una tarea raíz YOLO en un repositorio git corre en un **worktree privado**, creado desde una instantánea de tu estado: el último commit más los cambios staged y unstaged, mediante `git stash create`. Los archivos sin seguimiento no se incluyen. Sus subtareas ven ese mismo worktree.
- Al terminar, con éxito o no, se registra el diff (`git diff --stat` y un parche privado) y **no se aplica**. Tú decides: `a` o `/orch apply ID` lo aplica sobre tu árbol de trabajo (sin commit; si hay conflicto no se escribe nada y el worktree se conserva), y `x` o `/orch discard ID` lo descarta. Si no hubo cambios, el worktree se borra solo.
- Fuera de git, la tarea escribe directamente y la tarjeta lo dice. `PI_ORCHESTRATOR_ISOLATE_WRITES=0` desactiva el aislamiento.
- Sandbox (`PI_ORCHESTRATOR_YOLO_SANDBOX=on` por defecto):
  - Codex YOLO usa `workspace-write`: solo escribe en su directorio y no tiene red.
  - Claude ejecuta Bash dentro del sandbox de Claude Code, con `failIfUnavailable`, sin salida del sandbox y sin red. En modo restringido además tiene el directorio de la tarea protegido contra escritura: puede ejecutar `tsc` o tests, pero no escribir.
  - Medido en vivo: Codex y Claude YOLO arreglaron un error en su worktree, tu árbol quedó intacto hasta aplicar, y la escritura en `$HOME` y la red quedaron bloqueadas.
  - `off` restaura el acceso total. Que sea una elección explícita tuya.
- `cwd` por tarea: el modelo puede indicarlo cuando nombras otro proyecto. Debe estar dentro del `cwd` de Pi o de `PI_ORCHESTRATOR_ALLOWED_ROOTS` (rutas absolutas separadas por `:`). Las subtareas heredan el directorio del padre.
- Reintento automático: un fallo transitorio del proveedor (capacidad, sobrecarga, 5xx) o de red se reintenta **una vez** tras 5 s, solo si la tarea es de solo lectura, no lanzó subtareas y no fue cancelada. Los tokens de los dos intentos se suman. Medido: Codex devolvió `Selected model is at capacity` en una ejecución real de la matriz.

## Continuar una sesión

`orchestrator_continue` (y `r` en el panel) envía un seguimiento a la **misma sesión nativa** de una tarea completada: los hilos de Codex (`thread/resume`; ya no son efímeros) y las sesiones de Antigravity. Se ofrece cuando el resultado lleva `continuable: true`, nunca para YOLO. Medido con la misma pregunta de seguimiento sobre Codex: 18 309 tokens de entrada (261 sin caché) frente a 36 149 (18 357 sin caché) de una tarea nueva, 6 s frente a 8 s, y la misma respuesta correcta. En un hilo reanudado Codex informa totales acumulados del hilo: cada continuación registra solo su parte. En una prueba real de extremo a extremo, el modelo principal eligió `orchestrator_continue` por sí mismo para el seguimiento.

## Historial por defecto

La extensión guarda el historial en `~/.pi/agent/orchestrator-state` (directorio 0700, archivos 0600). `PI_ORCHESTRATOR_STATE_DIR` elige otro directorio y `PI_ORCHESTRATOR_STATE_DIR=off` lo desactiva. Retención: se conservan los 100 runs más recientes; solo se borran runs más antiguos con cierre registrado y archivo válido (nunca runs sin cierre, que podrían seguir vivos, ni archivos inválidos). La actividad se escribe en disco como mucho cada 5 s por tarea (medido en una tarea real de Codex: 18 → 11 escrituras); el cierre de cada tarea siempre se escribe.

Los lotes se agrupan por ejecución del agente: una tarea larga de una ejecución anterior no retrasa los resultados de un lote posterior más rápido.

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
| Cola de raíces | `fair` por defecto en la extensión (`PI_ORCHESTRATOR_QUEUE=reject` vuelve al rechazo); las tareas que exceden la capacidad esperan en cola |
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

**Panel (`/orch`).** Las tareas se ordenan por urgencia (te necesita › fallida › atascada › en curso › lista), sin IDs técnicos. Muestra tiempo, tokens reportados por el motor, subtareas activas y "sin actividad hace N" (tras 3 min sin actividad observada por el host). Lo que reporta el motor se etiqueta como "motor: …" y nunca se presenta como una fase verificada. Teclas, solo si la tarea las admite: `s` redirigir (Codex en curso), `r` reanudar (Antigravity), `R` reintentar (tarea raíz terminada; YOLO vuelve a pedir confirmación), `e` editor, `i` insertar en el chat, `y` copiar, `c` cancelar árbol, `d` detalles, `f` filtro. El widget se reduce a una línea cuando no queda trabajo activo. Los permisos se muestran con el comando y las rutas destacados, no como JSON.

Con la cola justa por defecto, las raíces que exceden la capacidad esperan; las subtareas siguen rechazándose si no queda plaza (no pueden esperar detrás de sus ancestros). Un padre que necesite capacidad para hijos debe conservar una plaza disponible. La cadena de tres runtimes `Pi → Codex → Claude → Antigravity` requiere aumentar la profundidad predeterminada; esa cadena de tres runtimes no se ha probado.

## Seguridad y límites reales

**"Solo lectura" no equivale a un aislamiento completo del sistema.**

- Codex utiliza por defecto sandbox `read-only` y aprobaciones `never`; una tarea autorizada YOLO usa `danger-full-access` y `never`, sin sandbox de archivos. Solo las cuatro herramientas del servidor MCP propio se preautorizan mediante `tools.<nombre>.approval_mode = "approve"` y una allowlist explícita. En modo restringido no se cambian las aprobaciones de archivos/shell ni se finge que lanzar/cancelar workers sea una operación MCP de lectura. Se desactivan hooks y notificaciones heredados en este proceso y su hilo, además del multiagente nativo; no se modifica `~/.codex/config.toml`.
- **Aislamiento MCP de Codex.** Los servidores MCP corren fuera del sandbox de Codex, así que un worker `read-only` que los heredara (p. ej. `node_repl`, `playwright` con herramientas preaprobadas, `supabase`) no sería de solo lectura. Antes de `thread/start` el adaptador obtiene los servidores definidos en la configuración efectiva (`config/read`, capas de usuario y proyecto) y los desactiva uno a uno; los de plugins y apps quedan fuera con `features.plugins=false` y `features.apps=false`. Todas las claves `mcp_servers.*` se envían en formato con punto: mezclar un objeto `mcp_servers` anidado con overrides con punto hace que Codex descarte parte de las desactivaciones (medido con codex-cli 0.166.0). Después de crear el hilo se verifica con `mcpServerStatus/list` por hilo que todo servidor distinto de `pi_orchestrator` esté `disabled`; si no, la tarea falla cerrada antes de enviar el turno. El `AGENTS.md` global de Codex sí se sigue cargando: Codex no permite excluirlo por hilo.
- Esto corrige una interacción observada durante la validación: primero hubo intentos bloqueados antes de llegar al puente; con hooks desactivados Codex rechazó explícitamente la llamada por requerir aprobación. Tras añadir aprobación limitada al puente propio pasaron ambas direcciones. Los intentos fallidos se conservan como evidencia; no se cuentan como pruebas exitosas.
- **YOLO requiere confirmación humana.** El modelo solo puede *proponer* `permissionMode=yolo`; `orchestrator_delegate` abre un diálogo de confirmación en la TUI de Pi con el motor y la tarea, y sin TUI o sin aceptación la tarea no se inicia. Así una inyección de prompt (texto del repositorio, salida de otro runtime) no basta para obtener ejecución sin aprobaciones.
- Claude utiliza por defecto `--restricted`, solo herramientas de archivos `Read,Glob,Grep`, configuración MCP estricta y permisos no interactivos. Si el modo restringido le deniega una herramienta pero devuelve una respuesta, esta se publica con un aviso explícito de las herramientas denegadas en lugar de descartarse. En YOLO se omite `--restricted`, se habilitan también Bash/Write/Edit y se usa `--dangerously-skip-permissions` con `bypassPermissions`. En ambos modos permanecen desactivados hooks, plugins, multiagente nativo y configuración MCP heredada.
- Se conservan las autenticaciones propias de los runtimes. Pi no intercambia sus tokens de proveedor con ellos.
- El núcleo y los CLI siguen ejecutándose con tu usuario. Las configuraciones administradas y el comportamiento interno de los runtimes siguen aplicando. Las credenciales MCP no protegen frente a procesos hostiles con acceso equivalente al sistema de archivos o memoria del mismo usuario.
- La comprobación de archivos de las pruebas cubre su directorio temporal, no todo el ordenador. No prueba que los CLI no escriban cachés, sesiones o logs propios.
- MCP escucha solo en loopback, exige Bearer y rechaza cualquier `Origin` y un `Host` distinto de `127.0.0.1:<puerto>`. Revalida autoridad tras leer el cuerpo y en cada invocación. Desconectar un `wait` MCP elimina su espera, no cancela la tarea. Un segundo attach fallido no deja otro puerto escuchando; el cierre del transporte se intenta aun si falla el núcleo. No es un servicio remoto ni una frontera contra otros programas hostiles del usuario.
- Hay persistencia opcional para inspección, no recuperación de ejecución. Hay reinicio explícito con nuevas identidades y Antigravity ACP experimental. No hay reintentos automáticos, adopción de procesos, adaptador Pi-hijo, worktrees ni integración FleetView. Las capacidades nuevas y su alcance están descritos al final. El consumo de los runtimes externos no se agrega a las estadísticas de costes de Pi.
- El cierre normal y la recarga liberan recursos. Un SIGKILL/crash de Pi no permite ejecutar limpieza; la reconciliación posterior es de solo lectura, no adopta ni detiene procesos descubiertos en archivos. Los PIDs persistidos no son una identidad de proceso recuperable.
- El panel y el widget utilizan componentes de Pi, no un renderer independiente. El texto de proveedores se limpia de secuencias de control terminal y se ajusta al ancho. Hay pruebas unitarias con Unicode, ventanas estrechas y paginación, además de interacción PTY automatizada. La revisión visual humana completa sigue pendiente.

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

### Permisos por intención, no por palabras clave

Puedes pedir, por ejemplo, «/orch manda a agy flash 3.8 high a explorar el repo, no me pidas permisos» o expresarlo de otra manera. Pi interpreta el significado y pasa `permissionMode: "yolo"` solo con autorización explícita del operador para esa tarea. No existe una lista de frases ni un parser que active permisos al encontrar «yolo» en un prompt, archivo o respuesta del runtime. Sin autorización se conserva `restricted`; los comandos legacy start/run siguen restringidos.

YOLO permite comandos y modificaciones sin confirmación, incluso fuera del workspace donde el motor lo permita. No equivale a aislamiento. La tarjeta muestra **YOLO autorizado (esta tarea)**; no se cambian defaults globales ni credenciales. Codex usa acceso completo sin aprobaciones; Claude habilita Bash/Write/Edit sin aprobaciones; Antigravity aprueba automáticamente solo opciones `allow_once` de la sesión activa. Una pregunta genuina no es una aprobación: no se inventan sus respuestas. Capacidades no implementadas siguen fallando, sin fallback silencioso.

El modo participa en idempotencia y checkpoints. Las subtareas no heredan YOLO y no pueden elevar permisos por MCP, incluso si el padre está en YOLO; hace falta una nueva raíz autorizada por el operador. No se permite resume nativo de sesiones YOLO para evitar reutilizar permisos/estado elevados silenciosamente; autoriza una tarea nueva. Un restart histórico también empieza restringido. Cancelación, límites, presupuesto y verificación del cierre siguen vigentes; este modo **no corrige** un cleanup no confirmado.

Cobertura local: políticas, propagación desde el tool, fixtures de los tres motores, ausencia de diálogos de aprobación en YOLO, rechazo de permisos persistentes/sesión ajena/IDs duplicados y persistencia estricta. No es una prueba nativa nueva ni garantía universal de interpretación semántica por cualquier modelo principal de Pi.

### Nuevos controles: alcance y evidencia

- `/orch capabilities TASK`: capacidad del adaptador y disponibilidad actual; no inicia un servicio ni adopta archivos históricos.
- `/orch steer TASK TEXTO`: solo Codex y su turno vivo. Correlaciona hilo/turno esperado; un ACK no demuestra obediencia. `artifacts/native-steer-mqHjxW/report.json` sí verifica que el resultado contiene una marca enviada exclusivamente por steer.
- `/orch resume TASK TEXTO`: solo Antigravity, desde una tarea completada con limpieza confirmada en **el coordinador todavía vivo**. Crea tarea/intento/proceso/credencial nuevos y conserva la sesión nativa; exclusión por sesión evita continuaciones simultáneas. No importa archivos, no adopta PIDs y no reenvía transcripts. La sesión puede contener continuaciones anteriores; no es un fork del estado histórico del origen. `artifacts/native-resume-bRLi0Z/report.json` verifica recuerdo de una marca ausente del segundo prompt, misma sesión e intentos distintos.
- En modo restringido, Antigravity traslada solicitudes adicionales a confirmación/selección humana en Pi. Permisos adicionales solo ofrecen `allow_once`, nunca aprobación persistente. Sin TUI, al expirar o sin handler, la operación se deniega (`cancelled`) y el turno continúa sin ella, como en Codex y Claude; el resultado lleva un aviso con el número de denegaciones. Más de 8 denegaciones, una petición de otra sesión o fuera del turno vivo siguen haciendo fallar la tarea. Texto externo no confiable y detalles redactados; las respuestas tardías pierden autoridad. Codex/Claude no ganan permisos interactivos.
- `PI_ORCHESTRATOR_QUEUE=fair` es el valor por defecto de la extensión: cola limitada de raíces, FIFO por motor y round-robin entre motores (no equidad multiusuario). `reject` restaura el rechazo inmediato. `PI_ORCHESTRATOR_MAX_QUEUED` y `PI_ORCHESTRATOR_RESERVED_CHILD_SLOTS` ajustan límites; los hijos rechazan saturación en vez de esperar detrás de sus ancestros.
- `PI_ORCHESTRATOR_MAX_RUNTIME_MS` limita la suma monotónica de milisegundos ocupados por slots de runtime, incluidos padres esperando. Al agotarse cierra admisión y cancela activos/pendientes; el cleanup puede exceder el límite. No mide CPU, tokens ni facturación. `/orch usage` informa consumo y coste monetario no disponible.
- También se validan `PI_ORCHESTRATOR_MAX_CONCURRENT`, `MAX_TASKS`, `MAX_DEPTH` e `INTERACTION_TIMEOUT_MS` con el mismo prefijo completo.

Suite secuencial histórica: **166/166**; evidencia `artifacts/interactive-scheduling-tests.log`. Los smokes nuevos también verificaron Pi→Antigravity→Codex y cancelación Codex→Antigravity. Un intento Pi anterior falló por red sin crear tareas y se conserva en `artifacts/cases-pi-nested-antigravity-xsBb86/report.json`. No extrapolar estos casos a garantías de producción ni a pruebas de supervisor SSH.
