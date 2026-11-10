# Persistencia y recuperación

Persistencia para inspección, no recuperación de ejecución.

[← README](../README.md)

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
